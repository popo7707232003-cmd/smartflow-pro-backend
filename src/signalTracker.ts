import { Pool } from 'pg';

let pool: Pool;
const CHECK_INTERVAL = 30 * 1000;

export function initSignalTracker(dbPool: Pool) {
  pool = dbPool;
  ensureTables().then(() => {
    console.log('[SignalTracker] Starting — checking every 30 seconds');
    backfillClosedSignals();
    checkSignals();
    setInterval(checkSignals, CHECK_INTERVAL);
  });
}

async function ensureTables() {
  // Create signal_results table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_results (
      id SERIAL PRIMARY KEY,
      signal_id TEXT,
      symbol VARCHAR(20) NOT NULL DEFAULT '',
      direction VARCHAR(10) NOT NULL DEFAULT '',
      entry DOUBLE PRECISION NOT NULL DEFAULT 0,
      exit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      exit_type VARCHAR(20) NOT NULL DEFAULT '',
      pnl_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
      result VARCHAR(10) NOT NULL DEFAULT 'unknown',
      closed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sr_closed ON signal_results(closed_at DESC);
  `);

  // Ensure all columns exist (fix for existing tables)
  const cols: [string, string][] = [
    ['signal_id', 'TEXT'],
    ['symbol', "VARCHAR(20) DEFAULT ''"],
    ['direction', "VARCHAR(10) DEFAULT ''"],
    ['entry', 'DOUBLE PRECISION DEFAULT 0'],
    ['exit_price', 'DOUBLE PRECISION DEFAULT 0'],
    ['exit_type', "VARCHAR(20) DEFAULT ''"],
    ['pnl_percent', 'DOUBLE PRECISION DEFAULT 0'],
    ['result', "VARCHAR(10) DEFAULT 'unknown'"],
    ['closed_at', 'TIMESTAMPTZ DEFAULT NOW()'],
  ];
  for (const [col, typedef] of cols) {
    try { await pool.query(`ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS ${col} ${typedef}`); } catch {}
  }

  // Ensure signals table has needed columns
  const sigCols: [string, string][] = [
    ['tp1_hit', 'BOOLEAN DEFAULT FALSE'],
    ['tp2_hit', 'BOOLEAN DEFAULT FALSE'],
    ['sl_hit', 'BOOLEAN DEFAULT FALSE'],
    ['closed_at', 'TIMESTAMPTZ'],
    ['pnl_percent', 'DOUBLE PRECISION'],
    ['status', "VARCHAR(20) DEFAULT 'active'"],
  ];
  for (const [col, typedef] of sigCols) {
    try { await pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${typedef}`); } catch {}
  }

  console.log('[SignalTracker] Tables ready');
}

// Backfill: create signal_results entries for already-closed signals that are missing
async function backfillClosedSignals() {
  try {
    const { rows: closed } = await pool.query(`
      SELECT s.* FROM signals s
      WHERE s.status IN ('closed', 'expired')
      AND s.pnl_percent IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM signal_results sr WHERE sr.signal_id = s.id::text)
    `);

    if (closed.length === 0) {
      console.log('[SignalTracker] No signals to backfill');
      return;
    }

    console.log(`[SignalTracker] Backfilling ${closed.length} closed signals into signal_results...`);

    for (const sig of closed) {
      const exitType = sig.tp2_hit ? 'tp2' : sig.tp1_hit ? 'tp1' : sig.sl_hit ? 'sl' : 'expired';
      const result = sig.tp2_hit ? 'win' : sig.sl_hit ? 'loss' : (parseFloat(sig.pnl_percent) || 0) > 0 ? 'win' : 'loss';
      const exitPrice = sig.tp2_hit ? parseFloat(sig.tp2) : sig.sl_hit ? parseFloat(sig.sl) : parseFloat(sig.entry);

      await pool.query(`
        INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        String(sig.id),
        sig.symbol,
        sig.direction,
        parseFloat(sig.entry) || 0,
        exitPrice,
        exitType,
        parseFloat(sig.pnl_percent) || 0,
        result,
        sig.closed_at || new Date()
      ]);
    }

    console.log(`[SignalTracker] Backfilled ${closed.length} signal results`);
  } catch (err: any) {
    console.error('[SignalTracker] Backfill error:', err.message);
  }
}

async function fetchPrice(symbol: string): Promise<number> {
  const urls = [
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any;
      return parseFloat(data.price) || 0;
    } catch { continue; }
  }
  return 0;
}

async function checkSignals() {
  try {
    const { rows: activeSignals } = await pool.query(`
      SELECT * FROM signals WHERE status = 'active' ORDER BY created_at DESC
    `);

    if (activeSignals.length === 0) {
      console.log('[SignalTracker] No active signals to check');
      return;
    }

    let checked = 0, closed = 0;

    for (const sig of activeSignals) {
      try {
        const price = await fetchPrice(sig.symbol);
        if (!price) continue;
        checked++;

        // Parse all values as numbers
        const entry = parseFloat(sig.entry) || 0;
        const tp1 = parseFloat(sig.tp1) || 0;
        const tp2 = parseFloat(sig.tp2) || 0;
        const sl = parseFloat(sig.sl) || 0;
        const isLong = sig.direction === 'LONG';
        const tp1AlreadyHit = sig.tp1_hit === true;

        // Check conditions
        const slHit = isLong ? price <= sl : price >= sl;
        const tp1Hit = isLong ? price >= tp1 : price <= tp1;
        const tp2Hit = isLong ? price >= tp2 : price <= tp2;

        if (slHit && !tp1AlreadyHit) {
          // Full stop loss
          const pnl = isLong ? ((sl - entry) / entry) * 100 : ((entry - sl) / entry) * 100;
          const pnlRounded = Math.round(pnl * 100) / 100;

          await pool.query(`UPDATE signals SET status = 'closed', sl_hit = TRUE, closed_at = NOW(), pnl_percent = $1 WHERE id = $2`, [pnlRounded, sig.id]);
          await pool.query(`INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
            [String(sig.id), sig.symbol, sig.direction, entry, sl, 'sl', pnlRounded, 'loss']);

          closed++;
          console.log(`[SignalTracker] ❌ ${sig.symbol} SL hit at ${price} — PnL: ${pnlRounded}%`);

        } else if (slHit && tp1AlreadyHit) {
          // SL after TP1 — breakeven or small profit
          const pnlTp1 = isLong ? ((tp1 - entry) / entry) * 100 * 0.5 : ((entry - tp1) / entry) * 100 * 0.5;
          const pnlRest = isLong ? ((entry - entry) / entry) * 100 * 0.5 : 0; // BE
          const totalPnl = Math.round((pnlTp1 + pnlRest) * 100) / 100;

          await pool.query(`UPDATE signals SET status = 'closed', sl_hit = TRUE, closed_at = NOW(), pnl_percent = $1 WHERE id = $2`, [totalPnl, sig.id]);
          await pool.query(`INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
            [String(sig.id), sig.symbol, sig.direction, entry, entry, 'sl_after_tp1', totalPnl, 'partial']);

          closed++;
          console.log(`[SignalTracker] 🟡 ${sig.symbol} SL after TP1 — PnL: ${totalPnl}%`);

        } else if (tp2Hit) {
          // Full TP2 win
          const pnl = isLong ? ((tp2 - entry) / entry) * 100 : ((entry - tp2) / entry) * 100;
          const pnlRounded = Math.round(pnl * 100) / 100;

          await pool.query(`UPDATE signals SET status = 'closed', tp1_hit = TRUE, tp2_hit = TRUE, closed_at = NOW(), pnl_percent = $1 WHERE id = $2`, [pnlRounded, sig.id]);
          await pool.query(`INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
            [String(sig.id), sig.symbol, sig.direction, entry, tp2, 'tp2', pnlRounded, 'win']);

          closed++;
          console.log(`[SignalTracker] ✅ ${sig.symbol} TP2 hit at ${price} — PnL: ${pnlRounded}%`);

        } else if (tp1Hit && !tp1AlreadyHit) {
          // TP1 partial — move SL to entry (breakeven)
          await pool.query(`UPDATE signals SET tp1_hit = TRUE, sl = entry WHERE id = $1`, [sig.id]);

          await pool.query(`INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
            [String(sig.id), sig.symbol, sig.direction, entry, tp1, 'tp1_partial',
             Math.round((isLong ? ((tp1 - entry) / entry) * 100 * 0.5 : ((entry - tp1) / entry) * 100 * 0.5) * 100) / 100,
             'partial']);

          console.log(`[SignalTracker] 🟡 ${sig.symbol} TP1 hit at ${price} — SL moved to BE`);
        }

        // Expire signals older than 24h
        const age = Date.now() - new Date(sig.created_at).getTime();
        if (age > 24 * 60 * 60 * 1000 && sig.status === 'active') {
          const pnl = isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
          const pnlRounded = Math.round(pnl * 100) / 100;

          await pool.query(`UPDATE signals SET status = 'expired', closed_at = NOW(), pnl_percent = $1 WHERE id = $2`, [pnlRounded, sig.id]);
          await pool.query(`INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
            [String(sig.id), sig.symbol, sig.direction, entry, price, 'expired', pnlRounded, pnl > 0 ? 'win' : 'loss']);

          closed++;
          console.log(`[SignalTracker] ⏰ ${sig.symbol} expired — PnL: ${pnlRounded}%`);
        }

      } catch (err: any) {
        console.error(`[SignalTracker] Error checking ${sig.symbol}:`, err.message);
      }
    }

    console.log(`[SignalTracker] Checked ${checked}/${activeSignals.length} signals, closed ${closed}`);
  } catch (err: any) {
    console.error('[SignalTracker] Error:', err.message);
  }
}
