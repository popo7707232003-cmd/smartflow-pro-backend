import { Router, Request, Response } from 'express';
import { SignalTracker } from '../services/signalTracker';

export function createStatsRouter(tracker: SignalTracker): Router {
  const r = Router();

  r.get('/overview', async (_req: Request, res: Response) => {
    const stats = await tracker.getOverallStats();
    res.json({ success: true, data: stats });
  });

  r.get('/by-symbol', async (_req: Request, res: Response) => {
    const data = await tracker.getStatsBySymbol();
    res.json({ success: true, data });
  });

  r.get('/active', async (_req: Request, res: Response) => {
    const data = await tracker.getActiveSignals();
    res.json({ success: true, data });
  });

  r.get('/results', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const data = await tracker.getRecentResults(limit);
    res.json({ success: true, data });
  });

  return r;
}
