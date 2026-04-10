import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '4000', 10);

// CORS and middleware FIRST — before any routes
app.use(cors({ origin: true, credentials: true }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ready: servicesReady });
});
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ready: servicesReady, wsClients: clients.size });
});

// Portfolio placeholder routes (frontend expects these)
app.get('/api/portfolio/stats', (_req, res) => {
  res.json({ success: true, data: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalPnl: 0, maxDrawdown: 0, avgHoldTime: '-', monthReturn: 0 } });
});
app.get('/api/portfolio/trades', (_req, res) => {
  res.json({ success: true, data: [] });
});
app.get('/api/signals', (_req, res) => {
  res.json({ success: true, data: [] });
});

// WebSocket
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const clients = new Set<WebSocket>();
wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'CONNECTED', data: { clients: clients.size }, timestamp: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});
function broadcast(msg: any): void {
  const data = JSON.stringify(msg);
  for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(data); }
}

process.on('unhandledRejection', (r) => console.error('[FATAL]', r));
process.on('uncaughtException', (e) => { console.error('[FATAL]', e.message); process.exit(1); });

// Start
let servicesReady = false;

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP + WS listening on 0.0.0.0:' + PORT);
});

async function initServices() {
  try {
    const { initializeServices } = require('./startup');
    await initializeServices(app, broadcast);
    servicesReady = true;
    console.log('All services ready');
    // 404 handler AFTER all routes
    app.use((_req: any, res: any) => { res.status(404).json({ error: 'Not found' }); });
  } catch (err: any) {
    console.error('Service init error:', err.message);
    app.use((_req: any, res: any) => { res.status(404).json({ error: 'Not found' }); });
  }
}

initServices();
