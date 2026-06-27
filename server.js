const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '32e267c453b2a6fa1ae82f355d413b8e';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://profit-analytics-server-production.up.railway.app';
const SCOPES = 'read_orders,read_products,read_all_orders,read_shopify_payments_payouts';
const TOKEN_FILE = '/tmp/tokens.json';

// Meta (Facebook) OAuth config
const META_APP_ID = process.env.META_APP_ID || '2204919553684262';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_REDIRECT_URI = BASE_URL + '/auth/meta/callback';
const META_SCOPES = 'ads_read';

// Load tokens
let tokenStore = {};
try { tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch(e) {}
function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore)); } catch(e) {}
  // Persist to Postgres too - /tmp doesn't survive a Railway redeploy, so without this every
  // deploy lost the token and forced a needless full resync via /auth.
  Object.entries(tokenStore).forEach(([shop, access_token]) => {
    pool.query(
      `INSERT INTO shopify_tokens (shop, access_token, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW()`,
      [shop, access_token]
    ).catch(e => console.error('saveTokens DB persist failed:', e.message));
  });
}
// Loads any previously saved tokens from Postgres into tokenStore at startup, so a redeploy
// (which wipes /tmp) doesn't force a fresh /auth + full resync.
async function loadTokensFromDB() {
  try {
    const result = await pool.query('SELECT shop, access_token FROM shopify_tokens');
    result.rows.forEach(row => { tokenStore[row.shop] = row.access_token; });
    if (result.rows.length > 0) console.log(`Loaded ${result.rows.length} Shopify token(s) from database`);
  } catch(e) { console.error('loadTokensFromDB failed:', e.message); }
}

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT PRIMARY KEY,
      shop VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      financial_status VARCHAR(50),
      created_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      current_total_price DECIMAL(10,2),
      total_price DECIMAL(10,2),
      total_tax DECIMAL(10,2),
      current_total_tax DECIMAL(10,2),
      line_items JSONB,
      refunds JSONB,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop);
    CREATE INDEX IF NOT EXISTS idx_orders_processed_at ON orders(processed_at);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_tax DECIMAL(10,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS current_total_tax DECIMAL(10,2);
    CREATE TABLE IF NOT EXISTS sync_status (
      shop VARCHAR(255) PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      total_orders INT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta_accounts (
      shop VARCHAR(255) PRIMARY KEY,
      access_token TEXT NOT NULL,
      ad_account_id VARCHAR(64) NOT NULL,
      ad_account_name VARCHAR(255),
      token_expires_at TIMESTAMPTZ,
      connected_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shopify_tokens (
      shop VARCHAR(255) PRIMARY KEY,
      access_token TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

app.use(cors({ origin: '*' }));
// Webhook routes need the raw, unparsed body to verify Shopify's HMAC signature, so we
// exclude them from the global JSON parser here (they apply their own express.raw() instead).
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) return next();
  express.json()(req, res, next);
});

// OAuth
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(BASE_URL+'/auth/callback')}&state=${state}`);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');
  try {
    const data = JSON.parse(await httpsPost(shop, '/admin/oauth/access_token', { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }));
    if (!data.access_token) return res.status(400).send('No token');
    tokenStore[shop] = data.access_token;
    saveTokens();
    // Start initial sync in background
    syncAllOrders(shop, data.access_token);
    // Register webhooks so order edits/refunds reach us immediately, instead of relying on
    // the 48h polling window which can miss returns that happen days after purchase (the root
    // cause behind several stale-data bugs we've hit: refunds, current_total_tax, current_total_price).
    registerWebhooks(shop, data.access_token);
    res.send(`<html><body style="background:#0f1117;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h1>✓ Ansluten!</h1><p style="color:#9ca3b8;margin-top:12px">Synkar ordrar i bakgrunden. Stäng denna flik.</p></body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Registers the webhooks needed to keep order data fresh in near-real-time: new orders,
// order edits, and refunds. Safe to call repeatedly - Shopify won't duplicate a webhook with the same topic+address.
async function registerWebhooks(shop, token) {
  const topics = ['orders/create', 'orders/updated', 'refunds/create'];
  for (const topic of topics) {
    try {
      const body = JSON.stringify({ webhook: { topic, address: `${BASE_URL}/webhooks/${topic.replace('/', '-')}`, format: 'json' } });
      const result = await new Promise((resolve, reject) => {
        const options = { hostname: shop, path: '/admin/api/2024-01/webhooks.json', method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
        const r = https.request(options, resp => { let raw=''; resp.on('data',c=>raw+=c); resp.on('end',()=>resolve(raw)); });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
      console.log(`Webhook registered for ${topic}:`, result.slice(0, 200));
    } catch(e) { console.error(`Webhook registration failed for ${topic}:`, e.message); }
  }
}

// Verifies a Shopify webhook's HMAC signature against the raw request body, using the app's
// client secret. Returns true if valid. Without this, anyone who finds our webhook URL could
// post fake order data and corrupt our database.
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !req.rawBody) return false;
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(req.rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader)); }
  catch(e) { return false; } // length mismatch etc - treat as invalid rather than crashing
}

// Webhook receiver: orders/create, orders/updated and refunds/create all trigger a re-sync of
// just that single order, so new orders and changes (refunds, edits) are reflected within
// seconds instead of waiting for the 30-min delta sync.
app.post('/webhooks/orders-create', express.raw({ type: '*/*' }), async (req, res) => {
  req.rawBody = req.body; // express.raw() puts the raw Buffer in req.body
  if (!verifyShopifyWebhook(req)) { console.error('Webhook orders-create: invalid HMAC, rejecting'); return res.status(401).send('invalid signature'); }
  res.status(200).send('ok'); // ack immediately, Shopify expects a fast response within 5s
  try {
    const order = JSON.parse(req.rawBody.toString('utf8'));
    const shop = Object.keys(tokenStore)[0];
    const token = tokenStore[shop];
    if (!shop || !token || !order.id) return;
    await upsertOrders(shop, [order]);
    console.log('Webhook orders/create processed for order', order.id);
  } catch(e) { console.error('Webhook orders/create error:', e.message); }
});

app.post('/webhooks/orders-updated', express.raw({ type: '*/*' }), async (req, res) => {
  req.rawBody = req.body; // express.raw() puts the raw Buffer in req.body
  if (!verifyShopifyWebhook(req)) { console.error('Webhook orders-updated: invalid HMAC, rejecting'); return res.status(401).send('invalid signature'); }
  res.status(200).send('ok'); // ack immediately, Shopify expects a fast response within 5s
  try {
    const order = JSON.parse(req.rawBody.toString('utf8'));
    const shop = Object.keys(tokenStore)[0];
    const token = tokenStore[shop];
    if (!shop || !token || !order.id) return;
    await upsertOrders(shop, [order]);
    console.log('Webhook orders/updated processed for order', order.id);
  } catch(e) { console.error('Webhook orders/updated error:', e.message); }
});

app.post('/webhooks/refunds-create', express.raw({ type: '*/*' }), async (req, res) => {
  req.rawBody = req.body;
  if (!verifyShopifyWebhook(req)) { console.error('Webhook refunds-create: invalid HMAC, rejecting'); return res.status(401).send('invalid signature'); }
  res.status(200).send('ok');
  try {
    const payload = JSON.parse(req.rawBody.toString('utf8'));
    const orderId = payload.order_id;
    const shop = Object.keys(tokenStore)[0];
    const token = tokenStore[shop];
    if (!shop || !token || !orderId) return;
    // The refund webhook payload itself doesn't include the full updated order (current_total_tax
    // etc), so we re-fetch the order fresh from Shopify to get the post-refund totals.
    const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${orderId}.json`);
    const data = JSON.parse(body);
    if (data.order) {
      await upsertOrders(shop, [data.order]);
      console.log('Webhook refunds/create processed for order', orderId);
    }
  } catch(e) { console.error('Webhook refunds/create error:', e.message); }
});

// Meta OAuth - step 1: redirect to Facebook login
app.get('/auth/meta', (req, res) => {
  const shop = req.query.shop || Object.keys(tokenStore)[0];
  if (!shop) return res.status(400).send('Anslut Shopify-butiken först');
  const state = Buffer.from(JSON.stringify({ shop })).toString('base64');
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&scope=${META_SCOPES}&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

// Meta OAuth - step 2: handle callback, exchange code for long-lived token
app.get('/auth/meta/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send('Meta-fel: ' + (error_description || error));
  if (!code) return res.status(400).send('Missing code');
  let shop;
  try { shop = JSON.parse(Buffer.from(state, 'base64').toString()).shop; } catch(e) { return res.status(400).send('Invalid state'); }
  try {
    // Exchange code for short-lived token
    const shortLived = await httpsGetJson('graph.facebook.com', `/v19.0/oauth/access_token?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&client_secret=${META_APP_SECRET}&code=${code}`);
    if (!shortLived.access_token) return res.status(400).send('No token from Meta: ' + JSON.stringify(shortLived));

    // Exchange short-lived for long-lived token (~60 days)
    const longLived = await httpsGetJson('graph.facebook.com', `/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortLived.access_token}`);
    const finalToken = longLived.access_token || shortLived.access_token;
    const expiresInSec = longLived.expires_in || shortLived.expires_in || 5184000; // default 60 days
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    // Fetch ad accounts so the user can pick one
    const accountsResp = await httpsGetJson('graph.facebook.com', `/v19.0/me/adaccounts?fields=name,account_id&access_token=${finalToken}`);
    const accounts = accountsResp.data || [];

    if (accounts.length === 0) {
      return res.status(400).send('Inga ad-konton hittades för detta Facebook-konto.');
    }

    // If only one account, connect it directly. Otherwise show a picker.
    if (accounts.length === 1) {
      await pool.query(`
        INSERT INTO meta_accounts (shop, access_token, ad_account_id, ad_account_name, token_expires_at, connected_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (shop) DO UPDATE SET access_token=EXCLUDED.access_token, ad_account_id=EXCLUDED.ad_account_id, ad_account_name=EXCLUDED.ad_account_name, token_expires_at=EXCLUDED.token_expires_at, connected_at=NOW()
      `, [shop, finalToken, accounts[0].id, accounts[0].name, expiresAt]);
      return res.send(`<html><body style="background:#0f1117;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h1>✓ Meta Ads anslutet!</h1><p style="color:#9ca3b8;margin-top:12px">Konto: ${accounts[0].name}. Stäng denna flik.</p></body></html>`);
    }

    // Multiple accounts - let user pick
    const options = accounts.map(a => `<option value="${a.id}">${a.name} (${a.id})</option>`).join('');
    res.send(`<html><body style="background:#0f1117;color:#e8eef8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px">
      <h1>Välj ad-konto</h1>
      <select id="acc" style="padding:10px;border-radius:8px;font-size:14px;min-width:300px">${options}</select>
      <button onclick="confirmAccount()" style="padding:10px 20px;border-radius:8px;background:#4a90d9;color:#fff;border:none;cursor:pointer;font-size:14px">Anslut detta konto</button>
      <script>
        async function confirmAccount(){
          const id = document.getElementById('acc').value;
          const name = document.getElementById('acc').selectedOptions[0].text;
          await fetch('/auth/meta/select-account?shop=${encodeURIComponent(shop)}&account_id='+encodeURIComponent(id)+'&account_name='+encodeURIComponent(name)+'&token=${encodeURIComponent(finalToken)}&expires_at=${encodeURIComponent(expiresAt.toISOString())}');
          document.body.innerHTML = '<h1 style="color:#22c55e">✓ Anslutet! Stäng denna flik.</h1>';
        }
      </script>
    </body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Meta OAuth - step 3 (only when multiple ad accounts): save the chosen account
app.get('/auth/meta/select-account', async (req, res) => {
  const { shop, account_id, account_name, token, expires_at } = req.query;
  if (!shop || !account_id || !token) return res.status(400).json({ error: 'Missing parameters' });
  try {
    await pool.query(`
      INSERT INTO meta_accounts (shop, access_token, ad_account_id, ad_account_name, token_expires_at, connected_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (shop) DO UPDATE SET access_token=EXCLUDED.access_token, ad_account_id=EXCLUDED.ad_account_id, ad_account_name=EXCLUDED.ad_account_name, token_expires_at=EXCLUDED.token_expires_at, connected_at=NOW()
    `, [shop, token, account_id, account_name || '', expires_at]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Meta status - is it connected, expiring soon?
app.get('/meta-status', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.json({ connected: false });
  try {
    const result = await pool.query('SELECT ad_account_id, ad_account_name, token_expires_at FROM meta_accounts WHERE shop=$1', [shop]);
    if (result.rows.length === 0) return res.json({ connected: false });
    const row = result.rows[0];
    res.json({ connected: true, adAccountId: row.ad_account_id, adAccountName: row.ad_account_name, expiresAt: row.token_expires_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Disconnect Meta
app.post('/meta-disconnect', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await pool.query('DELETE FROM meta_accounts WHERE shop=$1', [shop]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Daily spend from Meta, server-side (no token exposed to frontend)
app.get('/meta-spend', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { since, until } = req.query;
  if (!since || !until) return res.status(400).json({ error: 'Missing since/until' });
  try {
    const result = await pool.query('SELECT access_token, ad_account_id, token_expires_at FROM meta_accounts WHERE shop=$1', [shop]);
    if (result.rows.length === 0) return res.json({ total: 0, connected: false });
    const { access_token, ad_account_id, token_expires_at } = result.rows[0];

    if (token_expires_at && new Date(token_expires_at) < new Date()) {
      return res.json({ total: 0, connected: true, expired: true, error: 'Meta-tokenet har gått ut. Återanslut.' });
    }

    // since/until are already plain YYYY-MM-DD strings in the shop's local calendar days,
    // exactly as Meta's time_range expects (both inclusive) - no timezone conversion needed here.
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const insights = await httpsGetJson('graph.facebook.com', `/v19.0/${ad_account_id}/insights?fields=spend&time_range=${timeRange}&time_increment=1&access_token=${access_token}`);

    if (insights.error) {
      return res.json({ total: 0, connected: true, error: insights.error.message });
    }
    const days = insights.data || [];
    const total = days.reduce((sum, d) => sum + (parseFloat(d.spend) || 0), 0);
    res.json({ total, connected: true, days });
  } catch(e) { res.json({ total: 0, error: e.message }); }
});

// Sync all orders from Shopify to DB
async function syncAllOrders(shop, token) {
  console.log('Starting sync for', shop);
  let sinceId = null, total = 0;
  try {
    while (true) {
      let path;
      if (sinceId) {
        path = '/admin/api/2024-01/orders.json?status=any&limit=250&order=id+asc&since_id=' + sinceId;
      } else {
        path = '/admin/api/2024-01/orders.json?status=any&limit=250&order=id+asc&created_at_min=2020-01-01T00:00:00Z';
      }
      const { body } = await shopifyGet(shop, token, path);
      const data = JSON.parse(body);
      const orders = data.orders || [];
      if (orders.length === 0) break;
      await upsertOrders(shop, orders);
      total += orders.length;
      sinceId = orders[orders.length - 1].id;
      console.log(`Synced ${total} orders for ${shop}`);
      await pool.query('INSERT INTO sync_status (shop, last_synced_at, total_orders) VALUES ($1, NOW(), $2) ON CONFLICT (shop) DO UPDATE SET last_synced_at=NOW(), total_orders=$2', [shop, total]);
      if (orders.length < 250) break;
    }
    console.log('Sync complete for', shop, '- total:', total);
  } catch(e) { console.error('Sync error:', e.message); }
}

async function upsertOrders(shop, orders) {
  for (const o of orders) {
    // IMPORTANT: don't use `parseFloat(x) || fallback` here - 0 is a legitimate, correct value
    // (e.g. a fully refunded order has current_total_tax=0), but 0 is falsy in JS, so `||` would
    // silently replace it with the fallback. This caused fully-refunded orders to keep their
    // stale pre-refund tax value forever, even after a full re-sync. Check for null/undefined
    // explicitly instead.
    const totalTax = o.total_tax !== null && o.total_tax !== undefined ? parseFloat(o.total_tax) : 0;
    const currentTotalTax = o.current_total_tax !== null && o.current_total_tax !== undefined ? parseFloat(o.current_total_tax) : totalTax;
    await pool.query(`
      INSERT INTO orders (id, shop, email, financial_status, created_at, processed_at, current_total_price, total_price, total_tax, current_total_tax, line_items, refunds, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (id) DO UPDATE SET
        financial_status=EXCLUDED.financial_status,
        current_total_price=EXCLUDED.current_total_price,
        total_price=EXCLUDED.total_price,
        total_tax=EXCLUDED.total_tax,
        current_total_tax=EXCLUDED.current_total_tax,
        line_items=EXCLUDED.line_items,
        refunds=EXCLUDED.refunds,
        synced_at=NOW()
    `, [o.id, shop, o.email, o.financial_status, o.created_at, o.processed_at||o.created_at,
        parseFloat(o.current_total_price)||0, parseFloat(o.total_price)||0,
        totalTax, currentTotalTax,
        JSON.stringify(o.line_items||[]), JSON.stringify(o.refunds||[])]);
  }
}

// Get orders from DB
app.get('/orders', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, email, financial_status, created_at, processed_at, current_total_price, total_price, total_tax, current_total_tax, line_items, refunds
       FROM orders WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    res.json({ orders: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get refunds from DB for a period
app.get('/refunds', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  try {
    // Fetch ALL orders with refunds - refund may be on order from different date
    const result = await pool.query(
      `SELECT refunds, created_at, processed_at FROM orders WHERE shop=$1 AND refunds != '[]'::jsonb`,
      [shop]
    );
    let total = 0;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    result.rows.forEach(row => {
      (row.refunds || []).forEach(r => {
        const rDate = new Date(r.created_at);
        if (rDate >= fromDate && rDate < toDate) {
          // Sum refund_line_items (product refunds)
          (r.refund_line_items || []).forEach(li => {
            total += parseFloat(li.subtotal) || 0;
          });
          // Sum order_adjustments
          (r.order_adjustments || []).forEach(adj => {
            if (adj.kind === 'shipping_refund') {
              total += Math.abs(parseFloat(adj.amount) || 0);
            } else if (adj.kind === 'refund_discrepancy') {
              const reason = adj.reason || '';
              if (!reason.includes('Pending')) {
                const amt = parseFloat(adj.amount) || 0;
                if (amt < 0) total += Math.abs(amt);
              }
            }
          });
        }
      });
    });
    res.json({ total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Debug endpoint to inspect refund structure
app.get('/refunds-debug', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const { from, to } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, refunds, created_at, processed_at FROM orders WHERE shop=$1 AND refunds != '[]'::jsonb`,
      [shop]
    );
    const fromDate = from ? new Date(from) : new Date('2026-06-10T22:00:00Z');
    const toDate = to ? new Date(to) : new Date('2026-06-12T22:00:00Z');
    const matches = [];
    result.rows.forEach(row => {
      (row.refunds || []).forEach(r => {
        const rDate = new Date(r.created_at);
        if (rDate >= fromDate && rDate < toDate) {
          matches.push({ order_id: row.id, created_at: r.created_at, refund_line_items: r.refund_line_items, order_adjustments: r.order_adjustments, transactions: r.transactions });
        }
      });
    });
    res.json(matches);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Transaction fees from Shopify Payments balance transactions.
// Uses /shopify_payments/balance/transactions.json which has a per-transaction fee
// tied to the order's own transaction date (processed_at), avoiding the payout-timing
// mismatch where a fee could land in a different period than the sale it belongs to.
// Shopify's own date_min/date_max filters on this endpoint are unreliable, so we fetch
// everything (paginated) and filter by processed_at ourselves, same pattern as /refunds.
// TEMPORARY DEBUG endpoint - shows raw balance transaction data for inspection.
// Remove once the transaction-fees discrepancy is resolved.
// TEMPORARY DEBUG endpoint - inspect total_tax values for a date range.
// TEMPORARY DEBUG endpoint - inspect line_items + discount_allocations for VAT fallback debugging.
// TEMPORARY DEBUG endpoint - inspect a single order by ID, both from DB and fresh from Shopify.
// TEMPORARY DEBUG endpoint - find an order by its visible order number (e.g. 12443 for #12443).
// TEMPORARY DEBUG endpoint - sum quantity for a specific product_id across a date range,
// listing every order that contributes, to find where an extra/missing unit comes from.
// TEMPORARY DEBUG endpoint - compare every order in a date range between our DB and
// live Shopify data, to find which specific order(s) have drifted out of sync.
// TEMPORARY DEBUG endpoint - list every order in a range with financial_status, to spot
// statuses (voided/pending/refunded) that might explain why a sum differs from another tool.
// TEMPORARY DEBUG endpoint - per-day revenue breakdown over a date range, to spot which
// specific days diverge and by how much, plus status breakdown per day.
// TEMPORARY DEBUG endpoint - VAT per day using the same date-cutoff logic as the frontend,
// to narrow down which specific day the remaining small discrepancy comes from.
// TEMPORARY DEBUG endpoint - find refunds PROCESSED within a date range, regardless of the
// original order's date. Tests the hypothesis that a refund on an order from a different day
// was processed on the day in question, which could explain a Shopify report attributing tax
// adjustments to the refund's processing date rather than the order's date.
// TEMPORARY DEBUG endpoint - list every individual order for a day with its VAT classification
// and contribution, to find exactly where a day-level sum discrepancy comes from.
// TEMPORARY DEBUG endpoint - fetch FRESH data directly from Shopify for orders in a date
// range and compare total_price sums against our database, to catch sync staleness affecting
// the revenue base itself (not just tax fields).
// TEMPORARY DEBUG endpoint - look up a list of order NUMBERS (e.g. 12397,12389,...) and show
// their tax-related fields, for easy comparison against a list the user already has.
app.get('/debug-orders-by-numbers', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { numbers } = req.query;
  if (!numbers) return res.status(400).json({ error: 'Missing numbers (comma-separated)' });
  const numberList = numbers.split(',').map(n => n.trim()).filter(Boolean);
  try {
    const results = [];
    let sumTotalPrice = 0, sumTax = 0;
    for (const num of numberList) {
      const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + num)}&status=any`);
      let data;
      try { data = JSON.parse(body); } catch(e) { continue; }
      const order = (data.orders || [])[0];
      if (!order) { results.push({ number: num, found: false }); continue; }
      const tax = parseFloat(order.current_total_tax !== undefined && order.current_total_tax !== null ? order.current_total_tax : order.total_tax) || 0;
      sumTotalPrice += parseFloat(order.total_price) || 0;
      sumTax += tax;
      results.push({ number: num, found: true, id: order.id, processed_at: order.processed_at, total_price: order.total_price, total_tax: order.total_tax, current_total_tax: order.current_total_tax, financial_status: order.financial_status });
    }
    res.json({ count: results.length, sumTotalPrice: sumTotalPrice.toFixed(2), sumTax: sumTax.toFixed(2), expectedVatAt25pct: (sumTotalPrice*(25/125)).toFixed(2), orders: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-fresh-vs-db', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const dbResult = await pool.query(
      `SELECT id, processed_at, total_price, total_tax, current_total_tax FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    let dbSum = 0, freshSum = 0;
    const diffs = [];
    for (const row of dbResult.rows) {
      dbSum += parseFloat(row.total_price) || 0;
      const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${row.id}.json?fields=id,total_price,current_total_price,total_tax,current_total_tax,financial_status`);
      let fresh;
      try { fresh = JSON.parse(body).order; } catch(e) { fresh = null; }
      if (fresh) {
        freshSum += parseFloat(fresh.total_price) || 0;
        if (parseFloat(fresh.total_price) !== parseFloat(row.total_price) || parseFloat(fresh.current_total_tax) !== parseFloat(row.current_total_tax)) {
          diffs.push({ id: row.id, db_total_price: row.total_price, fresh_total_price: fresh.total_price, db_current_total_tax: row.current_total_tax, fresh_current_total_tax: fresh.current_total_tax, fresh_financial_status: fresh.financial_status });
        }
      }
    }
    res.json({ orderCount: dbResult.rows.length, dbSum: dbSum.toFixed(2), freshSum: freshSum.toFixed(2), diffCount: diffs.length, diffs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-vat-detail', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  const SHOPIFY_TAX_CUTOFF = new Date('2026-06-13T15:00:00.000Z');
  const DEFAULT_VAT = 25;
  try {
    const result = await pool.query(
      `SELECT id, processed_at, total_price, total_tax, current_total_tax FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    let sumExact = 0, sumFallback = 0, sumFallbackRevenue = 0;
    const orders = result.rows.map(r => {
      const orderDate = new Date(r.processed_at);
      const hasShopifyTax = orderDate >= SHOPIFY_TAX_CUTOFF;
      const orderTax = parseFloat(r.current_total_tax !== null && r.current_total_tax !== undefined ? r.current_total_tax : r.total_tax);
      const price = parseFloat(r.total_price) || 0;
      let usedTax, method;
      if (hasShopifyTax && !isNaN(orderTax)) { usedTax = orderTax; method = 'exact'; sumExact += usedTax; }
      else { usedTax = price * (DEFAULT_VAT / (100 + DEFAULT_VAT)); method = 'fallback'; sumFallback += usedTax; sumFallbackRevenue += price; }
      return { id: r.id, processed_at: r.processed_at, total_price: r.total_price, total_tax: r.total_tax, current_total_tax: r.current_total_tax, method, usedTax: usedTax.toFixed(2) };
    });
    res.json({ count: orders.length, sumExact: sumExact.toFixed(2), sumFallback: sumFallback.toFixed(2), sumFallbackRevenue: sumFallbackRevenue.toFixed(2), grandTotal: (sumExact+sumFallback).toFixed(2), orders });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-refunds-processed-on', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    // Scan ALL orders with any refund (not just ones whose processed_at falls in range),
    // then filter by the refund's own processed_at timestamp.
    const result = await pool.query(`SELECT id, processed_at, total_price, total_tax, current_total_tax, refunds FROM orders WHERE shop=$1 AND refunds != '[]'::jsonb`, [shop]);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const matches = [];
    result.rows.forEach(row => {
      const refunds = typeof row.refunds === 'string' ? JSON.parse(row.refunds) : row.refunds;
      (refunds || []).forEach(r => {
        const rDate = new Date(r.processed_at);
        if (rDate >= fromDate && rDate < toDate) {
          const taxAdjustments = (r.order_adjustments || []).reduce((s, a) => s + (parseFloat(a.tax_amount) || 0), 0);
          matches.push({ order_id: row.id, order_processed_at: row.processed_at, refund_processed_at: r.processed_at, order_total_tax: row.total_tax, order_current_total_tax: row.current_total_tax, refund_tax_adjustments: taxAdjustments.toFixed(2) });
        }
      });
    });
    res.json({ count: matches.length, matches });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-vat-by-day', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  const SHOPIFY_TAX_CUTOFF = new Date('2026-06-13T15:00:00.000Z'); // 13 June 17:00 Stockholm
  const DEFAULT_VAT = 25;
  try {
    const result = await pool.query(
      `SELECT id, processed_at, total_price, total_tax, current_total_tax FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    const byDay = {};
    result.rows.forEach(r => {
      const localDate = new Date(new Date(r.processed_at).toLocaleString('en-US', { timeZone: 'Europe/Stockholm' }));
      const dayKey = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
      if (!byDay[dayKey]) byDay[dayKey] = { exactCount: 0, fallbackCount: 0, vatSum: 0 };
      const orderDate = new Date(r.processed_at);
      const hasShopifyTax = orderDate >= SHOPIFY_TAX_CUTOFF;
      const orderTax = parseFloat(r.current_total_tax !== null && r.current_total_tax !== undefined ? r.current_total_tax : r.total_tax);
      const price = parseFloat(r.total_price) || 0;
      if (hasShopifyTax && !isNaN(orderTax)) {
        byDay[dayKey].vatSum += orderTax;
        byDay[dayKey].exactCount++;
      } else {
        byDay[dayKey].vatSum += price * (DEFAULT_VAT / (100 + DEFAULT_VAT));
        byDay[dayKey].fallbackCount++;
      }
    });
    Object.keys(byDay).forEach(k => { byDay[k].vatSum = byDay[k].vatSum.toFixed(2); });
    res.json({ totalOrders: result.rows.length, byDay });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-revenue-by-day', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, financial_status, total_price, current_total_price FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    // Group by Stockholm-local calendar day
    const byDay = {};
    result.rows.forEach(r => {
      const localDate = new Date(r.processed_at).toLocaleString('en-US', { timeZone: 'Europe/Stockholm' });
      const d = new Date(localDate);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!byDay[dayKey]) byDay[dayKey] = { count: 0, sumTotalPrice: 0, sumCurrentTotalPrice: 0, statuses: {}, orderIds: [] };
      byDay[dayKey].count++;
      byDay[dayKey].sumTotalPrice += parseFloat(r.total_price) || 0;
      byDay[dayKey].sumCurrentTotalPrice += parseFloat(r.current_total_price) || 0;
      byDay[dayKey].statuses[r.financial_status] = (byDay[dayKey].statuses[r.financial_status] || 0) + 1;
      byDay[dayKey].orderIds.push(r.id);
    });
    Object.keys(byDay).forEach(k => {
      byDay[k].sumTotalPrice = byDay[k].sumTotalPrice.toFixed(2);
      byDay[k].sumCurrentTotalPrice = byDay[k].sumCurrentTotalPrice.toFixed(2);
    });
    res.json({ totalOrders: result.rows.length, byDay });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY DEBUG endpoint - for each order in a date range, fetch its transactions and compare
// the sum of successful charges against total_price. Finds orders where a post-purchase upsell
// (e.g. via Kaching/ReConvert) went to partially_paid and auto-voided after ~10 minutes, but
// total_price on the order was never corrected down to match what was actually paid.
app.get('/debug-orders-vs-transactions', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const dbResult = await pool.query(
      `SELECT id, processed_at, total_price, financial_status FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    const diffs = [];
    for (const row of dbResult.rows) {
      await new Promise(r => setTimeout(r, 250)); // small delay between calls to avoid rate limiting
      const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${row.id}/transactions.json`);
      let data;
      try { data = JSON.parse(body); } catch(e) { diffs.push({ id: row.id, error: 'JSON parse failed', raw: body.slice(0,200) }); continue; }
      if (data.errors) { diffs.push({ id: row.id, error: 'Shopify API error', detail: data.errors }); continue; }
      const txs = data.transactions || [];
      if (txs.length === 0) { diffs.push({ id: row.id, error: 'No transactions returned', raw_keys: Object.keys(data) }); continue; }
      // Sum successful sale/capture amounts minus successful refunds, to get net paid amount.
      let netPaid = 0;
      txs.forEach(t => {
        if (t.status !== 'success') return;
        const amt = parseFloat(t.amount) || 0;
        if (t.kind === 'sale' || t.kind === 'capture') netPaid += amt;
        else if (t.kind === 'refund') netPaid -= amt;
        else if (t.kind === 'void') { /* voided authorization - contributes 0, never captured */ }
      });
      const totalPrice = parseFloat(row.total_price) || 0;
      if (Math.abs(totalPrice - netPaid) > 0.01) {
        diffs.push({ id: row.id, processed_at: row.processed_at, financial_status: row.financial_status, total_price: totalPrice.toFixed(2), netPaidFromTransactions: netPaid.toFixed(2), diff: (totalPrice - netPaid).toFixed(2), transactions: txs.map(t => ({ kind: t.kind, status: t.status, amount: t.amount })) });
      }
    }
    res.json({ orderCount: dbResult.rows.length, diffCount: diffs.length, diffs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-order-statuses', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, financial_status, total_price, current_total_price FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    const sumTotalPrice = result.rows.reduce((s, r) => s + (parseFloat(r.total_price) || 0), 0);
    const sumCurrentTotalPrice = result.rows.reduce((s, r) => s + (parseFloat(r.current_total_price) || 0), 0);
    const byStatus = {};
    result.rows.forEach(r => {
      byStatus[r.financial_status] = (byStatus[r.financial_status] || { count: 0, sum: 0 });
      byStatus[r.financial_status].count++;
      byStatus[r.financial_status].sum += parseFloat(r.total_price) || 0;
    });
    res.json({ count: result.rows.length, sumTotalPrice: sumTotalPrice.toFixed(2), sumCurrentTotalPrice: sumCurrentTotalPrice.toFixed(2), byStatus, orders: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-compare-orders', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const dbResult = await pool.query(
      `SELECT id, processed_at, total_price, total_tax, current_total_tax, financial_status FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    const dbOrders = {};
    dbResult.rows.forEach(r => { dbOrders[r.id] = r; });

    // Fetch the same window fresh from Shopify using created_at_min/max (status=any to include all)
    const dateMin = new Date(from).toISOString();
    const dateMax = new Date(to).toISOString();
    let sinceId = null, first = true;
    const shopifyOrders = {};
    while (first || sinceId) {
      first = false;
      let path = `/admin/api/2024-01/orders.json?status=any&limit=250&order=id+asc&processed_at_min=${dateMin}&processed_at_max=${dateMax}`;
      if (sinceId) path += `&since_id=${sinceId}`;
      const { body } = await shopifyGet(shop, token, path);
      let data;
      try { data = JSON.parse(body); } catch(e) { break; }
      const orders = data.orders || [];
      if (orders.length === 0) break;
      orders.forEach(o => { shopifyOrders[o.id] = o; });
      if (orders.length < 250) break;
      sinceId = orders[orders.length - 1].id;
    }

    const allIds = new Set([...Object.keys(dbOrders), ...Object.keys(shopifyOrders).map(String)]);
    const diffs = [];
    allIds.forEach(id => {
      const db = dbOrders[id];
      const sf = shopifyOrders[id];
      if (!db) { diffs.push({ id, issue: 'missing_in_db', shopify_total_price: sf?.total_price, shopify_processed_at: sf?.processed_at }); return; }
      if (!sf) { diffs.push({ id, issue: 'missing_in_shopify_for_this_window', db_total_price: db.total_price, db_processed_at: db.processed_at }); return; }
      if (parseFloat(db.total_price) !== parseFloat(sf.total_price)) {
        diffs.push({ id, issue: 'total_price_mismatch', db_total_price: db.total_price, shopify_total_price: sf.total_price, db_processed_at: db.processed_at, shopify_processed_at: sf.processed_at, financial_status: sf.financial_status });
      }
    });

    res.json({ dbCount: dbResult.rows.length, shopifyCount: Object.keys(shopifyOrders).length, diffCount: diffs.length, diffs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-product-qty', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to, product_id } = req.query;
  if (!from || !to || !product_id) return res.status(400).json({ error: 'Missing from/to/product_id' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, financial_status, total_price, line_items, refunds FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    let totalQty = 0;
    let totalRefundedQty = 0;
    const contributingOrders = [];
    result.rows.forEach(row => {
      const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
      const refunds = typeof row.refunds === 'string' ? JSON.parse(row.refunds) : row.refunds;
      (items || []).forEach(li => {
        if (String(li.product_id) === String(product_id)) {
          totalQty += li.quantity;
          contributingOrders.push({ order_id: row.id, processed_at: row.processed_at, financial_status: row.financial_status, quantity: li.quantity, variant_id: li.variant_id, variant_title: li.variant_title });
        }
      });
      (refunds || []).forEach(r => {
        (r.refund_line_items || []).forEach(rli => {
          if (rli.line_item && String(rli.line_item.product_id) === String(product_id)) {
            totalRefundedQty += rli.quantity;
          }
        });
      });
    });
    res.json({ totalQty, totalRefundedQty, netQty: totalQty - totalRefundedQty, orderCount: contributingOrders.length, contributingOrders });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-order-by-number/:number', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const number = req.params.number;
  try {
    const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + number)}&status=any`);
    let data;
    try { data = JSON.parse(body); } catch(e) { return res.json({ error: 'parse error', raw: body.slice(0,300) }); }
    const orders = data.orders || [];
    if (orders.length === 0) return res.json({ found: false });
    const o = orders[0];
    const dbResult = await pool.query('SELECT id, processed_at, total_price, current_total_price, total_tax, current_total_tax, line_items, refunds FROM orders WHERE id=$1 AND shop=$2', [o.id, shop]);
    const dbOrder = dbResult.rows[0] || null;
    res.json({
      shopify_id: o.id,
      shopify: { processed_at: o.processed_at, created_at: o.created_at, total_price: o.total_price, current_total_price: o.current_total_price, total_tax: o.total_tax, current_total_tax: o.current_total_tax, refunds: o.refunds },
      db: dbOrder ? { ...dbOrder, line_items: typeof dbOrder.line_items === 'string' ? JSON.parse(dbOrder.line_items) : dbOrder.line_items } : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-order/:id', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const orderId = req.params.id;
  try {
    const dbResult = await pool.query('SELECT id, processed_at, created_at, total_price, total_tax, line_items, refunds FROM orders WHERE id=$1 AND shop=$2', [orderId, shop]);
    const dbOrder = dbResult.rows[0] || null;

    const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${orderId}.json`);
    let shopifyOrder;
    try { shopifyOrder = JSON.parse(body); } catch(e) { shopifyOrder = { error: 'Could not parse', raw: body.slice(0, 500) }; }

    res.json({
      db: dbOrder ? { ...dbOrder, line_items: typeof dbOrder.line_items === 'string' ? JSON.parse(dbOrder.line_items) : dbOrder.line_items } : null,
      shopify: shopifyOrder.order ? { id: shopifyOrder.order.id, processed_at: shopifyOrder.order.processed_at, created_at: shopifyOrder.order.created_at, total_price: shopifyOrder.order.total_price, line_items: shopifyOrder.order.line_items, refunds: shopifyOrder.order.refunds } : shopifyOrder
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-line-items', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, total_price, total_tax, line_items FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    let sumLinePrice = 0, sumDiscount = 0, sumTotalPrice = 0;
    const orders = result.rows.map(row => {
      const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
      const lines = (items || []).map(li => {
        const lineGross = parseFloat(li.price) * li.quantity;
        const discAlloc = (li.discount_allocations || []).reduce((s, da) => s + (parseFloat(da.amount) || 0), 0);
        const totalDiscField = parseFloat(li.total_discount) || 0;
        sumLinePrice += lineGross;
        sumDiscount += discAlloc;
        return { title: li.title, price: li.price, quantity: li.quantity, lineGross, discount_allocations: li.discount_allocations, discAllocSum: discAlloc, total_discount_field: totalDiscField };
      });
      sumTotalPrice += parseFloat(row.total_price) || 0;
      return { id: row.id, total_price: row.total_price, total_tax: row.total_tax, lines };
    });
    res.json({ count: orders.length, sumLinePrice: sumLinePrice.toFixed(2), sumDiscount: sumDiscount.toFixed(2), sumTotalPrice: sumTotalPrice.toFixed(2), lineMinusDiscount: (sumLinePrice - sumDiscount).toFixed(2), orders });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY DEBUG endpoint - sum total_tax grouped by financial_status and test-order flag,
// to find which order(s) Shopify's own sales_taxes report excludes that we might be including.
// TEMPORARY DEBUG endpoint - find orders with a specific financial_status in a date range.
app.get('/debug-orders-by-status', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to, status } = req.query;
  if (!from || !to || !status) return res.status(400).json({ error: 'Missing from/to/status' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, financial_status, total_price, current_total_price, total_tax, current_total_tax, refunds FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3 AND financial_status=$4
       ORDER BY processed_at ASC`,
      [shop, from, to, status]
    );
    // Also fetch fresh data from Shopify for each matching order to compare.
    const enriched = [];
    for (const row of result.rows) {
      const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${row.id}.json?fields=id,financial_status,total_price,current_total_price,total_tax,current_total_tax,refunds`);
      let fresh;
      try { fresh = JSON.parse(body).order; } catch(e) { fresh = { error: 'parse error' }; }
      enriched.push({ db: row, shopify_fresh: fresh });
    }
    res.json({ count: result.rows.length, orders: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY DEBUG endpoint - test shopifyqlQuery access via GraphQL Admin API, to see if the
// read_reports scope + protected customer data access actually works for our own store.
// Fetches sales_taxes directly from Shopify's own ShopifyQL reporting engine for a date range,
// grouped by day. This is the SAME data source Shopify's own "Taxes" report and TrueProfit use,
// so it correctly includes retroactive tax adjustments (e.g. from editing an old order after
// Shopify Tax was enabled) attributed to the day they were posted - which a pure orders.json
// based calculation can never see, since it only knows about each order's own date.
app.get('/shopify-sales-taxes', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { since, until } = req.query; // expects YYYY-MM-DD local dates, both inclusive
  if (!since || !until) return res.status(400).json({ error: 'Missing since/until (YYYY-MM-DD)' });
  try {
    const ql = `FROM sales_taxes SHOW sales_taxes GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day ASC`;
    const query = `query { shopifyqlQuery(query: ${JSON.stringify(ql)}) { tableData { columns { name dataType displayName } rows } parseErrors } }`;
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ query });
      const options = { hostname: shop, path: '/admin/api/2026-04/graphql.json', method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
      const r = https.request(options, resp => { let raw=''; resp.on('data',c=>raw+=c); resp.on('end',()=>resolve(raw)); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
    let data;
    try { data = JSON.parse(result); } catch(e) { return res.json({ error: 'parse error', raw: result.slice(0,500) }); }
    if (data.errors) return res.json({ error: data.errors });
    const tableData = data.data && data.data.shopifyqlQuery && data.data.shopifyqlQuery.tableData;
    if (!tableData) return res.json({ error: 'No table data', raw: data });
    const rows = tableData.rows || [];
    const total = rows.reduce((s, r) => s + (parseFloat(r.sales_taxes) || 0), 0);
    res.json({ total: total.toFixed(2), byDay: rows, parseErrors: data.data.shopifyqlQuery.parseErrors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-shopifyql-test', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const query = `query { shopifyqlQuery(query: "FROM sales_taxes SHOW sales_taxes SINCE -7d") { tableData { columns { name dataType displayName } rows } parseErrors } }`;
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ query });
      const options = { hostname: shop, path: '/admin/api/2026-04/graphql.json', method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
      const r = https.request(options, resp => { let raw=''; resp.on('data',c=>raw+=c); resp.on('end',()=>resolve(raw)); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
    let data;
    try { data = JSON.parse(result); } catch(e) { return res.json({ error: 'parse error', raw: result.slice(0,500) }); }
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-tax-by-status', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, financial_status, total_price, total_tax, current_total_tax FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    let sumOurTax = 0;
    const byStatus = {};
    const orders = [];
    for (const row of result.rows) {
      const tax = parseFloat(row.current_total_tax !== null && row.current_total_tax !== undefined ? row.current_total_tax : row.total_tax) || 0;
      sumOurTax += tax;
      byStatus[row.financial_status] = (byStatus[row.financial_status] || { count: 0, taxSum: 0 });
      byStatus[row.financial_status].count++;
      byStatus[row.financial_status].taxSum += tax;
      orders.push({ id: row.id, processed_at: row.processed_at, financial_status: row.financial_status, total_price: row.total_price, total_tax: row.total_tax, current_total_tax: row.current_total_tax, used_tax: tax });
    }
    // Cross-check a sample of orders against live Shopify to see if any are flagged test orders
    // (test orders are excluded from Shopify's own sales reports but may still be in our DB).
    let testOrderTaxSum = 0;
    const testOrders = [];
    for (const o of orders) {
      try {
        const { body } = await shopifyGet(shop, token, `/admin/api/2024-01/orders/${o.id}.json?fields=id,test,total_tax,current_total_tax`);
        const data = JSON.parse(body);
        if (data.order && data.order.test) {
          testOrderTaxSum += o.used_tax;
          testOrders.push({ id: o.id, used_tax: o.used_tax });
        }
      } catch(e) { /* skip on error */ }
    }
    Object.keys(byStatus).forEach(k => { byStatus[k].taxSum = byStatus[k].taxSum.toFixed(2); });
    res.json({ sumOurTax: sumOurTax.toFixed(2), byStatus, testOrderCount: testOrders.length, testOrderTaxSum: testOrderTaxSum.toFixed(2), testOrders, orderCount: orders.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-orders-tax', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const result = await pool.query(
      `SELECT id, processed_at, total_price, current_total_price, total_tax, current_total_tax FROM orders
       WHERE shop=$1 AND processed_at >= $2 AND processed_at < $3
       ORDER BY processed_at ASC`,
      [shop, from, to]
    );
    res.json({ count: result.rows.length, orders: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-balance-tx', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const matches = [];
    let pageInfo = null, first = true, pages = 0;
    while ((first || pageInfo) && pages < 40) {
      first = false;
      let path = `/admin/api/2024-01/shopify_payments/balance/transactions.json?limit=250`;
      if (pageInfo) path += `&page_info=${pageInfo}`;
      const { body, link } = await shopifyGet(shop, token, path);
      let data;
      try { data = JSON.parse(body); } catch(e) { break; }
      if (data.errors) return res.json({ error: data.errors });
      const txs = data.transactions || [];
      if (txs.length === 0) break;
      let allOlder = true;
      for (const t of txs) {
        const pa = new Date(t.processed_at);
        if (pa >= fromDate && pa < toDate) {
          matches.push({ id: t.id, type: t.type, amount: t.amount, fee: t.fee, net: t.net, processed_at: t.processed_at, source_order_id: t.source_order_id, currency: t.currency, payout_status: t.payout_status });
        }
        if (pa >= fromDate) allOlder = false;
      }
      pages++;
      if (allOlder) break;
      const nm = link.match(/page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      pageInfo = nm ? nm[1] : null;
    }
    const feeSum = matches.reduce((s, m) => s + (parseFloat(m.fee) || 0), 0);
    res.json({ count: matches.length, feeSum: feeSum.toFixed(2), transactions: matches });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/transaction-fees', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });
  try {
    // from/to are exact UTC timestamps (ISO 8601, same as /orders uses against Postgres
    // TIMESTAMPTZ). A direct timestamp comparison is timezone-safe by construction - no
    // local-date conversion needed, since processed_at from Shopify is also an exact instant.
    const fromDate = new Date(from);
    const toDate = new Date(to);
    let total = 0;
    let pageInfo = null;
    let first = true;
    let pages = 0;
    const MAX_PAGES = 40; // safety cap (250 per page = up to 10,000 transactions scanned)

    while (first || pageInfo) {
      first = false;
      let path = `/admin/api/2024-01/shopify_payments/balance/transactions.json?limit=250`;
      if (pageInfo) path = `/admin/api/2024-01/shopify_payments/balance/transactions.json?limit=250&page_info=${pageInfo}`;
      const { body, link } = await shopifyGet(shop, token, path);
      let data;
      try { data = JSON.parse(body); } catch(e) { break; }
      if (data.errors) {
        console.log('Balance transactions API error:', data.errors);
        return res.json({ total: 0, error: JSON.stringify(data.errors) });
      }
      const txs = data.transactions || [];
      if (txs.length === 0) break;

      // List is ordered newest-first by processing time. We scan the whole page (rather
      // than break on the first out-of-range item) since ordering edge cases could exist,
      // but we stop requesting further pages once an entire page is older than 'from'.
      let allOlderThanFrom = true;
      for (const t of txs) {
        const processedAt = new Date(t.processed_at);
        if (processedAt >= fromDate && processedAt < toDate) {
          // fee is the amount Shopify Payments charged for this transaction.
          // For debit (sale) transactions this is positive; for refund-related entries
          // the fee may be returned (negative) - summing as-is gives the correct net fee.
          total += parseFloat(t.fee) || 0;
        }
        if (processedAt >= fromDate) allOlderThanFrom = false;
      }

      pages++;
      if (pages >= MAX_PAGES) { res.json({ total: Math.abs(total), incomplete: true, error: 'Nådde maxgräns för sidor - resultatet kan vara inkomplett för långa perioder' }); return; }
      if (allOlderThanFrom) break; // remaining (older) pages can't contain anything newer
      const nm = link.match(/page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      pageInfo = nm ? nm[1] : null;
    }

    res.json({ total: Math.abs(total) });
  } catch(e) {
    console.error('Transaction fees error:', e.message);
    res.json({ total: 0, error: e.message });
  }
});


// Returns every unique product/variant that has ever appeared in a synced order's line_items,
// regardless of whether it still exists in Shopify today. Deleted variants are NOT available
// via Shopify's API anymore (Shopify only returns the ID for a deleted variant, nothing else),
// but our own database already has title/price/sku captured at sync time from each order's
// line_items, so we can reconstruct the full historical variant list without needing Shopify
// to still have the variant. This lets COGS be set for products/variants no longer sold.
app.get('/historical-variants', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query('SELECT line_items FROM orders WHERE shop=$1', [shop]);
    const variantsMap = {}; // key: 'v'+variant_id or 'p'+product_id (no variant) -> details
    result.rows.forEach(row => {
      const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
      (items || []).forEach(li => {
        if (!li.product_id) return;
        const key = li.variant_id ? 'v' + li.variant_id : 'p' + li.product_id;
        if (!variantsMap[key]) {
          variantsMap[key] = {
            key,
            product_id: li.product_id,
            variant_id: li.variant_id || null,
            product_title: li.title,
            variant_title: li.variant_title || null,
            sku: li.sku || null,
            last_price: li.price,
            order_count: 0
          };
        }
        variantsMap[key].order_count++;
        // Keep the most recent price seen, as a reasonable default reference (not authoritative).
        variantsMap[key].last_price = li.price;
      });
    });
    res.json({ variants: Object.values(variantsMap) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/sync-status', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query('SELECT * FROM sync_status WHERE shop=$1', [shop]);
    res.json(result.rows[0] || { shop, last_synced_at: null, total_orders: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delta sync - updates recently modified orders
async function syncRecentOrders(shop, token) {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  let pageInfo = null, first = true, total = 0;
  try {
    while (first || pageInfo) {
      first = false;
      let path = '/admin/api/2024-01/orders.json?status=any&limit=250&updated_at_min=' + since;
      if (pageInfo) path = '/admin/api/2024-01/orders.json?limit=250&page_info=' + pageInfo;
      const { body, link } = await shopifyGet(shop, token, path);
      const data = JSON.parse(body);
      const orders = data.orders || [];
      if (orders.length === 0) break;
      await upsertOrders(shop, orders);
      total += orders.length;
      const nm = link.match(/page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      pageInfo = nm ? nm[1] : null;
      if (orders.length < 250) break;
    }
    console.log('Delta sync complete - updated', total, 'orders');
  } catch(e) { console.error('Delta sync error:', e.message); }
}

// Run delta sync every 30 minutes
setInterval(() => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (shop && token) syncRecentOrders(shop, token);
}, 30 * 60 * 1000);

// Manual delta sync
app.post('/sync-recent', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  syncRecentOrders(shop, token);
  res.json({ message: 'Delta sync started' });
});

// Manual resync
app.post('/sync', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  syncAllOrders(shop, token);
  syncRecentOrders(shop, token);
  res.json({ message: 'Sync started' });
});

// Shopify proxy (still needed for products)
app.use('/shopify', (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const options = { hostname: shop, path: req.url, method: req.method, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } };
  let body = '';
  const proxyReq = https.request(options, proxyRes => {
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      try { const data = JSON.parse(body); if (proxyRes.headers['link']) data._link = proxyRes.headers['link']; res.status(proxyRes.statusCode).json(data); }
      catch(e) { res.status(proxyRes.statusCode).send(body); }
    });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

// Manual trigger for webhook registration - needed for shops that installed the app before
// webhooks were added to the OAuth flow (registerWebhooks only auto-runs on fresh installs).
app.post('/register-webhooks', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  await registerWebhooks(shop, token);
  res.json({ ok: true, message: 'Webhook registration attempted - check server logs for results' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', connectedShops: Object.keys(tokenStore) }));

// TEMPORARY DEBUG endpoint - list all currently registered webhook subscriptions on Shopify's
// side, so we can see exactly what's registered (address, topic, id) when diagnosing HMAC
// mismatches that persist despite a confirmed-correct, clean CLIENT_SECRET.
app.get('/debug-list-webhooks', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { body } = await shopifyGet(shop, token, '/admin/api/2024-01/webhooks.json?limit=250');
    const data = JSON.parse(body);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY DEBUG endpoint - delete ALL registered webhook subscriptions for this shop, then
// caller should hit /register-webhooks again to recreate them fresh. Used to rule out stale
// webhook subscriptions that may have been signed/registered against a previous secret.
app.post('/debug-delete-all-webhooks', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { body } = await shopifyGet(shop, token, '/admin/api/2024-01/webhooks.json?limit=250');
    const data = JSON.parse(body);
    const webhooks = data.webhooks || [];
    const results = [];
    for (const wh of webhooks) {
      try {
        await new Promise((resolve, reject) => {
          const options = { hostname: shop, path: `/admin/api/2024-01/webhooks/${wh.id}.json`, method: 'DELETE', headers: { 'X-Shopify-Access-Token': token } };
          const r = https.request(options, resp => { let raw=''; resp.on('data',c=>raw+=c); resp.on('end',()=>resolve(raw)); });
          r.on('error', reject);
          r.end();
        });
        results.push({ id: wh.id, topic: wh.topic, address: wh.address, deleted: true });
      } catch(e) { results.push({ id: wh.id, topic: wh.topic, deleted: false, error: e.message }); }
    }
    res.json({ deletedCount: results.filter(r => r.deleted).length, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function shopifyGet(hostname, token, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: { 'X-Shopify-Access-Token': token } };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ body: raw, link: res.headers['link'] || '' }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw)); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// GET request to any hostname, returns parsed JSON. Used for Meta Graph API calls.
function httpsGetJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET' };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid JSON from ' + hostname + path + ': ' + raw.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

initDB().then(loadTokensFromDB).then(() => {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}).catch(e => console.error('DB init failed:', e));
