BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(20) NOT NULL,
    password_hash TEXT NOT NULL,
    balance_cents BIGINT NOT NULL DEFAULT 100000 CHECK (balance_cents >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq
    ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx
    ON sessions(user_id);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
    ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS bets (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    entry_price DOUBLE PRECISION NOT NULL CHECK (entry_price > 0 AND entry_price < 1),
    stake_cents BIGINT NOT NULL CHECK (stake_cents > 0),
    potential_cents BIGINT NOT NULL CHECK (potential_cents >= 0),
    status TEXT NOT NULL CHECK (status IN ('OPEN','WON','LOST')),
    pnl_cents BIGINT NOT NULL DEFAULT 0,
    placed_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bets_user_id_idx
    ON bets(user_id);

CREATE INDEX IF NOT EXISTS bets_status_market_idx
    ON bets(status, market_id);

CREATE INDEX IF NOT EXISTS bets_placed_at_idx
    ON bets(placed_at DESC);

COMMIT;
