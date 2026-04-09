// backend/src/services/smartMoney.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 聰明錢鏈上追蹤系統
// ═══════════════════════════════════════════════════════════════
//
// 三層數據源（按優先序）：
//   1. Nansen API (付費) → 最準確的 Smart Money 標籤
//   2. Arkham Intelligence API (次選)
//   3. Etherscan API (免費兜底)
//
// 功能：
//   - 監控 10+ 已知聰明錢錢包
//   - 自動分類：sell_pressure / accumulation / transfer
//   - 過濾閾值：BTC > $500K / ETH > $200K / 其他 > $50K
//   - 大額交易即時推播 (WebSocket)
// ═══════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import pg from 'pg';
import { config } from '../config/index';

// ═══ Types ═══

export type TxType = 'sell_pressure' | 'accumulation' | 'transfer';

export interface SmartMoneyTx {
  id: string;
  walletAddress: string;
  walletLabel: string;
  txHash: string;
  blockchain: string;
  type: TxType;
  token: string;
  amount: number;
  usdValue: number;
  fromAddress: string;
  toAddress: string;
  fromLabel: string;
  toLabel: string;
  timestamp: number;
  minutesAgo: number;
  relatedSignalSymbol: string | null;
}

export interface WalletConfig {
  address: string;
  label: string;
  blockchain: string;
  tags: string[];
}

interface RawTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  tokenDecimal: number;
  blockTimestamp: number;
  blockchain: string;
}

// ═══════════════════════════════════════════════════════
// KNOWN ADDRESSES DATABASE
// ═══════════════════════════════════════════════════════

/** 10 real, publicly known smart money / whale / market maker wallets */
const DEFAULT_WALLETS: WalletConfig[] = [
  { address: '0x56Eddb7aa87536c09CCc2793473599fD21A8b17F', label: 'Cumberland DRW', blockchain: 'ethereum', tags: ['market_maker', 'smart_money'] },
  { address: '0xDA9dfA130Df4dE4673b89022EE50ff26f6EA73Cf', label: 'Jump Trading', blockchain: 'ethereum', tags: ['market_maker', 'smart_money'] },
  { address: '0x0716a17FBAEe714f1E6aB0f9d59edbC5f09815C0', label: 'Wintermute', blockchain: 'ethereum', tags: ['market_maker'] },
  { address: '0x1B3cB81E51011b549d78bf720b0d924ac763A7C2', label: 'Grayscale', blockchain: 'ethereum', tags: ['institution', 'fund'] },
  { address: '0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489', label: 'Robinhood', blockchain: 'ethereum', tags: ['exchange'] },
  { address: '0x8103683202aa8DA10536036EDef04CDd865c225E', label: 'Nansen Smart Money #7', blockchain: 'ethereum', tags: ['smart_money'] },
  { address: '0x2fAF487A4414Fe77e2327F0bf4AE2a264a776AD2', label: 'FTX Estate Wallet', blockchain: 'ethereum', tags: ['whale'] },
  { address: '0x6262998Ced04146fA42253a5C0AF90CA02dfd2A3', label: 'Crypto.com', blockchain: 'ethereum', tags: ['exchange'] },
  { address: '0x77134cbC06cB00b66F4c7e623D5fdBF6777635EC', label: 'Alameda Remnant', blockchain: 'ethereum', tags: ['whale'] },
  { address: '0x539C92186f7C6CC4CbF443F26eF84C595993751b', label: 'Galaxy Digital', blockchain: 'ethereum', tags: ['institution', 'smart_money'] },
];

/** Major centralized exchange deposit/hot wallet addresses */
const EXCHANGE_ADDRESSES: Record<string, string> = {
  // Binance
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8': 'Binance',
  // Coinbase
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase',
  // OKX
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3': 'OKX',
  // Kraken
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
  '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0': 'Kraken',
  // Bybit
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
  // Bitfinex
  '0x876eabf441b2ee5b5b0554fd502a8e0600950cfa': 'Bitfinex',
  // Gate.io
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  // HTX (Huobi)
  '0xab5c66752a9e8167967685f1450532fb96d5d24f': 'HTX',
};

/** USD thresholds — transactions below these are completely ignored */
const TX_THRESHOLDS: Record<string, number> = {
  BTC: 500_000, WBTC: 500_000,
  ETH: 200_000, WETH: 200_000, stETH: 200_000,
  USDT: 500_000, USDC: 500_000,
  DEFAULT: 50_000,
};

/** Map token to Binance signal symbol */
const TOKEN_TO_SYMBOL: Record<string, string> = {
  BTC: 'BTCUSDT', WBTC: 'BTCUSDT',
  ETH: 'ETHUSDT', WETH: 'ETHUSDT', stETH: 'ETHUSDT',
  SOL: 'SOLUSDT', BNB: 'BNBUSDT',
  XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT', AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT', DOT: 'DOTUSDT',
};

/** Approximate prices for USD conversion (updated at runtime) */
const PRICE_CACHE: Record<string, number> = {
  ETH: 2200, WETH: 2200, stETH: 2200,
  BTC: 84000, WBTC: 84000,
  BNB: 600, SOL: 130, XRP: 2.1, DOGE: 0.16,
  USDT: 1, USDC: 1, DAI: 1, BUSD: 1,
};

// ═══════════════════════════════════════════════════════
// DATA SOURCE ADAPTERS
// ═══════════════════════════════════════════════════════

interface DataAdapter {
  name: string;
  available: boolean;
  fetch(wallets: string[], sinceMs: number): Promise<RawTx[]>;
}

class NansenAdapter implements DataAdapter {
  name = 'Nansen';
  private key = config.apis.nansenKey;
  get available() { return !!this.key; }

  async fetch(wallets: string[], sinceMs: number): Promise<RawTx[]> {
    if (!this.available) return [];
    const txs: RawTx[] = [];
    try {
      for (const wallet of wallets.slice(0, 10)) {
        const { data } = await axios.get(
          `https://api.nansen.ai/v1/address/${wallet}/transactions`,
          {
            params: { chain: 'ethereum', limit: 50 },
            headers: { Authorization: `Bearer ${this.key}` },
            timeout: 8000,
          },
        );
        for (const tx of data.transactions || []) {
          if (tx.timestamp * 1000 < sinceMs) continue;
          txs.push({
            hash: tx.hash,
            from: tx.from_address?.toLowerCase() || '',
            to: tx.to_address?.toLowerCase() || '',
            value: String(tx.value || '0'),
            tokenSymbol: tx.token_symbol || 'ETH',
            tokenDecimal: tx.token_decimal || 18,
            blockTimestamp: tx.timestamp,
            blockchain: 'ethereum',
          });
        }
        await sleep(300); // Rate limit
      }
    } catch (err) {
      console.error(`[SmartMoney][Nansen] Error:`, (err as Error).message);
    }
    return txs;
  }
}

class ArkhamAdapter implements DataAdapter {
  name = 'Arkham';
  private key = config.apis.arkhamKey;
  get available() { return !!this.key; }

  async fetch(wallets: string[], sinceMs: number): Promise<RawTx[]> {
    if (!this.available) return [];
    const txs: RawTx[] = [];
    try {
      const { data } = await axios.get(
        'https://api.arkhamintelligence.com/transfers',
        {
          params: { flow: 'all', chains: 'ethereum', usdGte: 50000, limit: 100 },
          headers: { 'API-Key': this.key },
          timeout: 8000,
        },
      );
      const walletSet = new Set(wallets.map(w => w.toLowerCase()));
      for (const tx of data.transfers || []) {
        const from = tx.fromAddress?.address?.toLowerCase() || '';
        const to = tx.toAddress?.address?.toLowerCase() || '';
        if (!walletSet.has(from) && !walletSet.has(to)) continue;
        if (tx.blockTimestamp * 1000 < sinceMs) continue;
        txs.push({
          hash: tx.transactionHash || '',
          from, to,
          value: String(tx.unitValue || '0'),
          tokenSymbol: tx.tokenSymbol || 'ETH',
          tokenDecimal: tx.tokenDecimals || 18,
          blockTimestamp: tx.blockTimestamp,
          blockchain: tx.chain || 'ethereum',
        });
      }
    } catch (err) {
      console.error(`[SmartMoney][Arkham] Error:`, (err as Error).message);
    }
    return txs;
  }
}

class EtherscanAdapter implements DataAdapter {
  name = 'Etherscan';
  private key = config.apis.etherscanKey;
  get available() { return true; } // Works without key (rate limited)

  async fetch(wallets: string[], sinceMs: number): Promise<RawTx[]> {
    const txs: RawTx[] = [];
    const baseUrl = 'https://api.etherscan.io/api';

    for (const wallet of wallets.slice(0, 5)) { // Limit for free tier
      try {
        // ERC-20 transfers
        const params: Record<string, string> = {
          module: 'account', action: 'tokentx',
          address: wallet, page: '1', offset: '30', sort: 'desc',
        };
        if (this.key) params.apikey = this.key;

        const { data } = await axios.get(baseUrl, { params, timeout: 8000 });

        if (data.status === '1' && data.result) {
          for (const tx of data.result) {
            const ts = parseInt(tx.timeStamp) * 1000;
            if (ts < sinceMs) continue;
            txs.push({
              hash: tx.hash,
              from: tx.from?.toLowerCase() || '',
              to: tx.to?.toLowerCase() || '',
              value: tx.value || '0',
              tokenSymbol: tx.tokenSymbol || 'UNKNOWN',
              tokenDecimal: parseInt(tx.tokenDecimal) || 18,
              blockTimestamp: parseInt(tx.timeStamp),
              blockchain: 'ethereum',
            });
          }
        }
        await sleep(220); // 5 calls/sec limit

        // Also fetch ETH transfers
        const ethParams: Record<string, string> = {
          module: 'account', action: 'txlist',
          address: wallet, page: '1', offset: '15', sort: 'desc',
        };
        if (this.key) ethParams.apikey = this.key;

        const { data: ethData } = await axios.get(baseUrl, { params: ethParams, timeout: 8000 });
        if (ethData.status === '1' && ethData.result) {
          for (const tx of ethData.result) {
            const ts = parseInt(tx.timeStamp) * 1000;
            if (ts < sinceMs) continue;
            const ethVal = parseFloat(tx.value) / 1e18;
            if (ethVal < 0.5) continue; // Skip dust
            txs.push({
              hash: tx.hash,
              from: tx.from?.toLowerCase() || '',
              to: tx.to?.toLowerCase() || '',
              value: tx.value || '0',
              tokenSymbol: 'ETH',
              tokenDecimal: 18,
              blockTimestamp: parseInt(tx.timeStamp),
              blockchain: 'ethereum',
            });
          }
        }
        await sleep(220);
      } catch (err) {
        console.error(`[SmartMoney][Etherscan] ${wallet.slice(0, 10)}:`, (err as Error).message);
      }
    }
    return txs;
  }
}

// ═══════════════════════════════════════════════════════
// MAIN SERVICE
// ═══════════════════════════════════════════════════════

export class SmartMoneyService extends EventEmitter {
  private adapters: DataAdapter[];
  private wallets: WalletConfig[];
  private pool: pg.Pool;
  private cache: SmartMoneyTx[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private broadcastFn: ((msg: any) => void) | null = null;

  constructor(pool: pg.Pool, customWallets?: WalletConfig[]) {
    super();
    this.pool = pool;
    this.wallets = customWallets || [...DEFAULT_WALLETS];
    this.adapters = [new NansenAdapter(), new ArkhamAdapter(), new EtherscanAdapter()];

    console.log('[SmartMoney] Adapters:',
      this.adapters.map(a => `${a.name}(${a.available ? '✓' : '✗'})`).join(', '));
  }

  setBroadcast(fn: (msg: any) => void): void { this.broadcastFn = fn; }

  /** Update price cache from market data */
  updatePrices(prices: Record<string, number>): void {
    for (const [sym, price] of Object.entries(prices)) {
      const token = sym.replace('USDT', '');
      if (price > 0) PRICE_CACHE[token] = price;
    }
  }

  // ═══ START / STOP ═══

  start(intervalMs: number = 60_000): void {
    console.log(`[SmartMoney] Starting — ${this.wallets.length} wallets, poll every ${intervalMs / 1000}s`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    console.log('[SmartMoney] Stopped');
  }

  // ═══ WALLET MANAGEMENT ═══

  watchWallets(wallets: WalletConfig[]): void {
    for (const w of wallets) {
      if (!this.wallets.find(x => x.address.toLowerCase() === w.address.toLowerCase())) {
        this.wallets.push(w);
        console.log(`[SmartMoney] + Watching: ${w.label} (${w.address.slice(0, 10)}...)`);
      }
    }
  }

  removeWallet(address: string): void {
    this.wallets = this.wallets.filter(w => w.address.toLowerCase() !== address.toLowerCase());
  }

  getWallets(): WalletConfig[] { return [...this.wallets]; }

  // ═══ POLLING ═══

  private async poll(): Promise<void> {
    const sinceMs = Date.now() - 4 * 3600_000; // Look back 4 hours
    const addresses = this.wallets.map(w => w.address);
    let rawTxs: RawTx[] = [];

    // Try adapters in priority order
    for (const adapter of this.adapters) {
      if (!adapter.available) continue;
      try {
        rawTxs = await adapter.fetch(addresses, sinceMs);
        if (rawTxs.length > 0) {
          console.log(`[SmartMoney] ${rawTxs.length} raw txs via ${adapter.name}`);
          break;
        }
      } catch (err) {
        console.error(`[SmartMoney] ${adapter.name} failed:`, (err as Error).message);
      }
    }

    // Process each transaction
    let newCount = 0;
    for (const raw of rawTxs) {
      const processed = this.processTransaction(raw);
      if (!processed) continue;

      // Dedup
      if (this.cache.find(c => c.txHash === processed.txHash)) continue;

      this.cache.unshift(processed);
      newCount++;

      // Persist to DB
      await this.persistTx(processed);

      // ═══ 4-D: WebSocket push (only sell_pressure and accumulation) ═══
      if (processed.type !== 'transfer' && this.broadcastFn) {
        this.broadcastFn({
          type: 'SMART_MONEY_ALERT',
          data: {
            id: processed.id,
            walletLabel: processed.walletLabel,
            txType: processed.type,
            txTypeLabel: processed.type === 'sell_pressure'
              ? '🔴 流入交易所（賣壓）'
              : '🟢 流出交易所（吸籌）',
            token: processed.token,
            amount: processed.amount,
            usdValue: processed.usdValue,
            usdFormatted: formatUsd(processed.usdValue),
            fromLabel: processed.fromLabel,
            toLabel: processed.toLabel,
            blockchain: processed.blockchain,
            txHash: processed.txHash,
            minutesAgo: processed.minutesAgo,
            relatedSymbol: processed.relatedSignalSymbol,
            direction: processed.type === 'accumulation' ? 'bullish' : 'bearish',
          },
          timestamp: Date.now(),
        });

        console.log(
          `[SmartMoney] 🐋 ${processed.type === 'sell_pressure' ? '🔴 SELL' : '🟢 BUY'} ` +
          `${processed.walletLabel} | ${processed.token} ${formatUsd(processed.usdValue)} | ` +
          `${processed.fromLabel} → ${processed.toLabel}`
        );
      }
    }

    // Trim cache
    if (this.cache.length > 500) this.cache = this.cache.slice(0, 500);

    if (newCount > 0) {
      console.log(`[SmartMoney] ${newCount} new transactions processed`);
    }
  }

  // ═══ TRANSACTION PROCESSING ═══

  private processTransaction(raw: RawTx): SmartMoneyTx | null {
    // Parse amount
    const rawAmount = parseFloat(raw.value) / Math.pow(10, raw.tokenDecimal);
    if (isNaN(rawAmount) || rawAmount === 0) return null;

    const token = raw.tokenSymbol.toUpperCase();

    // Estimate USD value
    const price = PRICE_CACHE[token] || 0;
    const usdValue = rawAmount * price;

    // ═══ THRESHOLD FILTER ═══
    const threshold = TX_THRESHOLDS[token] || TX_THRESHOLDS.DEFAULT;
    if (usdValue < threshold) return null;

    // Classify
    const type = this.classifyTransaction(raw.from, raw.to);

    // Find wallet label
    const fromWallet = this.wallets.find(w => w.address.toLowerCase() === raw.from);
    const toWallet = this.wallets.find(w => w.address.toLowerCase() === raw.to);
    const wallet = fromWallet || toWallet;

    const fromExchange = EXCHANGE_ADDRESSES[raw.from] || null;
    const toExchange = EXCHANGE_ADDRESSES[raw.to] || null;

    return {
      id: uuidv4(),
      walletAddress: wallet?.address || raw.from,
      walletLabel: wallet?.label || shortenAddr(raw.from),
      txHash: raw.hash,
      blockchain: raw.blockchain,
      type,
      token,
      amount: +rawAmount.toFixed(token === 'BTC' || token === 'WBTC' ? 4 : 2),
      usdValue: Math.round(usdValue),
      fromAddress: raw.from,
      toAddress: raw.to,
      fromLabel: fromExchange || fromWallet?.label || shortenAddr(raw.from),
      toLabel: toExchange || toWallet?.label || shortenAddr(raw.to),
      timestamp: raw.blockTimestamp * 1000,
      minutesAgo: Math.round((Date.now() - raw.blockTimestamp * 1000) / 60000),
      relatedSignalSymbol: TOKEN_TO_SYMBOL[token] || null,
    };
  }

  /**
   * Classify a transaction based on from/to addresses.
   *
   * → TO exchange = sell_pressure (whale depositing to sell)
   * → FROM exchange = accumulation (whale withdrawing to hold)
   * → Neither = transfer (wallet-to-wallet, neutral)
   */
  classifyTransaction(from: string, to: string): TxType {
    const fromNorm = from.toLowerCase();
    const toNorm = to.toLowerCase();

    const fromIsExchange = fromNorm in EXCHANGE_ADDRESSES;
    const toIsExchange = toNorm in EXCHANGE_ADDRESSES;

    if (toIsExchange && !fromIsExchange) return 'sell_pressure';
    if (fromIsExchange && !toIsExchange) return 'accumulation';
    return 'transfer';
  }

  // ═══ PERSISTENCE ═══

  private async persistTx(tx: SmartMoneyTx): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO smart_money_txns
          (id, wallet_address, wallet_label, tx_hash, type, token, amount, usd_value, blockchain, from_label, to_label, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))
         ON CONFLICT DO NOTHING`,
        [tx.id, tx.walletAddress, tx.walletLabel, tx.txHash, tx.type,
         tx.token, tx.amount, tx.usdValue, tx.blockchain,
         tx.fromLabel, tx.toLabel, tx.timestamp / 1000],
      );
    } catch (err) {
      console.error('[SmartMoney] DB insert error:', (err as Error).message);
    }
  }

  // ═══ DATA ACCESS ═══

  getRecentTransactions(limit: number = 50, token?: string): SmartMoneyTx[] {
    let txs = this.cache;
    if (token) {
      const t = token.toUpperCase().replace('USDT', '');
      txs = txs.filter(tx => tx.token === t || tx.relatedSignalSymbol?.includes(t));
    }
    return txs.slice(0, limit).map(tx => ({
      ...tx,
      minutesAgo: Math.round((Date.now() - tx.timestamp) / 60000),
    }));
  }

  getTransactionsSince(hours: number): SmartMoneyTx[] {
    const since = Date.now() - hours * 3600_000;
    return this.cache.filter(tx => tx.timestamp > since);
  }

  get24hStats(): {
    total: number; sells: number; buys: number; transfers: number;
    sellVolume: number; buyVolume: number; netFlow: number;
    largest: SmartMoneyTx | null;
    topTokens: { token: string; volume: number }[];
  } {
    const since = Date.now() - 24 * 3600_000;
    const txs = this.cache.filter(tx => tx.timestamp > since);
    const sells = txs.filter(t => t.type === 'sell_pressure');
    const buys = txs.filter(t => t.type === 'accumulation');
    const sellVol = sells.reduce((s, t) => s + t.usdValue, 0);
    const buyVol = buys.reduce((s, t) => s + t.usdValue, 0);

    // Top tokens by volume
    const tokenMap = new Map<string, number>();
    for (const tx of txs) tokenMap.set(tx.token, (tokenMap.get(tx.token) || 0) + tx.usdValue);
    const topTokens = Array.from(tokenMap.entries())
      .map(([token, volume]) => ({ token, volume }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5);

    return {
      total: txs.length,
      sells: sells.length,
      buys: buys.length,
      transfers: txs.filter(t => t.type === 'transfer').length,
      sellVolume: sellVol,
      buyVolume: buyVol,
      netFlow: buyVol - sellVol,
      largest: txs.length > 0 ? txs.reduce((max, t) => t.usdValue > max.usdValue ? t : max, txs[0]) : null,
      topTokens,
    };
  }
}

// ═══ Helpers ═══

function shortenAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || 'unknown';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
