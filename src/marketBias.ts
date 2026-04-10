import { Router, Request, Response } from 'express';

const router = Router();

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const TIMEFRAMES = ['15m', '1h', '4h'];

// ===== Indicator Helpers =====

function calcEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  if (closes.length === 0) return ema;
  const k = 2 / (period + 1);
  ema[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function detectStructure(closes: number[]): 'bullish' | 'bearish' | 'neutral' {
  // Simple higher-high/lower-low detection on last ~20 candles
  if (closes.length < 20) return 'neutral';
  const recent = closes.slice(-20);
  
  // Find swing points (simple: compare to neighbors)
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] &&
        recent[i] > recent[i+1] && recent[i] > recent[i+2]) {
      swingHighs.push(recent[i]);
    }
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] &&
        recent[i] < recent[i+1] && recent[i] < recent[i+2]) {
      swingLows.push(recent[i]);
    }
  }

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hhCount = swingHighs[swingHighs.length-1] > swingHighs[swingHighs.length-2];
    const hlCount = swingLows[swingLows.length-1] > swingLows[swingLows.length-2];
    const llCount = swingLows[swingLows.length-1] < swingLows[swingLows.length-2];
    const lhCount = swingHighs[swingHighs.length-1] < swingHighs[swingHighs.length-2];
    
    if (hhCount && hlCount) return 'bullish';
    if (llCount && lhCount) return 'bearish';
  }

  return 'neutral';
}

// ===== Single timeframe bias =====

function calcTimeframeBias(closes: number[]): { bias: 'LONG' | 'SHORT' | 'WAIT'; ema9: number; ema21: number; rsi: number; structure: string } {
  if (closes.length < 30) {
    return { bias: 'WAIT', ema9: 0, ema21: 0, rsi: 50, structure: 'neutral' };
  }

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes);
  const structure = detectStructure(closes);

  const lastEma9 = ema9[ema9.length - 1];
  const lastEma21 = ema21[ema21.length - 1];
  const price = closes[closes.length - 1];

  let score = 0;

  // EMA cross
  if (lastEma9 > lastEma21) score += 1;
  else if (lastEma9 < lastEma21) score -= 1;

  // Price vs EMA21
  if (price > lastEma21) score += 1;
  else if (price < lastEma21) score -= 1;

  // RSI
  if (rsi > 55) score += 1;
  else if (rsi < 45) score -= 1;

  // Structure
  if (structure === 'bullish') score += 1;
  else if (structure === 'bearish') score -= 1;

  let bias: 'LONG' | 'SHORT' | 'WAIT' = 'WAIT';
  if (score >= 2) bias = 'LONG';
  else if (score <= -2) bias = 'SHORT';

  return { bias, ema9: lastEma9, ema21: lastEma21, rsi, structure };
}

// ===== Fetch klines from Binance =====

async function fetchKlines(symbol: string, interval: string, limit = 100): Promise<number[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Fallback to main API
      const res2 = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!res2.ok) throw new Error(`Binance API error: ${res2.status}`);
      const data = await res2.json();
      return (data as any[]).map((k: any) => parseFloat(k[4])); // close price
    }
    const data = await res.json();
    return (data as any[]).map((k: any) => parseFloat(k[4]));
  } catch (err: any) {
    console.error(`[MarketBias] Failed to fetch ${symbol} ${interval}:`, err.message);
    return [];
  }
}

// ===== Multi-timeframe analysis =====

async function analyzeSymbol(symbol: string) {
  const results: Record<string, any> = {};

  // Fetch all timeframes in parallel
  const [closes15m, closes1h, closes4h] = await Promise.all([
    fetchKlines(symbol, '15m', 100),
    fetchKlines(symbol, '1h', 100),
    fetchKlines(symbol, '4h', 100),
  ]);

  results['15m'] = calcTimeframeBias(closes15m);
  results['1h'] = calcTimeframeBias(closes1h);
  results['4h'] = calcTimeframeBias(closes4h);

  // Overall bias: at least 2 timeframes agree → that direction
  const biases = [results['15m'].bias, results['1h'].bias, results['4h'].bias];
  const longCount = biases.filter(b => b === 'LONG').length;
  const shortCount = biases.filter(b => b === 'SHORT').length;

  let overall: 'LONG' | 'SHORT' | 'WAIT' = 'WAIT';
  if (longCount >= 2) overall = 'LONG';
  else if (shortCount >= 2) overall = 'SHORT';

  // Confidence: 3/3 = high, 2/3 = medium
  let confidence = 'low';
  if (longCount === 3 || shortCount === 3) confidence = 'high';
  else if (longCount === 2 || shortCount === 2) confidence = 'medium';

  return {
    symbol,
    overall,
    confidence,
    timeframes: results,
    updatedAt: new Date().toISOString()
  };
}

// Cache to avoid hammering Binance
let biasCache: any[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 30000; // 30s

router.get('/market-bias', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (biasCache.length > 0 && now - lastFetchTime < CACHE_TTL) {
      return res.json({ success: true, data: biasCache, cached: true });
    }

    const results = await Promise.all(
      SYMBOLS.map(s => analyzeSymbol(s))
    );

    biasCache = results;
    lastFetchTime = now;

    return res.json({ success: true, data: results, cached: false });
  } catch (err: any) {
    console.error('[MarketBias] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
