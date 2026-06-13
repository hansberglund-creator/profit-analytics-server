const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

const SHOP = process.env.SHOPIFY_SHOP || 'grownatural.myshopify.com';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

app.use(cors({ origin: '*' }));
app.use(express.json());

// Shopify API proxy
app.use('/shopify', (req, res) => {
  if (!ACCESS_TOKEN) return res.status(401).json({ error: 'No access token configured' });

  const options = {
    hostname: SHOP,
    path: req.url,
    method: req.method,
    headers: {
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    const link = proxyRes.headers['link'];
    if (link) res.setHeader('link', link);
    res.setHeader('content-type', proxyRes.headers['content-type'] || 'application/json');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
  proxyReq.end();
});

// Meta API proxy
app.use('/meta', (req, res) => {
  const options = {
    hostname: 'graph.facebook.com',
    path: req.url,
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', shop: SHOP, tokenConfigured: !!ACCESS_TOKEN });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shop: ${SHOP}`);
  console.log(`Token configured: ${!!ACCESS_TOKEN}`);
});
