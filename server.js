const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');

// Compression & Security headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://airshare-pro.markiv.site/sitemap.xml\n');
});

const staticOptions = {
  maxAge: '1d',
  etag: true,
  lastModified: true
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));

// High-performance PeerServer configuration with alive ping
const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  allow_discovery: true,
  alive_timeout: 60000,
  key: 'peerjs',
  concurrent_limit: 5000
});

app.use('/peerjs', peerServer);

const activePeers = new Set();

peerServer.on('connection', (client) => {
  const id = client.getId();
  activePeers.add(id);
});

peerServer.on('disconnect', (client) => {
  const id = client.getId();
  activePeers.delete(id);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Air Share Pro Conduit Active at: http://localhost:${PORT}`);
});