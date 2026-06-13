const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '32e267c453b2a6fa1ae82f355d413b8e';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://profit-analytics-server-production.up.railway.app';
const TOKEN_FILE = '/tmp/tokens.json';
const SCOPES = 'read_orders,read_products';

// Load tokens from disk
let tokenStore = {};
try { tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch(e) {}

function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore)); } catch(e) {}
}

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${BASE_URL}/auth/callback`;
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');
  try {
    const data = JSON.parse(await httpsPost(shop, '/admin/oauth/access_token', { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }));
    if (!data.access_token) return res.status(400).send('No token received');
    tokenStore[shop] = data.access_token;
    saveTokens();
    res.send(`<html><body style="background:#0f1117;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h1>✓ Ansluten!</h1><p style="color:#9ca3b8;margin-top:12px">Stäng den här fliken och gå tillbaka till appen.</p></body></html>`);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

app.use('/shopify', (req, res) => {
  const shop = req.headers['x-shop-url'] || Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: 'Not authenticated', authUrl: `${BASE_URL}/auth?shop=${shop}` });

  const options = { hostname: shop, path: req.url, method: req.method, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } };
  const proxyReq = https.request(options, proxyRes => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Inject link header into response body so browser can access it
        if (proxyRes.headers['link']) {
          data._link = proxyRes.headers['link'];
        }
        res.status(proxyRes.statusCode).json(data);
      } catch(e) {
        res.status(proxyRes.statusCode).send(body);
      }
    });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

app.use('/meta', (req, res) => {
  const options = { hostname: 'graph.facebook.com', path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } };
  const proxyReq = https.request(options, proxyRes => { res.status(proxyRes.statusCode); proxyRes.pipe(res); });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

app.get('/health', (req, res) => res.json({ status: 'ok', connectedShops: Object.keys(tokenStore) }));

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

app.listen(PORT, () => console.log(`Server running on port ${PORT}, connected shops: ${Object.keys(tokenStore).join(', ') || 'none'}`));
