-- Browser app sessions, encrypted Robinhood connections, and Bluechip runtime.
-- Credentials are encrypted by the API before they reach these tables.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS web_sessions (
    session_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    session_token_hash BINARY(32) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (session_id),
    UNIQUE KEY web_sessions_token_unique (session_token_hash),
    KEY web_sessions_license_index (license_id),
    KEY web_sessions_expiry_index (expires_at),
    CONSTRAINT web_sessions_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_oauth_states (
    state_hash BINARY(32) NOT NULL,
    license_id CHAR(36) NOT NULL,
    provider ENUM('robinhood') NOT NULL,
    encrypted_payload LONGBLOB NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (state_hash),
    KEY web_oauth_states_expiry_index (expires_at),
    CONSTRAINT web_oauth_states_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_trading_connections (
    connection_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    provider ENUM('robinhood') NOT NULL,
    encrypted_credentials LONGBLOB NOT NULL,
    connection_state ENUM(
      'connected',
      'needs_agentic_account',
      'authentication_expired',
      'error'
    ) NOT NULL,
    has_buying_power BOOLEAN NOT NULL DEFAULT FALSE,
    last_checked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (connection_id),
    UNIQUE KEY web_trading_connections_license_provider_unique (license_id, provider),
    CONSTRAINT web_trading_connections_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_trading_settings (
    license_id CHAR(36) NOT NULL,
    agent_id ENUM('bluechip') NOT NULL DEFAULT 'bluechip',
    mode ENUM('practice', 'real') NOT NULL DEFAULT 'practice',
    daily_budget_cents INT NOT NULL DEFAULT 1000,
    max_per_trade_cents INT NOT NULL DEFAULT 200,
    running BOOLEAN NOT NULL DEFAULT FALSE,
    real_authorized_until DATETIME(6) NULL,
    last_checked_at DATETIME(6) NULL,
    next_check_at DATETIME(6) NULL,
    cycle_locked_until DATETIME(6) NULL,
    status_message VARCHAR(500) NOT NULL DEFAULT 'Ready when you are.',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (license_id),
    CONSTRAINT web_trading_settings_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id),
    CONSTRAINT web_trading_settings_daily_budget_check CHECK (
      daily_budget_cents BETWEEN 100 AND 2500
    ),
    CONSTRAINT web_trading_settings_trade_limit_check CHECK (
      max_per_trade_cents BETWEEN 100 AND 500
      AND max_per_trade_cents <= daily_budget_cents
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_trading_activity (
    activity_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    agent_id ENUM('bluechip') NOT NULL DEFAULT 'bluechip',
    mode ENUM('practice', 'real') NOT NULL,
    kind ENUM(
      'started',
      'paused',
      'market_check',
      'signal',
      'skipped',
      'reviewed',
      'order_submitted',
      'filled',
      'error'
    ) NOT NULL,
    symbol VARCHAR(10) NULL,
    amount_cents INT NULL,
    message VARCHAR(500) NOT NULL,
    occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (activity_id),
    KEY web_trading_activity_license_time_index (license_id, occurred_at),
    CONSTRAINT web_trading_activity_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_trade_intents (
    intent_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    source_event_hash BINARY(32) NOT NULL,
    strategy_id VARCHAR(64) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    amount_cents INT NOT NULL,
    mode ENUM('real') NOT NULL DEFAULT 'real',
    state ENUM(
      'reserved',
      'submitting',
      'submitted',
      'unknown',
      'rejected',
      'filled',
      'canceled'
    ) NOT NULL,
    request_fingerprint BINARY(32) NULL,
    venue_order_id CHAR(36) NULL,
    failure_code VARCHAR(128) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (intent_id),
    UNIQUE KEY web_trade_intents_source_unique (license_id, source_event_hash),
    UNIQUE KEY web_trade_intents_order_unique (venue_order_id),
    KEY web_trade_intents_license_state_index (license_id, state, created_at),
    CONSTRAINT web_trade_intents_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id),
    CONSTRAINT web_trade_intents_amount_check CHECK (amount_cents BETWEEN 100 AND 500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_trade_fills (
    fill_id CHAR(36) NOT NULL,
    intent_id CHAR(36) NOT NULL,
    venue_fill_id VARCHAR(255) NOT NULL,
    quantity VARCHAR(64) NOT NULL,
    price VARCHAR(64) NOT NULL,
    fee VARCHAR(64) NOT NULL,
    filled_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (fill_id),
    UNIQUE KEY web_trade_fills_venue_unique (intent_id, venue_fill_id),
    CONSTRAINT web_trade_fills_intent_fk FOREIGN KEY (intent_id)
      REFERENCES web_trade_intents (intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
