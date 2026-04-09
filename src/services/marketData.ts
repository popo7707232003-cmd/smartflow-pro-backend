// backend/src/services/marketData.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — Binance WebSocket 即時數據串接
// ═══════════════════════════════════════════════════════════════
//
// 訂閱 1H + 5M K線 → Redis 快取 + 記憶體 Buffer
// 斷線自動重連（3秒延遲，最多10次）
// 只有 isClosed === true 才計入指標計算
// ═══════════════════════════════════════════════════════════════

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import axios from 'axios';
import { config } from '../config/index';

// ═══ Types ═══

export interface Candle {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  isClosed: boolean;
}

interface CandleBuffer {
  candles: Candle[];      // Only closed candles
  current: Candle | null; // The currently forming candle
}

// ═══ Constants ═══

const SYMBOLS = ['btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'dogeusdt', 'xrpusdt'];
const INTERVALS = ['1h', '5m'] as const;
const MAX_HISTORY = 200;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const REDIS_TTL = 86400; // 24 hours

// ═══ Service ═══

export class MarketDataService extends EventEmitter {
  private ws: WebSocket | null = null;
  private redis: Redis;
  private reconnectAttempts = 0;
  private connected = false;
  private buffers: Map<string, CandleBuffer> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(redis: Redis) {
    super();
    this.redis = redis;
    this.initBuffers();
  }

  private initBuffers(): void {
    for (const symbol of SYMBOLS) {
      for (const interval of INTERVALS) {
        this.buffers.set(`${symbol}:${interval}`, { candles: [], current: null });
      }
    }
  }

  // ═══════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════

  async start(): Promise<void> {
    console.log('[MarketData] Starting...');
    console.log(`[MarketData] Symbols: ${SYMBOLS.join(', ')}`);
    console.log(`[MarketData] Intervals: ${INTERVALS.join(', ')}`);

    // Step 1: Fetch historical candles via REST (to pre-fill buffer)
    await this.fetchAllHistory();

    // Step 2: Connect WebSocket for real-time
    this.connectWebSocket();
  }

  stop(): void {
    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connected = false;
    console.log('[MarketData] Stopped');
  }

  /**
   * Get the last N closed candles for a symbol+interval.
   * This is the PRIMARY data source for indicator calculations.
   */
  getCandles(symbol: string, interval: string, limit?: number): Candle[] {
    const key = `${symbol.toLowerCase()}:${interval}`;
    const buffer = this.buffers.get(key);
    if (!buffer) return [];
    const candles = buffer.candles;
    return limit ? candles.slice(-limit) : candles;
  }

  /**
   * Get OHLCV arrays (convenient for technicalindicators library).
   */
  getOHLCV(symbol: string, interval: string): {
    open: number[]; high: number[]; low: number[];
    close: number[]; volume: number[];
  } {
    const candles = this.getCandles(symbol, interval);
    return {
      open: candles.map(c => c.open),
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      volume: candles.map(c => c.volume),
    };
  }

  /**
   * Get the current live price (from the forming candle).
   */
  getCurrentPrice(symbol: string): number | null {
    // Try 5m first (more frequent updates), then 1h
    for (const interval of ['5m', '1h']) {
      const buffer = this.buffers.get(`${symbol.toLowerCase()}:${interval}`);
      if (buffer?.current) return buffer.current.close;
      if (buffer?.candles.length) return buffer.candles[buffer.candles.length - 1].close;
    }
    return null;
  }

  isConnected(): boolean { return this.connected; }

  getBufferSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    this.buffers.forEach((buf, key) => { sizes[key] = buf.candles.length; });
    return sizes;
  }

  // ═══════════════════════════════════════
  // HISTORICAL DATA (REST)
  // ═══════════════════════════════════════

  private async fetchAllHistory(): Promise<void> {
    console.log('[MarketData] Fetching historical klines...');
    const promises: Promise<void>[] = [];

    for (const symbol of SYMBOLS) {
      for (const interval of INTERVALS) {
        promises.push(this.fetchHistory(symbol, interval));
      }
    }

    const results = await Promise.allSettled(promises);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(`[MarketData] History loaded: ${ok} success, ${fail} failed`);
  }

  private async fetchHistory(symbol: string, interval: string): Promise<void> {
    try {
      const url = `${config.binance.restBaseUrl}/api/v3/klines`;
      const { data } = await axios.get(url, {
        params: { symbol: symbol.toUpperCase(), interval, limit: MAX_HISTORY },
        timeout: 10000,
      });

      const candles: Candle[] = data.map((k: any[]) => ({
        symbol: symbol.toUpperCase(),
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        quoteVolume: parseFloat(k[7]),
        isClosed: true,
      }));

      // Remove last candle if it's the currently forming one
      if (candles.length > 0) {
        const last = candles[candles.length - 1];
        const now = Date.now();
        const intervalMs = interval === '1h' ? 3600000 : 300000;
        if (now - last.timestamp < intervalMs) {
          const current = candles.pop()!;
          current.isClosed = false;
          const key = `${symbol}:${interval}`;
          const buffer = this.buffers.get(key);
          if (buffer) buffer.current = current;
        }
      }

      const key = `${symbol}:${interval}`;
      const buffer = this.buffers.get(key);
      if (buffer) {
        buffer.candles = candles;
      }

      // Cache in Redis
      await this.cacheToRedis(symbol, interval, candles);

      console.log(`[MarketData]   ${symbol.toUpperCase()} ${interval}: ${candles.length} candles`);
    } catch (err) {
      console.error(`[MarketData]   ${symbol.toUpperCase()} ${interval}: FAILED -`, (err as Error).message);
    }
  }

  // ═══════════════════════════════════════
  // WEBSOCKET
  // ═══════════════════════════════════════

  private connectWebSocket(): void {
    const streams = SYMBOLS.flatMap(s =>
      INTERVALS.map(i => `${s}@kline_${i}`)
    );

    const wsUrl = `${config.binance.wsBaseUrl}/${streams.join('/')}`;

    console.log(`[MarketData] Connecting WS (${streams.length} streams)...`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[MarketData] WS creation failed:', (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log('[MarketData] ✓ WebSocket connected');
      this.emit('connected');
      this.startHeartbeat();
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Combined stream format: { stream: "...", data: { e: "kline", k: {...} } }
        const d = msg.data || msg;
        if (d.e === 'kline') {
          this.handleKline(d);
        }
      } catch (err) {
        // Ignore parse errors on pong frames etc.
      }
    });

    this.ws.on('close', (code: number) => {
      this.connected = false;
      console.warn(`[MarketData] WS closed (code: ${code})`);
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[MarketData] WS error:', err.message);
    });

    this.ws.on('pong', () => {
      // Heartbeat response received
    });
  }

  private handleKline(msg: any): void {
    const k = msg.k;
    const candle: Candle = {
      symbol: k.s,              // "BTCUSDT"
      timestamp: k.t,            // Kline start time
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      quoteVolume: parseFloat(k.q),
      isClosed: k.x,             // true when this kline is closed
    };

    const interval = k.i as string; // "1h" or "5m"
    const sym = candle.symbol.toLowerCase();
    const bufKey = `${sym}:${interval}`;
    const buffer = this.buffers.get(bufKey);
    if (!buffer) return;

    if (candle.isClosed) {
      // ══ CLOSED CANDLE — this is the important one ══
      buffer.candles.push(candle);
      if (buffer.candles.length > MAX_HISTORY) {
        buffer.candles.shift();
      }
      buffer.current = null;

      // Cache single candle to Redis
      this.cacheSingleCandle(sym, interval, candle).catch(() => {});

      // Emit for signal engine
      this.emit('candle:closed', { candle, interval });

      if (interval === '1h') {
        console.log(
          `[MarketData] ${candle.symbol} 1H CLOSED: ` +
          `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
          `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} ` +
          `V=${candle.volume.toFixed(0)}`
        );
      }
    } else {
      // Update forming candle
      buffer.current = candle;
    }

    // Emit tick for real-time UI
    this.emit('candle:tick', { candle, interval });
  }

  // ═══════════════════════════════════════
  // REDIS CACHING
  // ═══════════════════════════════════════

  private async cacheToRedis(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    try {
      const histKey = `kline:${symbol}:${interval}:history`;
      await this.redis.set(histKey, JSON.stringify(candles), 'EX', REDIS_TTL);
    } catch (err) {
      console.error(`[MarketData] Redis cache error:`, (err as Error).message);
    }
  }

  private async cacheSingleCandle(symbol: string, interval: string, candle: Candle): Promise<void> {
    try {
      const latestKey = `kline:${symbol}:${interval}:latest`;
      await this.redis.set(latestKey, JSON.stringify(candle), 'EX', REDIS_TTL);

      // Also push to list for history
      const histKey = `kline:${symbol}:${interval}:list`;
      await this.redis.rpush(histKey, JSON.stringify(candle));
      await this.redis.ltrim(histKey, -MAX_HISTORY, -1);
      await this.redis.expire(histKey, REDIS_TTL);
    } catch {
      // Non-critical, don't crash
    }
  }

  // ═══════════════════════════════════════
  // RECONNECTION
  // ═══════════════════════════════════════

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[MarketData] ✗ Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      this.emit('fatal_disconnect');
      return;
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 5);

    console.log(
      `[MarketData] Reconnecting in ${delay}ms ` +
      `(attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Ping every 3 minutes to keep connection alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.ping();
      }
    }, 180_000);
  }
}
