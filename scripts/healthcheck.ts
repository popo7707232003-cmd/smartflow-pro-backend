// backend/scripts/healthcheck.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 系統健康檢查腳本
// 執行方式：npx tsx scripts/healthcheck.ts
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import pg from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import WebSocket from 'ws';
import { ATR } from 'technicalindicators';

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';
const results: { name: string; status: string; detail: string }[] = [];

function log(name: string, ok: boolean, detail: string) {
  results.push({ name, status: ok ? PASS : FAIL, detail });
  console.log(`${ok ? PASS : FAIL} ${name}: ${detail}`);
}

async function checkPostgres() {
  const url = process.env.DATABASE_URL || 'postgresql://smartflow:smartflow_secret_2024@localhost:5432/smartflow';
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    const res = await pool.query('SELECT NOW() as now, current_database() as db');
    log('PostgreSQL', true, `Connected to "${res.rows[0].db}" at ${res.rows[0].now}`);
    // Check tables exist
    const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const tableNames = tables.rows.map((r: any) => r.tablename);
    const required = ['signals', 'signal_results', 'smart_money_txns', 'news_events', 'alerts'];
    const missing = required.filter(t => !tableNames.includes(t));
    if (missing.length > 0) {
      log('DB Tables', false, `Missing tables: ${missing.join(', ')}. Run: npx tsx src/db/migrate.ts`);
    } else {
      log('DB Tables', true, `All 5 tables exist: ${required.join(', ')}`);
    }
    await pool.end();
  } catch (err) {
    log('PostgreSQL', false, (err as Error).message);
  }
}

async function checkRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(url, { connectTimeout: 5000 });
  try {
    const pong = await redis.ping();
    log('Redis', pong === 'PONG', `Response: ${pong}`);
    // Test read/write
    await redis.set('healthcheck:test', 'ok', 'EX', 10);
    const val = await redis.get('healthcheck:test');
    log('Redis R/W', val === 'ok', `Write+Read test: ${val}`);
    redis.disconnect();
  } catch (err) {
    log('Redis', false, (err as Error).message);
  }
}

async function checkBinanceWS() {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log('Binance WebSocket', false, 'Connection timeout (10s). Check network/firewall.');
      resolve();
    }, 10000);

    try {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_1h');
      ws.on('open', () => {
        log('Binance WebSocket', true, 'Connected to wss://stream.binance.com');
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.k) {
            log('Binance Kline', true, `BTC 1H: O=${parseFloat(msg.k.o).toFixed(0)} H=${parseFloat(msg.k.h).toFixed(0)} L=${parseFloat(msg.k.l).toFixed(0)} C=${parseFloat(msg.k.c).toFixed(0)}`);
          }
        } catch {}
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on('error', (err) => {
        log('Binance WebSocket', false, `Error: ${err.message}`);
        clearTimeout(timeout);
        resolve();
      });
    } catch (err) {
      log('Binance WebSocket', false, (err as Error).message);
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function checkATR() {
  try {
    // Fetch real 1H klines from Binance REST
    const { data } = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: 'BTCUSDT', interval: '1h', limit: 50 },
      timeout: 10000,
    });

    const highs = data.map((k: any[]) => parseFloat(k[2]));
    const lows = data.map((k: any[]) => parseFloat(k[3]));
    const closes = data.map((k: any[]) => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];

    const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr = atrResult[atrResult.length - 1];
    const atrPct = (atr / currentPrice) * 100;

    const isReasonable = atr >= 300 && atr <= 2000;
    log('ATR Calculation', isReasonable,
      `BTC ATR(14,1H) = $${atr.toFixed(2)} (${atrPct.toFixed(3)}% of $${currentPrice.toFixed(0)})`);

    if (!isReasonable) {
      console.log(`   ${WARN} Expected BTC ATR: $300-$2000. Got: $${atr.toFixed(2)}`);
      if (atr < 50) console.log(`   ${FAIL} ATR is suspiciously LOW — are you using 1M/5M candles instead of 1H?`);
    }

    // Test stop levels
    const slDist = atr * 1.5;
    const tp1Dist = atr * 2.0;
    const sl = currentPrice - slDist;
    const tp1 = currentPrice + tp1Dist;
    const rr = tp1Dist / slDist;

    log('Stop Levels', slDist > 300,
      `Entry: $${currentPrice.toFixed(0)} | SL: $${sl.toFixed(0)} (-$${slDist.toFixed(0)}) | TP1: $${tp1.toFixed(0)} (+$${tp1Dist.toFixed(0)}) | R:R: ${rr.toFixed(2)}`);

  } catch (err) {
    log('ATR Calculation', false, (err as Error).message);
  }
}

async function checkSignalScan() {
  try {
    // Quick indicator check
    const { data } = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: 'BTCUSDT', interval: '1h', limit: 30 },
      timeout: 10000,
    });

    if (data.length >= 30) {
      log('Signal Data', true, `Got ${data.length} BTC 1H candles (need 30+ for scoring)`);
    } else {
      log('Signal Data', false, `Only ${data.length} candles available`);
    }

    // Check funding rate API
    try {
      const { data: frData } = await axios.get('https://fapi.binance.com/fapi/v1/fundingRate', {
        params: { symbol: 'BTCUSDT', limit: 1 },
        timeout: 5000,
      });
      if (frData.length > 0) {
        const rate = +(parseFloat(frData[0].fundingRate) * 100).toFixed(4);
        log('Funding Rate API', true, `BTC funding: ${rate}%`);
      }
    } catch {
      log('Funding Rate API', false, 'Binance Futures API unreachable (may be geo-blocked)');
    }
  } catch (err) {
    log('Signal Data', false, (err as Error).message);
  }
}

async function checkLocalWebSocket() {
  const wsPort = process.env.WS_PORT || '4001';
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log('Local WebSocket', false, `Cannot connect to ws://localhost:${wsPort} (backend not running?)`);
      resolve();
    }, 3000);

    try {
      const ws = new WebSocket(`ws://localhost:${wsPort}`);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'CONNECTED') {
            log('Local WebSocket', true, `Connected. ${msg.data?.clients || 0} clients online.`);
          }
        } catch {}
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on('error', () => {
        log('Local WebSocket', false, `Backend WS not running on port ${wsPort}`);
        clearTimeout(timeout);
        resolve();
      });
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function checkAPIs() {
    try {
        timeout: 5000,
      });
    } catch (err) {
    }
  } else {
  }

  // Etherscan
  const esKey = process.env.ETHERSCAN_API_KEY;
  if (esKey) {
    try {
      const { data } = await axios.get('https://api.etherscan.io/api', {
        params: { module: 'stats', action: 'ethprice', apikey: esKey },
        timeout: 5000,
      });
      log('Etherscan API', data.status === '1', `ETH price: $${data.result?.ethusd || '?'}`);
    } catch (err) {
      log('Etherscan API', false, (err as Error).message);
    }
  } else {
    log('Etherscan API', false, 'No key set (ETHERSCAN_API_KEY). Smart money will be limited.');
  }
}

// ═══ MAIN ═══
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  SmartFlow Pro — 系統健康檢查');
  console.log('══════════════════════════════════════════');
  console.log('');

  await checkPostgres();
  console.log('');
  await checkRedis();
  console.log('');
  await checkBinanceWS();
  console.log('');
  await checkATR();
  console.log('');
  await checkSignalScan();
  console.log('');
  await checkLocalWebSocket();
  console.log('');
  await checkAPIs();

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  結果摘要');
  console.log('══════════════════════════════════════════');

  const passed = results.filter(r => r.status === PASS).length;
  const failed = results.filter(r => r.status === FAIL).length;

  results.forEach(r => console.log(`  ${r.status} ${r.name}`));

  console.log('');
  console.log(`  通過: ${passed}  失敗: ${failed}  共: ${results.length}`);

  if (failed === 0) {
    console.log('');
    console.log('  🎉 所有檢查通過！系統可以正式運行。');
  } else {
    console.log('');
    console.log(`  ⚠️  有 ${failed} 項未通過，請檢查上方錯誤訊息。`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Health check failed:', err); process.exit(1); });
