// backend/src/services/indicators.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — Technical Indicators Engine
// ═══════════════════════════════════════════════════════════════
//
// ⚠️  CRITICAL BUG FIX: ATR must use 1H/4H OHLC candles.
//     Using 1M/5M produces absurdly small values
//     (BTC SL = $6 instead of $600-$1200).
//
// All functions are PURE (stateless, testable, no side effects).
// Uses the `technicalindicators` library for core math.
// ═══════════════════════════════════════════════════════════════

import { ATR, EMA, RSI, MACD, BollingerBands } from 'technicalindicators';
import axios from 'axios';
import type { Candle } from './marketData';
import { config } from '../config/index';

const TC = config.trading;

// ═══════════════════════════════════════════════════════
// 1. ATR — Average True Range
// ═══════════════════════════════════════════════════════

/**
 * Calculate ATR from OHLC candle data.
 *
 * ⚠️  MUST receive 1H or 4H candles. NEVER 1M or 5M.
 *     Verification: BTC ATR(14) on 1H should be ~$400-$1500.
 *     If you see ATR < $50 for BTC, your input data is wrong.
 *
 * Uses Wilder's smoothing (same as TradingView).
 *
 * @param candles - 1H OHLC kline data (minimum period+1 candles)
 * @param period - Lookback period (default 14)
 * @returns ATR value, or null if insufficient data
 */
export function calculateATR(candles: Candle[], period: number = TC.atrPeriod): number | null {
  if (candles.length < period + 1) {
    console.warn(`[Indicators] ATR: Need ${period + 1} candles, got ${candles.length}`);
    return null;
  }

  const result = ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period,
  });

  if (result.length === 0) return null;

  const atr = result[result.length - 1];

  // ═══ SANITY CHECK ═══
  // BTC 1H ATR should be roughly $300-$2000.
  // If we see something absurdly small, log a warning.
  const lastPrice = candles[candles.length - 1].close;
  const atrPct = (atr / lastPrice) * 100;
  if (atrPct < 0.05) {
    console.warn(
      `[Indicators] ⚠️ ATR suspiciously low: ${atr.toFixed(4)} ` +
      `(${atrPct.toFixed(4)}% of ${lastPrice}). Are you using 1H candles?`
    );
  }

  return atr;
}

/**
 * Calculate stop-loss and take-profit levels from ATR.
 *
 * SL  = ATR × 1.5 (structure invalidation point)
 * TP1 = ATR × 2.0 (close 50%, move SL to breakeven)
 * TP2 = ATR × 3.0 (close remaining 50%)
 *
 * Returns null if R:R < 1.8 (signal should be rejected).
 *
 * @param entry - Entry price
 * @param atr - ATR value (from 1H klines)
 * @param direction - 'long' or 'short'
 */
export function calculateStopLevels(
  entry: number,
  atr: number,
  direction: 'long' | 'short',
): {
  sl: number;
  tp1: number;
  tp2: number;
  slPct: number;
  tp1Pct: number;
  tp2Pct: number;
  rr: number;
} | null {
  const minATR = entry * 0.003; const safeATR = Math.max(atr, minATR); const slDist = safeATR * TC.slMultiplier;   // ATR × 1.5
  const tp1Dist = safeATR * 2.25; // ATR × 2.0
  const tp2Dist = safeATR * 3.0; // ATR × 3.0

  let sl: number, tp1: number, tp2: number;

  if (direction === 'long') {
    sl  = entry - slDist;
    tp1 = entry + tp1Dist;
    tp2 = entry + tp2Dist;
  } else {
    sl  = entry + slDist;
    tp1 = entry - tp1Dist;
    tp2 = entry - tp2Dist;
  }

  // R:R based on TP1
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp1 - entry);
  const rr = risk > 0 ? +(reward / risk).toFixed(2) : 0;

  // ═══ FILTER: R:R must be >= 1.8 ═══
  if (rr < 1.8) {
    return null;
  }

  // Smart precision based on price level
  const dec = getPriceDecimals(entry);

  return {
    sl:     +sl.toFixed(dec),
    tp1:    +tp1.toFixed(dec),
    tp2:    +tp2.toFixed(dec),
    slPct:  +((slDist / entry) * 100).toFixed(2),
    tp1Pct: +((tp1Dist / entry) * 100).toFixed(2),
    tp2Pct: +((tp2Dist / entry) * 100).toFixed(2),
    rr,
  };
}

/**
 * Get appropriate decimal places for a price level.
 * BTC ($80K+): 1 decimal = $0.1 precision
 * ETH ($2K):   2 decimals = $0.01
 * SOL ($130):  2 decimals
 * DOGE ($0.1): 5 decimals
 */
function getPriceDecimals(price: number): number {
  if (price >= 10000) return 1;
  if (price >= 100)   return 2;
  if (price >= 1)     return 3;
  if (price >= 0.01)  return 5;
  return 6;
}

// ═══════════════════════════════════════════════════════
// 2. EMA — Exponential Moving Average
// ═══════════════════════════════════════════════════════

/**
 * Calculate EMA for a series of candles.
 * Returns the full EMA array (same length as input minus period-1).
 */
export function calculateEMA(candles: Candle[], period: number): number[] {
  if (candles.length < period) return [];

  return EMA.calculate({
    values: candles.map(c => c.close),
    period,
  });
}

/**
 * Get the latest EMA value.
 */
export function getLatestEMA(candles: Candle[], period: number): number | null {
  const ema = calculateEMA(candles, period);
  return ema.length > 0 ? ema[ema.length - 1] : null;
}

/**
 * Determine EMA alignment.
 * Bullish: EMA20 > EMA50 > EMA200  (all moving averages stacked upward)
 * Bearish: EMA20 < EMA50 < EMA200  (all stacked downward)
 * Neutral: Any other configuration
 */
export function getEMAAlignment(
  ema20: number,
  ema50: number,
  ema200: number,
): 'bullish' | 'bearish' | 'neutral' {
  if (ema20 > ema50 && ema50 > ema200) return 'bullish';
  if (ema20 < ema50 && ema50 < ema200) return 'bearish';
  return 'neutral';
}

/**
 * Calculate all three EMAs and return alignment + values.
 */
export function calculateEMABundle(candles: Candle[]): {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  alignment: 'bullish' | 'bearish' | 'neutral';
} {
  const ema20 = getLatestEMA(candles, 20);
  const ema50 = getLatestEMA(candles, 50);
  const ema200 = getLatestEMA(candles, Math.min(200, candles.length));

  if (ema20 === null || ema50 === null || ema200 === null) {
    return { ema20, ema50, ema200, alignment: 'neutral' };
  }

  return {
    ema20: +ema20.toFixed(getPriceDecimals(ema20)),
    ema50: +ema50.toFixed(getPriceDecimals(ema50)),
    ema200: +ema200.toFixed(getPriceDecimals(ema200)),
    alignment: getEMAAlignment(ema20, ema50, ema200),
  };
}

// ═══════════════════════════════════════════════════════
// 3. RSI — Relative Strength Index
// ═══════════════════════════════════════════════════════

/**
 * Calculate RSI(14) from candle close prices.
 * Returns the most recent RSI value.
 */
export function calculateRSI(candles: Candle[], period: number = TC.rsi.period): number | null {
  if (candles.length < period + 1) return null;

  const result = RSI.calculate({
    values: candles.map(c => c.close),
    period,
  });

  return result.length > 0 ? +result[result.length - 1].toFixed(2) : null;
}

/**
 * Calculate full RSI array (for divergence detection).
 */
export function calculateRSIArray(candles: Candle[], period: number = TC.rsi.period): number[] {
  if (candles.length < period + 1) return [];

  return RSI.calculate({
    values: candles.map(c => c.close),
    period,
  });
}

/**
 * Validate RSI for a given trade direction.
 *
 * ═══ BUG FIX: These filters were missing in the original system. ═══
 *
 * Long entry:
 *   - RSI < 70  → valid (OK to enter)
 *   - RSI > 75  → warning "超買警告，RSI進入危險區間"
 *   - RSI >= 70 → valid = false (signal should be blocked/downgraded)
 *
 * Short entry:
 *   - RSI > 30  → valid (OK to enter)
 *   - RSI < 25  → warning "超賣警告，RSI進入危險區間"
 *   - RSI <= 30 → valid = false
 */
export function getRSISignal(
  rsi: number,
  direction: 'long' | 'short',
): { valid: boolean; warning: string | null } {
  if (direction === 'long') {
    if (rsi >= TC.rsi.longMaxEntry) {
      return {
        valid: false,
        warning: rsi >= TC.rsi.overboughtWarning
          ? `超買警告，RSI ${rsi.toFixed(1)} 進入危險區間，做多已被屏蔽`
          : `RSI ${rsi.toFixed(1)} ≥ ${TC.rsi.longMaxEntry}，不建議做多`,
      };
    }
    if (rsi > TC.rsi.longIdealMax) {
      return {
        valid: true,
        warning: `RSI ${rsi.toFixed(1)} 偏高，接近超買區`,
      };
    }
    return { valid: true, warning: null };
  }

  // Short
  if (rsi <= TC.rsi.shortMinEntry) {
    return {
      valid: false,
      warning: rsi <= TC.rsi.oversoldWarning
        ? `超賣警告，RSI ${rsi.toFixed(1)} 進入危險區間，做空已被屏蔽`
        : `RSI ${rsi.toFixed(1)} ≤ ${TC.rsi.shortMinEntry}，不建議做空`,
    };
  }
  if (rsi < TC.rsi.shortIdealMin) {
    return {
      valid: true,
      warning: `RSI ${rsi.toFixed(1)} 偏低，接近超賣區`,
    };
  }
  return { valid: true, warning: null };
}

/**
 * Detect RSI divergence.
 * Bullish: price makes lower low, RSI makes higher low
 * Bearish: price makes higher high, RSI makes lower high
 */
export function detectRSIDivergence(
  candles: Candle[],
  rsiValues: number[],
  lookback: number = 10,
): 'bullish' | 'bearish' | 'none' {
  if (candles.length < lookback || rsiValues.length < lookback) return 'none';

  const half = Math.floor(lookback / 2);
  const priceA = candles.slice(-lookback, -half).map(c => c.close);
  const priceB = candles.slice(-half).map(c => c.close);
  const rsiA = rsiValues.slice(-lookback, -half);
  const rsiB = rsiValues.slice(-half);

  // Bullish divergence
  if (Math.min(...priceB) < Math.min(...priceA) &&
      Math.min(...rsiB) > Math.min(...rsiA)) {
    return 'bullish';
  }

  // Bearish divergence
  if (Math.max(...priceB) > Math.max(...priceA) &&
      Math.max(...rsiB) < Math.max(...rsiA)) {
    return 'bearish';
  }

  return 'none';
}

// ═══════════════════════════════════════════════════════
// 4. MACD (12, 26, 9)
// ═══════════════════════════════════════════════════════

/**
 * Calculate MACD with standard parameters (12, 26, 9).
 * Returns the latest values for MACD line, signal line, histogram.
 */
export function calculateMACD(candles: Candle[]): {
  macdLine: number;
  signalLine: number;
  histogram: number;
  direction: 'bullish' | 'bearish';
} | null {
  if (candles.length < TC.macd.slow + TC.macd.signal) return null;

  const result = MACD.calculate({
    values: candles.map(c => c.close),
    fastPeriod: TC.macd.fast,
    slowPeriod: TC.macd.slow,
    signalPeriod: TC.macd.signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (result.length === 0) return null;

  const latest = result[result.length - 1];
  if (latest.MACD === undefined || latest.signal === undefined || latest.histogram === undefined) {
    return null;
  }

  const dec = getPriceDecimals(candles[candles.length - 1].close);

  return {
    macdLine: +latest.MACD.toFixed(dec + 2),
    signalLine: +latest.signal.toFixed(dec + 2),
    histogram: +latest.histogram.toFixed(dec + 2),
    direction: latest.histogram > 0 ? 'bullish' : 'bearish',
  };
}

// ═══════════════════════════════════════════════════════
// 5. VWAP — Volume Weighted Average Price
// ═══════════════════════════════════════════════════════

/**
 * Calculate intraday VWAP.
 * Resets at midnight UTC (standard for crypto).
 *
 * Formula: VWAP = Σ(Typical Price × Volume) / Σ(Volume)
 * Typical Price = (High + Low + Close) / 3
 */
export function calculateVWAP(candles: Candle[]): number | null {
  if (candles.length === 0) return null;

  // Filter to today's candles (since midnight UTC)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayCandles = candles.filter(c => c.timestamp >= todayMs);
  if (todayCandles.length === 0) {
    // Fallback: use all candles
    return calculateVWAPFromCandles(candles);
  }

  return calculateVWAPFromCandles(todayCandles);
}

function calculateVWAPFromCandles(candles: Candle[]): number | null {
  let cumTPV = 0; // Cumulative (Typical Price × Volume)
  let cumVol = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }

  if (cumVol === 0) return null;
  return +(cumTPV / cumVol).toFixed(getPriceDecimals(cumTPV / cumVol));
}

/**
 * Get VWAP bias: is current price above or below VWAP?
 * Long entries prefer price ABOVE VWAP.
 * Short entries prefer price BELOW VWAP.
 */
export function getVWAPBias(price: number, vwap: number): 'above' | 'below' {
  return price >= vwap ? 'above' : 'below';
}

// ═══════════════════════════════════════════════════════
// 6. VOLUME ANALYSIS
// ═══════════════════════════════════════════════════════

/**
 * Check if current volume confirms a breakout.
 * A breakout with current volume > 20-period average × 1.5 is "confirmed".
 *
 * @param currentVol - Volume of the breakout candle
 * @param avgVol20 - 20-period simple average volume
 * @returns true if volume is sufficient to confirm the move
 */
export function isVolumeConfirmed(currentVol: number, avgVol20: number): boolean {
  if (avgVol20 <= 0) return false;
  return currentVol >= avgVol20 * TC.volumeSpikeThreshold;
}

/**
 * Calculate 20-period average volume and current ratio.
 */
export function analyzeVolume(candles: Candle[]): {
  current: number;
  avg20: number;
  ratio: number;
  confirmed: boolean;
  spike: boolean;
} {
  if (candles.length < 21) {
    return { current: 0, avg20: 0, ratio: 0, confirmed: false, spike: false };
  }

  const current = candles[candles.length - 1].volume;
  const prev20 = candles.slice(-21, -1);
  const avg20 = prev20.reduce((sum, c) => sum + c.volume, 0) / prev20.length;
  const ratio = avg20 > 0 ? +(current / avg20).toFixed(2) : 0;

  return {
    current: +current.toFixed(2),
    avg20: +avg20.toFixed(2),
    ratio,
    confirmed: ratio >= TC.volumeSpikeThreshold,  // >= 1.5×
    spike: ratio >= 2.5,                           // >= 2.5× (very significant)
  };
}

// ═══════════════════════════════════════════════════════
// 7. BOLLINGER BANDS
// ═══════════════════════════════════════════════════════

/**
 * Calculate Bollinger Bands (20, 2).
 */
export function calculateBollingerBands(candles: Candle[]): {
  upper: number;
  middle: number;
  lower: number;
  position: number; // 0-100, where current price sits in the band
} | null {
  if (candles.length < 20) return null;

  const result = BollingerBands.calculate({
    period: 20,
    values: candles.map(c => c.close),
    stdDev: 2,
  });

  if (result.length === 0) return null;

  const latest = result[result.length - 1];
  const price = candles[candles.length - 1].close;
  const bandWidth = latest.upper - latest.lower;
  const position = bandWidth > 0 ? +((price - latest.lower) / bandWidth * 100).toFixed(1) : 50;

  return {
    upper: +latest.upper.toFixed(getPriceDecimals(latest.upper)),
    middle: +latest.middle.toFixed(getPriceDecimals(latest.middle)),
    lower: +latest.lower.toFixed(getPriceDecimals(latest.lower)),
    position,
  };
}

// ═══════════════════════════════════════════════════════
// 8. FUNDING RATE (Binance Futures)
// ═══════════════════════════════════════════════════════

/**
 * Get the latest funding rate for a symbol from Binance Futures.
 * Funding rate is a % paid between longs and shorts every 8 hours.
 *
 * Positive → longs pay shorts → bullish sentiment (contrarian: bearish signal)
 * Negative → shorts pay longs → bearish sentiment (contrarian: bullish signal)
 *
 * @param symbol - e.g. "BTCUSDT"
 * @returns Funding rate as percentage (e.g. 0.01 means 0.01%)
 */
export async function getFundingRate(symbol: string): Promise<number | null> {
  try {
    const url = `${config.binance.futuresRestUrl}/fapi/v1/fundingRate`;
    const { data } = await axios.get(url, {
      params: { symbol: symbol.toUpperCase(), limit: 1 },
      timeout: 5000,
    });

    if (data && data.length > 0) {
      // Binance returns as decimal (e.g. 0.0001 = 0.01%)
      // We convert to percentage for display
      return +(parseFloat(data[0].fundingRate) * 100).toFixed(4);
    }
    return null;
  } catch (err) {
    console.error(`[Indicators] Funding rate error for ${symbol}:`, (err as Error).message);
    return null;
  }
}

/**
 * Get funding rates for all tracked symbols.
 */
export async function getAllFundingRates(): Promise<Record<string, number | null>> {
  const symbols = config.symbols;
  const rates: Record<string, number | null> = {};

  // Fetch in parallel
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const rate = await getFundingRate(sym);
      return { sym, rate };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      rates[result.value.sym] = result.value.rate;
    }
  }

  return rates;
}

// ═══════════════════════════════════════════════════════
// 9. COMPOSITE: All indicators for a symbol
// ═══════════════════════════════════════════════════════

export interface IndicatorSnapshot {
  symbol: string;
  price: number;
  atr: number | null;
  atrPct: number | null;
  rsi: number | null;
  rsiSignalLong: { valid: boolean; warning: string | null };
  rsiSignalShort: { valid: boolean; warning: string | null };
  rsiDivergence: 'bullish' | 'bearish' | 'none';
  macd: ReturnType<typeof calculateMACD>;
  ema: ReturnType<typeof calculateEMABundle>;
  vwap: number | null;
  vwapBias: 'above' | 'below' | null;
  volume: ReturnType<typeof analyzeVolume>;
  bollingerBands: ReturnType<typeof calculateBollingerBands>;
  fundingRate: number | null;
  timestamp: number;
}

/**
 * Calculate ALL indicators for a single symbol.
 * This is the main function called by the signal engine.
 */
export function calculateAllIndicators(
  symbol: string,
  candles1h: Candle[],
  candles5m: Candle[],
  fundingRate: number | null = null,
): IndicatorSnapshot {
  const price = candles1h.length > 0 ? candles1h[candles1h.length - 1].close : 0;

  // ATR from 1H candles (CRITICAL: must be 1H, not 5M)
  const atr = calculateATR(candles1h);
  const atrPct = atr && price > 0 ? +((atr / price) * 100).toFixed(3) : null;

  // RSI from 1H
  const rsi = calculateRSI(candles1h);
  const rsiArr = calculateRSIArray(candles1h);
  const rsiDivergence = detectRSIDivergence(candles1h, rsiArr);

  return {
    symbol,
    price,
    atr,
    atrPct,
    rsi,
    rsiSignalLong: rsi !== null ? getRSISignal(rsi, 'long') : { valid: true, warning: null },
    rsiSignalShort: rsi !== null ? getRSISignal(rsi, 'short') : { valid: true, warning: null },
    rsiDivergence,
    macd: calculateMACD(candles1h),
    ema: calculateEMABundle(candles1h),
    vwap: calculateVWAP(candles1h),
    vwapBias: (() => {
      const vwap = calculateVWAP(candles1h);
      return vwap ? getVWAPBias(price, vwap) : null;
    })(),
    volume: analyzeVolume(candles1h),
    bollingerBands: calculateBollingerBands(candles1h),
    fundingRate,
    timestamp: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════
// FUNCTION REGISTRY (for documentation / testing)
// ═══════════════════════════════════════════════════════
//
// ATR:
//   calculateATR(candles: Candle[], period?: number) → number | null
//   calculateStopLevels(entry, atr, direction) → { sl, tp1, tp2, slPct, tp1Pct, tp2Pct, rr } | null
//
// EMA:
//   calculateEMA(candles, period) → number[]
//   getLatestEMA(candles, period) → number | null
//   getEMAAlignment(ema20, ema50, ema200) → 'bullish' | 'bearish' | 'neutral'
//   calculateEMABundle(candles) → { ema20, ema50, ema200, alignment }
//
// RSI:
//   calculateRSI(candles, period?) → number | null
//   calculateRSIArray(candles, period?) → number[]
//   getRSISignal(rsi, direction) → { valid, warning }
//   detectRSIDivergence(candles, rsiValues, lookback?) → 'bullish' | 'bearish' | 'none'
//
// MACD:
//   calculateMACD(candles) → { macdLine, signalLine, histogram, direction } | null
//
// VWAP:
//   calculateVWAP(candles) → number | null
//   getVWAPBias(price, vwap) → 'above' | 'below'
//
// Volume:
//   isVolumeConfirmed(currentVol, avgVol20) → boolean
//   analyzeVolume(candles) → { current, avg20, ratio, confirmed, spike }
//
// Bollinger Bands:
//   calculateBollingerBands(candles) → { upper, middle, lower, position } | null
//
// Funding Rate:
//   getFundingRate(symbol) → Promise<number | null>
//   getAllFundingRates() → Promise<Record<string, number | null>>
//
// Composite:
//   calculateAllIndicators(symbol, candles1h, candles5m, fundingRate?) → IndicatorSnapshot
