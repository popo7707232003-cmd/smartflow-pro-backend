import 'dotenv/config';

export const config = {
  server: {
    port: parseInt(process.env.PORT || '4000'),
    nodeEnv: process.env.NODE_ENV || 'development',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://smartflow:smartflow_secret_2024@localhost:5432/smartflow',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  binance: {
    wsBaseUrl: process.env.BINANCE_WS_URL || 'wss://data-stream.binance.vision/ws',
    restBaseUrl: process.env.BINANCE_REST_URL || 'https://data-api.binance.vision',
    futuresRestUrl: 'https://fapi.binance.com',
  },
  apis: {
    nansenKey: process.env.NANSEN_API_KEY || '',
    etherscanKey: process.env.ETHERSCAN_API_KEY || '',
    arkhamKey: process.env.ARKHAM_API_KEY || '',
  },
  trading: {
    atrPeriod: 14,
    slMultiplier: 1.5,
    tp1Multiplier: 2.0,
    tp2Multiplier: 3.0,
    minRR: 2.0,
    minScore: 5,
    maxSignalsPerCoinPerDay: 3,
    rsi: { period: 14, longMaxEntry: 70, longIdealMin: 40, longIdealMax: 65, shortMinEntry: 30, shortIdealMin: 35, shortIdealMax: 60, overboughtWarning: 75, oversoldWarning: 25 },
    macd: { fast: 12, slow: 26, signal: 9 },
    volumeSpikeThreshold: 1.5,
    txThresholds: { BTC: 500000, WBTC: 500000, ETH: 200000, WETH: 200000, DEFAULT: 50000 } as Record<string, number>,
  },
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'SUIUSDT', 'NEARUSDT'] as string[],
  intervals: ['1h', '5m'] as string[],
};
