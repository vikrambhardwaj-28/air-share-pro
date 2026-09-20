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

// CORS & Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sitemap & Robots
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://airshare-pro.markiv.site/sitemap.xml\n');
});

// Render Keep-Alive / Health Check
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Static assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

// ==========================================
// 6-DIGIT PIN ROOM WEBSOCKET SIGNALLING
// ==========================================
const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/signal' });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function leave(ws) {
  if (!ws.room) return;
  const clients = rooms.get(ws.room);
  clients?.delete(ws);
  for (const peer of clients || []) send(peer, { type: 'peer-left' });
  if (!clients?.size) rooms.delete(ws.room);
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const pin = String(msg.pin || '');
      if (!/^\d{6}$/.test(pin)) {
        return send(ws, { type: 'error', message: 'Valid 6-digit PIN required.' });
      }

      leave(ws);

      const clients = rooms.get(pin) || new Set();
      if (clients.size >= 2) {
        return send(ws, { type: 'error', message: 'Room is already full.' });
      }

      rooms.set(pin, clients);
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
      for (const peer of rooms.get(ws.room) || []) {
        if (peer !== ws) send(peer, msg);
      }
    }
  });

  ws.on('close', () => leave(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Air Share Pro Conduit running on port ${PORT}`);
});