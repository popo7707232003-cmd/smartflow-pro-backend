// backend/src/services/alertEngine.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 統一警報引擎
// ═══════════════════════════════════════════════════════════════
//
// 整合 5 個警報來源：
//   1. 新聞 A 級 → NEWS_ALERT_A（紅色 + 聲音 + 全螢幕）
//   2. 新聞 B 級 → NEWS_ALERT_B（黃色 + 聲音）
//   3. 經濟日曆 → EVENT_WARNING（事件前60分鐘）
//   4. 聰明錢 → SMART_MONEY_ALERT（>$2M 觸發聲音）
//   5. 風險 → RISK_WARNING（RSI/連敗/策略失效）
//
// 去重：同 type + 同 affectedSymbols → 1小時內只發一次
// ═══════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import { NewsAggregator, RawNewsItem } from './newsAggregator';
import { classifyNews, ClassifiedNews } from './newsFilter';
import { isHighVolatilityPeriod, formatEvent } from './economicCalendar';
import { SmartMoneyService, SmartMoneyTx } from './smartMoney';
import type { RiskWarning } from './riskMonitor';

// ═══ Types ═══

export type AlertType =
  | 'NEWS_ALERT_A' | 'NEWS_ALERT_B' | 'NEWS_ALERT_C'
  | 'EVENT_WARNING'
  | 'SMART_MONEY_ALERT'
  | 'RISK_WARNING';

export type AlertLevel = 'A' | 'B' | 'C';
export type AlertSource = 'news' | 'calendar' | 'smartmoney' | 'risk';

export interface Alert {
  id: string;
  type: AlertType;
  level: AlertLevel;
  title: string;
  message: string;
  affectedSymbols: string[];
  actionSuggestion: string;
  source: AlertSource;
  soundEnabled: boolean;
  fullscreen: boolean;
  timestamp: number;
}

// ═══ Dedup ═══

const DEDUP_WINDOW_MS = 3600_000;
const dedupMap = new Map<string, number>();

function isDuplicate(type: string, symbols: string[]): boolean {
  const key = `${type}:${symbols.sort().join(',')}`;
  const last = dedupMap.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  dedupMap.set(key, Date.now());
  // Cleanup
  for (const [k, v] of dedupMap) {
    if (Date.now() - v > DEDUP_WINDOW_MS) dedupMap.delete(k);
  }
  return false;
}

// ═══════════════════════════════════════════════════════
// ALERT ENGINE
// ═══════════════════════════════════════════════════════

export class AlertEngine extends EventEmitter {
  private newsAgg: NewsAggregator;
  private smartMoney: SmartMoneyService;
  private pool: pg.Pool;
  private broadcastFn: ((msg: any) => void) | null = null;
  private history: Alert[] = [];
  private calendarTimer: NodeJS.Timeout | null = null;

  constructor(
    newsAgg: NewsAggregator,
    smartMoney: SmartMoneyService,
    pool: pg.Pool,
  ) {
    super();
    this.newsAgg = newsAgg;
    this.smartMoney = smartMoney;
    this.pool = pool;
  }

  setBroadcast(fn: (msg: any) => void): void { this.broadcastFn = fn; }

  // ═══════════════════════════════════════
  // START / STOP
  // ═══════════════════════════════════════

  start(): void {
    console.log('[AlertEngine] Starting...');

    // 1. Subscribe to news events
    this.newsAgg.on('news:new', (items: RawNewsItem[]) => {
      this.processNews(items);
    });

    // 2. Subscribe to smart money alerts
    this.smartMoney.on('smart_money_alert', (tx: SmartMoneyTx) => {
      this.processSmartMoney(tx);
    });

    // 3. Check calendar every 5 minutes
    this.calendarTimer = setInterval(() => this.checkCalendar(), 5 * 60_000);
    this.checkCalendar(); // Initial check

    console.log('[AlertEngine] ✓ Subscribed to: News, SmartMoney, Calendar');
  }

  stop(): void {
    if (this.calendarTimer) { clearInterval(this.calendarTimer); this.calendarTimer = null; }
    this.removeAllListeners();
    console.log('[AlertEngine] Stopped');
  }

  // ═══════════════════════════════════════
  // 1. NEWS PROCESSING
  // ═══════════════════════════════════════

  private processNews(items: RawNewsItem[]): void {
    for (const item of items) {
      const classified = classifyNews(item);
      if (classified.level === 'filtered') continue;

      let type: AlertType;
      let level: AlertLevel;
      let sound: boolean;
      let fullscreen: boolean;

      switch (classified.level) {
        case 'A': type = 'NEWS_ALERT_A'; level = 'A'; sound = true; fullscreen = true; break;
        case 'B': type = 'NEWS_ALERT_B'; level = 'B'; sound = true; fullscreen = false; break;
        case 'C': type = 'NEWS_ALERT_C'; level = 'C'; sound = false; fullscreen = false; break;
        default: continue;
      }

      if (isDuplicate(type, classified.affectedSymbols)) continue;

      const levelEmoji = level === 'A' ? '🔴' : level === 'B' ? '🟡' : '🔵';
      const sentEmoji = classified.sentiment === 'positive' ? '📈' : classified.sentiment === 'negative' ? '📉' : '📰';

      this.pushAlert({
        type, level,
        title: `${levelEmoji} ${sentEmoji} [${classified.matchedKeywords[0] || 'News'}] ${classified.source}`,
        message: classified.title,
        affectedSymbols: classified.affectedSymbols,
        actionSuggestion: classified.actionSuggestion,
        source: 'news',
        soundEnabled: sound,
        fullscreen,
      });
    }
  }

  // ═══════════════════════════════════════
  // 2. CALENDAR EVENTS
  // ═══════════════════════════════════════

  private checkCalendar(): void {
    const vol = isHighVolatilityPeriod();
    if (!vol.volatile || !vol.event || vol.phase !== 'before') return;

    const eventKey = `${vol.event.name}:${vol.event.date}`;
    if (isDuplicate('EVENT_WARNING', [eventKey])) return;

    const mins = vol.minutesUntil || 0;

    this.pushAlert({
      type: 'EVENT_WARNING',
      level: 'A',
      title: `⏰ 重大事件預警：${vol.event.name}`,
      message: [
        `📅 ${formatEvent(vol.event)}`,
        `⏱️ 距離公布還有 ${mins} 分鐘`,
        `📊 重要性：${'⭐'.repeat(vol.event.importance)}`,
        `💡 ${vol.event.description}`,
      ].join('\n'),
      affectedSymbols: vol.event.affectedAssets,
      actionSuggestion: mins <= 30
        ? '🛑 建議立即縮小倉位或暫時不進場'
        : '⚠️ 建議設好止損，或等數據公布後再操作',
      source: 'calendar',
      soundEnabled: true,
      fullscreen: mins <= 30,
    });
  }

  // ═══════════════════════════════════════
  // 3. SMART MONEY (from SmartMoneyService events)
  // ═══════════════════════════════════════

  private processSmartMoney(tx: SmartMoneyTx): void {
    if (tx.type === 'transfer') return; // Only push sell_pressure and accumulation

    const symbols = tx.relatedSignalSymbol ? [tx.relatedSignalSymbol] : [];
    if (isDuplicate('SMART_MONEY_ALERT', [tx.walletLabel, tx.token])) return;

    const isSell = tx.type === 'sell_pressure';
    const usdFmt = tx.usdValue >= 1e6 ? `$${(tx.usdValue / 1e6).toFixed(1)}M` : `$${(tx.usdValue / 1e3).toFixed(0)}K`;

    this.pushAlert({
      type: 'SMART_MONEY_ALERT',
      level: tx.usdValue >= 5_000_000 ? 'A' : 'B',
      title: `💰 ${isSell ? '🔴 賣壓' : '🟢 吸籌'} ${tx.walletLabel}`,
      message: [
        `${isSell ? '📥 流入交易所' : '📤 流出交易所'}`,
        `💎 ${tx.token} (${usdFmt})`,
        `👛 ${tx.fromLabel} → ${tx.toLabel}`,
      ].join('\n'),
      affectedSymbols: symbols,
      actionSuggestion: isSell
        ? '留意短期賣壓，持有多單建議設好止損'
        : '聰明錢吸籌信號，可作為做多輔助參考',
      source: 'smartmoney',
      soundEnabled: tx.usdValue >= 2_000_000,
      fullscreen: false,
    });
  }

  // ═══════════════════════════════════════
  // 4. RISK WARNINGS (called externally by SignalGenerator)
  // ═══════════════════════════════════════

  processRiskWarnings(warnings: RiskWarning[], symbol: string): void {
    for (const w of warnings) {
      if (!w.triggered) continue;
      if (isDuplicate('RISK_WARNING', [w.category, symbol])) continue;

      this.pushAlert({
        type: 'RISK_WARNING',
        level: w.level === 'danger' ? 'A' : w.level === 'warning' ? 'B' : 'C',
        title: `⚠️ 風險警告 [${w.category}]`,
        message: w.message,
        affectedSymbols: [symbol],
        actionSuggestion: this.riskAction(w.category),
        source: 'risk',
        soundEnabled: w.level === 'danger',
        fullscreen: false,
      });
    }
  }

  private riskAction(category: string): string {
    const map: Record<string, string> = {
      'RSI': '等待 RSI 回到健康區間再進場',
      'Funding': '資金費率極端，考慮反向或觀望',
      'Overtrading': '今日交易次數已達上限，建議休息',
      'Strategy': '近期策略表現不佳，建議暫停或降低倉位',
      'ConsecutiveLoss': '連續虧損，強烈建議今日停止交易',
      'SmartMoney': '聰明錢方向與訊號相反，額外謹慎',
      'Event': '重大事件即將發布，建議縮倉',
    };
    return map[category] || '請謹慎評估後再操作';
  }

  // ═══════════════════════════════════════
  // PUSH ALERT
  // ═══════════════════════════════════════

  private pushAlert(params: Omit<Alert, 'id' | 'timestamp'>): void {
    const alert: Alert = {
      id: uuidv4(),
      timestamp: Date.now(),
      ...params,
    };

    // Store in history
    this.history.unshift(alert);
    if (this.history.length > 500) this.history = this.history.slice(0, 500);

    // Persist to DB
    this.persistAlert(alert);

    // Broadcast via WebSocket
    if (this.broadcastFn) {
      this.broadcastFn({
        type: alert.type,
        level: alert.level,
        data: {
          id: alert.id,
          title: alert.title,
          message: alert.message,
          affectedSymbols: alert.affectedSymbols,
          actionSuggestion: alert.actionSuggestion,
          source: alert.source,
          soundEnabled: alert.soundEnabled,
          fullscreen: alert.fullscreen,
        },
        timestamp: alert.timestamp,
      });
    }

    const icon = alert.level === 'A' ? '🔴' : alert.level === 'B' ? '🟡' : '🔵';
    console.log(
      `[AlertEngine] ${icon} ${alert.type} | ${alert.title} | ` +
      `${alert.affectedSymbols.join(',') || 'ALL'} | ` +
      `sound:${alert.soundEnabled ? 'ON' : 'off'} fullscreen:${alert.fullscreen ? 'YES' : 'no'}`
    );
  }

  private async persistAlert(alert: Alert): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO alerts (id, type, level, title, message, affected_symbols, action_suggestion, source, sound_enabled, fullscreen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [alert.id, alert.type, alert.level, alert.title, alert.message,
         alert.affectedSymbols, alert.actionSuggestion, alert.source,
         alert.soundEnabled, alert.fullscreen],
      );
    } catch (err) {
      console.error('[AlertEngine] DB error:', (err as Error).message);
    }
  }

  // ═══════════════════════════════════════
  // DATA ACCESS
  // ═══════════════════════════════════════

  getHistory(limit: number = 50, level?: AlertLevel, source?: AlertSource): Alert[] {
    let alerts = this.history;
    if (level) alerts = alerts.filter(a => a.level === level);
    if (source) alerts = alerts.filter(a => a.source === source);
    return alerts.slice(0, limit);
  }

  getActive(): Alert[] {
    const cutoff = Date.now() - 2 * 3600_000;
    return this.history.filter(a => a.timestamp > cutoff);
  }

  getStats(): {
    total24h: number;
    levelA: number; levelB: number; levelC: number;
    bySource: Record<string, number>;
  } {
    const cutoff = Date.now() - 24 * 3600_000;
    const recent = this.history.filter(a => a.timestamp > cutoff);
    const bySource: Record<string, number> = {};
    for (const a of recent) bySource[a.source] = (bySource[a.source] || 0) + 1;
    return {
      total24h: recent.length,
      levelA: recent.filter(a => a.level === 'A').length,
      levelB: recent.filter(a => a.level === 'B').length,
      levelC: recent.filter(a => a.level === 'C').length,
      bySource,
    };
  }

  // ═══════════════════════════════════════
  // MOCK TRIGGER (for testing)
  // ═══════════════════════════════════════

  /**
   * Manually trigger an alert. For testing the full pipeline.
   *
   * Usage:
   *   alertEngine.triggerMock({
   *     type: 'NEWS_ALERT_A', level: 'A',
   *     title: '🔴 FOMC 利率決議',
   *     message: '聯準會宣布升息 25bp',
   *     affectedSymbols: ['BTCUSDT'],
   *   });
   */
  triggerMock(params: {
    type: AlertType;
    level: AlertLevel;
    title: string;
    message: string;
    affectedSymbols?: string[];
    source?: AlertSource;
  }): Alert {
    const alert: Alert = {
      id: uuidv4(),
      type: params.type,
      level: params.level,
      title: params.title,
      message: params.message,
      affectedSymbols: params.affectedSymbols || [],
      actionSuggestion: '手動測試警報',
      source: params.source || 'risk',
      soundEnabled: params.level === 'A' || params.level === 'B',
      fullscreen: params.level === 'A',
      timestamp: Date.now(),
    };

    this.history.unshift(alert);
    if (this.broadcastFn) {
      this.broadcastFn({ type: alert.type, level: alert.level, data: alert, timestamp: Date.now() });
    }

    console.log(`[AlertEngine] 🧪 MOCK: ${alert.type} ${alert.title}`);
    return alert;
  }
}
