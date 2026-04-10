-- Signal Tracking Tables (002)

-- Add status column if not exists
DO $$ BEGIN
  ALTER TABLE signals ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
EXCEPTION WHEN others THEN null;
END $$;

-- Signal tracking snapshots
CREATE TABLE IF NOT EXISTS signal_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES signals(id) ON DELETE CASCADE,
  check_time TIMESTAMPTZ DEFAULT NOW(),
  current_price DECIMAL(20,8),
  pnl_pct DECIMAL(10,4),
  max_favorable DECIMAL(10,4) DEFAULT 0,
  max_adverse DECIMAL(10,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_tracking_signal ON signal_tracking(signal_id);
CREATE INDEX IF NOT EXISTS idx_tracking_time ON signal_tracking(check_time DESC);

-- Daily stats with unique date constraint
CREATE TABLE IF NOT EXISTS daily_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  total_signals INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_rate DECIMAL(5,2) DEFAULT 0,
  profit_factor DECIMAL(10,4) DEFAULT 0,
  total_pnl DECIMAL(20,8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(date DESC);

SELECT 'Signal tracking tables created' AS status;
