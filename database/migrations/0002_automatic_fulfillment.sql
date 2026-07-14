BEGIN;

ALTER TABLE licenses
    ADD COLUMN license_code_ciphertext bytea;

ALTER TABLE licenses
    ADD CONSTRAINT purchase_license_has_delivery_copy CHECK (
        source <> 'purchase' OR license_code_ciphertext IS NOT NULL
    ) NOT VALID;

CREATE TABLE license_deliveries (
    purchase_id uuid PRIMARY KEY REFERENCES purchases(purchase_id),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    sending_at timestamptz,
    delivered_at timestamptz,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
