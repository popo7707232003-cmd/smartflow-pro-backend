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
import { SignalTracker } from './services/signalTracker';
import { createMarketRouter } from './routes/market';
import { createSmartMoneyRouter } from './routes/smartmoney';
import { createAlertsRouter } from './routes/alerts';
import { createStatsRouter } from './routes/stats';

export async function initializeServices(app: any, broadcast: (msg: any) => void) {
  console.log('Initializing services...');
  let pool: pg.Pool;
  try {
    pool = new pg.Pool({ connectionString: config.database.url, max: 20, connectionTimeoutMillis: 10000 });
    const r = await pool.query('SELECT NOW()');
    console.log('PG connected: ' + r.rows[0].now);
  } catch (e: any) { console.error('PG error:', e.message); throw e; }

  let redis: Redis;
  try {
    redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3, connectTimeout: 5000, retryStrategy: (t: number) => t > 3 ? null : Math.min(t * 200, 3000) });
    await redis.ping(); console.log('Redis connected');
  } catch (e: any) {
    console.warn('Redis unavailable, running without cache');
    redis = new Proxy({} as any, { get: (_t, p) => { const noop: Record<string, any> = { ping: async()=>'PONG', get: async()=>null, set: async()=>'OK', del: async()=>0, sadd: async()=>0, smembers: async()=>[], expire: async()=>0, disconnect:()=>{}, on:()=>{} }; return noop[p as string] || (async()=>null); } }) as any;
  }

  let marketData: MarketDataService;
  try { marketData = new MarketDataService(redis); await marketData.start(); console.log('MarketData started'); }
  catch (e: any) { console.error('MarketData error:', e.message); throw e; }

  const riskMonitor = new RiskMonitor(pool);
  const signalGen = new SignalGenerator(marketData, pool, riskMonitor);
  signalGen.setBroadcast(broadcast);

  const smartMoney = new SmartMoneyService(pool);
  smartMoney.setBroadcast(broadcast);
  const consensus = new SmartMoneyConsensusService(smartMoney);
  try { marketData.on('candle:tick', ({ candle }: any) => { smartMoney.updatePrices({ [candle.symbol]: candle.close }); }); smartMoney.start(60000); console.log('SmartMoney started'); }
  catch (e: any) { console.warn('SmartMoney warning:', e.message); }

  let newsAgg: NewsAggregator;
  try { newsAgg = new NewsAggregator(redis); await newsAgg.start(); console.log('NewsAgg started'); }
  catch (e: any) { console.warn('NewsAgg warning:', e.message); newsAgg = new NewsAggregator(redis); }

  let alertEngine: AlertEngine;
  try { alertEngine = new AlertEngine(newsAgg, smartMoney, pool); alertEngine.setBroadcast(broadcast); alertEngine.start(); console.log('AlertEngine started'); }
  catch (e: any) { console.warn('AlertEngine warning:', e.message); alertEngine = new AlertEngine(newsAgg, smartMoney, pool); }

  // Signal Tracker — auto win rate
  const tracker = new SignalTracker(pool);
  tracker.setBroadcast(broadcast);
  tracker.start();
  console.log('SignalTracker started');

  // Routes
  app.use('/api/market', createMarketRouter(marketData));
  app.use('/api/smartmoney', createSmartMoneyRouter(smartMoney, consensus));
  app.use('/api', createAlertsRouter(newsAgg, alertEngine));
  app.use('/api/stats', createStatsRouter(tracker));
  app.get('/api/portfolio/stats', async (_req: any, res: any) => { res.json({ success: true, data: await tracker.getOverallStats() }); });
  app.get('/api/portfolio/trades', async (req: any, res: any) => { res.json({ success: true, data: await tracker.getRecentResults(Math.min(parseInt(req.query?.limit)||20,100)) }); });
  app.get('/api/portfolio/active', async (_req: any, res: any) => { res.json({ success: true, data: await tracker.getActiveSignals() }); });
  console.log('Routes mounted');

  setTimeout(() => { signalGen.startScanner(); }, 15000);
  marketData.on('candle:closed', async ({ candle, interval }: any) => {
    if (interval === '1h') { try { for (const dir of ['long','short']) await signalGen.generateSignal(candle.symbol+'USDT', dir); } catch (e: any) { console.error('Scan err:', e.message); } }
  });
  console.log('All services initialized');
}
