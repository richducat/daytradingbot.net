import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { hashLicenseSecret } from "./licensing.js";

function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const path = process.env[`${name}_FILE`];
  if (path) return readFileSync(path, "utf8").trim();
  throw new Error(`${name} is required`);
}

const databaseUrl = secret("DATABASE_URL");
const pepper = secret("LICENSE_SECRET_PEPPER");
const licenseCode = `DTB-OWNER-${randomBytes(18).toString("hex").toUpperCase()}`;
const licenseHash = hashLicenseSecret(pepper, licenseCode);
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  const existing = await client.query<{ license_id: string }>(
    "SELECT license_id FROM licenses WHERE source = 'owner_canary' FOR UPDATE",
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE licenses
          SET license_secret_hash = $2, status = 'active', revoked_at = NULL
        WHERE license_id = $1`,
      [existing.rows[0].license_id, licenseHash],
    );
  } else {
    await client.query(
      `INSERT INTO licenses (source, license_secret_hash, status)
       VALUES ('owner_canary', $1, 'active')`,
      [licenseHash],
    );
  }
  await client.query("COMMIT");
  process.stdout.write(`${licenseCode}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
