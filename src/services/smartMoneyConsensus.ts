// backend/src/services/smartMoneyConsensus.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 聰明錢共識指標
// ═══════════════════════════════════════════════════════════════
//
// 統計聰明錢淨流向 → bullish / bearish / neutral + confidence
// 判定邏輯：
//   淨流出(吸籌) > 淨流入(賣壓) × 1.5 → bullish
//   淨流入(賣壓) > 淨流出(吸籌) × 1.5 → bearish
//   其他 → neutral
// ═══════════════════════════════════════════════════════════════

import { SmartMoneyService, SmartMoneyTx } from './smartMoney';

export type ConsensusDirection = 'bullish' | 'bearish' | 'neutral';

export interface SmartMoneyConsensus {
  direction: ConsensusDirection;
  bullishVolume: number;
  bearishVolume: number;
  netFlow: number;
  confidence: number;        // 0-100
  txCount: number;
  detail: string;
  periodHours: number;
}

export class SmartMoneyConsensusService {
  private smartMoney: SmartMoneyService;

  constructor(smartMoney: SmartMoneyService) {
    this.smartMoney = smartMoney;
  }

  /**
   * Calculate consensus for a specific symbol/token.
   *
   * @param symbol - "BTCUSDT" or "BTC" (flexible matching)
   * @param hours - Lookback window (default 4 hours)
   */
  calculateConsensus(symbol: string, hours: number = 4): SmartMoneyConsensus {
    const txs = this.smartMoney.getTransactionsSince(hours);
    const token = symbol.toUpperCase().replace('USDT', '');

    // Filter for this token + stablecoins (stablecoin flows affect entire market)
    const relevant = txs.filter(tx =>
      tx.token === token ||
      tx.relatedSignalSymbol?.includes(token) ||
      ['USDT', 'USDC'].includes(tx.token)
    );

    return this.computeFromTxs(relevant, hours);
  }

  /**
   * Calculate consensus for ALL tracked symbols + overall market.
   */
  calculateAll(hours: number = 4): Record<string, SmartMoneyConsensus> {
    const tokens = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
    const result: Record<string, SmartMoneyConsensus> = {};

    for (const token of tokens) {
      result[token] = this.calculateConsensus(token, hours);
    }

    // Overall market
    result['MARKET'] = this.calculateMarket(hours);

    return result;
  }

  /**
   * Overall market consensus (all tokens combined).
   */
  calculateMarket(hours: number = 4): SmartMoneyConsensus {
    const txs = this.smartMoney.getTransactionsSince(hours);
    return this.computeFromTxs(txs, hours);
  }

  // ═══════════════════════════════════════

  private computeFromTxs(txs: SmartMoneyTx[], hours: number): SmartMoneyConsensus {
    const buys = txs.filter(t => t.type === 'accumulation');
    const sells = txs.filter(t => t.type === 'sell_pressure');

    const bullishVolume = buys.reduce((sum, t) => sum + t.usdValue, 0);
    const bearishVolume = sells.reduce((sum, t) => sum + t.usdValue, 0);
    const netFlow = bullishVolume - bearishVolume;
    const totalVolume = bullishVolume + bearishVolume;

    // Direction
    const RATIO = 1.5;
    let direction: ConsensusDirection;
    if (totalVolume === 0) {
      direction = 'neutral';
    } else if (bullishVolume > bearishVolume * RATIO) {
      direction = 'bullish';
    } else if (bearishVolume > bullishVolume * RATIO) {
      direction = 'bearish';
    } else {
      direction = 'neutral';
    }

    // Confidence (0-100)
    let confidence = 0;
    if (totalVolume > 0) {
      // Factor 1: Ratio strength (0-50)
      const ratio = Math.max(bullishVolume, bearishVolume) /
                    Math.max(Math.min(bullishVolume, bearishVolume), 1);
      const ratioScore = Math.min(50, (ratio - 1) * 25);

      // Factor 2: Transaction count (0-30)
      const countScore = Math.min(30, (buys.length + sells.length) * 5);

      // Factor 3: Volume magnitude (0-20)
      const volScore = Math.min(20, totalVolume / 1_000_000 * 2);

      confidence = Math.round(Math.min(100, ratioScore + countScore + volScore));
    }

    // Detail string
    const fmtVol = (v: number) =>
      v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`;

    const detail =
      `${hours}h: 吸籌 ${fmtVol(bullishVolume)}(${buys.length}筆) | ` +
      `賣壓 ${fmtVol(bearishVolume)}(${sells.length}筆) | ` +
      `淨流向 ${netFlow >= 0 ? '+' : ''}${fmtVol(Math.abs(netFlow))}`;

    return {
      direction,
      bullishVolume,
      bearishVolume,
      netFlow,
      confidence,
      txCount: buys.length + sells.length,
      detail,
      periodHours: hours,
    };
  }

  /**
   * Get a detailed breakdown by token, wallet, and hourly timeline.
   */
  getBreakdown(hours: number = 4): {
    byToken: { token: string; bullish: number; bearish: number; direction: ConsensusDirection }[];
    byWallet: { label: string; volume: number; direction: ConsensusDirection; count: number }[];
  } {
    const txs = this.smartMoney.getTransactionsSince(hours);

    // By token
    const tokenMap = new Map<string, { b: number; s: number }>();
    for (const tx of txs) {
      const entry = tokenMap.get(tx.token) || { b: 0, s: 0 };
      if (tx.type === 'accumulation') entry.b += tx.usdValue;
      if (tx.type === 'sell_pressure') entry.s += tx.usdValue;
      tokenMap.set(tx.token, entry);
    }
    const byToken = Array.from(tokenMap.entries())
      .map(([token, { b, s }]) => ({
        token,
        bullish: b,
        bearish: s,
        direction: (b > s * 1.5 ? 'bullish' : s > b * 1.5 ? 'bearish' : 'neutral') as ConsensusDirection,
      }))
      .sort((a, b) => (b.bullish + b.bearish) - (a.bullish + a.bearish));

    // By wallet
    const walletMap = new Map<string, { vol: number; b: number; s: number; count: number }>();
    for (const tx of txs) {
      const entry = walletMap.get(tx.walletLabel) || { vol: 0, b: 0, s: 0, count: 0 };
      entry.vol += tx.usdValue;
      entry.count++;
      if (tx.type === 'accumulation') entry.b += tx.usdValue;
      if (tx.type === 'sell_pressure') entry.s += tx.usdValue;
      walletMap.set(tx.walletLabel, entry);
    }
    const byWallet = Array.from(walletMap.entries())
      .map(([label, w]) => ({
        label,
        volume: w.vol,
        direction: (w.b > w.s * 1.5 ? 'bullish' : w.s > w.b * 1.5 ? 'bearish' : 'neutral') as ConsensusDirection,
        count: w.count,
      }))
      .sort((a, b) => b.volume - a.volume);

    return { byToken, byWallet };
  }
}
