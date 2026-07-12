BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE purchase_status AS ENUM ('pending', 'paid', 'refunded', 'disputed', 'canceled');
CREATE TYPE license_status AS ENUM ('active', 'revoked', 'refunded');
CREATE TYPE activation_status AS ENUM ('active', 'deactivated');

CREATE TABLE founder_inventory (
    inventory_key text PRIMARY KEY CHECK (inventory_key = 'founder-v1'),
    total_seats integer NOT NULL CHECK (total_seats = 10),
    reserved_seats integer NOT NULL DEFAULT 0 CHECK (reserved_seats BETWEEN 0 AND total_seats),
    sold_seats integer NOT NULL DEFAULT 0 CHECK (sold_seats BETWEEN 0 AND total_seats),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (reserved_seats + sold_seats <= total_seats)
);

INSERT INTO founder_inventory (inventory_key, total_seats) VALUES ('founder-v1', 10);

CREATE TABLE seat_reservations (
    reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_checkout_session_id text UNIQUE,
    email_hash bytea,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchases (
    purchase_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid UNIQUE REFERENCES seat_reservations(reservation_id),
    stripe_checkout_session_id text NOT NULL UNIQUE,
    stripe_payment_intent_id text UNIQUE,
    customer_email_ciphertext bytea NOT NULL,
    amount_cents integer NOT NULL CHECK (amount_cents = 9800),
    currency text NOT NULL CHECK (currency = 'usd'),
    status purchase_status NOT NULL,
    paid_at timestamptz,
    refunded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stripe_events (
    stripe_event_id text PRIMARY KEY,
    event_type text NOT NULL,
    payload_sha256 bytea NOT NULL,
    processed_at timestamptz,
    processing_error text,
    received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE licenses (
    license_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id uuid NOT NULL UNIQUE REFERENCES purchases(purchase_id),
    license_secret_hash bytea NOT NULL UNIQUE,
    status license_status NOT NULL DEFAULT 'active',
    issued_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE activations (
    activation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id uuid NOT NULL REFERENCES licenses(license_id),
    device_public_key bytea NOT NULL,
    platform text NOT NULL CHECK (platform IN ('windows-x64', 'macos-universal')),
    status activation_status NOT NULL DEFAULT 'active',
    activated_at timestamptz NOT NULL DEFAULT now(),
    deactivated_at timestamptz,
    UNIQUE (license_id, device_public_key)
);

CREATE UNIQUE INDEX one_active_device_per_license
    ON activations (license_id)
    WHERE status = 'active';

CREATE TABLE license_leases (
    lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    activation_id uuid NOT NULL REFERENCES activations(activation_id),
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    released_at timestamptz,
    CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX one_active_lease_per_activation
    ON license_leases (activation_id)
    WHERE released_at IS NULL;

CREATE TABLE release_manifests (
    release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel text NOT NULL CHECK (channel IN ('stable', 'canary')),
    target text NOT NULL CHECK (target IN ('windows', 'macos')),
    arch text NOT NULL CHECK (arch IN ('x64', 'universal')),
    version text NOT NULL,
    asset_path text NOT NULL,
    asset_sha256 bytea NOT NULL,
    signature text NOT NULL,
    minimum_version text,
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, target, arch, version)
);

CREATE TABLE refund_requests (
    request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id uuid NOT NULL REFERENCES purchases(purchase_id),
    reason_code text NOT NULL,
    status text NOT NULL CHECK (status IN ('received', 'approved', 'denied', 'completed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telemetry_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anonymous_install_id uuid NOT NULL,
    event_name text NOT NULL,
    app_version text NOT NULL,
    platform text NOT NULL,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(properties) = 'object')
);

COMMIT;

