-- 001_init.sql
-- SmartFlow Pro — Database Schema
-- PostgreSQL 16+
--
-- IMPORTANT: src/index.ts does NOT run this file at boot. Each active module
-- (src/signalScanner.ts, src/signalTracker.ts, src/alertEngine.ts) bootstraps
-- its own tables via CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN
-- IF NOT EXISTS. This file mirrors that runtime schema for the signals /
-- signal_results path so a fresh DB can also be bootstrapped via:
--   npx tsx src/db/migrate.ts
-- Keep this file in sync with the ensureTable() calls when schema changes.

-- ═══ ENUMS ═══
-- Used by smart_money_txns / news_events / alerts only. The signals path
-- uses plain VARCHAR (matches runtime ensureTable behavior).
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
-- Mirrors src/signalScanner.ts:ensureTable()
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS signals (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL,
    direction       VARCHAR(10) NOT NULL,
    entry           DOUBLE PRECISION NOT NULL,
    tp1             DOUBLE PRECISION,
    tp2             DOUBLE PRECISION,
    sl              DOUBLE PRECISION,
    score           INTEGER,
    max_score       INTEGER DEFAULT 13,
    score_details   JSONB DEFAULT '{}',
    rsi             DOUBLE PRECISION,
    atr             DOUBLE PRECISION,
    rr              DOUBLE PRECISION,
    timeframe       VARCHAR(10) DEFAULT '15m',
    reason          TEXT,
    status          VARCHAR(20) DEFAULT 'active',
    tp1_hit         BOOLEAN DEFAULT FALSE,
    tp2_hit         BOOLEAN DEFAULT FALSE,
    sl_hit          BOOLEAN DEFAULT FALSE,
    closed_at       TIMESTAMPTZ,
    pnl_percent     DOUBLE PRECISION,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

-- ═══════════════════════════════════════
-- TABLE: signal_results
-- Mirrors src/signalTracker.ts:ensureTable()
-- Note: signal_id is TEXT (not UUID) and has no FK. Active code writes
-- signals.id::text via sig.id.toString() on INSERT, and signalRoutes.ts
-- joins with an implicit text/int coercion.
-- ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS signal_results (
    id              SERIAL PRIMARY KEY,
    signal_id       TEXT NOT NULL,
    symbol          VARCHAR(20),
    direction       VARCHAR(10),
    entry           NUMERIC,
    exit_price      NUMERIC,
    exit_type       VARCHAR(20),
    pnl_percent     DOUBLE PRECISION,
    result          VARCHAR(20),
    closed_at       TIMESTAMPTZ DEFAULT NOW()
);

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
