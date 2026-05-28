import { Pool } from 'pg';

// data-api.binance.vision is reachable from Railway's region; api.binance.com
// is NOT (debug endpoint confirms this — see signalScanner.ts for the same
// pattern). Try the data-api host first, fall back to api.binance.com.
const BINANCE_PRICE_URLS = [
  'https://data-api.binance.vision/api/v3/ticker/price',
  'https://api.binance.com/api/v3/ticker/price',
];
const CHECK_INTERVAL = 30_000;    // 30 秒
const EXPIRY_HOURS = 24;          // 24 小時後過期

let pool: Pool;
let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

// Diagnostic state — exposed via getTrackerStatus() for debug endpoint
let ensureTableOk = false;
let ensureTableError: string | null = null;
let lastCheckStartAt: number | null = null;
let lastCheckEndAt: number | null = null;
let lastSignalsFetched = 0;
let lastClosed = 0;
let lastTp1Marked = 0;
let lastExpired = 0;
let lastCheckError: string | null = null;
let lastCloseError: string | null = null;
let lastCloseErrorAt: number | null = null;
let lastPricesFetched = 0;
let lastPriceFetchError: string | null = null;

export function getTrackerStatus() {
  const now = Date.now();
  return {
    isRunning,
    ensureTableOk,
    ensureTableError,
    lastCheckStartAt: lastCheckStartAt ? new Date(lastCheckStartAt).toISOString() : null,
    lastCheckEndAt:   lastCheckEndAt   ? new Date(lastCheckEndAt).toISOString()   : null,
    lastCheckAgeSec:  lastCheckStartAt ? Math.round((now - lastCheckStartAt) / 1000) : null,
    lastCheckDurationMs: lastCheckStartAt && lastCheckEndAt ? lastCheckEndAt - lastCheckStartAt : null,
    lastSignalsFetched,
    lastClosed,
    lastTp1Marked,
    lastExpired,
    lastCheckError,
    lastCloseError,
    lastCloseErrorAt: lastCloseErrorAt ? new Date(lastCloseErrorAt).toISOString() : null,
    lastPricesFetched,
    lastPriceFetchError,
  };
}

// ============================================================
// 初始化
// ============================================================
export function initSignalTracker(dbPool: Pool) {
  pool = dbPool;
  ensureTable()
    .then(() => {
      ensureTableOk = true;
      console.log('[SignalTracker] Initialized — checking every 30s');
      // 啟動後先跑一次
      checkSignals();
      intervalId = setInterval(checkSignals, CHECK_INTERVAL);
    })
    .catch((err) => {
      ensureTableError = err?.message || String(err);
      console.error('[SignalTracker] FATAL: ensureTable failed, tracker not started:', err);
    });
}

// 確保 signal_results 表結構正確
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_results (
      id SERIAL PRIMARY KEY,
      signal_id TEXT NOT NULL,
      symbol VARCHAR(20),
      direction VARCHAR(10),
      entry NUMERIC,
      exit_price NUMERIC,
      exit_type VARCHAR(20),
      pnl_percent DOUBLE PRECISION,
      result VARCHAR(20),
      closed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // 確保欄位都在（防止舊表缺欄位）— legacy schema 沒有 symbol/direction/entry/exit_price
  const cols = [
    { name: 'symbol', type: 'VARCHAR(20)' },
    { name: 'direction', type: 'VARCHAR(10)' },
    { name: 'entry', type: 'NUMERIC' },
    { name: 'exit_price', type: 'NUMERIC' },
    { name: 'exit_type', type: 'VARCHAR(20)' },
    { name: 'result', type: 'VARCHAR(20)' },
    { name: 'pnl_percent', type: 'DOUBLE PRECISION' },
  ];
  for (const col of cols) {
    await pool.query(
      `ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`
    );
  }

  // Legacy UUID-based schema had result_type/pnl/pnl_pct as NOT NULL; the
  // active INSERT does not write those columns. Drop NOT NULL so the INSERT
  // can succeed. Only swallow SQLSTATE 42703 ("column does not exist") for
  // fresh DBs; rethrow everything else so operational failures surface.
  const dropNotNull = ['result_type', 'pnl', 'pnl_pct'];
  for (const col of dropNotNull) {
    try {
      await pool.query(`ALTER TABLE signal_results ALTER COLUMN ${col} DROP NOT NULL`);
    } catch (e: any) {
      if (e?.code !== '42703') throw e;
    }
  }
}

// ============================================================
// 從 Binance 批量取價格
// ============================================================
// Wrap fetch with a hard timeout so a hung Binance request can't strand the
// tracker (isRunning would otherwise stay true forever and block all scans).
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  lastPriceFetchError = null;
  if (symbols.length === 0) {
    lastPricesFetched = 0;
    return prices;
  }

  const encodedSymbols = encodeURIComponent(JSON.stringify(symbols));
  const errors: string[] = [];

  // Try bulk endpoint on each host in order. Treat empty/all-invalid
  // responses as failure so we fall through to the next host or per-symbol
  // fallback, instead of silently returning 0 prices.
  for (const base of BINANCE_PRICE_URLS) {
    try {
      const res = await fetchWithTimeout(`${base}?symbols=${encodedSymbols}`);
      if (!res.ok) {
        errors.push(`${base} → ${res.status}`);
        continue;
      }
      const data: Array<{ symbol: string; price: string }> = await res.json();
      const collected: Record<string, number> = {};
      for (const item of data) {
        if (!item || typeof item.symbol !== 'string') continue;
        const p = parseFloat(item.price);
        if (Number.isFinite(p) && p > 0) collected[item.symbol] = p;
      }
      if (Object.keys(collected).length === 0) {
        errors.push(`${base} → empty/malformed bulk response`);
        continue;
      }
      Object.assign(prices, collected);
      lastPricesFetched = Object.keys(prices).length;
      return prices;
    } catch (err: any) {
      errors.push(`${base} → ${err?.message || err}`);
    }
  }

  // Per-symbol fallback across both hosts
  for (const sym of symbols) {
    for (const base of BINANCE_PRICE_URLS) {
      try {
        const res = await fetchWithTimeout(`${base}?symbol=${encodeURIComponent(sym)}`);
        if (!res.ok) continue;
        const data: any = await res.json();
        const p = parseFloat(data?.price);
        if (Number.isFinite(p) && p > 0) {
          prices[sym] = p;
          break;
        }
      } catch { /* try next */ }
    }
  }
  lastPricesFetched = Object.keys(prices).length;
  if (lastPricesFetched === 0) {
    lastPriceFetchError = errors.join('; ') || 'all price fetches failed';
    console.error('[SignalTracker] Price fetch failed:', lastPriceFetchError);
  }
  return prices;
}

// ============================================================
// 核心：檢查所有 active 訊號
// ============================================================
async function checkSignals() {
  // In-flight guard: 30s interval is shorter than a full backlog drain.
  // Without this, overlapping scans exhaust the pg pool and hammer Binance.
  if (isRunning) {
    console.log('[SignalTracker] Previous scan still running, skipping');
    return;
  }
  isRunning = true;
  lastCheckStartAt = Date.now();
  lastCheckError = null;
  try {
    // 1. 撈最多 500 筆 active 訊號（FIFO oldest-first，確保 backlog 排水）
    const { rows: signals } = await pool.query(`
      SELECT id, symbol, direction, entry, tp1, tp2, sl,
             tp1_hit, tp2_hit, sl_hit, created_at
      FROM signals
      WHERE status = 'active'
      ORDER BY created_at ASC
      LIMIT 500
    `);

    if (signals.length === 0) {
      console.log('[SignalTracker] No active signals');
      return;
    }

    // 2. 取得所有需要的幣種價格
    const uniqueSymbols = [...new Set(signals.map((s: any) => s.symbol as string))];
    const prices = await fetchPrices(uniqueSymbols);

    let closedCount = 0;
    let tp1Count = 0;
    let expiredCount = 0;

    // 3. 逐一檢查
    for (const sig of signals) {
      const price = prices[sig.symbol];
      if (!price) continue;

      const entry = parseFloat(sig.entry);
      const tp1 = parseFloat(sig.tp1);
      const tp2 = parseFloat(sig.tp2);
      const sl = parseFloat(sig.sl);
      const dir = sig.direction?.toUpperCase();
      const signalAge = Date.now() - new Date(sig.created_at).getTime();
      const hoursOld = signalAge / (1000 * 60 * 60);

      // --- 過期檢查 ---
      if (hoursOld > EXPIRY_HOURS) {
        const pnl = dir === 'LONG'
          ? ((price - entry) / entry) * 100
          : ((entry - price) / entry) * 100;

        await closeSignal(sig, price, 'expired', pnl, 'expired');
        expiredCount++;
        continue;
      }

      // --- SL 觸發（僢先判斷，避免同時觸發 TP 和 SL 時選錯）---
      const slHit = dir === 'LONG' ? price <= sl : price >= sl;
      if (slHit) {
        const pnl = dir === 'LONG'
          ? ((sl - entry) / entry) * 100
          : ((entry - sl) / entry) * 100;

        await closeSignal(sig, sl, 'sl', pnl, 'loss');
        closedCount++;
        continue;
      }

      // --- TP2 觸發 ---
      const tp2Hit = dir === 'LONG' ? price >= tp2 : price <= tp2;
      if (tp2Hit) {
        const pnl = dir === 'LONG'
          ? ((tp2 - entry) / entry) * 100
          : ((entry - tp2) / entry) * 100;

        await closeSignal(sig, tp2, 'tp2', pnl, 'win');
        closedCount++;
        continue;
      }

      // --- TP1 觸發（不關閉，只標記）---
      const tp1Hit = dir === 'LONG' ? price >= tp1 : price <= tp1;
      if (tp1Hit && !sig.tp1_hit) {
        await pool.query(
          `UPDATE signals SET tp1_hit = true WHERE id = $1`,
          [sig.id]
        );
        tp1Count++;
      }
    }

    console.log(
      `[SignalTracker] Checked ${signals.length} signals — ` +
      `closed: ${closedCount}, tp1_hit: ${tp1Count}, expired: ${expiredCount}`
    );
    lastSignalsFetched = signals.length;
    lastClosed = closedCount;
    lastTp1Marked = tp1Count;
    lastExpired = expiredCount;
  } catch (err: any) {
    lastCheckError = err?.message || String(err);
    console.error('[SignalTracker] Check error:', err);
  } finally {
    lastCheckEndAt = Date.now();
    isRunning = false;
  }
}

// ============================================================
// 關閉訊號 + 寫入 signal_results
// ============================================================
async function closeSignal(
  sig: any,
  exitPrice: number,
  exitType: string,    // 'tp1' | 'tp2' | 'sl' | 'expired'
  pnl: number,
  result: string       // 'win' | 'loss' | 'expired'
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 更新 signals 表（gate on status='active' 防止並發重複關閉 → 重複 INSERT）
    const updateResult = await client.query(
      `UPDATE signals SET
        status = 'closed',
        closed_at = NOW(),
        pnl_percent = $1,
        sl_hit = CASE WHEN $3 = 'sl' THEN true ELSE sl_hit END,
        tp2_hit = CASE WHEN $3 = 'tp2' THEN true ELSE tp2_hit END,
        tp1_hit = CASE WHEN $3 IN ('tp1','tp2') THEN true ELSE tp1_hit END
      WHERE id = $2 AND status = 'active'`,
      [pnl, sig.id, exitType]
    );
    if (updateResult.rowCount === 0) {
      // 已被並發掃描關閉，放棄這次 INSERT
      await client.query('ROLLBACK');
      return;
    }

    // 如果是 expired，status 設為 expired 而非 closed
    if (exitType === 'expired') {
      await client.query(
        `UPDATE signals SET status = 'expired' WHERE id = $1`,
        [sig.id]
      );
    }

    // 2. 寫入 signal_results
    await client.query(
      `INSERT INTO signal_results
        (signal_id, symbol, direction, entry, exit_price, exit_type, pnl_percent, result, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        sig.id.toString(),  // signal_id 是 TEXT
        sig.symbol,
        sig.direction,
        parseFloat(sig.entry),
        exitPrice,
        exitType,
        Math.round(pnl * 100) / 100,  // 保留兩位小數
        result,
      ]
    );

    await client.query('COMMIT');
    console.log(
      `[SignalTracker] ${sig.symbol} ${sig.direction} → ${result.toUpperCase()} ` +
      `(${exitType}, PnL: ${pnl.toFixed(2)}%)`
    );
  } catch (err: any) {
    await client.query('ROLLBACK');
    lastCloseError = `id=${sig.id} ${err?.message || String(err)}`;
    lastCloseErrorAt = Date.now();
    console.error(`[SignalTracker] Close signal error (${sig.id}):`, err);
  } finally {
    client.release();
  }
}

export default { initSignalTracker };
