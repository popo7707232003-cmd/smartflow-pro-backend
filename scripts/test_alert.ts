// backend/scripts/test_alert.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 警報系統端到端測試
// 執行方式：npx tsx scripts/test_alert.ts
//
// 測試流程：
//   1. 透過 API 觸發 mock 警報
//   2. 同時用 WebSocket 監聽是否收到推播
//   3. 查詢資料庫確認是否已存入
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import axios from 'axios';
import WebSocket from 'ws';
import pg from 'pg';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', M = '\x1b[36m', W = '\x1b[37m', X = '\x1b[0m';

const API_URL = process.env.VITE_API_URL || 'http://localhost:4000';
const WS_URL = `ws://localhost:${process.env.WS_PORT || 4001}`;
const DB_URL = process.env.DATABASE_URL || 'postgresql://smartflow:smartflow_secret_2024@localhost:5432/smartflow';

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  SmartFlow Pro — 警報端到端測試');
  console.log('══════════════════════════════════════════');
  console.log('');

  let wsReceived = false;
  let wsData: any = null;
  let dbInserted = false;
  let apiSuccess = false;

  // ─── Step 1: Connect WebSocket to listen for the alert ───
  console.log(`${M}[1/4] 連接 WebSocket (${WS_URL})...${X}`);

  const wsPromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!wsReceived) console.log(`  ${Y}⚠️ WebSocket 超時 (5s)，後端可能未運行${X}`);
      resolve();
    }, 5000);

    try {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => console.log(`  ${G}✅ WebSocket 已連接${X}`));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'CONNECTED') return; // Skip welcome
          wsReceived = true;
          wsData = msg;
          console.log(`  ${G}✅ 收到 WebSocket 推播: type=${msg.type}${X}`);
          clearTimeout(timeout);
          ws.close();
          resolve();
        } catch {}
      });
      ws.on('error', (err) => {
        console.log(`  ${R}❌ WebSocket 連線失敗: ${err.message}${X}`);
        console.log(`  ${Y}   請確認後端已啟動 (npm run dev)${X}`);
        clearTimeout(timeout);
        resolve();
      });
    } catch (err) {
      console.log(`  ${R}❌ ${(err as Error).message}${X}`);
      clearTimeout(timeout);
      resolve();
    }
  });

  // Give WS time to connect
  await new Promise(r => setTimeout(r, 1000));

  // ─── Step 2: Trigger mock alert via API ───
  console.log('');
  console.log(`${M}[2/4] 透過 API 觸發 Level A 警報...${X}`);

  const alertPayload = {
    type: 'NEWS_ALERT_A',
    level: 'A',
    title: '🔴 FOMC 利率決議：聯準會宣布升息 25bp',
    message: '聯準會於今日 FOMC 會議宣布升息 25 個基點至 5.75%，為2025年首次升息。鮑威爾表示通膨仍高於目標，暗示年內可能再升一次。市場即時反應：BTC 下跌 3.2%。',
    affectedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    source: 'news',
  };

  try {
    const { data } = await axios.post(`${API_URL}/api/alerts/mock`, alertPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    apiSuccess = data.success;
    console.log(`  ${apiSuccess ? G + '✅' : R + '❌'} API 回應: ${data.message || JSON.stringify(data)}${X}`);
    if (data.data) {
      console.log(`  Alert ID: ${data.data.id}`);
    }
  } catch (err: any) {
    console.log(`  ${R}❌ API 請求失敗: ${err.response?.data?.error || err.message}${X}`);
    console.log(`  ${Y}   請確認後端已啟動在 ${API_URL}${X}`);
  }

  // ─── Step 3: Wait for WebSocket message ───
  console.log('');
  console.log(`${M}[3/4] 等待 WebSocket 推播...${X}`);
  await wsPromise;

  if (wsReceived && wsData) {
    console.log(`  推播內容：`);
    console.log(`    type:  ${wsData.type || wsData.data?.type || '?'}`);
    console.log(`    level: ${wsData.level || wsData.data?.level || '?'}`);
    console.log(`    title: ${wsData.data?.title || '?'}`);
    console.log(`    sound: ${wsData.data?.soundEnabled ? '🔊 ON' : '🔇 off'}`);
    console.log(`    fullscreen: ${wsData.data?.fullscreen ? '📺 YES' : 'no'}`);
  }

  // ─── Step 4: Check database ───
  console.log('');
  console.log(`${M}[4/4] 查詢資料庫確認寫入...${X}`);

  try {
    const pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 5000 });
    const result = await pool.query(
      `SELECT id, type, level, title, source, created_at FROM alerts ORDER BY created_at DESC LIMIT 1`
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      dbInserted = true;
      console.log(`  ${G}✅ 資料庫已寫入:${X}`);
      console.log(`    id:    ${row.id}`);
      console.log(`    type:  ${row.type}`);
      console.log(`    level: ${row.level}`);
      console.log(`    title: ${row.title?.slice(0, 50)}...`);
      console.log(`    time:  ${row.created_at}`);
    } else {
      console.log(`  ${Y}⚠️ 資料庫中沒有找到警報記錄${X}`);
    }
    await pool.end();
  } catch (err) {
    console.log(`  ${R}❌ 資料庫查詢失敗: ${(err as Error).message}${X}`);
  }

  // ─── Summary ───
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  結果摘要');
  console.log('══════════════════════════════════════════');
  console.log(`  ${apiSuccess ? G + '✅' : R + '❌'} API 觸發${X}`);
  console.log(`  ${wsReceived ? G + '✅' : R + '❌'} WebSocket 推播${X}`);
  console.log(`  ${dbInserted ? G + '✅' : R + '❌'} 資料庫存儲${X}`);
  console.log('');

  if (apiSuccess && wsReceived && dbInserted) {
    console.log(`  ${G}🎉 完整警報鏈路正常！${X}`);
    console.log(`  ${G}   API → AlertEngine → DB + WebSocket → 前端${X}`);
  } else if (apiSuccess) {
    console.log(`  ${Y}⚠️ API 成功但 WS/DB 有問題。請確認後端完整啟動。${X}`);
  } else {
    console.log(`  ${R}❌ 後端未運行。請先執行: cd backend && npm run dev${X}`);
  }
  console.log('');

  process.exit(apiSuccess ? 0 : 1);
}

main().catch(err => { console.error('Test failed:', err.message); process.exit(1); });
