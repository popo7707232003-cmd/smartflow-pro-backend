// backend/src/startup.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — Service Initialization Chain
// ═══════════════════════════════════════════════════════════════
//
// 啟動順序（嚴格）：
//   1. PostgreSQL + Redis 連線
//   2. MarketDataService（Binance WS + 歷史K線）
//   3. SignalGenerator（依賴 MarketData + RiskMonitor）
//   4. SmartMoneyService（獨立模組）
//   5. NewsAggregator（獨立模組）
//   6. AlertEngine（整合所有警報源）
//   7. 掛載 Express 路由
//   8. 開始 cron 掃描
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import Redis from 'ioredis';
import { config } from './config/index';
import { MarketDataService } from './services/marketData';
import { SignalGenerator } from './services/signalGenerator';
import { RiskMonitor } from './services/riskMonitor';
import { SmartMoneyService } from './services/smartMoney';
import { SmartMoneyConsensusService } from './services/smartMoneyConsensus';
import { NewsAggregator } from './services/newsAggregator';
import { AlertEngine } from './services/alertEngine';
import { createMarketRouter } from './routes/market';
import { createSmartMoneyRouter } from './routes/smartmoney';
import { createAlertsRouter } from './routes/alerts';
import type { Express } from 'express';

export interface Services {
  pool: pg.Pool;
  redis: Redis;
  marketData: MarketDataService;
  signalGenerator: SignalGenerator;
  riskMonitor: RiskMonitor;
  smartMoney: SmartMoneyService;
  consensus: SmartMoneyConsensusService;
  newsAggregator: NewsAggregator;
  alertEngine: AlertEngine;
}

export async function initializeServices(
  app: Express,
  broadcastFn: (msg: any) => void,
): Promise<Services> {
  console.log('═══════════════════════════════════════════');
  console.log('  SmartFlow Pro v1.0 — Initializing...');
  console.log('═══════════════════════════════════════════');

  // ─── 1. Database connections ───
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  try {
    const pgRes = await pool.query('SELECT NOW()');
    console.log(`✅ PostgreSQL connected: ${pgRes.rows[0].now}`);
  } catch (err) {
    console.error('❌ PostgreSQL failed:', (err as Error).message);
    throw err;
  }

  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  try {
    await redis.ping();
    console.log('✅ Redis connected');
  } catch (err) {
    console.error('❌ Redis failed:', (err as Error).message);
    throw err;
  }

  // ─── 2. Market Data (Binance WS + historical klines) ───
  const marketData = new MarketDataService(redis);
  await marketData.start();
  console.log('✅ MarketData started (Binance WS + REST)');

  // ─── 3. Risk Monitor + Signal Generator ───
  const riskMonitor = new RiskMonitor(pool);
  const signalGenerator = new SignalGenerator(marketData, pool, riskMonitor);
  signalGenerator.setBroadcast(broadcastFn);
  console.log('✅ SignalGenerator ready');

  // ─── 4. Smart Money ───
  const smartMoney = new SmartMoneyService(pool);
  smartMoney.setBroadcast(broadcastFn);
  const consensus = new SmartMoneyConsensusService(smartMoney);

  // Feed live prices to smart money USD estimates
  marketData.on('candle:tick', ({ candle }) => {
    smartMoney.updatePrices({ [candle.symbol]: candle.close });
  });

  smartMoney.start(60_000); // Poll every 60s
  console.log('✅ SmartMoney started');

  // ─── 5. News Aggregator ───
  const newsAggregator = new NewsAggregator(redis);
  await newsAggregator.start();
  console.log('✅ NewsAggregator started');

  // ─── 6. Alert Engine (integrates all sources) ───
  const alertEngine = new AlertEngine(newsAggregator, smartMoney, pool);
  alertEngine.setBroadcast(broadcastFn);
  alertEngine.start();
  console.log('✅ AlertEngine started');

  // ─── 7. Mount Express routes ───
  app.use('/api/market', createMarketRouter(marketData));
  app.use('/api/smartmoney', createSmartMoneyRouter(smartMoney, consensus));
  app.use('/api', createAlertsRouter(newsAggregator, alertEngine));
  console.log('✅ Routes mounted: /api/market, /api/smartmoney, /api/news, /api/alerts, /api/calendar');

  // ─── 8. Start cron scanner (after 15s delay for data to fill) ───
  setTimeout(() => {
    signalGenerator.startScanner();
    console.log('✅ Signal scanner started (cron: every 5 min)');
  }, 15_000);

  // ─── Also listen for 1H candle close to trigger immediate scan ───
  marketData.on('candle:closed', async ({ candle, interval }) => {
    if (interval === '1h') {
      console.log(`[Startup] 1H candle closed for ${candle.symbol}, scanning...`);
      try {
        for (const dir of ['long', 'short'] as const) {
          await signalGenerator.generateSignal(candle.symbol + 'USDT', dir);
        }
      } catch (err) {
        console.error('[Startup] Candle-triggered scan error:', (err as Error).message);
      }
    }
  });

  console.log('═══════════════════════════════════════════');
  console.log('  SmartFlow Pro is LIVE');
  console.log(`  Tracking: ${config.symbols.join(', ')}`);
  console.log('═══════════════════════════════════════════');

  return { pool, redis, marketData, signalGenerator, riskMonitor, smartMoney, consensus, newsAggregator, alertEngine };
}
