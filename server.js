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
const SCOPES = 'read_orders,read_products';
const TOKEN_FILE = '/tmp/tokens.json';

// Load tokens
let tokenStore = {};
try { tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch(e) {}
function saveTokens() { try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore)); } catch(e) {} }

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
      line_items JSONB,
      refunds JSONB,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop);
    CREATE INDEX IF NOT EXISTS idx_orders_processed_at ON orders(processed_at);
    CREATE TABLE IF NOT EXISTS sync_status (
      shop VARCHAR(255) PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      total_orders INT DEFAULT 0
    );
  `);
}

app.use(cors({ origin: '*' }));
app.use(express.json());

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
    res.send(`<html><body style="background:#0f1117;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h1>✓ Ansluten!</h1><p style="color:#9ca3b8;margin-top:12px">Synkar ordrar i bakgrunden. Stäng denna flik.</p></body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Sync all orders from Shopify to DB
async function syncAllOrders(shop, token) {
  console.log('Starting sync for', shop);
  let pageInfo = null, first = true, total = 0;
  try {
    while (first || pageInfo) {
      first = false;
      let path = '/admin/api/2024-01/orders.json?status=any&limit=250&order=created_at+asc';
      if (pageInfo) path = `/admin/api/2024-01/orders.json?limit=250&page_info=${pageInfo}`;
      const { body, link } = await shopifyGet(shop, token, path);
      const data = JSON.parse(body);
      const orders = data.orders || [];
      if (orders.length > 0) {
        await upsertOrders(shop, orders);
        total += orders.length;
        console.log(`Synced ${total} orders for ${shop}`);
        await pool.query('INSERT INTO sync_status (shop, last_synced_at, total_orders) VALUES ($1, NOW(), $2) ON CONFLICT (shop) DO UPDATE SET last_synced_at=NOW(), total_orders=$2', [shop, total]);
      }
      const nm = link.match(/page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      pageInfo = nm ? nm[1] : null;
      if (orders.length < 250) break;
    }
    console.log('Sync complete for', shop, '- total:', total);
  } catch(e) { console.error('Sync error:', e.message); }
}

async function upsertOrders(shop, orders) {
  for (const o of orders) {
    await pool.query(`
      INSERT INTO orders (id, shop, email, financial_status, created_at, processed_at, current_total_price, total_price, line_items, refunds, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (id) DO UPDATE SET
        financial_status=EXCLUDED.financial_status,
        current_total_price=EXCLUDED.current_total_price,
        total_price=EXCLUDED.total_price,
        line_items=EXCLUDED.line_items,
        refunds=EXCLUDED.refunds,
        synced_at=NOW()
    `, [o.id, shop, o.email, o.financial_status, o.created_at, o.processed_at||o.created_at,
        parseFloat(o.current_total_price)||0, parseFloat(o.total_price)||0,
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
      `SELECT id, email, financial_status, created_at, processed_at, current_total_price, total_price, line_items, refunds
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
    const result = await pool.query(
      `SELECT refunds FROM orders WHERE shop=$1 AND refunds != '[]'::jsonb`,
      [shop]
    );
    let total = 0;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    result.rows.forEach(row => {
      (row.refunds || []).forEach(r => {
        const rDate = new Date(r.created_at);
        if (rDate >= fromDate && rDate < toDate) {
          // Sum refund_line_items subtotal (product refunds)
          (r.refund_line_items || []).forEach(li => {
            total += parseFloat(li.subtotal) || 0;
          });
          // Sum shipping refunds from order_adjustments
          (r.order_adjustments || []).forEach(adj => {
            if (adj.kind === 'shipping_refund') {
              total += Math.abs(parseFloat(adj.amount) || 0);
            }
          });
        }
      });
    });
    res.json({ total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sync status
app.get('/sync-status', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  if (!shop) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query('SELECT * FROM sync_status WHERE shop=$1', [shop]);
    res.json(result.rows[0] || { shop, last_synced_at: null, total_orders: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual resync
app.post('/sync', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!shop || !token) return res.status(401).json({ error: 'Not authenticated' });
  syncAllOrders(shop, token);
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

app.use('/meta', (req, res) => {
  const options = { hostname: 'graph.facebook.com', path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } };
  const proxyReq = https.request(options, proxyRes => { proxyRes.pipe(res); });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

app.get('/health', (req, res) => res.json({ status: 'ok', connectedShops: Object.keys(tokenStore) }));

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

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
}).catch(e => console.error('DB init failed:', e));
