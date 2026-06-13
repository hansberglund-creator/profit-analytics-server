const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '32e267c453b2a6fa1ae82f355d413b8e';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SCOPES = 'read_orders,read_products';
const BASE_URL = process.env.BASE_URL || 'https://profit-analytics-server-production.up.railway.app';

const tokenStore = {};

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${BASE_URL}/auth/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');
  try {
    const tokenRes = await httpsPost(shop, '/admin/oauth/access_token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code
    });
    const data = JSON.parse(tokenRes);
    if (!data.access_token) return res.status(400).send('No token: ' + JSON.stringify(data));
    tokenStore[shop] = data.access_token;
    console.log('Connected:', shop, 'Token:', data.access_token.substring(0,10)+'...');
    res.send(`<html><body style="background:#0f1117;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>✓ Ansluten!</h1><p style="color:#9ca3b8">Butik: ${shop}</p><p style="color:#9ca3b8">Token: ${data.access_token.substring(0,15)}...</p><p style="margin-top:20px;color:#6b7494">Du kan nu stänga den här fliken och öppna appen.</p></div></body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.use('/shopify', (req, res) => {
  const shop = req.headers['x-shop-url'] || Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: 'Not authenticated. Visit /auth?shop='+shop });

  const options = {
    hostname: shop,
    path: req.url,
    method: req.method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    if (proxyRes.headers['link']) res.setHeader('link', proxyRes.headers['link']);
    res.setHeader('content-type', proxyRes.headers['content-type'] || 'application/json');
    proxyRes.pipe(res);
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

app.get('/shop-timezone', async (req, res) => {
  const shop = Object.keys(tokenStore)[0];
  const token = tokenStore[shop];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await httpsGet(shop, '/admin/api/2024-01/shop.json', token);
    const shopData = JSON.parse(data);
    res.json({ timezone: shopData.shop?.iana_timezone || 'Europe/Stockholm' });
  } catch(e) {
    res.json({ timezone: 'Europe/Stockholm' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connectedShops: Object.keys(tokenStore) });
});

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: { 'X-Shopify-Access-Token': token } };
    const req = https.request(options, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw)); });
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

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
