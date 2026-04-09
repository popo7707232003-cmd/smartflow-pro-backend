// src/types/index.ts

// ═══ Kline / Market Data ═══
export interface Kline {
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

// ═══ Trading ═══
export type Direction = 'long' | 'short';
export type SignalGrade = 'strong' | 'medium' | 'weak';
export type SignalStatus = 'pending' | 'tp1' | 'tp2' | 'sl' | 'timeout' | 'manual';
export type EMAAlignment = 'bullish' | 'bearish' | 'neutral';
export type VWAPBias = 'above' | 'below';

export interface StopLevels {
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp1Pct: number;
  tp2Pct: number;
  slPct: number;
  rr: number;
  atr: number;
  direction: Direction;
}

export interface RSISignal {
  value: number;
  valid: boolean;
  warning: string | null;
  zone: 'oversold' | 'normal' | 'overbought';
}

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
  direction: Direction | 'neutral';
  crossover: 'bullish_cross' | 'bearish_cross' | 'none';
}

export interface VolumeAnalysis {
  current: number;
  average20: number;
  ratio: number;
  confirmed: boolean;
  spike: boolean;
}

export interface SignalConditions {
  mtfAligned: boolean;
  bosConfirmed: boolean;
  chochDetected: boolean;
  inOrderBlock: boolean;
  hasFVG: boolean;
  liquiditySweep: boolean;
  rsiHealthy: boolean;
  macdAligned: boolean;
  volumeConfirmed: boolean;
  rrAbove2: boolean;
}

export interface Signal {
  id: string;
  symbol: string;
  direction: Direction;
  entry: number;
  tp1: number;
  tp1Pct: number;
  tp2: number;
  tp2Pct: number;
  sl: number;
  slPct: number;
  rr: number;
  atr: number;
  score: number;
  scoreLabel: SignalGrade;
  conditions: SignalConditions;
  warnings: string[];
  status: SignalStatus;
  createdAt: string;
}

export interface SignalResult {
  id: string;
  signalId: string;
  resultType: 'tp1' | 'tp2' | 'sl' | 'timeout' | 'manual';
  pnl: number;
  pnlPct: number;
  closedAt: string;
}

// ═══ Smart Money ═══
export type SmartMoneyTxType = 'sell_pressure' | 'accumulation' | 'transfer';

export interface SmartMoneyTx {
  id: string;
  walletAddress: string;
  walletLabel: string;
  txHash: string;
  type: SmartMoneyTxType;
  token: string;
  amount: number;
  usdValue: number;
  blockchain: string;
  fromLabel: string;
  toLabel: string;
  timestamp: number;
  minutesAgo: number;
}

export interface SmartMoneyConsensus {
  direction: 'bullish' | 'bearish' | 'neutral';
  bullishVolume: number;
  bearishVolume: number;
  confidence: number;
  periodHours: number;
}

// ═══ News ═══
export type NewsLevel = 'A' | 'B' | 'C';
export type NewsSentiment = 'positive' | 'negative' | 'neutral';

export interface NewsEvent {
  id: string;
  title: string;
  source: string;
  url: string;
  level: NewsLevel;
  sentiment: NewsSentiment;
  affectedSymbols: string[];
  estimatedImpact: 'high' | 'medium' | 'low';
  timestamp: number;
}

// ═══ Alerts ═══
export type AlertType =
  | 'NEWS_ALERT_A' | 'NEWS_ALERT_B' | 'NEWS_ALERT_C'
  | 'EVENT_WARNING' | 'SMART_MONEY_ALERT' | 'RISK_WARNING'
  | 'SIGNAL_NEW';

export interface Alert {
  id: string;
  type: AlertType;
  level: NewsLevel;
  title: string;
  message: string;
  affectedSymbols: string[];
  actionSuggestion: string;
  source: 'news' | 'calendar' | 'smartmoney' | 'risk' | 'signal';
  soundEnabled: boolean;
  fullscreen: boolean;
  timestamp: number;
}

// ═══ WebSocket Events ═══
export type WSEventType =
  | 'SIGNAL_UPDATE'
  | 'SMART_MONEY_ALERT'
  | 'NEWS_ALERT'
  | 'RISK_WARNING'
  | 'PRICE_UPDATE'
  | 'CONNECTED';

export interface WSMessage {
  type: WSEventType;
  data: unknown;
  timestamp: number;
}

// ═══ API Responses ═══
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}
