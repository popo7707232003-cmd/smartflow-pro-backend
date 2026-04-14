import debugRouter, { initDebugRoutes } from './debugRoutes';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Pool } from 'pg';
import { setupWebSocket } from './websocket';
import marketBiasRouter from './marketBias';
import { initSignalScanner } from './signalScanner';
import { initSignalTracker } from './signalTracker';
import signalRoutes, { initSignalRoutes } from './signalRoutes';
import smartMoneyRouter from './smartMoney';
import alertRouter, { initAlertEngine } from './alertEngine';

const app = express();
app.use(cors({
  origin: [
    'https://smartflow-pro-frontendv1.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', ready: true, redis: false, redisFallback: true, ts: new Date().toISOString() });
  } catch (err: any) {
    res.json({ status: 'ok', ready: false, dbError: err.message });
  }
});

// Alias for Railway healthcheck
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', ready: true });
  } catch (err: any) {
    res.json({ status: 'ok', ready: false });
  }
});

app.use('/api', marketBiasRouter);
app.use('/api', smartMoneyRouter);
initSignalRoutes(pool);
app.use('/api', signalRoutes);
app.use('/api', initAlertEngine(pool));

app.use('/api', initDebugRoutes(pool));
const server = http.createServer(app);
setupWebSocket(server);
initSignalScanner(pool);
initSignalTracker(pool);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('SmartFlow Pro backend running on port ' + PORT);
});
