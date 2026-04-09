// backend/src/routes/market.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — Market Data API Endpoints
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import { MarketDataService } from '../services/marketData';
import {
  calculateAllIndicators,
  getAllFundingRates,
  getFundingRate,
} from '../services/indicators';
import { config } from '../config/index';

export function createMarketRouter(marketData: MarketDataService): Router {
  const router = Router();

  // ═══════════════════════════════════════
  // GET /api/market/candles/:symbol/:interval
  // Returns the last 200 candles for a symbol+interval.
  //
  // Example: GET /api/market/candles/BTCUSDT/1h
  // Query params: ?limit=50 (optional, default 200)
  // ═══════════════════════════════════════

  router.get('/candles/:symbol/:interval', (req: Request, res: Response) => {
    const { symbol, interval } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 200);

    // Validate interval
    if (!['1h', '5m'].includes(interval)) {
      return res.status(400).json({
        success: false,
        error: `Invalid interval "${interval}". Must be "1h" or "5m".`,
      });
    }

    // Validate symbol
    const symUpper = symbol.toUpperCase();
    if (!config.symbols.includes(symUpper)) {
      return res.status(400).json({
        success: false,
        error: `Symbol "${symUpper}" is not tracked. Available: ${config.symbols.join(', ')}`,
      });
    }

    const candles = marketData.getCandles(symbol as any, interval as any, limit);

    if (candles.length === 0) {
      return res.status(503).json({
        success: false,
        error: 'No candle data available yet. Service may still be initializing.',
      });
    }

    res.json({
      success: true,
      data: {
        symbol: symUpper,
        interval,
        count: candles.length,
        candles: candles.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
      },
    });
  });

  // ═══════════════════════════════════════
  // GET /api/market/indicators/:symbol
  // Returns ALL indicator values for a symbol.
  //
  // This is the main endpoint for the frontend dashboard.
  // Calculates everything from the candle buffer in real-time.
  //
  // Example: GET /api/market/indicators/BTCUSDT
  // ═══════════════════════════════════════

  router.get('/indicators/:symbol', async (req: Request, res: Response) => {
    const symUpper = req.params.symbol.toUpperCase();

    if (!config.symbols.includes(symUpper)) {
      return res.status(400).json({
        success: false,
        error: `Symbol "${symUpper}" is not tracked.`,
      });
    }

    const candles1h = marketData.getCandles(symUpper.toLowerCase() as any, '1h' as any);
    const candles5m = marketData.getCandles(symUpper.toLowerCase() as any, '5m' as any);

    if (candles1h.length < 30) {
      return res.status(503).json({
        success: false,
        error: `Insufficient 1H data for ${symUpper}: ${candles1h.length} candles (need 30+).`,
      });
    }

    // Get funding rate (async)
    let fundingRate: number | null = null;
    try {
      fundingRate = await getFundingRate(symUpper);
    } catch {
      // Non-critical
    }

    const snapshot = calculateAllIndicators(symUpper, candles1h, candles5m, fundingRate);

    res.json({
      success: true,
      data: snapshot,
    });
  });

  // ═══════════════════════════════════════
  // GET /api/market/indicators
  // Returns indicators for ALL tracked symbols.
  // ═══════════════════════════════════════

  router.get('/indicators', async (_req: Request, res: Response) => {
    const results: Record<string, any> = {};
    const fundingRates = await getAllFundingRates();

    for (const sym of config.symbols) {
      const symLower = sym.toLowerCase();
      const candles1h = marketData.getCandles(symLower, '1h');
      const candles5m = marketData.getCandles(symLower, '5m');

      if (candles1h.length < 15) {
        results[sym] = { error: `Insufficient data: ${candles1h.length} candles` };
        continue;
      }

      results[sym] = calculateAllIndicators(
        sym,
        candles1h,
        candles5m,
        fundingRates[sym] ?? null,
      );
    }

    res.json({ success: true, data: results });
  });

  // ═══════════════════════════════════════
  // GET /api/market/funding
  // Returns funding rates for ALL tracked symbols.
  //
  // Example response:
  // { "BTCUSDT": 0.0087, "ETHUSDT": 0.0054, ... }
  // ═══════════════════════════════════════

  router.get('/funding', async (_req: Request, res: Response) => {
    try {
      const rates = await getAllFundingRates();

      res.json({
        success: true,
        data: rates,
        note: 'Values are in percentage. Positive = longs pay shorts. Negative = shorts pay longs.',
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch funding rates',
      });
    }
  });

  // ═══════════════════════════════════════
  // GET /api/market/prices
  // Returns current prices for all tracked symbols.
  // ═══════════════════════════════════════

  router.get('/prices', (_req: Request, res: Response) => {
    const prices: Record<string, number | null> = {};

    for (const sym of config.symbols) {
      prices[sym] = marketData.getCurrentPrice(sym);
    }

    res.json({
      success: true,
      data: prices,
      wsConnected: marketData.isConnected(),
    });
  });

  // ═══════════════════════════════════════
  // GET /api/market/status
  // Returns the data service health status.
  // ═══════════════════════════════════════

  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        wsConnected: marketData.isConnected(),
        bufferSizes: marketData.getBufferSizes(),
        trackedSymbols: config.symbols,
        intervals: config.intervals,
      },
    });
  });

  return router;
}
