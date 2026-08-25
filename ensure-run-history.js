const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("[MOCKKET] Missing DATABASE_URL for run-history migration.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sql = `
BEGIN;

CREATE TABLE IF NOT EXISTS simulator_runs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_number INTEGER NOT NULL CHECK (run_number > 0),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    starting_balance_cents BIGINT NOT NULL DEFAULT 100000,
    ending_balance_cents BIGINT,
    realized_pnl_cents BIGINT NOT NULL DEFAULT 0,
    total_bets INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    open_bets INTEGER NOT NULL DEFAULT 0,
    refill_count INTEGER NOT NULL DEFAULT 0,
    total_refilled_cents BIGINT NOT NULL DEFAULT 0,
    UNIQUE(user_id, run_number)
);

CREATE INDEX IF NOT EXISTS simulator_runs_user_ended_idx
    ON simulator_runs(user_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS simulator_run_bets (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES simulator_runs(id) ON DELETE CASCADE,
    original_bet_id UUID NOT NULL,
    market_id TEXT NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    game TEXT NOT NULL,
    game_key TEXT NOT NULL,
    competition TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    match_start TIMESTAMPTZ,
    outcome TEXT NOT NULL,
    outcome_index SMALLINT NOT NULL CHECK (outcome_index IN (0,1)),
    token_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    entry_price DOUBLE PRECISION NOT NULL,
    stake_cents BIGINT NOT NULL,
    potential_cents BIGINT NOT NULL,
    status TEXT NOT NULL,
    pnl_cents BIGINT NOT NULL DEFAULT 0,
    placed_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    UNIQUE(run_id, original_bet_id)
);

CREATE INDEX IF NOT EXISTS simulator_run_bets_run_idx
    ON simulator_run_bets(run_id, placed_at DESC);

CREATE TABLE IF NOT EXISTS simulator_run_refills (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES simulator_runs(id) ON DELETE CASCADE,
    original_refill_id BIGINT NOT NULL,
    amount_cents BIGINT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL,
    UNIQUE(run_id, original_refill_id)
);

CREATE INDEX IF NOT EXISTS simulator_run_refills_run_idx
    ON simulator_run_refills(run_id, claimed_at DESC);

CREATE TABLE IF NOT EXISTS simulator_run_archive_state (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_run_number INTEGER NOT NULL DEFAULT 1 CHECK (current_run_number > 0),
    current_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pending_run_id BIGINT REFERENCES simulator_runs(id) ON DELETE SET NULL
);

CREATE OR REPLACE FUNCTION mockket_ensure_archive_run(
    p_user_id BIGINT,
    p_activity_at TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id BIGINT;
    v_run_number INTEGER;
    v_started_at TIMESTAMPTZ;
BEGIN
    INSERT INTO simulator_run_archive_state(
        user_id,
        current_run_number,
        current_started_at
    )
    SELECT
        p_user_id,
        COALESCE((
            SELECT MAX(sr.run_number) + 1
            FROM simulator_runs sr
            WHERE sr.user_id = p_user_id
        ), 1),
        COALESCE(p_activity_at, NOW())
    ON CONFLICT (user_id) DO NOTHING;

    SELECT current_run_number, current_started_at, pending_run_id
    INTO v_run_number, v_started_at, v_run_id
    FROM simulator_run_archive_state
    WHERE user_id = p_user_id
    FOR UPDATE;

    v_started_at := LEAST(
        v_started_at,
        COALESCE(p_activity_at, v_started_at)
    );

    IF v_run_id IS NULL THEN
        INSERT INTO simulator_runs(
            user_id,
            run_number,
            started_at,
            starting_balance_cents
        )
        VALUES(
            p_user_id,
            v_run_number,
            v_started_at,
            100000
        )
        RETURNING id INTO v_run_id;

        UPDATE simulator_run_archive_state
        SET pending_run_id = v_run_id,
            current_started_at = v_started_at
        WHERE user_id = p_user_id;
    ELSE
        UPDATE simulator_runs
        SET started_at = LEAST(started_at, v_started_at)
        WHERE id = v_run_id;
    END IF;

    RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION mockket_archive_bet_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id BIGINT;
BEGIN
    v_run_id := mockket_ensure_archive_run(OLD.user_id, OLD.placed_at);

    INSERT INTO simulator_run_bets(
        run_id,
        original_bet_id,
        market_id,
        condition_id,
        game,
        game_key,
        competition,
        question,
        match_start,
        outcome,
        outcome_index,
        token_ids,
        entry_price,
        stake_cents,
        potential_cents,
        status,
        pnl_cents,
        placed_at,
        resolved_at
    )
    VALUES(
        v_run_id,
        OLD.id,
        OLD.market_id,
        OLD.condition_id,
        OLD.game,
        OLD.game_key,
        OLD.competition,
        OLD.question,
        OLD.match_start,
        OLD.outcome,
        OLD.outcome_index,
        OLD.token_ids,
        OLD.entry_price,
        OLD.stake_cents,
        OLD.potential_cents,
        OLD.status,
        OLD.pnl_cents,
        OLD.placed_at,
        OLD.resolved_at
    )
    ON CONFLICT (run_id, original_bet_id) DO NOTHING;

    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION mockket_archive_refill_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id BIGINT;
BEGIN
    v_run_id := mockket_ensure_archive_run(OLD.user_id, OLD.claimed_at);

    INSERT INTO simulator_run_refills(
        run_id,
        original_refill_id,
        amount_cents,
        claimed_at
    )
    VALUES(
        v_run_id,
        OLD.id,
        OLD.amount_cents,
        OLD.claimed_at
    )
    ON CONFLICT (run_id, original_refill_id) DO NOTHING;

    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION mockket_finalize_archived_run_after_balance_reset()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_run_id BIGINT;
BEGIN
    SELECT pending_run_id
    INTO v_run_id
    FROM simulator_run_archive_state
    WHERE user_id = NEW.id
    FOR UPDATE;

    IF v_run_id IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE simulator_runs sr
    SET ended_at = NOW(),
        ending_balance_cents = OLD.balance_cents,
        realized_pnl_cents = COALESCE((
            SELECT SUM(b.pnl_cents)
            FROM simulator_run_bets b
            WHERE b.run_id = v_run_id
        ), 0),
        total_bets = (
            SELECT COUNT(*)::int
            FROM simulator_run_bets b
            WHERE b.run_id = v_run_id
        ),
        wins = (
            SELECT COUNT(*)::int
            FROM simulator_run_bets b
            WHERE b.run_id = v_run_id
              AND b.status = 'WON'
        ),
        losses = (
            SELECT COUNT(*)::int
            FROM simulator_run_bets b
            WHERE b.run_id = v_run_id
              AND b.status = 'LOST'
        ),
        open_bets = (
            SELECT COUNT(*)::int
            FROM simulator_run_bets b
            WHERE b.run_id = v_run_id
              AND b.status = 'OPEN'
        ),
        refill_count = (
            SELECT COUNT(*)::int
            FROM simulator_run_refills r
            WHERE r.run_id = v_run_id
        ),
        total_refilled_cents = COALESCE((
            SELECT SUM(r.amount_cents)
            FROM simulator_run_refills r
            WHERE r.run_id = v_run_id
        ), 0)
    WHERE sr.id = v_run_id;

    UPDATE simulator_run_archive_state
    SET current_run_number = current_run_number + 1,
        current_started_at = NOW(),
        pending_run_id = NULL
    WHERE user_id = NEW.id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mockket_archive_bet_on_delete ON bets;
CREATE TRIGGER mockket_archive_bet_on_delete
BEFORE DELETE ON bets
FOR EACH ROW
EXECUTE FUNCTION mockket_archive_bet_before_delete();

DROP TRIGGER IF EXISTS mockket_archive_refill_on_delete ON daily_refills;
CREATE TRIGGER mockket_archive_refill_on_delete
BEFORE DELETE ON daily_refills
FOR EACH ROW
EXECUTE FUNCTION mockket_archive_refill_before_delete();

DROP TRIGGER IF EXISTS mockket_finalize_archived_run_on_reset ON users;
CREATE TRIGGER mockket_finalize_archived_run_on_reset
AFTER UPDATE OF balance_cents ON users
FOR EACH ROW
WHEN (NEW.balance_cents = 100000)
EXECUTE FUNCTION mockket_finalize_archived_run_after_balance_reset();

COMMIT;
`;

(async () => {
  try {
    await pool.query(sql);
    console.log("[MOCKKET] Simulator run-history archive ready.");
  } catch (err) {
    console.error("[MOCKKET] Run-history migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
