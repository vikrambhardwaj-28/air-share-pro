const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

// 1. Crucial for Render / Reverse Proxy (Fixes WSS / HTTPS WebSocket drop)
app.enable('trust proxy');
app.disable('x-powered-by');

// 2. Global CORS & Security Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// SEO & Crawler Sitemap
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://airshare-pro.markiv.site/sitemap.xml\n');
});

// Health check endpoint (Render auto-sleep preventer)
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Static assets serving
const staticOptions = {
  maxAge: '1d',
  etag: true,
  lastModified: true
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));

// 3. High-Speed Cellular PeerServer Configuration
const peerServer = ExpressPeerServer(server, {
  debug: false,
  allow_discovery: true,
  alive_timeout: 45000,     // 45s heartbeat to keep cellular sockets alive
  key: 'peerjs',
  concurrent_limit: 5000
});

app.use('/peerjs', peerServer);

// Connection logging for easy debugging
peerServer.on('connection', (client) => {
  console.log(`[Peer Connected] ID: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[Peer Disconnected] ID: ${client.getId()}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Air Share Pro Conduit active on port ${PORT}`);
});