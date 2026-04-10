import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import { config } from '../config';

export class SignalTracker {
  private pool: pg.Pool;
  private broadcastFn: ((msg: any) => void) | null = null;
  private timer: any = null;

  constructor(pool: pg.Pool) { this.pool = pool; }
  setBroadcast(fn: (msg: any) => void) { this.broadcastFn = fn; }

  start() {
    console.log('[SignalTracker] Started (every 30s)');
    this.check();
    this.timer = setInterval(() => this.check(), 30000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  private async check() {
    try {
      // Get active signals
      const { rows: activeSignals } = await this.pool.query(
        "SELECT * FROM signals WHERE status IN ('pending', 'active', 'tp1') ORDER BY created_at DESC LIMIT 50"
      );
      if (!activeSignals.length) return;

      // Get current prices from Binance
      const symbols = [...new Set(activeSignals.map((s: any) => s.symbol))];
      const prices: Record<string, number> = {};
      for (const sym of symbols) {
        try {
          const { data } = await axios.get(`${config.binance.restBaseUrl}/api/v3/ticker/price?symbol=${sym}`, { timeout: 5000 });
          prices[sym] = parseFloat(data.price);
        } catch { continue; }
      }

      for (const sig of activeSignals) {
        const price = prices[sig.symbol];
        if (!price) continue;

        const isLong = sig.direction === 'long';
        const entry = parseFloat(sig.entry);
        const tp1 = parseFloat(sig.tp1);
        const tp2 = parseFloat(sig.tp2);
        const sl = parseFloat(sig.sl);
        const pnlPct = isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;

        // Track max favorable/adverse
        await this.pool.query(
          `INSERT INTO signal_tracking (signal_id, current_price, pnl_pct, max_favorable, max_adverse, status)
           VALUES ($1, $2, $3, GREATEST($3, 0), LEAST($3, 0), $4)`,
          [sig.id, price, +pnlPct.toFixed(4), sig.status]
        ).catch(() => {});

        // Check TP2 first (full win)
        if ((isLong && price >= tp2) || (!isLong && price <= tp2)) {
          await this.closeSignal(sig, 'tp2', price, pnlPct);
          continue;
        }

        // Check TP1 (partial win — only if not already triggered)
        if (sig.status !== 'tp1' && ((isLong && price >= tp1) || (!isLong && price <= tp1))) {
          await this.pool.query("UPDATE signals SET status = 'tp1' WHERE id = $1", [sig.id]);
          // Move SL to breakeven
          await this.pool.query("UPDATE signals SET sl = entry WHERE id = $1", [sig.id]);
          this.broadcast({
            type: 'SIGNAL_TP1', level: 'B',
            data: {
              signalId: sig.id, symbol: sig.symbol, direction: sig.direction,
              entry, tp1, currentPrice: price,
              pnlPct: +pnlPct.toFixed(2),
              message: `${sig.symbol} ${isLong ? '做多' : '做空'} TP1 觸發 +${pnlPct.toFixed(2)}%`,
              action: '已平倉 50%，止損移至成本價',
            }
          });
          console.log(`[Tracker] ${sig.symbol} TP1 hit at ${price}`);
          continue;
        }

        // Check SL (loss)
        if ((isLong && price <= sl) || (!isLong && price >= sl)) {
          // If TP1 was already hit, this is breakeven or small win
          const resultType = sig.status === 'tp1' ? 'breakeven' : 'sl';
          const actualPnl = sig.status === 'tp1' ? +((parseFloat(sig.tp1_pct) || 0) * 0.5).toFixed(2) : +pnlPct.toFixed(2);
          await this.closeSignal(sig, resultType, price, actualPnl);
          continue;
        }
      }
    } catch (e: any) {
      console.error('[SignalTracker] Error:', e.message);
    }
  }

  private async closeSignal(sig: any, resultType: string, exitPrice: number, pnlPct: number) {
    const isWin = resultType === 'tp2' || (resultType === 'breakeven');
    try {
      // Update signal status
      await this.pool.query("UPDATE signals SET status = $2 WHERE id = $1", [sig.id, resultType]);

      // Insert result
      await this.pool.query(
        `INSERT INTO signal_results (signal_id, result_type, pnl_pct, exit_price, hold_duration, closed_at)
         VALUES ($1, $2, $3, $4, NOW() - (SELECT created_at FROM signals WHERE id = $1), NOW())`,
        [sig.id, resultType, pnlPct, exitPrice]
      );

      // Update daily stats
      await this.updateDailyStats();

      // Get updated stats for notification
      const stats = await this.getOverallStats();

      // Broadcast
      const notifType = resultType === 'tp2' ? 'SIGNAL_TP2' : resultType === 'sl' ? 'SIGNAL_SL' : 'SIGNAL_BREAKEVEN';
      const isLong = sig.direction === 'long';
      this.broadcast({
        type: notifType, level: resultType === 'sl' ? 'A' : 'B',
        data: {
          signalId: sig.id, symbol: sig.symbol, direction: sig.direction,
          entry: parseFloat(sig.entry), exitPrice, pnlPct: +pnlPct.toFixed(2),
          resultType, isWin,
          message: resultType === 'tp2'
            ? `🎯 ${sig.symbol} ${isLong?'做多':'做空'} 完整止盈 +${pnlPct.toFixed(2)}%`
            : resultType === 'sl'
            ? `❌ ${sig.symbol} ${isLong?'做多':'做空'} 止損 ${pnlPct.toFixed(2)}%`
            : `⚖️ ${sig.symbol} 打平（TP1已獲利）`,
          winRate: stats.winRate,
          totalTrades: stats.totalTrades,
        }
      });

      console.log(`[Tracker] ${sig.symbol} ${resultType} at ${exitPrice} (${pnlPct.toFixed(2)}%)`);
    } catch (e: any) {
      console.error('[Tracker] Close error:', e.message);
    }
  }

  private broadcast(msg: any) {
    if (this.broadcastFn) this.broadcastFn({ ...msg, timestamp: Date.now() });
  }

  async getOverallStats() {
    try {
      const { rows } = await this.pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE result_type IN ('tp2', 'breakeven')) as wins,
          COUNT(*) FILTER (WHERE result_type = 'sl') as losses,
          COALESCE(AVG(pnl_pct) FILTER (WHERE pnl_pct > 0), 0) as avg_win,
          COALESCE(AVG(ABS(pnl_pct)) FILTER (WHERE pnl_pct < 0), 0) as avg_loss,
          COALESCE(SUM(pnl_pct), 0) as total_pnl
        FROM signal_results
      `);
      const r = rows[0];
      const total = parseInt(r.total);
      const wins = parseInt(r.wins);
      const losses = parseInt(r.losses);
      const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : 0;
      const avgWin = +parseFloat(r.avg_win).toFixed(2);
      const avgLoss = +parseFloat(r.avg_loss).toFixed(2);
      const pf = avgLoss > 0 ? +(avgWin * wins / (avgLoss * losses)).toFixed(2) : 0;
      return { totalTrades: total, wins, losses, winRate, profitFactor: pf, avgWin, avgLoss, totalPnl: +parseFloat(r.total_pnl).toFixed(2) };
    } catch { return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, totalPnl: 0 }; }
  }

  async getStatsBySymbol() {
    try {
      const { rows } = await this.pool.query(`
        SELECT s.symbol,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE sr.result_type IN ('tp2','breakeven')) as wins,
          COALESCE(SUM(sr.pnl_pct), 0) as total_pnl
        FROM signal_results sr JOIN signals s ON sr.signal_id = s.id
        GROUP BY s.symbol ORDER BY total DESC
      `);
      return rows.map((r: any) => ({
        symbol: r.symbol, total: parseInt(r.total), wins: parseInt(r.wins),
        winRate: parseInt(r.total) > 0 ? +(parseInt(r.wins) / parseInt(r.total) * 100).toFixed(1) : 0,
        totalPnl: +parseFloat(r.total_pnl).toFixed(2),
      }));
    } catch { return []; }
  }

  async getActiveSignals() {
    try {
      const { rows } = await this.pool.query(
        "SELECT * FROM signals WHERE status IN ('pending','active','tp1') ORDER BY created_at DESC LIMIT 20"
      );
      return rows;
    } catch { return []; }
  }

  async getRecentResults(limit: number = 20) {
    try {
      const { rows } = await this.pool.query(`
        SELECT sr.*, s.symbol, s.direction, s.entry, s.tp1, s.tp2, s.sl, s.score, s.score_label, s.created_at as signal_created
        FROM signal_results sr JOIN signals s ON sr.signal_id = s.id
        ORDER BY sr.closed_at DESC LIMIT $1
      `, [limit]);
      return rows;
    } catch { return []; }
  }

  private async updateDailyStats() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const stats = await this.getOverallStats();
      await this.pool.query(`
        INSERT INTO daily_stats (date, total_signals, wins, losses, win_rate, profit_factor, total_pnl, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (date) DO UPDATE SET
          total_signals = $2, wins = $3, losses = $4, win_rate = $5, profit_factor = $6, total_pnl = $7, updated_at = NOW()
      `, [today, stats.totalTrades, stats.wins, stats.losses, stats.winRate, stats.profitFactor, stats.totalPnl])
      .catch(() => {});
    } catch {}
  }
}
