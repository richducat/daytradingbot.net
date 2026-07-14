import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPool as createMySqlPool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { Pool as PostgresPool } from "pg";
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
const databaseProvider = process.env.DATABASE_PROVIDER === "mysql" ? "mysql" : "postgres";

async function provisionPostgres(): Promise<void> {
  const pool = new PostgresPool({ connectionString: databaseUrl });
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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

interface OwnerLicenseRow extends RowDataPacket {
  license_id: string;
}

async function provisionMySql(): Promise<void> {
  const pool = createMySqlPool(databaseUrl);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<OwnerLicenseRow[]>(
      "SELECT license_id FROM licenses WHERE source = 'owner_canary' FOR UPDATE",
    );
    if (rows[0]) {
      await connection.execute<ResultSetHeader>(
        `UPDATE licenses
            SET license_secret_hash = ?, status = 'active', revoked_at = NULL
          WHERE license_id = ?`,
        [licenseHash, rows[0].license_id],
      );
    } else {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO licenses (license_id, source, license_secret_hash, status)
         VALUES (?, 'owner_canary', ?, 'active')`,
        [randomUUID(), licenseHash],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

if (databaseProvider === "mysql") {
  await provisionMySql();
} else {
  await provisionPostgres();
}
process.stdout.write(`${licenseCode}\n`);
