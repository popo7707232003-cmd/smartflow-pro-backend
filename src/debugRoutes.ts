import { Router } from 'express';
import { Pool } from 'pg';
let pool: Pool;
const router = Router();
export function initDebugRoutes(dbPool: Pool) { pool = dbPool; return router; }
router.get('/debug/db-check', async (_req, res) => {
  const r: Record<string,any> = {};
  try {
    r.sig_cols = (await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='signals' ORDER BY ordinal_position")).rows;
    r.sig_status = (await pool.query("SELECT status,COUNT(*)::int as c FROM signals GROUP BY status")).rows;
    r.sig_total = (await pool.query("SELECT COUNT(*)::int as c FROM signals")).rows[0].c;
    r.sample = (await pool.query("SELECT * FROM signals WHERE status='active' LIMIT 1")).rows[0];
    r.sr_exists = (await pool.query("SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_name='signal_results')")).rows[0].exists;
    if(r.sr_exists){r.sr_count=(await pool.query("SELECT COUNT(*)::int as c FROM signal_results")).rows[0].c;r.sr_dist=(await pool.query("SELECT result,COUNT(*)::int as c FROM signal_results GROUP BY result")).rows;r.sr_latest=(await pool.query("SELECT * FROM signal_results ORDER BY closed_at DESC LIMIT 1")).rows[0];}
    r.trades_exists = (await pool.query("SELECT EXISTS(SELECT FROM information_schema.tables WHERE table_name='trades')")).rows[0].exists;
    if(r.sample){const p=await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol='+r.sample.symbol);const d=await p.json() as any;const cp=parseFloat(d.price);const e=parseFloat(r.sample.entry);const t1=parseFloat(r.sample.tp1);const t2=parseFloat(r.sample.tp2);const s=parseFloat(r.sample.sl);const isL=r.sample.direction==='LONG';r.price_check={symbol:r.sample.symbol,dir:r.sample.direction,price:cp,entry:e,tp1:t1,tp2:t2,sl:s,tp1_hit:isL?cp>=t1:cp<=t1,tp2_hit:isL?cp>=t2:cp<=t2,sl_hit:isL?cp<=s:cp>=s};}
    res.json(r);
  } catch(e:any){res.status(500).json({error:e.message});}
});
export default router;