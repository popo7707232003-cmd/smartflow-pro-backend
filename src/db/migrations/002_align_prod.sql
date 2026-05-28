-- 002_align_prod.sql
-- Align legacy production signal_results with the active code's INSERT shape.
--
-- Background: production was originally bootstrapped from an earlier
-- UUID-based migration where signal_results had:
--   * signal_id UUID NOT NULL REFERENCES signals(id)
--   * result_type / pnl / pnl_pct as NOT NULL
--   * no symbol / direction / entry columns
-- src/signalTracker.ts:closeSignal INSERTs columns the legacy table doesn't
-- have, so every close transaction rolls back, signal_results stays empty,
-- and the active backlog grows unbounded.
--
-- This file is idempotent and safe on fresh DBs (the DO blocks catch
-- SQLSTATE 42703 = undefined_column for columns the legacy schema never
-- created).

-- ── Add columns missing from the legacy table ──────────────────────────
-- symbol/direction/entry are genuinely missing in legacy. exit_price/
-- exit_type/result/pnl_percent are added by the runtime ensureTable already,
-- but listed here defensively so this migration is self-sufficient on any DB
-- shape (legacy, fresh, partially-aligned). All IF NOT EXISTS → idempotent.
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS symbol      VARCHAR(20);
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS direction   VARCHAR(10);
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS entry       NUMERIC;
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS exit_price  NUMERIC;
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS exit_type   VARCHAR(20);
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS result      VARCHAR(20);
ALTER TABLE signal_results ADD COLUMN IF NOT EXISTS pnl_percent DOUBLE PRECISION;

-- ── Relax legacy NOT NULL constraints ─────────────────────────────────
-- Active code does not write result_type / pnl / pnl_pct. Drop NOT NULL
-- so the INSERT can succeed without supplying values for them. CHECK
-- constraints (if any) pass when value is NULL.
DO $$ BEGIN
  ALTER TABLE signal_results ALTER COLUMN result_type DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE signal_results ALTER COLUMN pnl DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE signal_results ALTER COLUMN pnl_pct DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN null; END $$;

SELECT 'signal_results aligned with active code' AS status;
