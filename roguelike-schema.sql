BEGIN;
CREATE TABLE IF NOT EXISTS rogue_runs (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  picked JSONB NOT NULL DEFAULT '[]'::jsonb,
  result TEXT CHECK (result IN ('VICTORY', 'ELIMINATED', 'RESET')),
  wins INTEGER NOT NULL DEFAULT 0,
  ending_balance_cents BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS rogue_runs_active_user ON rogue_runs(user_id) WHERE ended_at IS NULL;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS rogue_run_id UUID REFERENCES rogue_runs(id);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS relic_bonus_cents BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS bets_rogue_run ON bets(rogue_run_id);
COMMIT;
