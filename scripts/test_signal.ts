// backend/scripts/test_signal.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 訊號生成測試
// 執行方式：npx tsx scripts/test_signal.ts
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import axios from 'axios';
import { ATR, RSI, MACD, EMA, BollingerBands } from 'technicalindicators';

const M = '\x1b[36m'; // Cyan
const G = '\x1b[32m'; // Green
const R = '\x1b[31m'; // Red
const Y = '\x1b[33m'; // Yellow
const W = '\x1b[37m'; // White
const X = '\x1b[0m';  // Reset

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  SmartFlow Pro — 訊號生成完整測試');
  console.log('══════════════════════════════════════════');
  console.log('');

  // ─── Fetch real BTC 1H klines ───
  console.log(`${M}[1/7] 取得 BTC/USDT 1H K線...${X}`);
  const { data: klines } = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol: 'BTCUSDT', interval: '1h', limit: 200 },
    timeout: 15000,
  });

  const candles = klines.map((k: any[]) => ({
    timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));

  const highs = candles.map((c: any) => c.high);
  const lows = candles.map((c: any) => c.low);
  const closes = candles.map((c: any) => c.close);
  const volumes = candles.map((c: any) => c.volume);
  const currentPrice = closes[closes.length - 1];

  console.log(`  ${G}✅ ${candles.length} 根 1H K線${X}`);
  console.log(`  當前價格: ${W}$${currentPrice.toLocaleString()}${X}`);
  console.log('');

  // ─── ATR ───
  console.log(`${M}[2/7] 計算 ATR(14) — 使用 1H OHLC...${X}`);
  const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrResult[atrResult.length - 1];
  const atrPct = (atr / currentPrice) * 100;

  console.log(`  ATR = ${W}$${atr.toFixed(2)}${X} (${atrPct.toFixed(3)}% of price)`);
  if (atr >= 300 && atr <= 2000) {
    console.log(`  ${G}✅ ATR 在合理範圍 ($300-$2000)${X}`);
  } else if (atr < 50) {
    console.log(`  ${R}❌ ATR 異常偏低！可能使用了錯誤的時間框架${X}`);
  } else {
    console.log(`  ${Y}⚠️ ATR 略為異常，但可接受${X}`);
  }
  console.log('');

  // ─── Stop Levels ───
  console.log(`${M}[3/7] 計算止盈止損（ATR 乘數法）...${X}`);
  const slDist = atr * 1.5;
  const tp1Dist = atr * 2.0;
  const tp2Dist = atr * 3.0;

  // Test both directions
  for (const dir of ['做多 (LONG)', '做空 (SHORT)']) {
    const isLong = dir.includes('LONG');
    const entry = currentPrice;
    const sl  = isLong ? entry - slDist : entry + slDist;
    const tp1 = isLong ? entry + tp1Dist : entry - tp1Dist;
    const tp2 = isLong ? entry + tp2Dist : entry - tp2Dist;
    const rr  = tp1Dist / slDist;

    console.log(`  ┌─ ${W}${dir}${X}`);
    console.log(`  │ Entry: $${entry.toFixed(1)}`);
    console.log(`  │ TP1:   ${G}$${tp1.toFixed(1)} (+$${tp1Dist.toFixed(0)}, +${(tp1Dist/entry*100).toFixed(2)}%)${X}`);
    console.log(`  │ TP2:   ${G}$${tp2.toFixed(1)} (+$${tp2Dist.toFixed(0)}, +${(tp2Dist/entry*100).toFixed(2)}%)${X}`);
    console.log(`  │ SL:    ${R}$${sl.toFixed(1)} (-$${slDist.toFixed(0)}, -${(slDist/entry*100).toFixed(2)}%)${X}`);
    console.log(`  │ R:R:   ${Y}1:${rr.toFixed(2)}${X} ${rr >= 1.8 ? G + '✅ PASS' : R + '❌ REJECT (< 1.8)'}${X}`);
    console.log(`  └─`);
    console.log('');
  }

  // ─── RSI ───
  console.log(`${M}[4/7] RSI(14)...${X}`);
  const rsiResult = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiResult[rsiResult.length - 1];
  const rsiColor = rsi > 70 ? R : rsi < 30 ? G : W;
  console.log(`  RSI = ${rsiColor}${rsi.toFixed(1)}${X}`);
  console.log(`  做多: ${rsi < 70 ? G + '✅ 允許' : R + '❌ 屏蔽 (RSI ≥ 70)'}${X}`);
  console.log(`  做空: ${rsi > 30 ? G + '✅ 允許' : R + '❌ 屏蔽 (RSI ≤ 30)'}${X}`);
  console.log('');

  // ─── EMA ───
  console.log(`${M}[5/7] EMA 排列...${X}`);
  const ema20 = EMA.calculate({ values: closes, period: 20 });
  const ema50 = EMA.calculate({ values: closes, period: 50 });
  const ema200 = EMA.calculate({ values: closes, period: Math.min(200, closes.length) });
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const e200 = ema200[ema200.length - 1];
  const emaAlign = e20 > e50 && e50 > e200 ? '多頭排列 (Bullish)' :
                   e20 < e50 && e50 < e200 ? '空頭排列 (Bearish)' : '無明確排列 (Neutral)';
  console.log(`  EMA20: $${e20.toFixed(0)} | EMA50: $${e50.toFixed(0)} | EMA200: $${e200.toFixed(0)}`);
  console.log(`  排列: ${emaAlign.includes('Bullish') ? G : emaAlign.includes('Bearish') ? R : Y}${emaAlign}${X}`);
  console.log('');

  // ─── MACD ───
  console.log(`${M}[6/7] MACD(12,26,9)...${X}`);
  const macdResult = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macdLatest = macdResult[macdResult.length - 1];
  if (macdLatest && macdLatest.histogram !== undefined) {
    const h = macdLatest.histogram;
    console.log(`  Histogram: ${h > 0 ? G + '+' : R}${h.toFixed(2)}${X} → ${h > 0 ? '看多' : '看空'}`);
  }
  console.log('');

  // ─── Scoring Simulation ───
  console.log(`${M}[7/7] 13 項條件評分模擬...${X}`);
  const conditions: [string, boolean][] = [
    ['MTF 多時間框架', true], // Simplified for test
    ['BOS 結構突破', closes[closes.length - 1] > Math.max(...closes.slice(-20, -3))],
    ['ChoCH 反轉', false],
    ['Order Block', Math.random() > 0.4],
    ['FVG 缺口', Math.random() > 0.5],
    ['供需區 S/D', Math.random() > 0.5],
    ['Liquidity Sweep', Math.random() > 0.6],
    ['EMA 排列', e20 > e50 && e50 > e200],
    ['RSI 健康', rsi >= 40 && rsi <= 65],
    ['MACD 同向', (macdLatest?.histogram || 0) > 0],
    ['VWAP 偏向', true],
    ['成交量確認', volumes[volumes.length - 1] > volumes.slice(-21, -1).reduce((a: number, b: number) => a + b, 0) / 20 * 1.5],
    ['R:R ≥ 2', tp1Dist / slDist >= 2.0],
  ];

  let score = 0;
  conditions.forEach(([name, pass]) => {
    if (pass) score++;
    console.log(`  ${pass ? G + '✓' : R + '✗'}${X} ${name}`);
  });

  const scoreLabel = score >= 8 ? 'STRONG 強訊號' : score >= 5 ? 'NORMAL 普通' : 'WEAK 弱 (不發出)';
  const scoreColor = score >= 8 ? G : score >= 5 ? Y : R;

  console.log('');
  console.log(`  ═══════════════════════════════`);
  console.log(`  總分: ${scoreColor}${score}/13 — ${scoreLabel}${X}`);
  console.log(`  ${score >= 5 ? G + '✅ 訊號會被發出' : R + '❌ 訊號被過濾 (< 5 分)'}${X}`);
  console.log(`  ═══════════════════════════════`);

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  測試完成');
  console.log('══════════════════════════════════════════');
  console.log('');

  process.exit(0);
}

main().catch(err => { console.error('Test failed:', err.message); process.exit(1); });
