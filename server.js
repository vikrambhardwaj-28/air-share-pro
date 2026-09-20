import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

app.enable('trust proxy');
app.disable('x-powered-by');

app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nAllow: /\n'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/signal' });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function removeClient(ws) {
  if (!ws.room) return;
  const pin = ws.room;
  const clients = rooms.get(pin);
  if (clients) {
    clients.delete(ws);
    for (const peer of clients) {
      send(peer, { type: 'peer-left' });
    }
    if (clients.size === 0) {
      rooms.delete(pin);
    }
  }
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const pin = String(msg.pin || '').trim();
      if (!/^\d{6}$/.test(pin)) {
        return send(ws, { type: 'error', message: 'Valid 6-digit PIN enter karein.' });
      }

      removeClient(ws);

      let clients = rooms.get(pin);
      if (!clients) {
        clients = new Set();
        rooms.set(pin, clients);
      }

      if (clients.size >= 2) {
        return send(ws, { type: 'error', message: 'Is PIN par room already full hai.' });
      }

      ws.room = pin;
      clients.add(ws);

      const isInitiator = clients.size === 1;
      send(ws, { type: 'joined', initiator: isInitiator, pin });

      if (clients.size === 2) {
        for (const peer of clients) {
          send(peer, { type: 'peer-ready' });
        }
      }
      return;
    }

    if (['offer', 'answer', 'candidate', 'hangup'].includes(msg.type) && ws.room) {
      const clients = rooms.get(ws.room);
      if (clients) {
        for (const peer of clients) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(raw);
          }
        }
      }
    }
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Air Share Pro Conduit active on http://localhost:${PORT}`);
});