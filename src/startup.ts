import pg from 'pg';
import Redis from 'ioredis';
import { config } from './config';
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

export async function initializeServices(app: any, broadcast: (msg: any) => void) {
  console.log('Initializing services...');

  // 1. Database
  let pool: pg.Pool;
  try {
    pool = new pg.Pool({ connectionString: config.database.url, max: 20, connectionTimeoutMillis: 10000 });
    const r = await pool.query('SELECT NOW()');
    console.log('PG connected: ' + r.rows[0].now);
  } catch (e: any) {
    console.error('PG error:', e.message);
    throw e;
  }

  // 2. Redis — if fails, use a fake redis that does nothing
  let redis: Redis;
  try {
    redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3, connectTimeout: 5000, retryStrategy: (t: number) => t > 3 ? null : Math.min(t * 200, 3000) });
    await redis.ping();
    console.log('Redis connected');
  } catch (e: any) {
    console.warn('Redis unavailable (' + e.message + '), running without cache');
    redis = new Proxy({} as any, {
      get: (_target, prop) => {
        if (prop === 'ping') return async () => 'PONG';
        if (prop === 'get') return async () => null;
        if (prop === 'set') return async () => 'OK';
        if (prop === 'del') return async () => 0;
        if (prop === 'sadd') return async () => 0;
        if (prop === 'smembers') return async () => [];
        if (prop === 'expire') return async () => 0;
        if (prop === 'disconnect') return () => {};
        if (prop === 'on') return () => {};
        return async () => null;
      }
    }) as any;
  }

  // 3. Market Data
  let marketData: MarketDataService;
  try {
    marketData = new MarketDataService(redis);
    await marketData.start();
    console.log('MarketData started');
  } catch (e: any) {
    console.error('MarketData error:', e.message);
    throw e;
  }

  // 4. Signal Generator
  const riskMonitor = new RiskMonitor(pool);
  const signalGen = new SignalGenerator(marketData, pool, riskMonitor);
  signalGen.setBroadcast(broadcast);

  // 5. Smart Money
  const smartMoney = new SmartMoneyService(pool);
  smartMoney.setBroadcast(broadcast);
  const consensus = new SmartMoneyConsensusService(smartMoney);
  try {
    marketData.on('candle:tick', ({ candle }: any) => { smartMoney.updatePrices({ [candle.symbol]: candle.close }); });
    smartMoney.start(60000);
    console.log('SmartMoney started');
  } catch (e: any) { console.warn('SmartMoney warning:', e.message); }

  // 6. News
  let newsAgg: NewsAggregator;
  try {
    newsAgg = new NewsAggregator(redis);
    await newsAgg.start();
    console.log('NewsAggregator started');
  } catch (e: any) {
    console.warn('NewsAgg warning:', e.message);
    newsAgg = new NewsAggregator(redis);
  }

  // 7. Alerts
  let alertEngine: AlertEngine;
  try {
    alertEngine = new AlertEngine(newsAgg, smartMoney, pool);
    alertEngine.setBroadcast(broadcast);
    alertEngine.start();
    console.log('AlertEngine started');
  } catch (e: any) {
    console.warn('AlertEngine warning:', e.message);
    alertEngine = new AlertEngine(newsAgg, smartMoney, pool);
  }

  // 8. Routes — THIS IS THE CRITICAL PART
  app.use('/api/market', createMarketRouter(marketData));
  app.use('/api/smartmoney', createSmartMoneyRouter(smartMoney, consensus));
  app.use('/api', createAlertsRouter(newsAgg, alertEngine));
  console.log('Routes mounted');

  // 9. Cron
  setTimeout(() => { signalGen.startScanner(); }, 15000);

  // 10. Candle-triggered scan
  marketData.on('candle:closed', async ({ candle, interval }: any) => {
    if (interval === '1h') {
      try {
        for (const dir of ['long', 'short']) await signalGen.generateSignal(candle.symbol + 'USDT', dir);
      } catch (e: any) { console.error('Candle scan error:', e.message); }
    }
  });

  console.log('All services initialized. Tracking: ' + config.symbols.join(', '));
}
