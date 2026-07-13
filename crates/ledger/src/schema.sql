PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS intents (
    intent_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    risk_scope TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    instrument TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    purpose TEXT NOT NULL,
    notional_micros INTEGER NOT NULL CHECK (notional_micros > 0),
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_reservations (
    intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
    risk_scope TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    venue TEXT NOT NULL,
    venue_day TEXT NOT NULL,
    opening_notional_micros INTEGER NOT NULL CHECK (opening_notional_micros >= 0),
    exposure_micros INTEGER NOT NULL CHECK (exposure_micros >= 0),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    reserved_at TEXT NOT NULL,
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS prediction_intents (
    intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
    outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no')),
    contract_count INTEGER NOT NULL CHECK (contract_count > 0),
    limit_price_cents INTEGER NOT NULL CHECK (limit_price_cents BETWEEN 1 AND 99),
    max_fee_cents INTEGER NOT NULL CHECK (max_fee_cents >= 0)
);

CREATE INDEX IF NOT EXISTS active_reservations_by_venue
    ON risk_reservations(account_scope, venue, venue_day, active);

CREATE TABLE IF NOT EXISTS daily_usage (
    account_scope TEXT NOT NULL,
    venue TEXT NOT NULL,
    venue_day TEXT NOT NULL,
    opening_notional_micros INTEGER NOT NULL DEFAULT 0 CHECK (opening_notional_micros >= 0),
    pnl_micros INTEGER NOT NULL DEFAULT 0,
    pnl_observed_at TEXT,
    PRIMARY KEY (account_scope, venue, venue_day)
);

CREATE TABLE IF NOT EXISTS orders (
    intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
    venue_order_id TEXT,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_attempts (
    attempt_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE REFERENCES intents(intent_id),
    client_order_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('submitting', 'acknowledged', 'unknown', 'reconciled', 'quarantined')
    ),
    reconciled_state TEXT CHECK (
        reconciled_state IS NULL OR reconciled_state IN (
            'acknowledged', 'partially_filled', 'filled', 'canceled', 'rejected'
        )
    ),
    venue_order_id TEXT,
    detail_code TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS unresolved_submission_attempts
    ON submission_attempts(state, updated_at);

CREATE TABLE IF NOT EXISTS fills (
    fill_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES intents(intent_id),
    venue_fill_id TEXT NOT NULL,
    quantity TEXT NOT NULL,
    price TEXT NOT NULL,
    notional_micros INTEGER NOT NULL CHECK (notional_micros > 0),
    fee_micros INTEGER NOT NULL DEFAULT 0,
    filled_at TEXT NOT NULL,
    UNIQUE(intent_id, venue_fill_id)
);

CREATE TABLE IF NOT EXISTS lots (
    lot_id TEXT PRIMARY KEY,
    risk_scope TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    venue TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    instrument TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    exposure_micros INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    CHECK (
        (status = 'open' AND exposure_micros > 0 AND closed_at IS NULL)
        OR (status = 'closed' AND exposure_micros = 0 AND closed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_strategy_lot
    ON lots(account_scope, venue, strategy_id, instrument)
    WHERE status = 'open';

CREATE TABLE IF NOT EXISTS venue_state (
    account_scope TEXT NOT NULL,
    venue TEXT NOT NULL,
    state TEXT NOT NULL,
    eligibility_checked_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(account_scope, venue)
);

CREATE TABLE IF NOT EXISTS safety_state (
    risk_scope TEXT NOT NULL,
    account_scope TEXT NOT NULL,
    venue TEXT NOT NULL,
    global_kill_switch INTEGER NOT NULL CHECK (global_kill_switch IN (0, 1)),
    venue_paused INTEGER NOT NULL CHECK (venue_paused IN (0, 1)),
    strategy_enabled INTEGER NOT NULL CHECK (strategy_enabled IN (0, 1)),
    venue_eligible INTEGER NOT NULL CHECK (venue_eligible IN (0, 1)),
    connector_healthy INTEGER NOT NULL CHECK (connector_healthy IN (0, 1)),
    market_data_fresh INTEGER NOT NULL CHECK (market_data_fresh IN (0, 1)),
    license_allows_entries INTEGER NOT NULL CHECK (license_allows_entries IN (0, 1)),
    observed_at TEXT NOT NULL,
    PRIMARY KEY (account_scope, venue)
);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    intent_id TEXT REFERENCES intents(intent_id),
    event_type TEXT NOT NULL,
    detail_code TEXT,
    occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_activity (
    event_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('practice', 'real')),
    event_kind TEXT NOT NULL CHECK (
        event_kind IN (
            'started', 'paused', 'market_check', 'signal', 'skipped',
            'reviewed', 'order_submitted', 'filled', 'error'
        )
    ),
    symbol TEXT,
    amount_micros INTEGER CHECK (amount_micros IS NULL OR amount_micros >= 0),
    message TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recent_agent_activity
    ON agent_activity(occurred_at DESC);
