import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

let pool: Pool;

const router = Router();

export function initSignalRoutes(dbPool: Pool) {
  pool = dbPool;
  return router;
}

// GET /api/signals — return recent signals (active first, then recent closed)
router.get('/signals', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const status = req.query.status as string; // 'active', 'closed', 'all'

    let query = '';
    let params: any[] = [];

    if (status === 'active') {
      query = `SELECT * FROM signals WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`;
      params = [limit];
    } else if (status === 'closed') {
      query = `SELECT * FROM signals WHERE status IN ('closed', 'expired') ORDER BY closed_at DESC LIMIT $1`;
      params = [limit];
    } else {
      // Default: active first, then recent closed
      query = `
        (SELECT * FROM signals WHERE status = 'active' ORDER BY created_at DESC LIMIT 20)
        UNION ALL
        (SELECT * FROM signals WHERE status IN ('closed', 'expired') ORDER BY closed_at DESC LIMIT $1)
      `;
      params = [limit];
    }

    const { rows } = await pool.query(query, params);

    return res.json({
      success: true,
      data: rows.map(r => ({
        id: r.id,
        symbol: r.symbol,
        direction: r.direction,
        entry: r.entry,
        tp1: r.tp1,
        tp2: r.tp2,
        sl: r.sl,
        score: r.score,
        maxScore: r.max_score,
        scoreDetails: r.score_details,
        rsi: r.rsi,
        atr: r.atr,
        rr: r.rr,
        timeframe: r.timeframe,
        reason: r.reason,
        status: r.status,
        tp1Hit: r.tp1_hit,
        tp2Hit: r.tp2_hit,
        slHit: r.sl_hit,
        pnlPercent: r.pnl_percent,
        createdAt: r.created_at,
        closedAt: r.closed_at
      })),
      count: rows.length
    });
  } catch (err: any) {
    console.error('[API] /signals error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/performance — aggregated performance metrics
router.get('/performance', async (_req: Request, res: Response) => {
  try {
    // Overall stats
    const totalResult = await pool.query(`
      SELECT COUNT(*) as total FROM signals WHERE status IN ('closed', 'expired')
    `);
    const total = parseInt(totalResult.rows[0].total) || 0;

    const winsResult = await pool.query(`
      SELECT COUNT(*) as wins FROM signal_results WHERE result = 'win'
    `);
    const wins = parseInt(winsResult.rows[0].wins) || 0;

    const lossesResult = await pool.query(`
      SELECT COUNT(*) as losses FROM signal_results WHERE result = 'loss'
    `);
    const losses = parseInt(lossesResult.rows[0].losses) || 0;

    const partialResult = await pool.query(`
      SELECT COUNT(*) as partials FROM signal_results WHERE result = 'partial' AND exit_type = 'tp1_partial'
    `);
    const partials = parseInt(partialResult.rows[0].partials) || 0;

    // PnL stats
    const pnlResult = await pool.query(`
      SELECT
        COALESCE(SUM(pnl_percent), 0) as total_pnl,
        COALESCE(AVG(CASE WHEN pnl_percent > 0 THEN pnl_percent END), 0) as avg_win,
        COALESCE(AVG(CASE WHEN pnl_percent < 0 THEN pnl_percent END), 0) as avg_loss,
        COALESCE(SUM(CASE WHEN pnl_percent > 0 THEN pnl_percent END), 0) as gross_profit,
        COALESCE(ABS(SUM(CASE WHEN pnl_percent < 0 THEN pnl_percent END)), 0) as gross_loss
      FROM signal_results
      WHERE exit_type != 'tp1_partial'
    `);

    const pnl = pnlResult.rows[0];
    const totalPnl = parseFloat(pnl.total_pnl) || 0;
    const avgWin = parseFloat(pnl.avg_win) || 0;
    const avgLoss = parseFloat(pnl.avg_loss) || 0;
    const grossProfit = parseFloat(pnl.gross_profit) || 0;
    const grossLoss = parseFloat(pnl.gross_loss) || 0.01; // avoid div by 0
    const profitFactor = grossProfit / grossLoss;

    const winRate = total > 0 ? ((wins + partials) / total) * 100 : 0;

    // Active signals count
    const activeResult = await pool.query(`SELECT COUNT(*) as c FROM signals WHERE status = 'active'`);
    const activeCount = parseInt(activeResult.rows[0].c) || 0;

    // Recent trades (last 20)
    const recentResult = await pool.query(`
      SELECT sr.*, s.score, s.max_score, s.timeframe
      FROM signal_results sr
      LEFT JOIN signals s ON sr.signal_id = s.id
      WHERE sr.exit_type != 'tp1_partial'
      ORDER BY sr.closed_at DESC LIMIT 20
    `);

    // Daily breakdown (last 7 days)
    const dailyResult = await pool.query(`
      SELECT
        DATE(closed_at) as date,
        COUNT(*) as trades,
        SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl_percent), 0) as pnl
      FROM signal_results
      WHERE exit_type != 'tp1_partial' AND closed_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(closed_at)
      ORDER BY date DESC
    `);

    return res.json({
      success: true,
      data: {
        summary: {
          totalSignals: total,
          activeSignals: activeCount,
          wins,
          losses,
          partials,
          winRate: Math.round(winRate * 10) / 10,
          profitFactor: Math.round(profitFactor * 100) / 100,
          totalPnl: Math.round(totalPnl * 100) / 100,
          avgWin: Math.round(avgWin * 100) / 100,
          avgLoss: Math.round(avgLoss * 100) / 100
        },
        recentTrades: recentResult.rows.map(r => ({
          signalId: r.signal_id,
          symbol: r.symbol,
          direction: r.direction,
          entry: r.entry,
          exitPrice: r.exit_price,
          exitType: r.exit_type,
          pnlPercent: r.pnl_percent,
          result: r.result,
          score: r.score,
          closedAt: r.closed_at
        })),
        daily: dailyResult.rows
      }
    });
  } catch (err: any) {
    console.error('[API] /performance error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
