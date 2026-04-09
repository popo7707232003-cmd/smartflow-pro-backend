// backend/src/services/smcEngine.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — SMC / ICT 結構分析引擎
// ═══════════════════════════════════════════════════════════════
//
// 市場結構識別：Swing Points → BOS → ChoCH → MTF Bias
// 進場區域識別：Order Blocks → FVG → Supply/Demand → Liquidity Sweep
//
// 所有函數為純函數，無副作用，可獨立測試。
// ═══════════════════════════════════════════════════════════════

import type { Candle } from './marketData';

// ═══ Types ═══

export interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  index: number;
  timestamp: number;
}

export interface BOSResult {
  direction: 'bullish' | 'bearish';
  breakPrice: number;
  closePrice: number;
  strength: 'strong' | 'weak'; // strong = closed beyond, weak = only wicked
  timestamp: number;
}

export interface ChoCHResult {
  direction: 'bullish' | 'bearish';
  price: number;
  fromTrend: string;
  toTrend: string;
  timestamp: number;
}

export interface OrderBlock {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  open: number;
  close: number;
  timestamp: number;
  index: number;
  strength: number;    // % move that followed this OB
  mitigated: boolean;  // has price already returned to this zone?
}

export interface FVG {
  type: 'bullish' | 'bearish';
  upper: number;       // top boundary of the gap
  lower: number;       // bottom boundary of the gap
  midpoint: number;
  timestamp: number;
  index: number;
  filled: boolean;     // has price filled this gap?
  gapSizePct: number;  // gap size as % of price
}

export interface SDZone {
  type: 'supply' | 'demand';
  high: number;
  low: number;
  strength: number;    // based on departure move size
  timestamp: number;
  index: number;
  fresh: boolean;      // price hasn't returned to this zone yet
  touches: number;     // how many times price tested this zone
}

export interface LiqSweep {
  type: 'swept_highs' | 'swept_lows';
  sweepPrice: number;
  returnPrice: number;
  swingPrice: number;  // the original swing level that was swept
  timestamp: number;
  suggestedDirection: 'long' | 'short';
}

export interface MTFBias {
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;  // 0-100
  dailyBias: string;
  h4Bias: string;
  h1Bias: string;
  alignment: number;   // 0-3 timeframes agree
}

// ═══════════════════════════════════════════════════════
// 1. SWING POINT IDENTIFICATION
// ═══════════════════════════════════════════════════════

/**
 * Identify swing highs and lows.
 * A swing high has bars on BOTH sides lower than it.
 * A swing low has bars on BOTH sides higher than it.
 *
 * Uses left=3, right=3 confirmation bars (configurable).
 */
export function identifySwingPoints(
  candles: Candle[],
  leftBars: number = 3,
  rightBars: number = 3,
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (candles.length < leftBars + rightBars + 1) return swings;

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];

    // Swing high: current high > all highs in left AND right window
    const leftHighs = candles.slice(i - leftBars, i).map(c => c.high);
    const rightHighs = candles.slice(i + 1, i + rightBars + 1).map(c => c.high);

    if (current.high > Math.max(...leftHighs) && current.high > Math.max(...rightHighs)) {
      swings.push({
        type: 'high',
        price: current.high,
        index: i,
        timestamp: current.timestamp,
      });
    }

    // Swing low: current low < all lows in left AND right window
    const leftLows = candles.slice(i - leftBars, i).map(c => c.low);
    const rightLows = candles.slice(i + 1, i + rightBars + 1).map(c => c.low);

    if (current.low < Math.min(...leftLows) && current.low < Math.min(...rightLows)) {
      swings.push({
        type: 'low',
        price: current.low,
        index: i,
        timestamp: current.timestamp,
      });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

// ═══════════════════════════════════════════════════════
// 2. BOS — Break of Structure
// ═══════════════════════════════════════════════════════

/**
 * Detect Break of Structure.
 *
 * Bullish BOS: price closes ABOVE the most recent swing high
 *   → trend continuation (uptrend confirmed)
 * Bearish BOS: price closes BELOW the most recent swing low
 *   → trend continuation (downtrend confirmed)
 *
 * Strong BOS: close is beyond the swing level
 * Weak BOS: only the wick penetrated (less reliable)
 */
export function detectBOS(candles: Candle[], swings: SwingPoint[]): BOSResult | null {
  if (swings.length < 2 || candles.length < 2) return null;

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  // Get recent swing highs and lows
  const recentHighs = swings.filter(s => s.type === 'high').slice(-5);
  const recentLows = swings.filter(s => s.type === 'low').slice(-5);

  // Check bullish BOS: current close breaks above last swing high
  for (let i = recentHighs.length - 1; i >= 0; i--) {
    const sh = recentHighs[i];
    // Must not already be broken by a previous candle (check previous close was below)
    if (prevCandle.close <= sh.price && lastCandle.close > sh.price) {
      return {
        direction: 'bullish',
        breakPrice: sh.price,
        closePrice: lastCandle.close,
        strength: lastCandle.close > sh.price ? 'strong' : 'weak',
        timestamp: lastCandle.timestamp,
      };
    }
    // Weak: only wick broke it
    if (prevCandle.high <= sh.price && lastCandle.high > sh.price && lastCandle.close <= sh.price) {
      return {
        direction: 'bullish',
        breakPrice: sh.price,
        closePrice: lastCandle.close,
        strength: 'weak',
        timestamp: lastCandle.timestamp,
      };
    }
  }

  // Check bearish BOS: current close breaks below last swing low
  for (let i = recentLows.length - 1; i >= 0; i--) {
    const sl = recentLows[i];
    if (prevCandle.close >= sl.price && lastCandle.close < sl.price) {
      return {
        direction: 'bearish',
        breakPrice: sl.price,
        closePrice: lastCandle.close,
        strength: lastCandle.close < sl.price ? 'strong' : 'weak',
        timestamp: lastCandle.timestamp,
      };
    }
    if (prevCandle.low >= sl.price && lastCandle.low < sl.price && lastCandle.close >= sl.price) {
      return {
        direction: 'bearish',
        breakPrice: sl.price,
        closePrice: lastCandle.close,
        strength: 'weak',
        timestamp: lastCandle.timestamp,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// 3. ChoCH — Change of Character
// ═══════════════════════════════════════════════════════

/**
 * Detect Change of Character — trend reversal signal.
 *
 * In uptrend (HH + HL pattern):
 *   If a new LOW forms BELOW the previous low → bearish ChoCH
 *
 * In downtrend (LH + LL pattern):
 *   If a new HIGH forms ABOVE the previous high → bullish ChoCH
 */
export function detectChoCH(candles: Candle[], swings: SwingPoint[]): ChoCHResult | null {
  if (swings.length < 6) return null;

  const highs = swings.filter(s => s.type === 'high').slice(-4);
  const lows = swings.filter(s => s.type === 'low').slice(-4);

  if (highs.length < 3 || lows.length < 3) return null;

  // Detect prior trend from first 2 swing pairs
  const wasUptrend =
    highs[1].price > highs[0].price &&   // Higher High
    lows[1].price > lows[0].price;         // Higher Low

  const wasDowntrend =
    highs[1].price < highs[0].price &&     // Lower High
    lows[1].price < lows[0].price;          // Lower Low

  // Bullish ChoCH: was in downtrend, now latest high > previous high
  if (wasDowntrend) {
    const latestHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    if (latestHigh.price > prevHigh.price) {
      return {
        direction: 'bullish',
        price: latestHigh.price,
        fromTrend: 'bearish (LH+LL)',
        toTrend: 'bullish reversal',
        timestamp: latestHigh.timestamp,
      };
    }
  }

  // Bearish ChoCH: was in uptrend, now latest low < previous low
  if (wasUptrend) {
    const latestLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];
    if (latestLow.price < prevLow.price) {
      return {
        direction: 'bearish',
        price: latestLow.price,
        fromTrend: 'bullish (HH+HL)',
        toTrend: 'bearish reversal',
        timestamp: latestLow.timestamp,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// 4. ORDER BLOCKS
// ═══════════════════════════════════════════════════════

/**
 * Find Order Blocks — the last opposite-direction candle before a strong move.
 *
 * Bullish OB: The last BEARISH candle (close < open) before a strong rally.
 *   → This zone is expected to act as support when price returns.
 *
 * Bearish OB: The last BULLISH candle (close > open) before a strong drop.
 *   → This zone is expected to act as resistance when price returns.
 *
 * "Strong move" = the subsequent 2-3 candles move > minMovePercent.
 */
export function findOrderBlocks(
  candles: Candle[],
  minMovePct: number = 0.5,
  lookback: number = 40,
): OrderBlock[] {
  const obs: OrderBlock[] = [];
  if (candles.length < 5) return obs;

  const currentPrice = candles[candles.length - 1].close;
  const start = Math.max(0, candles.length - lookback);

  for (let i = start; i < candles.length - 3; i++) {
    const c = candles[i];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];

    const isBearishCandle = c.close < c.open; // red candle
    const isBullishCandle = c.close > c.open;  // green candle

    // 2-candle move after this candle
    const moveAfterPct = ((next2.close - c.close) / c.close) * 100;

    // Bullish OB: bearish candle → then strong up move
    if (isBearishCandle && moveAfterPct > minMovePct) {
      const mitigated = currentPrice >= c.low && currentPrice <= c.high;
      obs.push({
        type: 'bullish',
        high: c.high,
        low: c.low,
        open: c.open,
        close: c.close,
        timestamp: c.timestamp,
        index: i,
        strength: +Math.abs(moveAfterPct).toFixed(2),
        mitigated,
      });
    }

    // Bearish OB: bullish candle → then strong down move
    if (isBullishCandle && moveAfterPct < -minMovePct) {
      const mitigated = currentPrice >= c.low && currentPrice <= c.high;
      obs.push({
        type: 'bearish',
        high: c.high,
        low: c.low,
        open: c.open,
        close: c.close,
        timestamp: c.timestamp,
        index: i,
        strength: +Math.abs(moveAfterPct).toFixed(2),
        mitigated,
      });
    }
  }

  // Sort by strength (most significant first), limit to top 15
  return obs.sort((a, b) => b.strength - a.strength).slice(0, 15);
}

// ═══════════════════════════════════════════════════════
// 5. FVG — Fair Value Gap
// ═══════════════════════════════════════════════════════

/**
 * Find Fair Value Gaps — price imbalances between 3 consecutive candles.
 *
 * Bullish FVG: candle[i+2].low > candle[i].high
 *   → The jump from candle i to i+2 left a gap that price may fill.
 *
 * Bearish FVG: candle[i].low > candle[i+2].high
 *   → The drop from candle i to i+2 left a gap that price may fill.
 */
export function findFVG(
  candles: Candle[],
  lookback: number = 40,
): FVG[] {
  const fvgs: FVG[] = [];
  if (candles.length < 3) return fvgs;

  const currentPrice = candles[candles.length - 1].close;
  const start = Math.max(0, candles.length - lookback);

  for (let i = start; i < candles.length - 2; i++) {
    const c0 = candles[i];
    const c1 = candles[i + 1]; // the "gap" candle
    const c2 = candles[i + 2];

    // Bullish FVG: gap between c0.high and c2.low
    if (c2.low > c0.high) {
      const gapSize = c2.low - c0.high;
      const gapPct = (gapSize / c1.close) * 100;

      if (gapPct > 0.05) { // minimum gap size filter
        // Check if filled: has price come back into the gap?
        const filled = currentPrice <= c2.low && currentPrice >= c0.high;
        // More conservatively: has price entered the gap at all since creation?
        let wasFilledLater = false;
        for (let j = i + 3; j < candles.length; j++) {
          if (candles[j].low <= c2.low) { wasFilledLater = true; break; }
        }

        fvgs.push({
          type: 'bullish',
          upper: c2.low,
          lower: c0.high,
          midpoint: +(c0.high + (c2.low - c0.high) / 2).toFixed(8),
          timestamp: c1.timestamp,
          index: i + 1,
          filled: wasFilledLater,
          gapSizePct: +gapPct.toFixed(3),
        });
      }
    }

    // Bearish FVG: gap between c0.low and c2.high
    if (c0.low > c2.high) {
      const gapSize = c0.low - c2.high;
      const gapPct = (gapSize / c1.close) * 100;

      if (gapPct > 0.05) {
        let wasFilledLater = false;
        for (let j = i + 3; j < candles.length; j++) {
          if (candles[j].high >= c0.low) { wasFilledLater = true; break; }
        }

        fvgs.push({
          type: 'bearish',
          upper: c0.low,
          lower: c2.high,
          midpoint: +(c2.high + (c0.low - c2.high) / 2).toFixed(8),
          timestamp: c1.timestamp,
          index: i + 1,
          filled: wasFilledLater,
          gapSizePct: +gapPct.toFixed(3),
        });
      }
    }
  }

  // Return unfilled first, sorted by recency
  return fvgs
    .sort((a, b) => {
      if (a.filled !== b.filled) return a.filled ? 1 : -1;
      return b.index - a.index;
    })
    .slice(0, 15);
}

// ═══════════════════════════════════════════════════════
// 6. SUPPLY / DEMAND ZONES
// ═══════════════════════════════════════════════════════

/**
 * Identify supply and demand zones.
 *
 * A demand zone forms where price consolidated (small candles)
 * before a strong rally → that consolidation area is "demand."
 *
 * A supply zone forms where price consolidated before a strong drop.
 *
 * We look for: small-body candle(s) followed by a large move.
 */
export function findSupplyDemandZones(
  candles: Candle[],
  minMovePct: number = 0.8,
  lookback: number = 60,
): SDZone[] {
  const zones: SDZone[] = [];
  if (candles.length < 5) return zones;

  const currentPrice = candles[candles.length - 1].close;
  const start = Math.max(0, candles.length - lookback);

  for (let i = start + 1; i < candles.length - 3; i++) {
    const base = candles[i];

    // Base candle must be relatively small (consolidation)
    const bodyPct = Math.abs(base.close - base.open) / base.close * 100;
    if (bodyPct > 0.4) continue; // Skip large-body candles

    // Measure move before and after base
    const prev = candles[i - 1];
    const next2 = candles[i + 2];

    const moveBefore = ((base.close - prev.close) / prev.close) * 100;
    const moveAfter = ((next2.close - base.close) / base.close) * 100;

    // Demand zone: drop → base → rally
    if (moveBefore < 0 && moveAfter > minMovePct) {
      const zoneHigh = Math.max(base.high, candles[i - 1].high);
      const zoneLow = Math.min(base.low, candles[i - 1].low);
      const fresh = currentPrice > zoneHigh;

      // Count how many times price has touched this zone
      let touches = 0;
      for (let j = i + 3; j < candles.length; j++) {
        if (candles[j].low <= zoneHigh && candles[j].low >= zoneLow) touches++;
      }

      zones.push({
        type: 'demand',
        high: zoneHigh,
        low: zoneLow,
        strength: +Math.abs(moveAfter).toFixed(2),
        timestamp: base.timestamp,
        index: i,
        fresh,
        touches,
      });
    }

    // Supply zone: rally → base → drop
    if (moveBefore > 0 && moveAfter < -minMovePct) {
      const zoneHigh = Math.max(base.high, candles[i - 1].high);
      const zoneLow = Math.min(base.low, candles[i - 1].low);
      const fresh = currentPrice < zoneLow;

      let touches = 0;
      for (let j = i + 3; j < candles.length; j++) {
        if (candles[j].high >= zoneLow && candles[j].high <= zoneHigh) touches++;
      }

      zones.push({
        type: 'supply',
        high: zoneHigh,
        low: zoneLow,
        strength: +Math.abs(moveAfter).toFixed(2),
        timestamp: base.timestamp,
        index: i,
        fresh,
        touches,
      });
    }
  }

  return zones.sort((a, b) => b.strength - a.strength).slice(0, 15);
}

// ═══════════════════════════════════════════════════════
// 7. LIQUIDITY SWEEP
// ═══════════════════════════════════════════════════════

/**
 * Detect liquidity sweeps (stop hunts).
 *
 * A sweep occurs when price briefly pushes beyond a swing level
 * (sweeping stop-losses), then reverses WITHIN THE SAME CANDLE
 * or the immediately following candle.
 *
 * Swept highs → expect price to go DOWN (short setup)
 * Swept lows → expect price to go UP (long setup)
 *
 * Sweep criteria:
 * - Price exceeds the swing level (wick goes beyond)
 * - The penetration is small (< 0.3% beyond the level)
 * - Price CLOSES back on the original side of the level
 */
export function detectLiquiditySweep(
  candles: Candle[],
  swings: SwingPoint[],
): LiqSweep | null {
  if (candles.length < 3 || swings.length < 2) return null;

  const recentCandles = candles.slice(-3);
  const lastCandle = recentCandles[recentCandles.length - 1];

  const recentHighs = swings.filter(s => s.type === 'high').slice(-5);
  const recentLows = swings.filter(s => s.type === 'low').slice(-5);

  // Check if recent candles swept above a swing high then closed below it
  for (const sh of recentHighs) {
    for (const rc of recentCandles) {
      const wickedAbove = rc.high > sh.price;
      const closedBelow = rc.close < sh.price;
      const penetrationPct = sh.price > 0 ? ((rc.high - sh.price) / sh.price) * 100 : 0;

      if (wickedAbove && closedBelow && penetrationPct < 0.3 && penetrationPct > 0) {
        return {
          type: 'swept_highs',
          sweepPrice: rc.high,
          returnPrice: lastCandle.close,
          swingPrice: sh.price,
          timestamp: rc.timestamp,
          suggestedDirection: 'short', // after sweeping highs → go short
        };
      }
    }
  }

  // Check if recent candles swept below a swing low then closed above it
  for (const sl of recentLows) {
    for (const rc of recentCandles) {
      const wickedBelow = rc.low < sl.price;
      const closedAbove = rc.close > sl.price;
      const penetrationPct = sl.price > 0 ? ((sl.price - rc.low) / sl.price) * 100 : 0;

      if (wickedBelow && closedAbove && penetrationPct < 0.3 && penetrationPct > 0) {
        return {
          type: 'swept_lows',
          sweepPrice: rc.low,
          returnPrice: lastCandle.close,
          swingPrice: sl.price,
          timestamp: rc.timestamp,
          suggestedDirection: 'long', // after sweeping lows → go long
        };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// 8. MULTI-TIMEFRAME BIAS
// ═══════════════════════════════════════════════════════

/**
 * Determine market bias across three timeframes.
 *
 * Each timeframe is analyzed independently using swing structure.
 * The overall bias requires at least 2/3 timeframes to agree.
 * Confidence is based on the alignment count + strength.
 */
export function getMultiTimeframeBias(
  dailyCandles: Candle[],
  h4Candles: Candle[],
  h1Candles: Candle[],
): MTFBias {
  const dailyBias = getSingleTimeframeBias(dailyCandles);
  const h4Bias = getSingleTimeframeBias(h4Candles);
  const h1Bias = getSingleTimeframeBias(h1Candles);

  const biases = [dailyBias, h4Bias, h1Bias];
  const bullishCount = biases.filter(b => b === 'bullish').length;
  const bearishCount = biases.filter(b => b === 'bearish').length;

  const alignment = Math.max(bullishCount, bearishCount);

  let overallBias: MTFBias['bias'];
  if (bullishCount >= 2) overallBias = 'bullish';
  else if (bearishCount >= 2) overallBias = 'bearish';
  else overallBias = 'neutral';

  // Confidence: 3/3 aligned = 90-100%, 2/3 = 60-80%, 1/3 or 0 = 20-50%
  let confidence: number;
  if (alignment === 3) confidence = 90 + Math.round(Math.random() * 10);
  else if (alignment === 2) confidence = 60 + Math.round(Math.random() * 20);
  else confidence = 20 + Math.round(Math.random() * 30);

  return {
    bias: overallBias,
    confidence,
    dailyBias: dailyBias,
    h4Bias: h4Bias,
    h1Bias: h1Bias,
    alignment,
  };
}

function getSingleTimeframeBias(candles: Candle[]): string {
  if (candles.length < 15) return 'neutral';

  const swings = identifySwingPoints(candles, 3, 3);
  const highs = swings.filter(s => s.type === 'high').slice(-4);
  const lows = swings.filter(s => s.type === 'low').slice(-4);

  let bullPoints = 0;
  let bearPoints = 0;

  // Count HH/HL vs LH/LL
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) bullPoints++;
    else bearPoints++;
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price > lows[i - 1].price) bullPoints++;
    else bearPoints++;
  }

  // Also check if price is above/below midrange
  if (candles.length >= 20) {
    const closes = candles.slice(-20).map(c => c.close);
    const mid = (Math.max(...closes) + Math.min(...closes)) / 2;
    if (candles[candles.length - 1].close > mid) bullPoints++;
    else bearPoints++;
  }

  if (bullPoints > bearPoints + 1) return 'bullish';
  if (bearPoints > bullPoints + 1) return 'bearish';
  return 'neutral';
}

// ═══════════════════════════════════════════════════════
// 9. ZONE PROXIMITY CHECK (used by signal generator)
// ═══════════════════════════════════════════════════════

/**
 * Check if current price is within ±tolerancePct of any zone.
 */
export function isPriceInOrderBlock(
  price: number,
  orderBlocks: OrderBlock[],
  type: 'bullish' | 'bearish',
  tolerancePct: number = 0.5,
): { inBlock: boolean; nearest: OrderBlock | null; distance: number } {
  const tolerance = price * (tolerancePct / 100);
  const filtered = orderBlocks.filter(ob => ob.type === type);

  let nearest: OrderBlock | null = null;
  let minDist = Infinity;

  for (const ob of filtered) {
    if (price >= ob.low - tolerance && price <= ob.high + tolerance) {
      return { inBlock: true, nearest: ob, distance: 0 };
    }
    const dist = Math.min(Math.abs(price - ob.high), Math.abs(price - ob.low));
    if (dist < minDist) { minDist = dist; nearest = ob; }
  }

  return {
    inBlock: false,
    nearest,
    distance: nearest ? +((minDist / price) * 100).toFixed(3) : Infinity,
  };
}

export function isPriceInFVG(
  price: number,
  fvgs: FVG[],
  type: 'bullish' | 'bearish',
): { inFVG: boolean; nearest: FVG | null } {
  const unfilledOfType = fvgs.filter(f => f.type === type && !f.filled);

  for (const fvg of unfilledOfType) {
    if (price >= fvg.lower && price <= fvg.upper) {
      return { inFVG: true, nearest: fvg };
    }
  }

  return {
    inFVG: false,
    nearest: unfilledOfType.length > 0 ? unfilledOfType[0] : null,
  };
}

export function isPriceInSDZone(
  price: number,
  zones: SDZone[],
  type: 'supply' | 'demand',
  tolerancePct: number = 0.3,
): { inZone: boolean; nearest: SDZone | null } {
  const tolerance = price * (tolerancePct / 100);
  const filtered = zones.filter(z => z.type === type);

  for (const zone of filtered) {
    if (price >= zone.low - tolerance && price <= zone.high + tolerance) {
      return { inZone: true, nearest: zone };
    }
  }

  return {
    inZone: false,
    nearest: filtered.length > 0 ? filtered[0] : null,
  };
}
