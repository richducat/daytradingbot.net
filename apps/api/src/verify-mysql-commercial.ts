import {
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import assert from "node:assert/strict";
import { createPool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { MySqlCommerceRepository } from "./commerce-mysql.js";
import { MySqlLicenseRepository } from "./licensing-mysql.js";
import { LicenseService } from "./licensing.js";
import { MySqlWebAppRepository } from "./webapp.js";

interface LicenseStatusRow extends RowDataPacket {
  status: string;
}

interface TableNameRow extends RowDataPacket {
  table_name: string;
}

const forbiddenSharedHostTables = [
  "web_oauth_states",
  "web_real_authorizations",
  "web_trade_fills",
  "web_trade_intents",
  "web_trading_activity",
  "web_trading_connections",
  "web_trading_settings",
  "web_worker_status",
] as const;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const parsed = new URL(databaseUrl);
const pool = createPool({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 3306,
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  timezone: "Z",
  connectionLimit: 2,
});
const suffix = randomBytes(12).toString("hex");
const sessionId = `cs_test_${suffix}`;
const paymentIntentId = `pi_test_${suffix}`;
const encryptionKey = randomBytes(32).toString("base64url");
const pepper = randomBytes(32).toString("base64url");
let purchaseId: string | undefined;

try {
  const [forbiddenTables] = await pool.query<TableNameRow[]>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (${forbiddenSharedHostTables.map(() => "?").join(", ")})`,
    [...forbiddenSharedHostTables],
  );
  assert.deepEqual(
    forbiddenTables.map((row) => row.table_name).sort(),
    [],
    "shared hosting still contains retired brokerage or trading tables",
  );

  const commerce = new MySqlCommerceRepository(pool, encryptionKey, pepper);
  const first = await commerce.provisionPaidPurchase({
    sessionId,
    paymentIntentId,
    customerEmail: `launch-check-${suffix}@example.com`,
    amountCents: 9_800,
    currency: "usd",
  });
  purchaseId = first.purchaseId;
  const repeated = await commerce.provisionPaidPurchase({
    sessionId,
    paymentIntentId,
    customerEmail: `launch-check-${suffix}@example.com`,
    amountCents: 9_800,
    currency: "usd",
  });
  assert.equal(repeated.purchaseId, first.purchaseId);
  assert.equal(repeated.activationCode, first.activationCode);

  assert.equal(await commerce.claimLicenseDelivery(first.purchaseId), "send");
  assert.equal(await commerce.claimLicenseDelivery(first.purchaseId), "busy");
  await commerce.markLicenseDelivered(first.purchaseId);
  assert.equal(await commerce.claimLicenseDelivery(first.purchaseId), "sent");

  const { privateKey } = generateKeyPairSync("ed25519");
  const licensing = new LicenseService(
    new MySqlLicenseRepository(pool),
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pepper,
  );
  const devicePublicKey = randomBytes(32).toString("base64url");
  const activation = await licensing.activate({
    licenseCode: first.activationCode,
    devicePublicKey,
    platform: "macos-universal",
  });
  assert.ok(activation.activationToken);
  const renewed = await licensing.renew({
    activationToken: activation.activationToken,
    devicePublicKey,
  });
  assert.equal(renewed.signedLease.claims.license_id, activation.signedLease.claims.license_id);

  const browser = new MySqlWebAppRepository(
    pool,
    randomBytes(32).toString("base64url"),
    pepper,
  );
  const browserSession = await browser.createSession(first.activationCode);
  const authenticated = await browser.authenticate(browserSession.sessionToken);
  assert.equal(authenticated.licenseId, activation.signedLease.claims.license_id);
  await browser.revokeSession(authenticated.sessionId);

  await commerce.markPurchaseByPaymentIntent(paymentIntentId, "refunded");
  const [rows] = await pool.execute<LicenseStatusRow[]>(
    "SELECT status FROM licenses WHERE purchase_id = ?",
    [first.purchaseId],
  );
  assert.equal(rows[0]?.status, "refunded");
  process.stdout.write("MariaDB commerce, browser session, activation, renewal, delivery, and refund flow verified.\n");
} finally {
  if (purchaseId) {
    await pool.execute(
      `DELETE s FROM web_sessions s
       JOIN licenses l ON l.license_id = s.license_id
       WHERE l.purchase_id = ?`,
      [purchaseId],
    );
    await pool.execute(
      `DELETE ll FROM license_leases ll
       JOIN activations a ON a.activation_id = ll.activation_id
       JOIN licenses l ON l.license_id = a.license_id
       WHERE l.purchase_id = ?`,
      [purchaseId],
    );
    await pool.execute(
      `DELETE a FROM activations a
       JOIN licenses l ON l.license_id = a.license_id
       WHERE l.purchase_id = ?`,
      [purchaseId],
    );
    await pool.execute("DELETE FROM license_deliveries WHERE purchase_id = ?", [purchaseId]);
    await pool.execute("DELETE FROM licenses WHERE purchase_id = ?", [purchaseId]);
    await pool.execute("DELETE FROM purchases WHERE purchase_id = ?", [purchaseId]);
  }
  await pool.end();
}
