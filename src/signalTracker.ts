import { Pool } from 'pg';

let pool: Pool;
const CHECK_INTERVAL = 30 * 1000; // 30 seconds

// Cache latest prices (updated from websocket module or fetched)
let priceCache: Record<string, number> = {};

export function initSignalTracker(dbPool: Pool) {
  pool = dbPool;
  ensureTables().then(() => {
    console.log('[SignalTracker] Starting — checking every 30 seconds');
    checkSignals();
    setInterval(checkSignals, CHECK_INTERVAL);
  });
}

export function updatePriceCache(symbol: string, price: number) {
  priceCache[symbol] = price;
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_results (
      id SERIAL PRIMARY KEY,
      signal_id INTEGER REFERENCES signals(id),
      symbol VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      entry DOUBLE PRECISION NOT NULL,
      exit_price DOUBLE PRECISION NOT NULL,
      exit_type VARCHAR(20) NOT NULL,
      pnl_percent DOUBLE PRECISION NOT NULL,
      result VARCHAR(10) NOT NULL,
      closed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sr_closed ON signal_results(closed_at DESC);

    -- Fix missing columns on existing table
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS result VARCHAR(10) DEFAULT 'unknown';
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS exit_type VARCHAR(20) DEFAULT 'unknown';
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS exit_price DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS pnl_percent DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS direction VARCHAR(10) DEFAULT '';
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS symbol VARCHAR(20) DEFAULT '';
    ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS signal_id INTEGER;

    CREATE TABLE IF NOT EXISTS daily_stats (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      total_signals INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      partial_wins INTEGER DEFAULT 0,
      total_pnl DOUBLE PRECISION DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ensure columns exist on signals table (safe to re-run)
  const cols = ['tp1_hit', 'tp2_hit', 'sl_hit', 'closed_at', 'pnl_percent'];
  for (const col of cols) {
    try {
      const type = col.includes('hit') ? 'BOOLEAN DEFAULT FALSE'
        : col === 'closed_at' ? 'TIMESTAMPTZ'
        : 'DOUBLE PRECISION';
      await pool.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    } catch {}
  }
}

async function fetchPrice(symbol: string): Promise<number> {
  if (priceCache[symbol] && Date.now() - (priceCache[`${symbol}_ts`] as unknown as number || 0) < 60000) {
    return priceCache[symbol];
  }

  const urls = [
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any;
      const price = parseFloat(data.price);
      priceCache[symbol] = price;
      return price;
    } catch { continue; }
  }
  return priceCache[symbol] || 0;
}

async function checkSignals() {
  try {
    const { rows: activeSignals } = await pool.query(`
      SELECT * FROM signals WHERE status = 'active' ORDER BY created_at DESC
    `);

    if (activeSignals.length === 0) return;

    let checked = 0, closed = 0;

    for (const sig of activeSignals) {
      try {
        const price = await fetchPrice(sig.symbol);
        if (!price) continue;
        checked++;

        const isLong = sig.direction === 'LONG';

        // Check SL hit
        const slHit = isLong ? price <= sig.sl : price >= sig.sl;
        // Check TP1 hit
        const tp1Hit = isLong ? price >= sig.tp1 : price <= sig.tp1;
        // Check TP2 hit
        const tp2Hit = isLong ? price >= sig.tp2 : price <= sig.tp2;

        if (slHit && !sig.tp1_hit) {
          // Full stop loss — loss
          const pnl = isLong
            ? ((sig.sl - sig.entry) / sig.entry) * 100
            : ((sig.entry - sig.sl) / sig.entry) * 100;

          await pool.query(`
            UPDATE signals SET status = 'closed', sl_hit = TRUE, closed_at = NOW(), pnl_percent = $1
            WHERE id = $2
          `, [Math.round(pnl * 100) / 100, sig.id]);

          await pool.query(`
            INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result)
            VALUES ($1, $2, $3, $4, $5, 'sl', $6, 'loss')
          `, [sig.id, sig.symbol, sig.direction, sig.entry, sig.sl, Math.round(pnl * 100) / 100]);

          closed++;
          console.log(`[SignalTracker] ❌ ${sig.symbol} SL hit — PnL: ${pnl.toFixed(2)}%`);

        } else if (slHit && sig.tp1_hit) {
          // SL hit after TP1 — partial win (50% already locked, remaining 50% stopped)
          const pnlTp1 = isLong
            ? ((sig.tp1 - sig.entry) / sig.entry) * 100 * 0.5
            : ((sig.entry - sig.tp1) / sig.entry) * 100 * 0.5;
          const pnlRemaining = isLong
            ? ((sig.sl - sig.entry) / sig.entry) * 100 * 0.5
            : ((sig.entry - sig.sl) / sig.entry) * 100 * 0.5;
          const totalPnl = pnlTp1 + pnlRemaining;

          await pool.query(`
            UPDATE signals SET status = 'closed', sl_hit = TRUE, closed_at = NOW(), pnl_percent = $1
            WHERE id = $2
          `, [Math.round(totalPnl * 100) / 100, sig.id]);

          await pool.query(`
            INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result)
            VALUES ($1, $2, $3, $4, $5, 'sl_after_tp1', $6, 'partial')
          `, [sig.id, sig.symbol, sig.direction, sig.entry, sig.sl, Math.round(totalPnl * 100) / 100]);

          closed++;

        } else if (tp2Hit) {
          // Full win — both TP hit
          const pnl = isLong
            ? ((sig.tp2 - sig.entry) / sig.entry) * 100
            : ((sig.entry - sig.tp2) / sig.entry) * 100;

          await pool.query(`
            UPDATE signals SET status = 'closed', tp1_hit = TRUE, tp2_hit = TRUE, closed_at = NOW(), pnl_percent = $1
            WHERE id = $2
          `, [Math.round(pnl * 100) / 100, sig.id]);

          await pool.query(`
            INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result)
            VALUES ($1, $2, $3, $4, $5, 'tp2', $6, 'win')
          `, [sig.id, sig.symbol, sig.direction, sig.entry, sig.tp2, Math.round(pnl * 100) / 100]);

          closed++;
          console.log(`[SignalTracker] ✅ ${sig.symbol} TP2 hit — PnL: ${pnl.toFixed(2)}%`);

        } else if (tp1Hit && !sig.tp1_hit) {
          // TP1 hit — mark partial profit, move SL to breakeven
          const pnlPartial = isLong
            ? ((sig.tp1 - sig.entry) / sig.entry) * 100 * 0.5
            : ((sig.entry - sig.tp1) / sig.entry) * 100 * 0.5;

          // Move SL to entry (breakeven) for remaining 50%
          await pool.query(`
            UPDATE signals SET tp1_hit = TRUE, sl = entry WHERE id = $1
          `, [sig.id]);

          await pool.query(`
            INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result)
            VALUES ($1, $2, $3, $4, $5, 'tp1_partial', $6, 'partial')
          `, [sig.id, sig.symbol, sig.direction, sig.entry, sig.tp1, Math.round(pnlPartial * 100) / 100]);

          console.log(`[SignalTracker] 🟡 ${sig.symbol} TP1 hit — 50% closed, SL→BE`);
        }

        // Expire signals older than 24h
        const age = Date.now() - new Date(sig.created_at).getTime();
        if (age > 24 * 60 * 60 * 1000 && sig.status === 'active') {
          const pnl = isLong
            ? ((price - sig.entry) / sig.entry) * 100
            : ((sig.entry - price) / sig.entry) * 100;

          await pool.query(`
            UPDATE signals SET status = 'expired', closed_at = NOW(), pnl_percent = $1 WHERE id = $2
          `, [Math.round(pnl * 100) / 100, sig.id]);

          await pool.query(`
            INSERT INTO signal_results (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result)
            VALUES ($1, $2, $3, $4, $5, 'expired', $6, $7)
          `, [sig.id, sig.symbol, sig.direction, sig.entry, price,
              Math.round(pnl * 100) / 100, pnl > 0 ? 'win' : 'loss']);

          closed++;
        }

      } catch (err: any) {
        console.error(`[SignalTracker] Error checking ${sig.symbol}:`, err.message);
      }
    }

    if (checked > 0) {
      console.log(`[SignalTracker] Checked ${checked} signals, closed ${closed}`);
    }
  } catch (err: any) {
    console.error('[SignalTracker] Error:', err.message);
  }
}
