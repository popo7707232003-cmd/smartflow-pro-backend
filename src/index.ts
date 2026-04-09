// backend/src/index.ts
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

// ─── 健康檢查（最前面）───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ready: servicesReady });
});
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ready: servicesReady, wsClients: clients.size });
});

// ─── Middleware ───
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.endsWith('.vercel.app') || origin.includes('localhost')) return cb(null, true);
    cb(null, true);
  },
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ─── WebSocket（跟 HTTP 同 port，路徑 /ws）───
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] +1 (${clients.size} total)`);
  ws.send(JSON.stringify({ type: 'CONNECTED', data: { clients: clients.size }, timestamp: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg: any): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

// ─── 404 ───
app.use((_req: any, res: any) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── 錯誤處理 ───
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal error' });
});

process.on('unhandledRejection', (r) => console.error('[FATAL]', r));
process.on('uncaughtException', (e) => { console.error('[FATAL]', e.message); process.exit(1); });

// ─── 啟動 ───
let servicesReady = false;

// 先開 port（讓 Railway 健康檢查立即通過）
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP + WS listening on 0.0.0.0:${PORT}`);
});

// 再初始化 services（背景）
async function initServices() {
  try {
    const { initializeServices } = await import('./startup');
    await initializeServices(app, broadcast);
    servicesReady = true;
    console.log('✅ All services ready');
  } catch (err: any) {
    console.error('⚠️ Service init error:', err.message);
    // 不 exit — 健康檢查仍然能回應，Railway 不會殺掉 container
  }
}

initServices();
