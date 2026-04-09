-- 001_init.sql
-- SmartFlow Pro — Database Schema
-- PostgreSQL 16+

-- ═══ ENUMS ═══
DO $$ BEGIN
  CREATE TYPE trade_direction AS ENUM ('long', 'short');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE signal_grade AS ENUM ('strong', 'medium', 'weak');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE signal_status AS ENUM ('pending', 'tp1', 'tp2', 'sl', 'timeout', 'manual');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE smart_money_type AS ENUM ('sell_pressure', 'accumulation', 'transfer');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE news_level AS ENUM ('A', 'B', 'C');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE news_sentiment AS ENUM ('positive', 'negative', 'neutral');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ═══════════════════════════════════════
-- TABLE: signals
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol          VARCHAR(20) NOT NULL,
    direction       trade_direction NOT NULL,
    entry           DECIMAL(20, 8) NOT NULL,
    tp1             DECIMAL(20, 8) NOT NULL,
    tp1_pct         DECIMAL(8, 4) NOT NULL,
    tp2             DECIMAL(20, 8) NOT NULL,
    tp2_pct         DECIMAL(8, 4) NOT NULL,
    sl              DECIMAL(20, 8) NOT NULL,
    sl_pct          DECIMAL(8, 4) NOT NULL,
    rr              DECIMAL(8, 4) NOT NULL,
    atr             DECIMAL(20, 8) NOT NULL,
    score           SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
    score_label     signal_grade NOT NULL,
    conditions      JSONB NOT NULL DEFAULT '{}',
    warnings        TEXT[] DEFAULT '{}',
    -- Indicator snapshot
    rsi_value       DECIMAL(6, 2),
    macd_histogram  DECIMAL(20, 8),
    ema_alignment   VARCHAR(20),
    vwap_bias       VARCHAR(10),
    volume_ratio    DECIMAL(8, 2),
    -- Structure
    bos_confirmed   BOOLEAN DEFAULT FALSE,
    choch_detected  BOOLEAN DEFAULT FALSE,
    in_order_block  BOOLEAN DEFAULT FALSE,
    has_fvg         BOOLEAN DEFAULT FALSE,
    liq_sweep       BOOLEAN DEFAULT FALSE,
    -- Status
    status          signal_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(score DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_date ON signals(symbol, created_at DESC);

-- ═══════════════════════════════════════
-- TABLE: signal_results
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS signal_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    result_type     VARCHAR(10) NOT NULL CHECK (result_type IN ('tp1', 'tp2', 'sl', 'timeout', 'manual')),
    pnl             DECIMAL(20, 4) NOT NULL,
    pnl_pct         DECIMAL(10, 4) NOT NULL,
    exit_price      DECIMAL(20, 8),
    hold_duration   INTERVAL,
    mae_pct         DECIMAL(10, 4),
    mfe_pct         DECIMAL(10, 4),
    closed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_signal ON signal_results(signal_id);
CREATE INDEX IF NOT EXISTS idx_results_type ON signal_results(result_type);
CREATE INDEX IF NOT EXISTS idx_results_closed ON signal_results(closed_at DESC);

-- ═══════════════════════════════════════
-- TABLE: smart_money_txns
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS smart_money_txns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  VARCHAR(100) NOT NULL,
    wallet_label    VARCHAR(100),
    tx_hash         VARCHAR(100),
    type            smart_money_type NOT NULL,
    token           VARCHAR(20) NOT NULL,
    amount          DECIMAL(30, 8) NOT NULL,
    usd_value       DECIMAL(20, 2) NOT NULL,
    blockchain      VARCHAR(30) DEFAULT 'ethereum',
    from_label      VARCHAR(100),
    to_label        VARCHAR(100),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sm_token ON smart_money_txns(token);
CREATE INDEX IF NOT EXISTS idx_sm_type ON smart_money_txns(type);
CREATE INDEX IF NOT EXISTS idx_sm_time ON smart_money_txns(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sm_usd ON smart_money_txns(usd_value DESC);
CREATE INDEX IF NOT EXISTS idx_sm_wallet ON smart_money_txns(wallet_address);

-- ═══════════════════════════════════════
-- TABLE: news_events
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS news_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    source          VARCHAR(100),
    url             TEXT,
    level           news_level NOT NULL,
    sentiment       news_sentiment NOT NULL DEFAULT 'neutral',
    affected_symbols TEXT[] DEFAULT '{}',
    estimated_impact VARCHAR(20) DEFAULT 'medium',
    matched_keywords TEXT[] DEFAULT '{}',
    action_suggestion TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_level ON news_events(level);
CREATE INDEX IF NOT EXISTS idx_news_created ON news_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_sentiment ON news_events(sentiment);

-- ═══════════════════════════════════════
-- TABLE: alerts
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            VARCHAR(30) NOT NULL,
    level           news_level NOT NULL DEFAULT 'C',
    title           VARCHAR(300) NOT NULL,
    message         TEXT NOT NULL,
    affected_symbols TEXT[] DEFAULT '{}',
    action_suggestion TEXT,
    source          VARCHAR(30) NOT NULL DEFAULT 'system',
    sound_enabled   BOOLEAN DEFAULT TRUE,
    fullscreen      BOOLEAN DEFAULT FALSE,
    dismissed       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(dismissed, created_at DESC) WHERE dismissed = FALSE;

-- ═══ DONE ═══
SELECT 'SmartFlow Pro schema initialized' AS status;
