-- DayTradingBot commercial schema for Namecheap MariaDB 11.
-- Import this file into a dedicated DayTradingBot database; do not reuse another site's database.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS purchases (
    purchase_id CHAR(36) NOT NULL,
    stripe_checkout_session_id VARCHAR(255) NOT NULL,
    stripe_payment_intent_id VARCHAR(255) NULL,
    customer_email_ciphertext LONGBLOB NOT NULL,
    amount_cents INT NOT NULL,
    currency CHAR(3) NOT NULL,
    status ENUM('pending', 'paid', 'refunded', 'disputed', 'canceled') NOT NULL,
    paid_at DATETIME(6) NULL,
    refunded_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (purchase_id),
    UNIQUE KEY purchases_checkout_session_unique (stripe_checkout_session_id),
    UNIQUE KEY purchases_payment_intent_unique (stripe_payment_intent_id),
    CONSTRAINT purchases_amount_check CHECK (amount_cents = 9800),
    CONSTRAINT purchases_currency_check CHECK (currency = 'usd')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stripe_events (
    stripe_event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload_sha256 BINARY(32) NOT NULL,
    processed_at DATETIME(6) NULL,
    processing_error TEXT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stripe_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS licenses (
    license_id CHAR(36) NOT NULL,
    purchase_id CHAR(36) NULL,
    source ENUM('purchase', 'owner_canary') NOT NULL DEFAULT 'purchase',
    license_secret_hash BINARY(32) NOT NULL,
    license_code_ciphertext LONGBLOB NULL,
    status ENUM('active', 'revoked', 'refunded') NOT NULL DEFAULT 'active',
    issued_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    revoked_at DATETIME(6) NULL,
    owner_canary_unique VARCHAR(16)
      GENERATED ALWAYS AS (IF(source = 'owner_canary', 'owner_canary', NULL)) STORED,
    PRIMARY KEY (license_id),
    UNIQUE KEY licenses_purchase_unique (purchase_id),
    UNIQUE KEY licenses_secret_hash_unique (license_secret_hash),
    UNIQUE KEY licenses_owner_canary_unique (owner_canary_unique),
    CONSTRAINT licenses_purchase_fk FOREIGN KEY (purchase_id)
      REFERENCES purchases (purchase_id),
    CONSTRAINT licenses_source_purchase_check CHECK (
      (source = 'purchase' AND purchase_id IS NOT NULL AND license_code_ciphertext IS NOT NULL)
      OR (source = 'owner_canary' AND purchase_id IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activations (
    activation_id CHAR(36) NOT NULL,
    license_id CHAR(36) NOT NULL,
    device_public_key BINARY(32) NOT NULL,
    activation_secret_hash BINARY(32) NOT NULL,
    platform ENUM('windows-x64', 'macos-universal') NOT NULL,
    status ENUM('active', 'deactivated') NOT NULL DEFAULT 'active',
    activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    deactivated_at DATETIME(6) NULL,
    active_license_id CHAR(36)
      GENERATED ALWAYS AS (IF(status = 'active', RTRIM(license_id), NULL)) STORED,
    PRIMARY KEY (activation_id),
    UNIQUE KEY activations_secret_hash_unique (activation_secret_hash),
    UNIQUE KEY activations_license_device_unique (license_id, device_public_key),
    UNIQUE KEY activations_one_active_device_unique (active_license_id),
    CONSTRAINT activations_license_fk FOREIGN KEY (license_id)
      REFERENCES licenses (license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS license_leases (
    lease_id CHAR(36) NOT NULL,
    activation_id CHAR(36) NOT NULL,
    issued_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    released_at DATETIME(6) NULL,
    active_activation_id CHAR(36)
      GENERATED ALWAYS AS (IF(released_at IS NULL, RTRIM(activation_id), NULL)) STORED,
    PRIMARY KEY (lease_id),
    UNIQUE KEY leases_one_active_unique (active_activation_id),
    CONSTRAINT leases_activation_fk FOREIGN KEY (activation_id)
      REFERENCES activations (activation_id),
    CONSTRAINT leases_window_check CHECK (expires_at > issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS license_deliveries (
    purchase_id CHAR(36) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    sending_at DATETIME(6) NULL,
    delivered_at DATETIME(6) NULL,
    last_error TEXT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (purchase_id),
    CONSTRAINT deliveries_purchase_fk FOREIGN KEY (purchase_id)
      REFERENCES purchases (purchase_id),
    CONSTRAINT deliveries_attempts_check CHECK (attempts >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS release_manifests (
    release_id CHAR(36) NOT NULL,
    channel ENUM('stable', 'canary') NOT NULL,
    target ENUM('windows', 'macos') NOT NULL,
    arch ENUM('x64', 'universal') NOT NULL,
    version VARCHAR(64) NOT NULL,
    asset_path VARCHAR(1024) NOT NULL,
    asset_sha256 BINARY(32) NOT NULL,
    signature TEXT NOT NULL,
    minimum_version VARCHAR(64) NULL,
    published_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (release_id),
    UNIQUE KEY release_version_unique (channel, target, arch, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refund_requests (
    request_id CHAR(36) NOT NULL,
    purchase_id CHAR(36) NOT NULL,
    reason_code VARCHAR(128) NOT NULL,
    status ENUM('received', 'approved', 'denied', 'completed') NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (request_id),
    CONSTRAINT refund_purchase_fk FOREIGN KEY (purchase_id)
      REFERENCES purchases (purchase_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telemetry_events (
    event_id CHAR(36) NOT NULL,
    anonymous_install_id CHAR(36) NOT NULL,
    event_name VARCHAR(128) NOT NULL,
    app_version VARCHAR(64) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    properties JSON NOT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
