const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\n');
});

const staticOptions = {
  maxAge: '1d',
  etag: true,
  lastModified: true
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));

const activePeers = new Set();
const peerRoomLookup = new Map();

const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  allow_discovery: false
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  const id = client.getId();
  activePeers.add(id);

  const prefix = id.split('-')[0];
  if (!peerRoomLookup.has(prefix)) {
    peerRoomLookup.set(prefix, new Set());
  }
  peerRoomLookup.get(prefix).add(id);
});

peerServer.on('disconnect', (client) => {
  const id = client.getId();
  activePeers.delete(id);

  const prefix = id.split('-')[0];
  const roomSet = peerRoomLookup.get(prefix);
  if (roomSet) {
    roomSet.delete(id);
    if (roomSet.size === 0) {
      peerRoomLookup.delete(prefix);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at: http://localhost:${PORT}`);
});