import { Router, Request, Response } from 'express';

const router = Router();

// ===== Known Institutional Wallets =====
const WATCHED_WALLETS: Record<string, { name: string; type: 'institution' | 'exchange' }> = {
  // Cumberland DRW
  '0x2f47a1c2db4a3b78cda44eade915c3b19107ddcc': { name: 'Cumberland', type: 'institution' },
  '0xacd03d601e5bb1b275bb94076ff46ed9d753435a': { name: 'Cumberland', type: 'institution' },
  // Jump Trading
  '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621': { name: 'Jump Trading', type: 'institution' },
  '0x9507c04b10486547584c37bcbd931b2a4fee9a41': { name: 'Jump Trading', type: 'institution' },
  // Wintermute
  '0x00000000ae347930bd1e7b0f35588b92280f9e75': { name: 'Wintermute', type: 'institution' },
  '0x4f3a120e72c76c22ae802d129f599bfdbc31cb81': { name: 'Wintermute', type: 'institution' },
  // Galaxy Digital
  '0x7a91f0be0be6e759d41a0f255e1005930beef518': { name: 'Galaxy Digital', type: 'institution' },
  // Grayscale (GBTC)
  '0x1c8e02e440e598b0fa3850786a345ec9c9a3687e': { name: 'Grayscale', type: 'institution' },
};

const EXCHANGE_ADDRESSES: Record<string, string> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f': 'Binance',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase',
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13': 'Kraken',
  '0xfdb16996831753d5331ff813c29a93c76834a0ad': 'OKX',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
};

interface WhaleTransaction {
  id: string;
  hash: string;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  value: number;
  valueUsd: number;
  token: string;
  timestamp: string;
  direction: 'exchange_inflow' | 'exchange_outflow' | 'institution_move' | 'unknown';
  sentiment: 'bearish' | 'bullish' | 'neutral';
  significance: 'high' | 'medium' | 'low';
}

// ===== Cache =====
let txCache: WhaleTransaction[] = [];
let lastFetch = 0;
const CACHE_TTL = 60 * 1000; // 60s
let biasCache: { bias: string; score: number; inflow: number; outflow: number; updatedAt: string } | null = null;

// ===== Label lookup =====
function getLabel(addr: string): string {
  const lower = addr.toLowerCase();
  if (WATCHED_WALLETS[lower]) return WATCHED_WALLETS[lower].name;
  if (EXCHANGE_ADDRESSES[lower]) return EXCHANGE_ADDRESSES[lower];
  return addr.slice(0, 8) + '...';
}

function isExchange(addr: string): boolean {
  return !!EXCHANGE_ADDRESSES[addr.toLowerCase()];
}

function isInstitution(addr: string): boolean {
  return !!WATCHED_WALLETS[addr.toLowerCase()];
}

// ===== Etherscan Fetcher =====
async function fetchEtherscanTxs(apiKey: string): Promise<WhaleTransaction[]> {
  const txs: WhaleTransaction[] = [];
  const wallets = Object.keys(WATCHED_WALLETS);

  // Fetch last ~50 txs per wallet (only first 3 to stay within rate limits)
  const walletsToCheck = wallets.slice(0, 6);

  for (const wallet of walletsToCheck) {
    try {
      // ERC-20 token transfers (USDT, USDC, etc.)
      const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${wallet}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any;

      if (data.status !== '1' || !data.result) continue;

      for (const tx of data.result) {
        const valueRaw = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'));
        // Only track stablecoins and major tokens for USD estimation
        const isStable = ['USDT', 'USDC', 'DAI', 'BUSD'].includes(tx.tokenSymbol);
        const valueUsd = isStable ? valueRaw : valueRaw * 2500; // rough ETH estimate

        if (valueUsd < 500000) continue; // Skip < $500K

        const fromExchange = isExchange(tx.from);
        const toExchange = isExchange(tx.to);
        const fromInst = isInstitution(tx.from);
        const toInst = isInstitution(tx.to);

        let direction: WhaleTransaction['direction'] = 'unknown';
        let sentiment: WhaleTransaction['sentiment'] = 'neutral';
        let significance: WhaleTransaction['significance'] = 'low';

        if (toExchange && (fromInst || !fromExchange)) {
          direction = 'exchange_inflow';
          sentiment = 'bearish'; // sending to exchange = likely selling
        } else if (fromExchange && (toInst || !toExchange)) {
          direction = 'exchange_outflow';
          sentiment = 'bullish'; // withdrawing from exchange = likely holding
        } else if (fromInst || toInst) {
          direction = 'institution_move';
          sentiment = 'neutral';
        }

        if (valueUsd >= 5000000) significance = 'high';
        else if (valueUsd >= 1000000) significance = 'medium';
        else significance = 'low';

        txs.push({
          id: tx.hash + '_' + tx.tokenSymbol,
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          fromLabel: getLabel(tx.from),
          toLabel: getLabel(tx.to),
          value: valueRaw,
          valueUsd,
          token: tx.tokenSymbol,
          timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
          direction,
          sentiment,
          significance
        });
      }

      // Rate limit: small delay between calls
      await new Promise(r => setTimeout(r, 250));
    } catch (err: any) {
      console.error(`[SmartMoney] Etherscan error for ${wallet.slice(0, 8)}:`, err.message);
    }
  }

  // Also fetch ETH transfers for large moves
  for (const wallet of walletsToCheck.slice(0, 3)) {
    try {
      const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${wallet}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any;
      if (data.status !== '1' || !data.result) continue;

      for (const tx of data.result) {
        const valueEth = parseFloat(tx.value) / 1e18;
        const valueUsd = valueEth * 2500; // rough estimate
        if (valueUsd < 500000) continue;

        const toExchange = isExchange(tx.to);
        const fromExchange = isExchange(tx.from);

        let direction: WhaleTransaction['direction'] = 'institution_move';
        let sentiment: WhaleTransaction['sentiment'] = 'neutral';

        if (toExchange) { direction = 'exchange_inflow'; sentiment = 'bearish'; }
        else if (fromExchange) { direction = 'exchange_outflow'; sentiment = 'bullish'; }

        txs.push({
          id: tx.hash + '_ETH',
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          fromLabel: getLabel(tx.from),
          toLabel: getLabel(tx.to),
          value: valueEth,
          valueUsd,
          token: 'ETH',
          timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
          direction,
          sentiment,
          significance: valueUsd >= 5000000 ? 'high' : valueUsd >= 1000000 ? 'medium' : 'low'
        });
      }
      await new Promise(r => setTimeout(r, 250));
    } catch {}
  }

  return txs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ===== Whale Alert Fallback =====
async function fetchWhaleAlert(apiKey: string): Promise<WhaleTransaction[]> {
  try {
    const since = Math.floor(Date.now() / 1000) - 3600; // last hour
    const url = `https://api.whale-alert.io/v1/transactions?api_key=${apiKey}&min_value=500000&start=${since}&currency=usd`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    if (!data.transactions) return [];

    return data.transactions.map((tx: any) => {
      const fromExchange = tx.from?.owner_type === 'exchange';
      const toExchange = tx.to?.owner_type === 'exchange';

      let direction: WhaleTransaction['direction'] = 'unknown';
      let sentiment: WhaleTransaction['sentiment'] = 'neutral';

      if (toExchange && !fromExchange) { direction = 'exchange_inflow'; sentiment = 'bearish'; }
      else if (fromExchange && !toExchange) { direction = 'exchange_outflow'; sentiment = 'bullish'; }

      return {
        id: tx.id || tx.hash,
        hash: tx.hash || '',
        from: tx.from?.address || 'unknown',
        to: tx.to?.address || 'unknown',
        fromLabel: tx.from?.owner || getLabel(tx.from?.address || ''),
        toLabel: tx.to?.owner || getLabel(tx.to?.address || ''),
        value: tx.amount,
        valueUsd: tx.amount_usd,
        token: (tx.symbol || 'unknown').toUpperCase(),
        timestamp: new Date(tx.timestamp * 1000).toISOString(),
        direction,
        sentiment,
        significance: tx.amount_usd >= 5000000 ? 'high' as const : tx.amount_usd >= 1000000 ? 'medium' as const : 'low' as const
      };
    });
  } catch (err: any) {
    console.error('[SmartMoney] Whale Alert error:', err.message);
    return [];
  }
}

// ===== Calculate Bias =====
function calculateBias(txs: WhaleTransaction[]) {
  let inflowUsd = 0;
  let outflowUsd = 0;

  for (const tx of txs) {
    if (tx.direction === 'exchange_inflow') inflowUsd += tx.valueUsd;
    if (tx.direction === 'exchange_outflow') outflowUsd += tx.valueUsd;
  }

  const total = inflowUsd + outflowUsd;
  let bias = 'NEUTRAL';
  let score = 50; // 0=very bearish, 50=neutral, 100=very bullish

  if (total > 0) {
    const outflowRatio = outflowUsd / total;
    score = Math.round(outflowRatio * 100);

    if (outflowUsd > inflowUsd * 1.5) bias = 'BULLISH';
    else if (inflowUsd > outflowUsd * 1.5) bias = 'BEARISH';
    else if (outflowUsd > inflowUsd) bias = 'SLIGHTLY_BULLISH';
    else if (inflowUsd > outflowUsd) bias = 'SLIGHTLY_BEARISH';
  }

  return {
    bias,
    score,
    inflow: Math.round(inflowUsd),
    outflow: Math.round(outflowUsd),
    updatedAt: new Date().toISOString()
  };
}

// ===== API Routes =====

router.get('/smart-money', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (txCache.length > 0 && now - lastFetch < CACHE_TTL) {
      return res.json({ success: true, data: { transactions: txCache, bias: biasCache }, cached: true });
    }

    let txs: WhaleTransaction[] = [];

    const etherscanKey = process.env.ETHERSCAN_API_KEY;
    const whaleAlertKey = process.env.WHALE_ALERT_API_KEY;

    if (etherscanKey) {
      console.log('[SmartMoney] Fetching from Etherscan...');
      txs = await fetchEtherscanTxs(etherscanKey);
    }

    if (txs.length === 0 && whaleAlertKey) {
      console.log('[SmartMoney] Fallback to Whale Alert...');
      txs = await fetchWhaleAlert(whaleAlertKey);
    }

    if (txs.length === 0) {
      return res.json({
        success: true,
        data: {
          transactions: [],
          bias: { bias: 'NO_DATA', score: 50, inflow: 0, outflow: 0, updatedAt: new Date().toISOString() },
          source: 'none',
          message: 'No API key configured. Set ETHERSCAN_API_KEY or WHALE_ALERT_API_KEY in Railway env vars.'
        }
      });
    }

    txCache = txs.slice(0, 50); // keep last 50
    biasCache = calculateBias(txs);
    lastFetch = now;

    return res.json({
      success: true,
      data: {
        transactions: txCache,
        bias: biasCache,
        source: etherscanKey ? 'etherscan' : 'whale_alert'
      }
    });
  } catch (err: any) {
    console.error('[SmartMoney] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
