// backend/src/routes/smartmoney.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 聰明錢 API Endpoints
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import { SmartMoneyService } from '../services/smartMoney';
import { SmartMoneyConsensusService } from '../services/smartMoneyConsensus';

export function createSmartMoneyRouter(
  smartMoney: SmartMoneyService,
  consensus: SmartMoneyConsensusService,
): Router {
  const router = Router();

  // ═══════════════════════════════════════
  // GET /api/smartmoney/feed
  // Latest large transactions (real-time feed)
  //
  // Query params:
  //   ?limit=50 (default 50, max 100)
  //   ?token=ETH (optional filter)
  // ═══════════════════════════════════════

  router.get('/feed', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const token = req.query.token as string | undefined;

    const txs = smartMoney.getRecentTransactions(limit, token);

    res.json({
      success: true,
      count: txs.length,
      data: txs,
    });
  });

  // ═══════════════════════════════════════
  // GET /api/smartmoney/consensus/:symbol
  // Consensus direction for a specific symbol
  //
  // Params:
  //   :symbol — "BTCUSDT" or "BTC" (flexible)
  // Query params:
  //   ?hours=4 (lookback, default 4)
  // ═══════════════════════════════════════

  router.get('/consensus/:symbol', (req: Request, res: Response) => {
    const { symbol } = req.params;
    const hours = Math.min(parseInt(req.query.hours as string) || 4, 24);

    const result = consensus.calculateConsensus(symbol, hours);

    res.json({
      success: true,
      data: result,
    });
  });

  // ═══════════════════════════════════════
  // GET /api/smartmoney/consensus
  // Consensus for ALL symbols + market overall
  // ═══════════════════════════════════════

  router.get('/consensus', (req: Request, res: Response) => {
    const hours = Math.min(parseInt(req.query.hours as string) || 4, 24);

    const all = consensus.calculateAll(hours);
    const breakdown = consensus.getBreakdown(hours);

    res.json({
      success: true,
      data: { consensus: all, breakdown },
    });
  });

  // ═══════════════════════════════════════
  // GET /api/smartmoney/wallets
  // List of all monitored wallets
  // ═══════════════════════════════════════

  router.get('/wallets', (_req: Request, res: Response) => {
    const wallets = smartMoney.getWallets();

    res.json({
      success: true,
      count: wallets.length,
      data: wallets.map(w => ({
        address: w.address,
        shortAddress: `${w.address.slice(0, 6)}...${w.address.slice(-4)}`,
        label: w.label,
        blockchain: w.blockchain,
        tags: w.tags,
      })),
    });
  });

  // ═══════════════════════════════════════
  // GET /api/smartmoney/stats
  // 24-hour summary statistics
  // ═══════════════════════════════════════

  router.get('/stats', (_req: Request, res: Response) => {
    const stats = smartMoney.get24hStats();
    const marketConsensus = consensus.calculateMarket(24);

    const fmtVol = (v: number) =>
      v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`;

    res.json({
      success: true,
      data: {
        period: '24h',
        totalTransactions: stats.total,
        sellPressure: { count: stats.sells, volume: stats.sellVolume, formatted: fmtVol(stats.sellVolume) },
        accumulation: { count: stats.buys, volume: stats.buyVolume, formatted: fmtVol(stats.buyVolume) },
        transfers: stats.transfers,
        netFlow: stats.netFlow,
        netFlowFormatted: `${stats.netFlow >= 0 ? '+' : ''}${fmtVol(Math.abs(stats.netFlow))}`,
        largestTransaction: stats.largest ? {
          token: stats.largest.token,
          usdValue: stats.largest.usdValue,
          type: stats.largest.type,
          wallet: stats.largest.walletLabel,
        } : null,
        topTokens: stats.topTokens,
        marketConsensus: marketConsensus.direction,
        marketConfidence: marketConsensus.confidence,
      },
    });
  });

  // ═══════════════════════════════════════
  // POST /api/smartmoney/wallets
  // Add a wallet to the watch list
  // ═══════════════════════════════════════

  router.post('/wallets', (req: Request, res: Response) => {
    const { address, label, blockchain = 'ethereum', tags = [] } = req.body;

    if (!address || !label) {
      return res.status(400).json({
        success: false,
        error: 'address and label are required',
      });
    }

    smartMoney.watchWallets([{ address, label, blockchain, tags }]);

    res.json({
      success: true,
      message: `Wallet added: ${label} (${address.slice(0, 10)}...)`,
    });
  });

  // ═══════════════════════════════════════
  // DELETE /api/smartmoney/wallets/:address
  // Remove a wallet from the watch list
  // ═══════════════════════════════════════

  router.delete('/wallets/:address', (req: Request, res: Response) => {
    smartMoney.removeWallet(req.params.address);
    res.json({ success: true, message: 'Wallet removed' });
  });

  // ═══════════════════════════════════════
  // POST /api/smartmoney/mock
  // Inject a mock transaction (for testing without paid APIs)
  // ═══════════════════════════════════════

  router.post('/mock', (req: Request, res: Response) => {
    const {
      token = 'ETH',
      type = 'accumulation',
      usdValue = 500000,
      wallet = 'Test Whale',
    } = req.body;

    const mockTx = {
      id: `mock-${Date.now()}`,
      walletAddress: '0x0000000000000000000000000000000000000000',
      walletLabel: wallet,
      txHash: `0x${Date.now().toString(16).padStart(64, '0')}`,
      blockchain: 'ethereum',
      type: type as any,
      token: token.toUpperCase(),
      amount: 0,
      usdValue,
      fromAddress: '0x0',
      toAddress: '0x0',
      fromLabel: type === 'sell_pressure' ? wallet : 'Binance',
      toLabel: type === 'sell_pressure' ? 'Binance' : wallet,
      timestamp: Date.now(),
      minutesAgo: 0,
      relatedSignalSymbol: `${token.toUpperCase()}USDT`,
    };

    // This will trigger the WebSocket broadcast
    if (type !== 'transfer') {
      const broadcastFn = (smartMoney as any).broadcastFn;
      if (broadcastFn) {
        broadcastFn({
          type: 'SMART_MONEY_ALERT',
          data: {
            ...mockTx,
            txTypeLabel: type === 'sell_pressure' ? '🔴 流入交易所（賣壓）' : '🟢 流出交易所（吸籌）',
            usdFormatted: usdValue >= 1e6 ? `$${(usdValue / 1e6).toFixed(1)}M` : `$${(usdValue / 1e3).toFixed(0)}K`,
            direction: type === 'accumulation' ? 'bullish' : 'bearish',
          },
          timestamp: Date.now(),
        });
      }
    }

    res.json({
      success: true,
      message: `Mock ${type} transaction injected: ${token} ${usdValue >= 1e6 ? `$${(usdValue / 1e6).toFixed(1)}M` : `$${(usdValue / 1e3).toFixed(0)}K`}`,
      data: mockTx,
    });
  });

  return router;
}
