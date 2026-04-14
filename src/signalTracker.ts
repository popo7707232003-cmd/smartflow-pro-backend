import { Pool } from 'pg';

const BINANCE_API = 'https://api.binance.com/api/v3/ticker/price';
const CHECK_INTERVAL = 30_000;    // 30 秒
const EXPIRY_HOURS = 24;          // 24 小時後過期

let pool: Pool;
let intervalId: NodeJS.Timeout | null = null;

// ============================================================
// 初始化
// ============================================================
export function initSignalTracker(dbPool: Pool) {
  pool = dbPool;
  ensureTable().then(() => {
    console.log('[SignalTracker] Initialized — checking every 30s');
    // 啟動後先跑一次
    checkSignals();
    intervalId = setInterval(checkSignals, CHECK_INTERVAL);
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
  // 確保欄位都在（防止舊表缺欄位）
  const cols = [
    { name: 'exit_type', type: 'VARCHAR(20)' },
    { name: 'result', type: 'VARCHAR(20)' },
    { name: 'pnl_percent', type: 'DOUBLE PRECISION' },
  ];
  for (const col of cols) {
    await pool.query(
      `ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`
    );
  }
}

// ============================================================
// 從 Binance 批量取價格
// ============================================================
async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  if (symbols.length === 0) return prices;

  try {
    const symbolList = JSON.stringify(symbols);
    const url = `${BINANCE_API}?symbols=${encodeURIComponent(symbolList)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status}`);
    const data: Array<{ symbol: string; price: string }> = await res.json();
    for (const item of data) {
      prices[item.symbol] = parseFloat(item.price);
    }
  } catch (err) {
    console.error('[SignalTracker] Price fetch error:', err);
    // fallback: 逐一抓
    for (const sym of symbols) {
      try {
        const res = await fetch(`${BINANCE_API}?symbol=${sym}`);
        const data = await res.json();
        prices[sym] = parseFloat(data.price);
      } catch { /* skip */ }
    }
  }
  return prices;
}

// ============================================================
// 核心：檢查所有 active 訊號
// ============================================================
async function checkSignals() {
  try {
    // 1. 撈所有 active 訊號
    const { rows: signals } = await pool.query(`
      SELECT id, symbol, direction, entry, tp1, tp2, sl,
             tp1_hit, tp2_hit, sl_hit, created_at
      FROM signals
      WHERE status = 'active'
      ORDER BY created_at DESC
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
  } catch (err) {
    console.error('[SignalTracker] Check error:', err);
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

    // 1. 更新 signals 表
    await client.query(
      `UPDATE signals SET
        status = 'closed',
        closed_at = NOW(),
        pnl_percent = $1,
        sl_hit = CASE WHEN $3 = 'sl' THEN true ELSE sl_hit END,
        tp2_hit = CASE WHEN $3 = 'tp2' THEN true ELSE tp2_hit END,
        tp1_hit = CASE WHEN $3 IN ('tp1','tp2') THEN true ELSE tp1_hit END
      WHERE id = $2`,
      [pnl, sig.id, exitType]
    );

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
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[SignalTracker] Close signal error (${sig.id}):`, err);
  } finally {
    client.release();
  }
}

export default { initSignalTracker };
