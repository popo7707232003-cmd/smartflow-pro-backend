// backend/src/services/riskMonitor.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 風險警告自動化系統
// ═══════════════════════════════════════════════════════════════
//
// 每個函數返回：{ triggered, level, message }
// triggered = true 時，訊號應降級或附帶警告。
// level = 'danger' 時，建議完全停止交易。
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import { config } from '../config/index';

const TC = config.trading;

// ═══ Types ═══

export interface RiskWarning {
  triggered: boolean;
  level: 'info' | 'warning' | 'danger';
  message: string;
  category: string;
}

// ═══════════════════════════════════════════════════════
// RISK MONITOR CLASS
// ═══════════════════════════════════════════════════════

export class RiskMonitor {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ═══════════════════════════════════════
  // 1. RSI EXTREME CHECK
  // ═══════════════════════════════════════

  /**
   * Check if RSI is in a dangerous zone for the given direction.
   *
   * - Long + RSI > 75: warning (danger if > 80)
   * - Short + RSI < 25: warning (danger if < 20)
   */
  checkRSIExtreme(rsi: number | null, direction: string): RiskWarning {
    if (rsi === null) {
      return { triggered: false, level: 'info', message: '', category: 'RSI' };
    }

    if (direction === 'long') {
      if (rsi > 80) {
        return {
          triggered: true,
          level: 'danger',
          message: `🛑 RSI ${rsi.toFixed(1)} 極度超買，強烈不建議做多。等待回調後再進場。`,
          category: 'RSI',
        };
      }
      if (rsi > 75) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ RSI ${rsi.toFixed(1)} 超買警告，做多風險升高，考慮降低倉位。`,
          category: 'RSI',
        };
      }
    }

    if (direction === 'short') {
      if (rsi < 20) {
        return {
          triggered: true,
          level: 'danger',
          message: `🛑 RSI ${rsi.toFixed(1)} 極度超賣，強烈不建議做空。等待反彈後再進場。`,
          category: 'RSI',
        };
      }
      if (rsi < 25) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ RSI ${rsi.toFixed(1)} 超賣警告，做空風險升高，留意反彈。`,
          category: 'RSI',
        };
      }
    }

    return { triggered: false, level: 'info', message: '', category: 'RSI' };
  }

  // ═══════════════════════════════════════
  // 2. FUNDING RATE CHECK
  // ═══════════════════════════════════════

  /**
   * Check if funding rate indicates extreme positioning.
   *
   * > +0.1%: Longs are paying heavily → danger for longs (crowded trade)
   * < -0.1%: Shorts are paying heavily → danger for shorts
   * > +0.05%: Warning level
   */
  checkFundingRate(fundingRate: number | null): RiskWarning {
    if (fundingRate === null) {
      return { triggered: false, level: 'info', message: '', category: 'Funding' };
    }

    if (fundingRate > 0.1) {
      return {
        triggered: true,
        level: 'danger',
        message: `🛑 資金費率 ${fundingRate.toFixed(4)}% 極高。多頭持倉成本過高，爆倉風險增加。`,
        category: 'Funding',
      };
    }
    if (fundingRate > 0.05) {
      return {
        triggered: true,
        level: 'warning',
        message: `⚠️ 資金費率 ${fundingRate.toFixed(4)}% 偏高，多頭擁擠。`,
        category: 'Funding',
      };
    }
    if (fundingRate < -0.1) {
      return {
        triggered: true,
        level: 'danger',
        message: `🛑 資金費率 ${fundingRate.toFixed(4)}% 極低。強烈空頭情緒，反彈風險高。`,
        category: 'Funding',
      };
    }
    if (fundingRate < -0.05) {
      return {
        triggered: true,
        level: 'warning',
        message: `⚠️ 資金費率 ${fundingRate.toFixed(4)}% 偏低，空頭擁擠。`,
        category: 'Funding',
      };
    }

    return { triggered: false, level: 'info', message: '', category: 'Funding' };
  }

  // ═══════════════════════════════════════
  // 3. OVERTRADING CHECK
  // ═══════════════════════════════════════

  /**
   * Check if too many signals have been emitted for a symbol in 24 hours.
   * Limit: 3 signals per coin per day.
   */
  async checkOvertrading(symbol: string): Promise<RiskWarning> {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) as cnt FROM signals
         WHERE symbol = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [symbol.toUpperCase()],
      );

      const count = parseInt(result.rows[0].cnt);

      if (count >= TC.maxSignalsPerCoinPerDay) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ ${symbol} 過去 24H 已觸發 ${count} 個訊號（上限 ${TC.maxSignalsPerCoinPerDay}），過度交易警告。`,
          category: 'Overtrading',
        };
      }

      if (count >= TC.maxSignalsPerCoinPerDay - 1) {
        return {
          triggered: true,
          level: 'info',
          message: `ℹ️ ${symbol} 今日已有 ${count} 個訊號，接近上限。`,
          category: 'Overtrading',
        };
      }
    } catch (err) {
      console.error('[RiskMonitor] checkOvertrading DB error:', (err as Error).message);
    }

    return { triggered: false, level: 'info', message: '', category: 'Overtrading' };
  }

  // ═══════════════════════════════════════
  // 4. STRATEGY HEALTH CHECK
  // ═══════════════════════════════════════

  /**
   * Check if the strategy is working for this symbol+direction.
   * If 7-day win rate < 40%, it's likely the strategy has degraded.
   */
  async checkStrategyHealth(symbol: string, direction: string): Promise<RiskWarning> {
    try {
      const result = await this.pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN sr.result_type IN ('tp1', 'tp2') THEN 1 ELSE 0 END) as wins
         FROM signals s
         JOIN signal_results sr ON sr.signal_id = s.id
         WHERE s.symbol = $1
           AND s.direction = $2
           AND sr.closed_at > NOW() - INTERVAL '7 days'`,
        [symbol.toUpperCase(), direction],
      );

      const total = parseInt(result.rows[0].total);
      const wins = parseInt(result.rows[0].wins);

      if (total < 5) {
        // Not enough data to assess
        return { triggered: false, level: 'info', message: '', category: 'Strategy' };
      }

      const winRate = (wins / total) * 100;

      if (winRate < 30) {
        return {
          triggered: true,
          level: 'danger',
          message: `🛑 ${symbol} ${direction === 'long' ? '做多' : '做空'} 7日勝率僅 ${winRate.toFixed(1)}%，策略嚴重失效，強烈建議暫停。`,
          category: 'Strategy',
        };
      }

      if (winRate < 40) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ ${symbol} ${direction === 'long' ? '做多' : '做空'} 7日勝率 ${winRate.toFixed(1)}%，低於 40% 目標，建議降低倉位。`,
          category: 'Strategy',
        };
      }
    } catch (err) {
      console.error('[RiskMonitor] checkStrategyHealth DB error:', (err as Error).message);
    }

    return { triggered: false, level: 'info', message: '', category: 'Strategy' };
  }

  // ═══════════════════════════════════════
  // 5. CONSECUTIVE LOSS CHECK
  // ═══════════════════════════════════════

  /**
   * Check if the last 3 trade results are all stop-losses.
   * If yes, recommend stopping trading for the day.
   */
  async checkConsecutiveLoss(): Promise<RiskWarning> {
    try {
      const result = await this.pool.query(
        `SELECT result_type FROM signal_results
         ORDER BY closed_at DESC
         LIMIT 5`,
      );

      if (result.rows.length < 3) {
        return { triggered: false, level: 'info', message: '', category: 'ConsecutiveLoss' };
      }

      // Count consecutive SLs from most recent
      let consecutiveSL = 0;
      for (const row of result.rows) {
        if (row.result_type === 'sl') consecutiveSL++;
        else break;
      }

      if (consecutiveSL >= 3) {
        return {
          triggered: true,
          level: 'danger',
          message: `🛑 連續虧損 ${consecutiveSL} 筆。已達今日止損上限，強烈建議停止交易，調整策略後再重新開始。`,
          category: 'ConsecutiveLoss',
        };
      }

      if (consecutiveSL >= 2) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ 連續虧損 ${consecutiveSL} 筆。請謹慎評估下一筆交易，考慮降低倉位。`,
          category: 'ConsecutiveLoss',
        };
      }
    } catch (err) {
      console.error('[RiskMonitor] checkConsecutiveLoss DB error:', (err as Error).message);
    }

    return { triggered: false, level: 'info', message: '', category: 'ConsecutiveLoss' };
  }

  // ═══════════════════════════════════════
  // 6. EVENT RISK CHECK
  // ═══════════════════════════════════════

  /**
   * Check if there's a high-impact economic event within the next 60 minutes.
   * Queries the alerts table for upcoming calendar events.
   */
  async checkEventRisk(): Promise<RiskWarning> {
    try {
      // Check for Level A alerts from calendar source in the next 60 minutes
      const result = await this.pool.query(
        `SELECT title, message FROM alerts
         WHERE source = 'calendar'
           AND level = 'A'
           AND created_at > NOW() - INTERVAL '2 hours'
         ORDER BY created_at DESC
         LIMIT 1`,
      );

      if (result.rows.length > 0) {
        return {
          triggered: true,
          level: 'danger',
          message: `🛑 重大事件預警：${result.rows[0].title}。建議暫停進場，或縮小倉位並設緊止損。`,
          category: 'Event',
        };
      }

      // Also check hardcoded economic calendar
      const upcoming = await this.checkHardcodedCalendar();
      if (upcoming) return upcoming;
    } catch (err) {
      console.error('[RiskMonitor] checkEventRisk DB error:', (err as Error).message);
    }

    return { triggered: false, level: 'info', message: '', category: 'Event' };
  }

  private async checkHardcodedCalendar(): Promise<RiskWarning | null> {
    // Key dates that are always high-impact
    const KEY_EVENTS = [
      // 2025 remaining FOMC
      { date: '2025-05-07T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2025-06-18T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2025-07-30T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2025-09-17T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2025-10-29T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2025-12-10T18:00:00Z', name: 'FOMC 利率決議' },
      // 2025 CPI
      { date: '2025-05-13T12:30:00Z', name: 'CPI 通膨數據' },
      { date: '2025-06-11T12:30:00Z', name: 'CPI 通膨數據' },
      { date: '2025-07-10T12:30:00Z', name: 'CPI 通膨數據' },
      { date: '2025-08-12T12:30:00Z', name: 'CPI 通膨數據' },
      // 2025 NFP
      { date: '2025-05-02T12:30:00Z', name: '非農就業數據' },
      { date: '2025-06-06T12:30:00Z', name: '非農就業數據' },
      { date: '2025-07-03T12:30:00Z', name: '非農就業數據' },
      // 2026
      { date: '2026-01-28T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2026-03-18T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2026-05-06T18:00:00Z', name: 'FOMC 利率決議' },
      { date: '2026-06-17T18:00:00Z', name: 'FOMC 利率決議' },
    ];

    const now = Date.now();
    const WINDOW_MS = 60 * 60_000; // 60 minutes

    for (const event of KEY_EVENTS) {
      const eventTime = new Date(event.date).getTime();
      const timeUntil = eventTime - now;

      if (timeUntil > 0 && timeUntil <= WINDOW_MS) {
        const minutesLeft = Math.round(timeUntil / 60_000);
        return {
          triggered: true,
          level: minutesLeft <= 30 ? 'danger' : 'warning',
          message: minutesLeft <= 30
            ? `🛑 ${event.name} 將在 ${minutesLeft} 分鐘後發布。建議立即縮倉或暫停交易。`
            : `⚠️ ${event.name} 將在 ${minutesLeft} 分鐘後發布。建議準備好風控措施。`,
          category: 'Event',
        };
      }
    }

    return null;
  }

  // ═══════════════════════════════════════
  // 7. SMART MONEY DIVERGENCE CHECK
  // ═══════════════════════════════════════

  /**
   * Check if smart money flow contradicts the signal direction.
   */
  async checkSmartMoneyDivergence(
    symbol: string,
    direction: string,
  ): Promise<RiskWarning> {
    try {
      const token = symbol.replace('USDT', '');
      const result = await this.pool.query(
        `SELECT type, SUM(usd_value) as total
         FROM smart_money_txns
         WHERE token = $1 AND timestamp > NOW() - INTERVAL '4 hours'
         GROUP BY type`,
        [token],
      );

      let buyVol = 0, sellVol = 0;
      for (const row of result.rows) {
        if (row.type === 'accumulation') buyVol += parseFloat(row.total);
        if (row.type === 'sell_pressure') sellVol += parseFloat(row.total);
      }

      const smDirection = buyVol > sellVol * 1.5 ? 'bullish' : sellVol > buyVol * 1.5 ? 'bearish' : 'neutral';

      if (smDirection === 'neutral') {
        return { triggered: false, level: 'info', message: '', category: 'SmartMoney' };
      }

      const conflict =
        (direction === 'long' && smDirection === 'bearish') ||
        (direction === 'short' && smDirection === 'bullish');

      if (conflict) {
        return {
          triggered: true,
          level: 'warning',
          message: `⚠️ 聰明錢方向（${smDirection === 'bullish' ? '偏多' : '偏空'}）與 ${direction === 'long' ? '做多' : '做空'} 訊號相反。建議額外謹慎。`,
          category: 'SmartMoney',
        };
      }
    } catch (err) {
      console.error('[RiskMonitor] checkSmartMoneyDivergence error:', (err as Error).message);
    }

    return { triggered: false, level: 'info', message: '', category: 'SmartMoney' };
  }

  // ═══════════════════════════════════════
  // AGGREGATE: Run all checks
  // ═══════════════════════════════════════

  /**
   * Run all risk checks for a given context.
   * Returns only triggered warnings, sorted by severity.
   */
  async runAllChecks(
    symbol: string,
    direction: string,
    rsi: number | null,
    fundingRate: number | null,
  ): Promise<RiskWarning[]> {
    const checks = await Promise.all([
      Promise.resolve(this.checkRSIExtreme(rsi, direction)),
      Promise.resolve(this.checkFundingRate(fundingRate)),
      this.checkOvertrading(symbol),
      this.checkStrategyHealth(symbol, direction),
      this.checkConsecutiveLoss(),
      this.checkEventRisk(),
      this.checkSmartMoneyDivergence(symbol, direction),
    ]);

    const triggered = checks.filter(c => c.triggered);

    // Sort: danger first, then warning, then info
    const order: Record<string, number> = { danger: 0, warning: 1, info: 2 };
    triggered.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));

    return triggered;
  }

  /**
   * Quick check: should we stop trading entirely?
   * Returns true if ANY danger-level check is triggered.
   */
  async shouldStopTrading(symbol: string, direction: string): Promise<boolean> {
    const warnings = await this.runAllChecks(symbol, direction, null, null);
    return warnings.some(w => w.level === 'danger');
  }
}
