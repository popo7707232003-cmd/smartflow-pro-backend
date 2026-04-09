// backend/src/routes/alerts.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — News & Alerts API Endpoints
// ═══════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import { NewsAggregator } from '../services/newsAggregator';
import { classifyBatch } from '../services/newsFilter';
import { getUpcomingEvents, getTodayEvents, isHighVolatilityPeriod } from '../services/economicCalendar';
import { AlertEngine } from '../services/alertEngine';

export function createAlertsRouter(
  newsAgg: NewsAggregator,
  alertEngine: AlertEngine,
): Router {
  const router = Router();

  // ═══ NEWS ═══

  // GET /api/news — Classified news feed
  router.get('/news', (_req: Request, res: Response) => {
    const raw = newsAgg.getRecent(50);
    const classified = classifyBatch(raw);

    res.json({
      success: true,
      count: classified.length,
      data: classified,
    });
  });

  // GET /api/news/raw — Raw unfiltered news (for debugging)
  router.get('/news/raw', (_req: Request, res: Response) => {
    const raw = newsAgg.getRecent(50);
    res.json({ success: true, count: raw.length, data: raw });
  });

  // ═══ CALENDAR ═══

  // GET /api/calendar — Upcoming events
  router.get('/calendar', (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 7, 30);
    const events = getUpcomingEvents(days);

    res.json({ success: true, count: events.length, data: events });
  });

  // GET /api/calendar/today — Today's events
  router.get('/calendar/today', (_req: Request, res: Response) => {
    const events = getTodayEvents();
    const volatility = isHighVolatilityPeriod();

    res.json({
      success: true,
      data: {
        events,
        currentVolatility: volatility,
      },
    });
  });

  // ═══ ALERTS ═══

  // GET /api/alerts — Alert history
  router.get('/alerts', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const level = req.query.level as string | undefined;
    const source = req.query.source as string | undefined;

    const alerts = alertEngine.getHistory(limit, level as any, source as any);

    res.json({ success: true, count: alerts.length, data: alerts });
  });

  // GET /api/alerts/active — Currently active alerts
  router.get('/alerts/active', (_req: Request, res: Response) => {
    const active = alertEngine.getActive();
    res.json({ success: true, count: active.length, data: active });
  });

  // GET /api/alerts/stats — Alert statistics
  router.get('/alerts/stats', (_req: Request, res: Response) => {
    const stats = alertEngine.getStats();
    res.json({ success: true, data: stats });
  });

  // POST /api/alerts/mock — Trigger a mock alert (testing)
  router.post('/alerts/mock', (req: Request, res: Response) => {
    const { type = 'NEWS_ALERT_A', level = 'A', title, message, affectedSymbols = [], source = 'risk' } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, error: 'title and message required' });
    }

    const alert = alertEngine.triggerMock({ type, level, title, message, affectedSymbols, source });

    res.json({
      success: true,
      message: `Mock alert triggered: ${type}`,
      data: alert,
    });
  });

  return router;
}
