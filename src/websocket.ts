import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';

// ===== Binance WS Manager =====
class BinanceWSManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private baseDelay = 1000;
  private isClosedIntentionally = false;
  private subscribedStreams: string[] = [];
  private onMessageCallback: ((data: any) => void) | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private statusCallback: ((connected: boolean) => void) | null = null;

  constructor(streams: string[], onMessage: (data: any) => void, onStatus?: (connected: boolean) => void) {
    this.subscribedStreams = streams;
    this.onMessageCallback = onMessage;
    this.statusCallback = onStatus || null;
    this.connect();
  }

  private getUrl(): string {
    const streamPath = this.subscribedStreams.join('/');
    return `wss://data-stream.binance.vision/stream?streams=${streamPath}`;
  }

  private connect() {
    if (this.isClosedIntentionally) return;

    try {
      this.ws = new WebSocket(this.getUrl());

      this.ws.on('open', () => {
        console.log('[Binance WS] Connected');
        this.reconnectAttempts = 0;
        this.statusCallback?.(true);
        this.startPing();
      });

      this.ws.on('message', (raw: WebSocket.Data) => {
        try {
          const data = JSON.parse(raw.toString());
          this.onMessageCallback?.(data);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('pong', () => {
        // pong received, connection alive
      });

      this.ws.on('error', (err) => {
        console.error('[Binance WS] Error:', err.message);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[Binance WS] Closed: ${code} ${reason}`);
        this.statusCallback?.(false);
        this.stopPing();
        if (!this.isClosedIntentionally) {
          this.scheduleReconnect();
        }
      });
    } catch (err: any) {
      console.error('[Binance WS] Connection error:', err.message);
      this.statusCallback?.(false);
      this.scheduleReconnect();
    }
  }

  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect() {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;
    console.log(`[Binance WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  public close() {
    this.isClosedIntentionally = true;
    this.stopPing();
    this.ws?.close();
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ===== Client WS Server =====
interface ClientState {
  isAlive: boolean;
}

let wss: WebSocketServer | null = null;
let binanceManager: BinanceWSManager | null = null;
let binanceConnected = false;
let latestPrices: Record<string, any> = {};

const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt'];

export function setupWebSocket(server: http.Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat: check clients every 30s
  const heartbeatInterval = setInterval(() => {
    wss?.clients.forEach((ws: any) => {
      const state: ClientState = ws._sfState;
      if (!state?.isAlive) {
        console.log('[WS Server] Terminating dead client');
        return ws.terminate();
      }
      state.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: any) => {
    console.log('[WS Server] Client connected');
    ws._sfState = { isAlive: true } as ClientState;

    ws.on('pong', () => {
      ws._sfState.isAlive = true;
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {}
    });

    // Send current status immediately on connect
    ws.send(JSON.stringify({
      type: 'status',
      binanceConnected,
      ts: Date.now()
    }));

    // Send latest cached prices
    if (Object.keys(latestPrices).length > 0) {
      ws.send(JSON.stringify({
        type: 'prices',
        data: latestPrices,
        ts: Date.now()
      }));
    }
  });

  // Start Binance WS
  const streams = SYMBOLS.map(s => `${s}@ticker`);
  binanceManager = new BinanceWSManager(
    streams,
    // onMessage
    (data) => {
      if (data?.data?.s) {
        const d = data.data;
        latestPrices[d.s] = {
          symbol: d.s,
          price: parseFloat(d.c),
          change24h: parseFloat(d.P),
          volume: parseFloat(d.v),
          high: parseFloat(d.h),
          low: parseFloat(d.l),
          ts: Date.now()
        };
      }
      // Broadcast to all connected clients
      broadcast({ type: 'ticker', data: data?.data });
    },
    // onStatus
    (connected) => {
      binanceConnected = connected;
      broadcast({ type: 'status', binanceConnected: connected, ts: Date.now() });
    }
  );

  console.log('[WS Server] WebSocket server started on /ws');
}

function broadcast(msg: any) {
  const payload = JSON.stringify(msg);
  wss?.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

export function getLatestPrices() {
  return latestPrices;
}

export function isBinanceConnected() {
  return binanceConnected;
}
