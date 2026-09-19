const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

// Static frontend files serve karne ke liye
app.use(express.static(path.join(__dirname, 'public')));

// WebRTC Signaling Server (Sirf handshake coordinate karta hai, data store nahi karta)
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[Peer Connected] ID: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[Peer Disconnected] ID: ${client.getId()}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SonicDrop server running at: http://localhost:${PORT}`);
});