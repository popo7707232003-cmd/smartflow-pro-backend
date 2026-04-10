import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

const router = Router();
let pool: Pool;

export function initAlertEngine(dbPool: Pool) {
  pool = dbPool;
  ensureTable().then(() => {
    console.log('[AlertEngine] Starting — checking every 60 seconds');
    runAlertCheck();
    setInterval(runAlertCheck, 60 * 1000);
  });
  return router;
}

// ===== Types =====
interface Alert {
  type: 'news' | 'economic' | 'price_spike' | 'rsi_extreme' | 'whale';
  severity: 'high' | 'medium' | 'low';
  title: string;
  message: string;
  symbol?: string;
  value?: number;
  source?: string;
  timestamp: string;
}

// ===== DB =====
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      type VARCHAR(30) NOT NULL,
      severity VARCHAR(10) NOT NULL,
      title VARCHAR(200) NOT NULL,
      message TEXT,
      symbol VARCHAR(20),
      value DOUBLE PRECISION,
      source VARCHAR(100),
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
  `);
}

async function saveAlert(alert: Alert) {
  try {
    // Dedup: don't save identical alert within 1 hour
    const { rows } = await pool.query(`
      SELECT id FROM alerts
      WHERE type = $1 AND title = $2 AND created_at > NOW() - INTERVAL '1 hour'
      LIMIT 1
    `, [alert.type, alert.title]);

    if (rows.length > 0) return;

    await pool.query(`
      INSERT INTO alerts (type, severity, title, message, symbol, value, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [alert.type, alert.severity, alert.title, alert.message, alert.symbol, alert.value, alert.source]);

    console.log(`[AlertEngine] 🔔 ${alert.severity.toUpperCase()}: ${alert.title}`);
  } catch (err: any) {
    console.error('[AlertEngine] Save error:', err.message);
  }
}

// ===== 1. RSS News Fetcher =====

async function checkRSSNews() {
  const feeds = [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
  ];

  const keywords = {
    high: ['hack', 'exploit', 'crash', 'ban', 'sec charges', 'emergency', 'liquidat', 'bankrupt', 'default', 'sanctions'],
    medium: ['regulation', 'etf', 'fed', 'rate', 'inflation', 'fomc', 'cpi', 'whale', 'acquisition', 'partnership'],
    low: ['upgrade', 'launch', 'airdrop', 'listing', 'staking']
  };

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'SmartFlowPro/1.0' }
      });
      if (!res.ok) continue;
      const text = await res.text();

      // Simple XML parse for <item> blocks
      const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];

      for (const item of items.slice(0, 10)) {
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/);
        const title = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : '';
        if (!title) continue;

        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        const pubDate = pubDateMatch ? new Date(pubDateMatch[1]) : new Date();

        // Only process news from last 2 hours
        if (Date.now() - pubDate.getTime() > 2 * 60 * 60 * 1000) continue;

        const lowerTitle = title.toLowerCase();
        let severity: 'high' | 'medium' | 'low' | null = null;

        for (const kw of keywords.high) {
          if (lowerTitle.includes(kw)) { severity = 'high'; break; }
        }
        if (!severity) {
          for (const kw of keywords.medium) {
            if (lowerTitle.includes(kw)) { severity = 'medium'; break; }
          }
        }
        if (!severity) {
          for (const kw of keywords.low) {
            if (lowerTitle.includes(kw)) { severity = 'low'; break; }
          }
        }

        if (severity) {
          await saveAlert({
            type: 'news',
            severity,
            title: `📰 ${title}`,
            message: `來源：${feed.name}`,
            source: feed.name,
            timestamp: pubDate.toISOString()
          });
        }
      }
    } catch (err: any) {
      console.error(`[AlertEngine] RSS error (${feed.name}):`, err.message);
    }
  }
}

// ===== 2. Economic Calendar =====

const ECONOMIC_EVENTS = [
  { name: 'Non-Farm Payrolls (NFP)', dates: ['2026-05-01', '2026-06-05', '2026-07-02'], impact: 'high' as const },
  { name: 'FOMC 利率決議', dates: ['2026-05-06', '2026-06-17', '2026-07-29'], impact: 'high' as const },
  { name: 'CPI 消費者物價指數', dates: ['2026-05-13', '2026-06-10', '2026-07-14'], impact: 'high' as const },
  { name: 'PPI 生產者物價指數', dates: ['2026-05-14', '2026-06-11', '2026-07-15'], impact: 'medium' as const },
  { name: 'GDP 國內生產毛額', dates: ['2026-05-28', '2026-06-25', '2026-07-30'], impact: 'medium' as const },
  { name: 'Initial Jobless Claims', dates: ['2026-04-10', '2026-04-17', '2026-04-24', '2026-05-01'], impact: 'low' as const },
  { name: 'FOMC 會議紀要', dates: ['2026-05-20', '2026-07-08'], impact: 'medium' as const },
  { name: 'PCE 物價指數', dates: ['2026-04-30', '2026-05-29', '2026-06-26'], impact: 'high' as const },
  { name: 'ISM 製造業 PMI', dates: ['2026-05-01', '2026-06-01', '2026-07-01'], impact: 'medium' as const },
];

async function checkEconomicCalendar() {
  const now = new Date();

  for (const event of ECONOMIC_EVENTS) {
    for (const dateStr of event.dates) {
      const eventDate = new Date(dateStr + 'T00:00:00Z');
      const diffMs = eventDate.getTime() - now.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      if (diffDays > 0 && diffDays <= 3) {
        const daysText = diffDays < 1 ? `${Math.round(diffDays * 24)}小時` : `${Math.round(diffDays)}天`;
        const severity = event.impact === 'high' ? 'high' : event.impact === 'medium' ? 'medium' : 'low';

        await saveAlert({
          type: 'economic',
          severity,
          title: `📅 ${event.name} — ${daysText}後`,
          message: `預定時間：${dateStr}。${severity === 'high' ? '高影響事件，注意波動風險！' : '留意市場反應。'}`,
          source: 'economic_calendar',
          timestamp: now.toISOString()
        });
      }
    }
  }
}

// ===== 3. Price Spike Detection =====

const priceHistory: Record<string, { price: number; ts: number }[]> = {};

async function checkPriceSpikes() {
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

  for (const symbol of SYMBOLS) {
    try {
      const urls = [
        `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
      ];
      let price = 0;
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json() as any;
          price = parseFloat(data.price);
          break;
        } catch { continue; }
      }
      if (!price) continue;

      if (!priceHistory[symbol]) priceHistory[symbol] = [];
      priceHistory[symbol].push({ price, ts: Date.now() });

      // Keep only last 10 minutes
      const cutoff = Date.now() - 10 * 60 * 1000;
      priceHistory[symbol] = priceHistory[symbol].filter(p => p.ts > cutoff);

      // Check 5-min change
      const fiveMinAgo = priceHistory[symbol].find(p => p.ts <= Date.now() - 4.5 * 60 * 1000);
      if (fiveMinAgo) {
        const changePercent = ((price - fiveMinAgo.price) / fiveMinAgo.price) * 100;
        if (Math.abs(changePercent) >= 2) {
          const dir = changePercent > 0 ? '🚀 急漲' : '💥 急跌';
          await saveAlert({
            type: 'price_spike',
            severity: Math.abs(changePercent) >= 5 ? 'high' : 'medium',
            title: `${dir} ${symbol} ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%（5分鐘）`,
            message: `現價 $${price.toFixed(2)}，5分鐘前 $${fiveMinAgo.price.toFixed(2)}`,
            symbol: symbol.replace('USDT', ''),
            value: changePercent,
            source: 'price_monitor',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch {}
  }
}

// ===== 4. RSI Extreme Detection =====

async function checkRSIExtremes() {
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

  for (const symbol of SYMBOLS) {
    try {
      const urls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=15m&limit=20`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=20`
      ];
      let closes: number[] = [];
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json() as any[];
          closes = data.map(k => parseFloat(k[4]));
          break;
        } catch { continue; }
      }

      if (closes.length < 15) continue;

      // RSI calculation
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14 || 0.001;
      const rsi = 100 - 100 / (1 + avgGain / avgLoss);

      if (rsi > 75) {
        await saveAlert({
          type: 'rsi_extreme',
          severity: rsi > 85 ? 'high' : 'medium',
          title: `⚠️ ${symbol.replace('USDT', '')} RSI 超買 ${rsi.toFixed(1)}`,
          message: `15分鐘 RSI = ${rsi.toFixed(1)}，可能面臨回調壓力`,
          symbol: symbol.replace('USDT', ''),
          value: rsi,
          source: 'rsi_monitor',
          timestamp: new Date().toISOString()
        });
      } else if (rsi < 25) {
        await saveAlert({
          type: 'rsi_extreme',
          severity: rsi < 15 ? 'high' : 'medium',
          title: `⚠️ ${symbol.replace('USDT', '')} RSI 超賣 ${rsi.toFixed(1)}`,
          message: `15分鐘 RSI = ${rsi.toFixed(1)}，可能出現反彈機會`,
          symbol: symbol.replace('USDT', ''),
          value: rsi,
          source: 'rsi_monitor',
          timestamp: new Date().toISOString()
        });
      }
    } catch {}
  }
}

// ===== Main Check Loop =====
async function runAlertCheck() {
  try {
    await Promise.allSettled([
      checkRSSNews(),
      checkEconomicCalendar(),
      checkPriceSpikes(),
      checkRSIExtremes()
    ]);
  } catch (err: any) {
    console.error('[AlertEngine] Check error:', err.message);
  }
}

// ===== API Route =====
router.get('/alerts', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const type = req.query.type as string;
    const severity = req.query.severity as string;

    let query = 'SELECT * FROM alerts';
    const conditions: string[] = [];
    const params: any[] = [];

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    params.push(limit);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const { rows } = await pool.query(query, params);

    // Count by severity
    const countResult = await pool.query(`
      SELECT severity, COUNT(*) as count
      FROM alerts WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY severity
    `);
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0 };
    for (const r of countResult.rows) counts[r.severity] = parseInt(r.count);

    return res.json({
      success: true,
      data: {
        alerts: rows.map(r => ({
          id: r.id,
          type: r.type,
          severity: r.severity,
          title: r.title,
          message: r.message,
          symbol: r.symbol,
          value: r.value,
          source: r.source,
          read: r.read,
          createdAt: r.created_at
        })),
        counts,
        total: rows.length
      }
    });
  } catch (err: any) {
    console.error('[API] /alerts error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/alerts/:id/read', async (req: Request, res: Response) => {
  try {
    await pool.query('UPDATE alerts SET read = TRUE WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Economic calendar endpoint
router.get('/economic-calendar', async (_req: Request, res: Response) => {
  const now = new Date();
  const events = [];

  for (const event of ECONOMIC_EVENTS) {
    for (const dateStr of event.dates) {
      const eventDate = new Date(dateStr + 'T00:00:00Z');
      const diffMs = eventDate.getTime() - now.getTime();
      if (diffMs > -7 * 24 * 60 * 60 * 1000 && diffMs < 30 * 24 * 60 * 60 * 1000) {
        events.push({
          name: event.name,
          date: dateStr,
          impact: event.impact,
          daysUntil: Math.round(diffMs / (1000 * 60 * 60 * 24) * 10) / 10,
          isPast: diffMs < 0
        });
      }
    }
  }

  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return res.json({ success: true, data: events });
});

export default router;
