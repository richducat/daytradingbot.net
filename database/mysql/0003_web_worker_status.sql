-- Fail-closed heartbeat for the browser trading worker.
-- The API refuses to start Practice or Real mode when this worker is stale.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS web_worker_status (
    worker_name VARCHAR(32) NOT NULL,
    last_started_at DATETIME(6) NOT NULL,
    last_finished_at DATETIME(6) NULL,
    last_success_at DATETIME(6) NULL,
    last_result ENUM('running', 'success', 'error') NOT NULL,
    claimed_cycles INT NOT NULL DEFAULT 0,
    completed_cycles INT NOT NULL DEFAULT 0,
    failed_cycles INT NOT NULL DEFAULT 0,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (worker_name),
    CONSTRAINT web_worker_status_claimed_check CHECK (claimed_cycles >= 0),
    CONSTRAINT web_worker_status_completed_check CHECK (completed_cycles >= 0),
    CONSTRAINT web_worker_status_failed_check CHECK (failed_cycles >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable proof of each customer-approved 24-hour Real session and the
-- limits that were visible when they approved it.
CREATE TABLE IF NOT EXISTS web_real_authorizations (
    authorization_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    disclosure_version VARCHAR(32) NOT NULL,
    daily_budget_cents INT NOT NULL,
    max_per_trade_cents INT NOT NULL,
    authorized_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    PRIMARY KEY (authorization_id),
    KEY web_real_authorizations_license_time_index (license_id, authorized_at),
    CONSTRAINT web_real_authorizations_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id),
    CONSTRAINT web_real_authorizations_limits_check CHECK (
      daily_budget_cents BETWEEN 100 AND 2500
      AND max_per_trade_cents BETWEEN 100 AND 500
      AND max_per_trade_cents <= daily_budget_cents
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
