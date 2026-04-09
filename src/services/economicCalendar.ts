// backend/src/services/economicCalendar.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 經濟日曆
// ═══════════════════════════════════════════════════════════════
//
// 硬編碼真實 2025-2026 重要經濟事件日期
// getUpcomingEvents(days) · isHighVolatilityPeriod()
// ═══════════════════════════════════════════════════════════════

export interface EconomicEvent {
  name: string;
  date: string;            // ISO UTC: "YYYY-MM-DDTHH:mm:ssZ"
  importance: 1 | 2 | 3;   // 3 = highest
  category: 'fed' | 'inflation' | 'employment' | 'gdp' | 'crypto' | 'other';
  affectedAssets: string[];
  description: string;
}

// ═══════════════════════════════════════════════════════
// REAL 2025-2026 EVENTS
// ═══════════════════════════════════════════════════════

const EVENTS: EconomicEvent[] = [
  // ──── 2025 FOMC (importance 3) ────
  { name: 'FOMC 利率決議', date: '2025-05-07T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'Fed 利率決議公布' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2025-06-18T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'FOMC + SEP 經濟展望' },
  { name: 'FOMC 利率決議', date: '2025-07-30T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'Fed 利率決議' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2025-09-17T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'FOMC + 點陣圖更新' },
  { name: 'FOMC 利率決議', date: '2025-10-29T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'Fed 利率決議' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2025-12-10T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: '年度最後 FOMC' },

  // ──── 2026 FOMC ────
  { name: 'FOMC 利率決議', date: '2026-01-28T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: '2026首次FOMC' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2026-03-18T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'FOMC + SEP' },
  { name: 'FOMC 利率決議', date: '2026-05-06T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'Fed 利率決議' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2026-06-17T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'FOMC + 點陣圖' },
  { name: 'FOMC 利率決議', date: '2026-07-29T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'Fed 利率決議' },
  { name: 'FOMC 利率決議 + 點陣圖', date: '2026-09-16T18:00:00Z', importance: 3, category: 'fed', affectedAssets: ['BTCUSDT','ETHUSDT','SOLUSDT'], description: 'FOMC + SEP' },

  // ──── 2025 CPI (importance 3) ────
  { name: '美國 CPI 數據', date: '2025-05-13T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '4月CPI年率/月率' },
  { name: '美國 CPI 數據', date: '2025-06-11T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '5月CPI' },
  { name: '美國 CPI 數據', date: '2025-07-10T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '6月CPI' },
  { name: '美國 CPI 數據', date: '2025-08-12T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '7月CPI' },
  { name: '美國 CPI 數據', date: '2025-09-10T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '8月CPI' },
  { name: '美國 CPI 數據', date: '2025-10-14T12:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '9月CPI' },
  { name: '美國 CPI 數據', date: '2025-11-12T13:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '10月CPI' },
  { name: '美國 CPI 數據', date: '2025-12-10T13:30:00Z', importance: 3, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '11月CPI' },

  // ──── 2025 NFP (importance 3) ────
  { name: '非農就業數據', date: '2025-05-02T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '4月非農+失業率' },
  { name: '非農就業數據', date: '2025-06-06T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '5月非農' },
  { name: '非農就業數據', date: '2025-07-03T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '6月非農' },
  { name: '非農就業數據', date: '2025-08-01T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '7月非農' },
  { name: '非農就業數據', date: '2025-09-05T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '8月非農' },
  { name: '非農就業數據', date: '2025-10-03T12:30:00Z', importance: 3, category: 'employment', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '9月非農' },

  // ──── PCE (importance 2) ────
  { name: '核心 PCE 物價指數', date: '2025-05-30T12:30:00Z', importance: 2, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '4月核心PCE' },
  { name: '核心 PCE 物價指數', date: '2025-06-27T12:30:00Z', importance: 2, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '5月核心PCE' },
  { name: '核心 PCE 物價指數', date: '2025-07-31T12:30:00Z', importance: 2, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '6月核心PCE' },
  { name: '核心 PCE 物價指數', date: '2025-08-29T12:30:00Z', importance: 2, category: 'inflation', affectedAssets: ['BTCUSDT','ETHUSDT'], description: '7月核心PCE' },

  // ──── GDP (importance 2) ────
  { name: '美國 GDP', date: '2025-05-29T12:30:00Z', importance: 2, category: 'gdp', affectedAssets: ['BTCUSDT','ETHUSDT'], description: 'Q1 GDP 第二估計' },
  { name: '美國 GDP 初值', date: '2025-07-30T12:30:00Z', importance: 2, category: 'gdp', affectedAssets: ['BTCUSDT','ETHUSDT'], description: 'Q2 GDP 初值' },
  { name: '美國 GDP 初值', date: '2025-10-29T12:30:00Z', importance: 2, category: 'gdp', affectedAssets: ['BTCUSDT','ETHUSDT'], description: 'Q3 GDP 初值' },

  // ──── Crypto (importance 2) ────
  { name: 'Ethereum Pectra 升級', date: '2025-05-07T12:00:00Z', importance: 2, category: 'crypto', affectedAssets: ['ETHUSDT'], description: 'EIP-7702 帳戶抽象' },
];

// ═══════════════════════════════════════════════════════
// FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Get events within the next N days.
 */
export function getUpcomingEvents(days: number = 7): EconomicEvent[] {
  const now = Date.now();
  const cutoff = now + days * 86400_000;

  return EVENTS
    .filter(e => {
      const t = new Date(e.date).getTime();
      return t > now && t <= cutoff;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * Get the very next event.
 */
export function getNextEvent(): EconomicEvent | null {
  const now = Date.now();
  for (const e of EVENTS.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
    if (new Date(e.date).getTime() > now) return e;
  }
  return null;
}

/**
 * Check if we're in a high-volatility window.
 * Returns true if within 60 minutes BEFORE or 30 minutes AFTER
 * a major (importance >= 2) event.
 */
export function isHighVolatilityPeriod(): {
  volatile: boolean;
  event: EconomicEvent | null;
  minutesUntil: number | null;
  phase: 'before' | 'during' | 'after' | null;
} {
  const now = Date.now();
  const BEFORE_MS = 60 * 60_000;  // 60 min before
  const AFTER_MS = 30 * 60_000;   // 30 min after

  for (const event of EVENTS) {
    if (event.importance < 2) continue;
    const eventTime = new Date(event.date).getTime();
    const diff = eventTime - now;

    // Before
    if (diff > 0 && diff <= BEFORE_MS) {
      return { volatile: true, event, minutesUntil: Math.round(diff / 60_000), phase: 'before' };
    }
    // During (±5 min)
    if (Math.abs(diff) <= 5 * 60_000) {
      return { volatile: true, event, minutesUntil: 0, phase: 'during' };
    }
    // After
    if (diff < 0 && Math.abs(diff) <= AFTER_MS) {
      return { volatile: true, event, minutesUntil: Math.round(diff / 60_000), phase: 'after' };
    }
  }

  return { volatile: false, event: null, minutesUntil: null, phase: null };
}

/**
 * Get today's events.
 */
export function getTodayEvents(): EconomicEvent[] {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

  return EVENTS.filter(e => {
    const t = new Date(e.date).getTime();
    return t >= start.getTime() && t < end.getTime();
  });
}

/**
 * Format event for display (Taipei time).
 */
export function formatEvent(event: EconomicEvent): string {
  const d = new Date(event.date);
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
  const date = d.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', timeZone: 'Asia/Taipei' });
  return `${date} ${time} ${'⭐'.repeat(event.importance)} ${event.name}`;
}
