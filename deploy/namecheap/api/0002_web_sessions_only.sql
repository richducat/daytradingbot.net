-- Browser access sessions for the shared-hosted licensing API.
-- Brokerage and trading data must remain on the customer's device.

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
