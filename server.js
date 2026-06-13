const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '32e267c453b2a6fa1ae82f355d413b8e';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SCOPES = 'read_orders,read_products';
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/auth/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001/app';

// Store tokens in memory (persists until server restart)
const tokenStore = {};

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname + '/public'));

// Step 1: Start OAuth – redirect browser to Shopify
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}&state=${state}`;
  res.redirect(authUrl);
});

// Step 2: Shopify redirects back here with a code
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');

  try {
    const tokenRes = await httpsPost(shop, '/admin/oauth/access_token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code
    });

    const data = JSON.parse(tokenRes);
    if (!data.access_token) return res.status(400).send('Failed to get token: ' + JSON.stringify(data));

    tokenStore[shop] = data.access_token;
    console.log('Connected shop:', shop);

    // Redirect to the app with shop info
    res.redirect(`${FRONTEND_URL}?shop=${shop}`);
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// Check if shop is connected
app.get('/auth/status', (req, res) => {
  const shop = req.query.shop;
  res.json({ connected: !!tokenStore[shop] });
});

// Shopify API proxy – uses stored token
app.use('/shopify', async (req, res) => {
  const shop = req.headers['x-shop-url'];
  const token = tokenStore[shop];
  if (!shop) return res.status(400).json({ error: 'Missing X-Shop-Url header' });
  if (!token) return res.status(401).json({ error: 'Shop not authenticated. Visit /auth?shop='+shop });

  const path = req.url;
  const options = {
    hostname: shop,
    path: path,
    method: req.method,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    const linkHeader = proxyRes.headers['link'];
    if (linkHeader) res.setHeader('link', linkHeader);
    res.setHeader('content-type', proxyRes.headers['content-type'] || 'application/json');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

// Meta API proxy
app.use('/meta', (req, res) => {
  const path = req.url;
  const options = {
    hostname: 'graph.facebook.com',
    path: path,
    method: req.method,
    headers: { 'Content-Type': 'application/json' }
  };
  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

app.get('/health', (req, res) => res.json({ status: 'ok', connectedShops: Object.keys(tokenStore) }));

// Helper: HTTPS POST
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

app.listen(PORT, () => {
  console.log(`\nProfit Analytics server running on http://localhost:${PORT}`);
  console.log(`\nTo connect your Shopify store, open this URL in your browser:`);
  console.log(`http://localhost:${PORT}/auth?shop=grownatural.myshopify.com\n`);
});
