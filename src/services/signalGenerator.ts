// backend/src/services/signalGenerator.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 訊號生成器（13 項條件評分系統）
// ═══════════════════════════════════════════════════════════════
//
// 嚴格按照 20 步流程生成高品質交易訊號。
// score < 5 → 不發出 · 5-7 → normal · 8+ → strong
// R:R < 1.8 → 不發出 · RSI 超買/超賣做多/做空 → 屏蔽
// ═══════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import pg from 'pg';
import type { Candle } from './marketData';
import { MarketDataService } from './marketData';
import { config } from '../config/index';
import {
  calculateATR, calculateStopLevels,
  calculateEMABundle, getEMAAlignment,
  calculateRSI, getRSISignal, calculateRSIArray, detectRSIDivergence,
  calculateMACD,
  calculateVWAP, getVWAPBias,
  analyzeVolume,
  getFundingRate,
} from './indicators';
import {
  identifySwingPoints, detectBOS, detectChoCH,
  findOrderBlocks, findFVG, findSupplyDemandZones,
  detectLiquiditySweep, getMultiTimeframeBias,
  isPriceInOrderBlock, isPriceInFVG, isPriceInSDZone,
} from './smcEngine';
import type { RiskMonitor } from './riskMonitor';

const TC = config.trading;

// ═══ Types ═══

export interface SignalConditions {
  mtfAligned: boolean;
  bosConfirmed: boolean;
  chochDetected: boolean;
  inOrderBlock: boolean;
  hasFVG: boolean;
  inSDZone: boolean;
  liquiditySweep: boolean;
  emaAligned: boolean;
  rsiHealthy: boolean;
  macdAligned: boolean;
  vwapBias: boolean;
  volumeConfirmed: boolean;
  rrAbove2: boolean;
}

export interface Signal {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  timestamp: number;
  entry: number;
  tp1: number; tp1Pct: number;
  tp2: number; tp2Pct: number;
  sl: number; slPct: number;
  rr: number; atr: number;
  score: number;
  scoreLabel: 'strong' | 'normal' | 'weak';
  conditions: SignalConditions;
  warnings: string[];
  estimatedHoldTime: string;
  smartMoneyAligned: boolean | null;
  // Indicator snapshot
  rsiValue: number | null;
  macdHistogram: number | null;
  emaAlignment: string;
  vwapBiasStr: string | null;
  volumeRatio: number;
  fundingRate: number | null;
}

// Track deduplication: symbol:direction → last emit timestamp
const lastEmitted = new Map<string, number>();
const DEDUP_WINDOW = 3600_000; // 1 hour

// ═══════════════════════════════════════════════════════
// MAIN SIGNAL GENERATION
// ═══════════════════════════════════════════════════════

export class SignalGenerator {
  private marketData: MarketDataService;
  private pool: pg.Pool;
  private riskMonitor: RiskMonitor;
  private broadcastFn: ((msg: any) => void) | null = null;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(marketData: MarketDataService, pool: pg.Pool, riskMonitor: RiskMonitor) {
    this.marketData = marketData;
    this.pool = pool;
    this.riskMonitor = riskMonitor;
  }

  setBroadcast(fn: (msg: any) => void): void {
    this.broadcastFn = fn;
  }

  /**
   * Generate a signal for a specific symbol and direction.
   * Follows the strict 20-step evaluation process.
   * Returns null if the signal doesn't pass all filters.
   */
  async generateSignal(
    symbol: string,
    direction: 'long' | 'short',
  ): Promise<Signal | null> {
    const symLower = symbol.toLowerCase();

    // ═══ STEP 1: Get candle data ═══
    const candles1h = this.marketData.getCandles(symLower, '1h');

    if (candles1h.length < 50) {
      return null; // Insufficient data
    }

    const currentPrice = candles1h[candles1h.length - 1].close;

    // For MTF: simulate daily from 1H (24 candles per day),
    // and 4H from 1H (4 candles per 4H bar)
    const pseudoDaily = this.resampleCandles(candles1h, 24);
    const pseudo4h = this.resampleCandles(candles1h, 4);

    // ═══ STEP 2: Multi-timeframe bias ═══
    const mtfBias = getMultiTimeframeBias(pseudoDaily, pseudo4h, candles1h);
    const mtfAligned = (direction === 'long' && mtfBias.bias === 'bullish') ||
                       (direction === 'short' && mtfBias.bias === 'bearish');

    // If MTF strongly disagrees (confidence > 70%), reject
    if (!mtfAligned && mtfBias.bias !== 'neutral' && mtfBias.confidence > 70) {
      return null;
    }

    // ═══ STEP 3: BOS + ChoCH ═══
    const swings = identifySwingPoints(candles1h);
    const bos = detectBOS(candles1h, swings);
    const choch = detectChoCH(candles1h, swings);

    const bosConfirmed = bos !== null && (
      (direction === 'long' && bos.direction === 'bullish') ||
      (direction === 'short' && bos.direction === 'bearish')
    );
    const chochDetected = choch !== null && (
      (direction === 'long' && choch.direction === 'bullish') ||
      (direction === 'short' && choch.direction === 'bearish')
    );

    // At least one structure confirmation required
    if (!bosConfirmed && !chochDetected) {
      // Don't hard-reject — it costs points in scoring
    }

    // ═══ STEP 4: Order Blocks ═══
    const orderBlocks = findOrderBlocks(candles1h);
    const obType = direction === 'long' ? 'bullish' : 'bearish';
    const obCheck = isPriceInOrderBlock(currentPrice, orderBlocks, obType);
    const inOrderBlock = obCheck.inBlock;

    // ═══ STEP 5: FVG ═══
    const fvgs = findFVG(candles1h);
    const fvgType = direction === 'long' ? 'bullish' : 'bearish';
    const fvgCheck = isPriceInFVG(currentPrice, fvgs, fvgType);
    const hasFVG = fvgCheck.inFVG || (fvgCheck.nearest !== null && !fvgCheck.nearest.filled);

    // ═══ STEP 6: Supply/Demand Zones ═══
    const sdZones = findSupplyDemandZones(candles1h);
    const sdType = direction === 'long' ? 'demand' : 'supply';
    const sdCheck = isPriceInSDZone(currentPrice, sdZones, sdType);
    const inSDZone = sdCheck.inZone;

    // ═══ STEP 7: Liquidity Sweep ═══
    const liqSweep = detectLiquiditySweep(candles1h, swings);
    const liquiditySweep = liqSweep !== null && liqSweep.suggestedDirection === direction;

    // ═══ STEP 8: EMA ═══
    const emaBundle = calculateEMABundle(candles1h);
    const emaAligned = (direction === 'long' && emaBundle.alignment === 'bullish') ||
                       (direction === 'short' && emaBundle.alignment === 'bearish');

    // ═══ STEP 9: RSI ═══
    const rsiValue = calculateRSI(candles1h);
    const rsiSignal = rsiValue !== null ? getRSISignal(rsiValue, direction) : { valid: true, warning: null };

    // ═══ RSI HARD FILTER ═══
    // If RSI says invalid, this signal is blocked entirely
    if (!rsiSignal.valid) {
      return null;
    }

    const rsiHealthy = rsiValue !== null && (
      direction === 'long'
        ? (rsiValue >= TC.rsi.longIdealMin && rsiValue <= TC.rsi.longIdealMax)
        : (rsiValue >= TC.rsi.shortIdealMin && rsiValue <= TC.rsi.shortIdealMax)
    );

    // ═══ STEP 10: MACD ═══
    const macd = calculateMACD(candles1h);
    const macdAligned = macd !== null && (
      (direction === 'long' && macd.direction === 'bullish') ||
      (direction === 'short' && macd.direction === 'bearish')
    );

    // ═══ STEP 11: VWAP ═══
    const vwap = calculateVWAP(candles1h);
    const vwapBiasStr = vwap ? getVWAPBias(currentPrice, vwap) : null;
    const vwapOk = (direction === 'long' && vwapBiasStr === 'above') ||
                   (direction === 'short' && vwapBiasStr === 'below');

    // ═══ STEP 12: Volume ═══
    const vol = analyzeVolume(candles1h);
    const volumeConfirmed = vol.confirmed;

    // ═══ STEP 13: ATR (from 1H candles — CRITICAL) ═══
    const atr = calculateATR(candles1h);
    if (atr === null) {
      return null; // Can't calculate stops without ATR
    }

    // ═══ STEP 14: Stop levels ═══
    const levels = calculateStopLevels(currentPrice, atr, direction);
    if (levels === null) {
      // R:R < 1.8 — signal rejected
      return null;
    }

    const rrAbove2 = levels.rr >= 2.0;

    // ═══ STEP 15: Score (13 conditions) ═══
    const conditions: SignalConditions = {
      mtfAligned,
      bosConfirmed,
      chochDetected,
      inOrderBlock,
      hasFVG,
      inSDZone,
      liquiditySweep,
      emaAligned,
      rsiHealthy,
      macdAligned,
      vwapBias: vwapOk,
      volumeConfirmed,
      rrAbove2,
    };

    let score = Object.values(conditions).filter(Boolean).length;

    // RSI penalty: if RSI has a warning (but is still valid), deduct 2
    if (rsiSignal.warning && rsiSignal.valid) {
      score = Math.max(0, score - 2);
    }

    // ═══ STEP 16: Score filter ═══
    if (score < 5) {
      return null; // Too low quality
    }

    // ═══ STEP 17-18: Score label ═══
    let scoreLabel: Signal['scoreLabel'];
    if (score >= 8) scoreLabel = 'strong';
    else if (score >= 5) scoreLabel = 'normal';
    else scoreLabel = 'weak'; // shouldn't reach here due to filter above

    // ═══ STEP 19: Warnings ═══
    const warnings: string[] = [];
    if (rsiSignal.warning) warnings.push(rsiSignal.warning);

    const fundingRate = await getFundingRate(symbol).catch(() => null);
    if (fundingRate !== null) {
      if (direction === 'long' && fundingRate > 0.05) {
        warnings.push(`⚠️ 資金費率 ${fundingRate.toFixed(4)}% 偏高，多頭持倉成本過高`);
      }
      if (direction === 'short' && fundingRate < -0.05) {
        warnings.push(`⚠️ 資金費率 ${fundingRate.toFixed(4)}% 偏低，強烈空頭情緒，反彈風險`);
      }
    }

    // Estimated hold time based on ATR as % of price
    const atrPct = (atr / currentPrice) * 100;
    let estimatedHoldTime: string;
    if (atrPct > 3) estimatedHoldTime = '2-6 小時';
    else if (atrPct > 1.5) estimatedHoldTime = '6-12 小時';
    else if (atrPct > 0.8) estimatedHoldTime = '12-24 小時';
    else estimatedHoldTime = '1-3 天';

    // ═══ Build Signal ═══
    const signal: Signal = {
      id: uuidv4(),
      symbol: symbol.toUpperCase(),
      direction,
      timestamp: Date.now(),
      entry: currentPrice,
      tp1: levels.tp1,
      tp1Pct: levels.tp1Pct,
      tp2: levels.tp2,
      tp2Pct: levels.tp2Pct,
      sl: levels.sl,
      slPct: levels.slPct,
      rr: levels.rr,
      atr: +atr.toFixed(getPriceDecimals(currentPrice)),
      score,
      scoreLabel,
      conditions,
      warnings,
      estimatedHoldTime,
      smartMoneyAligned: null, // Will be set by integration layer
      rsiValue,
      macdHistogram: macd?.histogram ?? null,
      emaAlignment: emaBundle.alignment,
      vwapBiasStr,
      volumeRatio: vol.ratio,
      fundingRate,
    };

    // ═══ STEP 20: Persist + Broadcast ═══
    await this.persistSignal(signal);
    this.broadcastSignal(signal);

    console.log(
      `[SignalGen] ✅ ${signal.symbol} ${signal.direction.toUpperCase()} ` +
      `Score:${signal.score}/13(${signal.scoreLabel}) ` +
      `Entry:${signal.entry} TP1:${signal.tp1}(+${signal.tp1Pct}%) ` +
      `TP2:${signal.tp2}(+${signal.tp2Pct}%) SL:${signal.sl}(-${signal.slPct}%) ` +
      `R:R:${signal.rr} ATR:${signal.atr}`
    );

    return signal;
  }

  // ═══════════════════════════════════════════════════════
  // SCAN ALL SYMBOLS
  // ═══════════════════════════════════════════════════════

  /**
   * Scan all tracked symbols for both long and short signals.
   * Respects deduplication: same symbol+direction only once per hour.
   */
  async scanAllSymbols(): Promise<Signal[]> {
    const signals: Signal[] = [];

    for (const sym of config.symbols) {
      for (const dir of ['long', 'short'] as const) {
        // Dedup check
        const dedupKey = `${sym}:${dir}`;
        const lastTime = lastEmitted.get(dedupKey);
        if (lastTime && Date.now() - lastTime < DEDUP_WINDOW) {
          continue; // Skip — already emitted within 1 hour
        }

        try {
          const signal = await this.generateSignal(sym, dir);
          if (signal) {
            signals.push(signal);
            lastEmitted.set(dedupKey, Date.now());
          }
        } catch (err) {
          console.error(`[SignalGen] Error scanning ${sym} ${dir}:`, (err as Error).message);
        }
      }
    }

    if (signals.length > 0) {
      console.log(`[SignalGen] Scan complete: ${signals.length} signals from ${config.symbols.length} symbols`);
    }

    return signals;
  }

  /**
   * Start the cron-based scanner.
   * Runs every 5 minutes.
   */
  startScanner(): void {
    // "At every 5th minute"
    this.cronJob = cron.schedule('*/5 * * * *', async () => {
      console.log(`[SignalGen] Cron scan triggered at ${new Date().toISOString()}`);
      await this.scanAllSymbols();
    });

    console.log('[SignalGen] ✓ Cron scanner started (every 5 minutes)');

    // Also run immediately on start (after 10s delay for data to load)
    setTimeout(() => {
      console.log('[SignalGen] Running initial scan...');
      this.scanAllSymbols().catch(err => console.error('[SignalGen] Initial scan error:', err));
    }, 10_000);
  }

  stopScanner(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    console.log('[SignalGen] Scanner stopped');
  }

  // ═══════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════

  private async persistSignal(signal: Signal): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO signals (
          id, symbol, direction, entry, tp1, tp1_pct, tp2, tp2_pct,
          sl, sl_pct, rr, atr, score, score_label, conditions, warnings,
          rsi_value, macd_histogram, ema_alignment, vwap_bias, volume_ratio,
          bos_confirmed, choch_detected, in_order_block, has_fvg, liq_sweep,
          status, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21,
          $22, $23, $24, $25, $26,
          'pending', NOW()
        )`,
        [
          signal.id, signal.symbol, signal.direction,
          signal.entry, signal.tp1, signal.tp1Pct, signal.tp2, signal.tp2Pct,
          signal.sl, signal.slPct, signal.rr, signal.atr,
          signal.score, signal.scoreLabel,
          JSON.stringify(signal.conditions), signal.warnings,
          signal.rsiValue, signal.macdHistogram,
          signal.emaAlignment, signal.vwapBiasStr, signal.volumeRatio,
          signal.conditions.bosConfirmed, signal.conditions.chochDetected,
          signal.conditions.inOrderBlock, signal.conditions.hasFVG,
          signal.conditions.liquiditySweep,
        ],
      );
    } catch (err) {
      console.error('[SignalGen] DB insert error:', (err as Error).message);
    }
  }

  private broadcastSignal(signal: Signal): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: 'SIGNAL_UPDATE',
        data: signal,
        timestamp: Date.now(),
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

  /**
   * Resample 1H candles into larger timeframes.
   * Used to simulate daily/4H when we only have 1H data.
   */
  private resampleCandles(candles: Candle[], barsPerGroup: number): Candle[] {
    const resampled: Candle[] = [];
    for (let i = 0; i + barsPerGroup <= candles.length; i += barsPerGroup) {
      const group = candles.slice(i, i + barsPerGroup);
      resampled.push({
        symbol: group[0].symbol,
        timestamp: group[0].timestamp,
        open: group[0].open,
        high: Math.max(...group.map(c => c.high)),
        low: Math.min(...group.map(c => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((sum, c) => sum + c.volume, 0),
        quoteVolume: group.reduce((sum, c) => sum + c.quoteVolume, 0),
        isClosed: true,
      });
    }
    return resampled;
  }
}

function getPriceDecimals(price: number): number {
  if (price >= 10000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 6;
}
