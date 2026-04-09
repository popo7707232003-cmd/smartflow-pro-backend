// src/config/index.ts
import 'dotenv/config';

export const config = {
  server: {
    port: parseInt(process.env.PORT || '4000'),
    wsPort: parseInt(process.env.WS_PORT || '4001'),
    nodeEnv: process.env.NODE_ENV || 'development',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://smartflow:smartflow_secret_2024@localhost:5432/smartflow',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    klineTTL: 86400,
    indicatorTTL: 300,
  },

  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    wsBaseUrl: 'wss://stream.binance.com:9443/ws',
    restBaseUrl: 'https://api.binance.com',
    futuresRestUrl: 'https://fapi.binance.com',
    reconnectDelayMs: 3000,
    maxReconnectAttempts: 20,
    klineHistoryLimit: 200,
  },

  apis: {
    nansenKey: process.env.NANSEN_API_KEY || '',
    etherscanKey: process.env.ETHERSCAN_API_KEY || '',
    arkhamKey: process.env.ARKHAM_API_KEY || '',
  },

  // ═══ Trading Parameters (ICT/SMC Framework) ═══
  trading: {
    // ATR — MUST use 1H klines (not 1M/5M)
    atrPeriod: 14,
    atrInterval: '1h' as const,

    // Stop Levels (ATR multipliers)
    slMultiplier: 1.5,    // SL = ATR × 1.5
    tp1Multiplier: 2.0,   // TP1 = ATR × 2.0 (close 50%, move SL to breakeven)
    tp2Multiplier: 3.0,   // TP2 = ATR × 3.0 (close remaining 50%)

    // Filters
    minRR: 2.0,           // Reject signals with R:R below this
    minScore: 5,          // Reject signals scoring below 5/10
    maxSignalsPerCoinPerDay: 3,

    // RSI Filters (BUG FIX: must enforce these)
    rsi: {
      period: 14,
      longMaxEntry: 70,    // DO NOT go long above 70
      longIdealMin: 40,
      longIdealMax: 65,
      shortMinEntry: 30,   // DO NOT go short below 30
      shortIdealMin: 35,
      shortIdealMax: 60,
      overboughtWarning: 75,
      oversoldWarning: 25,
    },

    // EMA
    emaPeriods: [20, 50, 200] as const,

    // MACD
    macd: { fast: 12, slow: 26, signal: 9 },

    // Volume
    volumeAvgPeriod: 20,
    volumeSpikeThreshold: 1.5,

    // Smart Money
    txThresholds: {
      BTC: 500_000,
      WBTC: 500_000,
      ETH: 200_000,
      WETH: 200_000,
      DEFAULT: 50_000,
    } as Record<string, number>,
  },

  // Tracked symbols
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'SUIUSDT', 'NEARUSDT',
  ],

  intervals: ['1h', '5m'] as const,
} as const;

export type Config = typeof config;
