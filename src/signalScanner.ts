import { Pool } from 'pg';

// ===== Types =====
interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

interface Signal {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  score: number;
  maxScore: number;
  scoreDetails: Record<string, number>;
  rsi: number;
  atr: number;
  rr: number;
  timeframe: string;
  reason: string;
  status: string;
}

// ===== Config =====
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per symbol
const MIN_SCORE = 6; // minimum score out of 13 to emit signal
const MIN_RR = 1.5;
const MIN_ATR_MULTIPLIER = 0.003; // 0.3% minimum ATR as fraction of price

// Per-symbol cooldown tracker
const lastSignalTime: Record<string, number> = {};

let pool: Pool;

export function initSignalScanner(dbPool: Pool) {
  pool = dbPool;
  ensureTable().then(() => {
    console.log('[SignalScanner] Starting — scanning every 5 minutes');
    runScan(); // immediate first scan
    setInterval(runScan, SCAN_INTERVAL);
  });
}

// ===== DB Setup =====
async function ensureTable() {
  // Create table if brand new
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      entry DOUBLE PRECISION NOT NULL,
      tp1 DOUBLE PRECISION,
      tp2 DOUBLE PRECISION,
      sl DOUBLE PRECISION,
      score INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add all columns that might be missing on an existing table
  const columns: [string, string][] = [
    ['max_score', 'INTEGER DEFAULT 13'],
    ['score_details', "JSONB DEFAULT '{}'"],
    ['rsi', 'DOUBLE PRECISION'],
    ['atr', 'DOUBLE PRECISION'],
    ['rr', 'DOUBLE PRECISION'],
    ['timeframe', "VARCHAR(10) DEFAULT '15m'"],
    ['reason', 'TEXT'],
    ['status', "VARCHAR(20) DEFAULT 'active'"],
    ['tp1_hit', 'BOOLEAN DEFAULT FALSE'],
    ['tp2_hit', 'BOOLEAN DEFAULT FALSE'],
    ['sl_hit', 'BOOLEAN DEFAULT FALSE'],
    ['closed_at', 'TIMESTAMPTZ'],
    ['pnl_percent', 'DOUBLE PRECISION'],
  ];

  for (const [col, typedef] of columns) {
    try {
      await pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${typedef}`);
    } catch (e: any) {
      // ignore if already exists
    }
  }

  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC)');
  } catch {}
  console.log('[SignalScanner] Database table ready');
}

// ===== Binance Data Fetch =====
async function fetchCandles(symbol: string, interval: string, limit = 100): Promise<Candle[]> {
  const urls = [
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any[];
      return data.map(k => ({
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        time: k[0]
      }));
    } catch { continue; }
  }
  return [];
}

// ===== Indicator Calculations =====

function calcEMA(values: number[], period: number): number[] {
  const ema: number[] = [values[0]];
  const k = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calcMACD(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 35) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine.slice(-30), 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  return { macd, signal, hist: macd - signal };
}

function calcVWAP(candles: Candle[]): number {
  // Simple session VWAP from last 24 candles
  const recent = candles.slice(-24);
  let cumPV = 0, cumV = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumPV / cumV : 0;
}

// ===== SMC/ICT Detection =====

function detectOrderBlocks(candles: Candle[]): { bullish: Candle[]; bearish: Candle[] } {
  const bullish: Candle[] = [];
  const bearish: Candle[] = [];
  if (candles.length < 5) return { bullish, bearish };

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    // Bullish OB: bearish candle followed by strong bullish move
    if (c.close < c.open && candles[i + 1].close > c.high && candles[i + 2].close > candles[i + 1].close) {
      bullish.push(c);
    }
    // Bearish OB: bullish candle followed by strong bearish move
    if (c.close > c.open && candles[i + 1].close < c.low && candles[i + 2].close < candles[i + 1].close) {
      bearish.push(c);
    }
  }
  return { bullish, bearish };
}

function detectFVG(candles: Candle[]): { bullish: number; bearish: number } {
  let bullish = 0, bearish = 0;
  for (let i = 2; i < candles.length; i++) {
    // Bullish FVG: gap between candle[i-2].high and candle[i].low
    if (candles[i].low > candles[i - 2].high) bullish++;
    // Bearish FVG: gap between candle[i].high and candle[i-2].low
    if (candles[i].high < candles[i - 2].low) bearish++;
  }
  return { bullish, bearish };
}

function detectStructureBOS(candles: Candle[]): 'bullish' | 'bearish' | 'neutral' {
  if (candles.length < 20) return 'neutral';
  const recent = candles.slice(-20);
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
        recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high) {
      highs.push(recent[i].high);
    }
    if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
        recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low) {
      lows.push(recent[i].low);
    }
  }

  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1] > highs[highs.length - 2];
    const hl = lows[lows.length - 1] > lows[lows.length - 2];
    const ll = lows[lows.length - 1] < lows[lows.length - 2];
    const lh = highs[highs.length - 1] < highs[highs.length - 2];
    if (hh && hl) return 'bullish';
    if (ll && lh) return 'bearish';
  }
  return 'neutral';
}

function detectSupplyDemand(candles: Candle[]): { nearDemand: boolean; nearSupply: boolean } {
  if (candles.length < 30) return { nearDemand: false, nearSupply: false };
  const price = candles[candles.length - 1].close;
  const recent = candles.slice(-30);

  // Find zones with strong rejection (long wicks)
  let demandZone = Infinity, supplyZone = 0;
  for (const c of recent) {
    const bodySize = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);

    if (lowerWick > bodySize * 2) demandZone = Math.min(demandZone, c.low);
    if (upperWick > bodySize * 2) supplyZone = Math.max(supplyZone, c.high);
  }

  const atr = calcATR(candles);
  return {
    nearDemand: demandZone < Infinity && Math.abs(price - demandZone) < atr * 2,
    nearSupply: supplyZone > 0 && Math.abs(price - supplyZone) < atr * 2
  };
}

// ===== 13-Criteria Scoring =====

interface ScoreResult {
  total: number;
  details: Record<string, number>;
  direction: 'LONG' | 'SHORT' | null;
  indicators: {
    rsi: number;
    atr: number;
    macd: { macd: number; signal: number; hist: number };
    ema9: number;
    ema21: number;
    vwap: number;
    structure: string;
  };
}

function scoreSignal(candles15m: Candle[], candles1h: Candle[], candles4h: Candle[]): ScoreResult {
  const closes15 = candles15m.map(c => c.close);
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const price = closes15[closes15.length - 1];

  // Indicators on 15m (primary)
  const ema9 = calcEMA(closes15, 9);
  const ema21 = calcEMA(closes15, 21);
  const rsi = calcRSI(closes15);
  const atr = calcATR(candles15m);
  const macd = calcMACD(closes15);
  const vwap = calcVWAP(candles15m);
  const structure15 = detectStructureBOS(candles15m);
  const structure1h = detectStructureBOS(candles1h);
  const structure4h = detectStructureBOS(candles4h);
  const obs = detectOrderBlocks(candles15m);
  const fvg = detectFVG(candles15m);
  const sd = detectSupplyDemand(candles15m);

  const lastEma9 = ema9[ema9.length - 1];
  const lastEma21 = ema21[ema21.length - 1];

  const details: Record<string, number> = {};
  let longScore = 0, shortScore = 0;

  // 1. TF — Timeframe Confluence (15m + 1h + 4h structure agreement)
  const structs = [structure15, structure1h, structure4h];
  const bullTF = structs.filter(s => s === 'bullish').length;
  const bearTF = structs.filter(s => s === 'bearish').length;
  if (bullTF >= 2) { details.TF = 1; longScore++; }
  else if (bearTF >= 2) { details.TF = 1; shortScore++; }
  else { details.TF = 0; }

  // 2. MS — Market Structure (15m BOS/ChoCH)
  if (structure15 === 'bullish') { details.MS = 1; longScore++; }
  else if (structure15 === 'bearish') { details.MS = 1; shortScore++; }
  else { details.MS = 0; }

  // 3. VOL — Volume confirmation
  const recentVols = candles15m.slice(-5).map(c => c.volume);
  const avgVol = candles15m.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
  const lastVol = recentVols[recentVols.length - 1];
  if (lastVol > avgVol * 1.2) { details.VOL = 1; } else { details.VOL = 0; }
  // VOL doesn't pick direction, just confirms

  // 4. OB — Order Block proximity
  const recentBullOB = obs.bullish.length > 0;
  const recentBearOB = obs.bearish.length > 0;
  if (recentBullOB && price <= obs.bullish[obs.bullish.length - 1].high * 1.005) {
    details.OB = 1; longScore++;
  } else if (recentBearOB && price >= obs.bearish[obs.bearish.length - 1].low * 0.995) {
    details.OB = 1; shortScore++;
  } else { details.OB = 0; }

  // 5. FVG — Fair Value Gap
  if (fvg.bullish > fvg.bearish) { details.FVG = 1; longScore++; }
  else if (fvg.bearish > fvg.bullish) { details.FVG = 1; shortScore++; }
  else { details.FVG = 0; }

  // 6. SD — Supply/Demand Zone
  if (sd.nearDemand) { details.SD = 1; longScore++; }
  else if (sd.nearSupply) { details.SD = 1; shortScore++; }
  else { details.SD = 0; }

  // 7. EMA — Moving Average alignment
  if (lastEma9 > lastEma21 && price > lastEma21) { details.EMA = 1; longScore++; }
  else if (lastEma9 < lastEma21 && price < lastEma21) { details.EMA = 1; shortScore++; }
  else { details.EMA = 0; }

  // 8. RSI
  if (rsi > 50 && rsi < 75) { details.RSI = 1; longScore++; }
  else if (rsi < 50 && rsi > 25) { details.RSI = 1; shortScore++; }
  else { details.RSI = 0; }

  // 9. MACD
  if (macd.hist > 0 && macd.macd > macd.signal) { details.MACD = 1; longScore++; }
  else if (macd.hist < 0 && macd.macd < macd.signal) { details.MACD = 1; shortScore++; }
  else { details.MACD = 0; }

  // 10. ICB — ICT Concept (OB + FVG + structure combined)
  const ictBull = (structure15 === 'bullish' && recentBullOB && fvg.bullish > 0) ? 1 : 0;
  const ictBear = (structure15 === 'bearish' && recentBearOB && fvg.bearish > 0) ? 1 : 0;
  if (ictBull) { details.ICB = 1; longScore++; }
  else if (ictBear) { details.ICB = 1; shortScore++; }
  else { details.ICB = 0; }

  // 11. VWAP
  if (price > vwap) { details.VWAP = 1; longScore++; }
  else if (price < vwap) { details.VWAP = 1; shortScore++; }
  else { details.VWAP = 0; }

  // 12. SL — Stop loss reasonableness (ATR based, scored if ATR available)
  const minATR = price * MIN_ATR_MULTIPLIER;
  const effectiveATR = Math.max(atr, minATR);
  details.SL = effectiveATR > 0 ? 1 : 0;

  // 13. TREND — Overall trend (1h EMA cross)
  const ema9_1h = calcEMA(closes1h, 9);
  const ema21_1h = calcEMA(closes1h, 21);
  if (ema9_1h[ema9_1h.length - 1] > ema21_1h[ema21_1h.length - 1]) {
    details.TREND = 1; longScore++;
  } else if (ema9_1h[ema9_1h.length - 1] < ema21_1h[ema21_1h.length - 1]) {
    details.TREND = 1; shortScore++;
  } else { details.TREND = 0; }

  // Determine direction and total
  let direction: 'LONG' | 'SHORT' | null = null;
  let total = 0;
  if (longScore > shortScore && longScore >= 4) {
    direction = 'LONG';
    total = Object.values(details).reduce((a, b) => a + b, 0);
    // For directional scores, only count those aligned with LONG
    // VOL and SL are neutral — always count if 1
  } else if (shortScore > longScore && shortScore >= 4) {
    direction = 'SHORT';
    total = Object.values(details).reduce((a, b) => a + b, 0);
  }

  return {
    total,
    details,
    direction,
    indicators: {
      rsi, atr: effectiveATR, macd, ema9: lastEma9, ema21: lastEma21, vwap,
      structure: structure15
    }
  };
}

// ===== Stop Levels with minATR =====

function calcStopLevels(price: number, atr: number, direction: 'LONG' | 'SHORT') {
  const minATR = price * MIN_ATR_MULTIPLIER;
  const effectiveATR = Math.max(atr, minATR);

  if (direction === 'LONG') {
    const sl = price - effectiveATR * 1.5;
    const tp1 = price + effectiveATR * 2;
    const tp2 = price + effectiveATR * 3;
    return { sl, tp1, tp2, atr: effectiveATR };
  } else {
    const sl = price + effectiveATR * 1.5;
    const tp1 = price - effectiveATR * 2;
    const tp2 = price - effectiveATR * 3;
    return { sl, tp1, tp2, atr: effectiveATR };
  }
}

// ===== Main Scan =====

async function runScan() {
  console.log(`[SignalScanner] Scanning ${SYMBOLS.length} symbols at ${new Date().toISOString()}`);
  let generated = 0;

  for (const symbol of SYMBOLS) {
    try {
      // Cooldown check
      if (lastSignalTime[symbol] && Date.now() - lastSignalTime[symbol] < COOLDOWN_MS) {
        continue;
      }

      // Fetch data for all timeframes
      const [c15m, c1h, c4h] = await Promise.all([
        fetchCandles(symbol, '15m', 100),
        fetchCandles(symbol, '1h', 100),
        fetchCandles(symbol, '4h', 100)
      ]);

      if (c15m.length < 30 || c1h.length < 30 || c4h.length < 30) {
        console.log(`[SignalScanner] ${symbol}: insufficient data`);
        continue;
      }

      const result = scoreSignal(c15m, c1h, c4h);

      if (!result.direction || result.total < MIN_SCORE) {
        continue;
      }

      const price = c15m[c15m.length - 1].close;
      const levels = calcStopLevels(price, result.indicators.atr, result.direction);

      // Calculate R:R
      const risk = Math.abs(price - levels.sl);
      const reward = Math.abs(levels.tp2 - price);
      const rr = risk > 0 ? reward / risk : 0;

      if (rr < MIN_RR) {
        continue;
      }

      const reasons: string[] = [];
      for (const [k, v] of Object.entries(result.details)) {
        if (v === 1) reasons.push(k);
      }

      // Write to DB
      await pool.query(`
        INSERT INTO signals (symbol, direction, entry, tp1, tp2, sl, score, max_score, score_details, rsi, atr, rr, timeframe, reason, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active')
      `, [
        symbol,
        result.direction,
        price,
        levels.tp1,
        levels.tp2,
        levels.sl,
        result.total,
        13,
        JSON.stringify(result.details),
        result.indicators.rsi,
        levels.atr,
        Math.round(rr * 100) / 100,
        '15m',
        reasons.join(', ')
      ]);

      lastSignalTime[symbol] = Date.now();
      generated++;
      console.log(`[SignalScanner] ✅ ${symbol} ${result.direction} score=${result.total}/13 RR=${rr.toFixed(2)}`);

    } catch (err: any) {
      console.error(`[SignalScanner] ${symbol} error:`, err.message);
    }
  }

  console.log(`[SignalScanner] Scan complete — ${generated} new signals`);
}

export { runScan };
