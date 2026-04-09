// backend/scripts/test_smartmoney.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 聰明錢分類測試
// 執行方式：npx tsx scripts/test_smartmoney.ts
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import axios from 'axios';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', M = '\x1b[36m', W = '\x1b[37m', X = '\x1b[0m';

// Exchange addresses (lowercase)
const EXCHANGES: Record<string, string> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
};

function classify(from: string, to: string): { type: string; label: string; color: string } {
  const fromExchange = EXCHANGES[from.toLowerCase()];
  const toExchange = EXCHANGES[to.toLowerCase()];
  if (toExchange && !fromExchange) return { type: 'sell_pressure', label: `→ ${toExchange} (賣壓)`, color: R };
  if (fromExchange && !toExchange) return { type: 'accumulation', label: `← ${fromExchange} (吸籌)`, color: G };
  return { type: 'transfer', label: '↔ 轉帳 (中性)', color: Y };
}

async function main() {
  const WHALE_ADDRESS = '0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296';
  const etherscanKey = process.env.ETHERSCAN_API_KEY || '';

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  SmartFlow Pro — 聰明錢分類測試');
  console.log('══════════════════════════════════════════');
  console.log('');
  console.log(`${M}目標鯨魚地址:${X} ${WHALE_ADDRESS}`);
  console.log(`${M}Etherscan Key:${X} ${etherscanKey ? '✅ 已設定' : '⚠️ 未設定 (使用免費限額)'}`);
  console.log('');

  // ─── 1. Fetch ERC-20 token transfers ───
  console.log(`${M}[1/3] 查詢 ERC-20 代幣轉帳...${X}`);
  try {
    const params: Record<string, string> = {
      module: 'account', action: 'tokentx',
      address: WHALE_ADDRESS, page: '1', offset: '10', sort: 'desc',
    };
    if (etherscanKey) params.apikey = etherscanKey;

    const { data } = await axios.get('https://api.etherscan.io/api', { params, timeout: 10000 });

    if (data.status === '1' && data.result) {
      console.log(`  ${G}✅ 取得 ${data.result.length} 筆代幣轉帳${X}`);
      console.log('');

      for (const tx of data.result.slice(0, 5)) {
        const token = tx.tokenSymbol || 'UNKNOWN';
        const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal) || 18);
        const { type, label, color } = classify(tx.from, tx.to);
        const time = new Date(parseInt(tx.timeStamp) * 1000).toLocaleString('zh-TW');

        console.log(`  ┌─ ${W}${token}${X} ${amount > 0.01 ? amount.toFixed(4) : amount.toFixed(8)}`);
        console.log(`  │ ${color}${label}${X}`);
        console.log(`  │ From: ${tx.from.slice(0, 10)}... ${EXCHANGES[tx.from.toLowerCase()] ? `(${EXCHANGES[tx.from.toLowerCase()]})` : ''}`);
        console.log(`  │ To:   ${tx.to.slice(0, 10)}... ${EXCHANGES[tx.to.toLowerCase()] ? `(${EXCHANGES[tx.to.toLowerCase()]})` : ''}`);
        console.log(`  │ Type: ${color}${type}${X}`);
        console.log(`  │ Time: ${time}`);
        console.log(`  └─`);
        console.log('');
      }
    } else {
      console.log(`  ${R}❌ Etherscan 返回錯誤: ${data.message || 'Unknown'}${X}`);
    }
  } catch (err) {
    console.log(`  ${R}❌ 請求失敗: ${(err as Error).message}${X}`);
  }

  // ─── 2. Fetch ETH transfers ───
  console.log(`${M}[2/3] 查詢 ETH 轉帳...${X}`);
  try {
    const params: Record<string, string> = {
      module: 'account', action: 'txlist',
      address: WHALE_ADDRESS, page: '1', offset: '5', sort: 'desc',
    };
    if (etherscanKey) params.apikey = etherscanKey;

    const { data } = await axios.get('https://api.etherscan.io/api', { params, timeout: 10000 });

    if (data.status === '1' && data.result) {
      console.log(`  ${G}✅ 取得 ${data.result.length} 筆 ETH 轉帳${X}`);
      for (const tx of data.result.slice(0, 3)) {
        const ethVal = parseFloat(tx.value) / 1e18;
        if (ethVal < 0.01) continue;
        const { type, label, color } = classify(tx.from, tx.to);
        console.log(`  ${color}ETH ${ethVal.toFixed(4)} | ${label} | ${type}${X}`);
      }
    }
  } catch (err) {
    console.log(`  ${R}❌ ${(err as Error).message}${X}`);
  }

  // ─── 3. Classification logic test ───
  console.log('');
  console.log(`${M}[3/3] 分類邏輯驗證...${X}`);

  const tests = [
    { from: '0x1234567890abcdef', to: '0x28c6c06298d514db089934071355e5743bf21d60', expect: 'sell_pressure', desc: '錢包 → Binance = 賣壓' },
    { from: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3', to: '0x1234567890abcdef', expect: 'accumulation', desc: 'Coinbase → 錢包 = 吸籌' },
    { from: '0xaaaa', to: '0xbbbb', expect: 'transfer', desc: '錢包 → 錢包 = 轉帳 (中性)' },
    { from: '0x28c6c06298d514db089934071355e5743bf21d60', to: '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', expect: 'transfer', desc: 'Binance → OKX = 轉帳 (交易所間)' },
  ];

  let allPass = true;
  for (const t of tests) {
    const { type } = classify(t.from, t.to);
    const pass = type === t.expect;
    if (!pass) allPass = false;
    console.log(`  ${pass ? G + '✅' : R + '❌'} ${t.desc} → ${type} ${pass ? '' : `(expected: ${t.expect})`}${X}`);
  }

  console.log('');
  console.log(`  ${allPass ? G + '✅ 所有分類測試通過' : R + '❌ 有分類錯誤'}${X}`);
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => { console.error('Test failed:', err.message); process.exit(1); });
