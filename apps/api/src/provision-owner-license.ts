import { randomUUID, timingSafeEqual } from "node:crypto";
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
const databaseProvider = process.env.DATABASE_PROVIDER === "mysql" ? "mysql" : "postgres";

async function ownerLicenseCode(): Promise<string> {
  const file = process.env.OWNER_LICENSE_CODE_FILE;
  let value = file ? readFileSync(file, "utf8") : "";
  if (!file) {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
  }
  const normalized = value.trim().toUpperCase();
  if (!/^DTB-[A-Z0-9-]{12,80}$/.test(normalized)) {
    throw new Error("OWNER_LICENSE_CODE_FILE or stdin must contain one valid DayTradingBot code");
  }
  return normalized;
}

const licenseHash = hashLicenseSecret(pepper, await ownerLicenseCode());

function sameHash(existing: Buffer, candidate: Buffer): boolean {
  return existing.length === candidate.length && timingSafeEqual(existing, candidate);
}

type ProvisioningStatus = "created" | "already_exists" | "reactivated";

async function provisionPostgres(): Promise<ProvisioningStatus> {
  const pool = new PostgresPool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ license_id: string; license_secret_hash: Buffer; status: string }>(
      "SELECT license_id, license_secret_hash, status FROM licenses WHERE source = 'owner_canary' FOR UPDATE",
    );
    const row = existing.rows[0];
    let status: ProvisioningStatus;
    if (row) {
      if (!sameHash(row.license_secret_hash, licenseHash)) throw new Error("OWNER_LICENSE_CONFLICT");
      await client.query(
        "UPDATE licenses SET status = 'active', revoked_at = NULL WHERE license_id = $1",
        [row.license_id],
      );
      status = row.status === "active" ? "already_exists" : "reactivated";
    } else {
      await client.query(
        `INSERT INTO licenses (source, license_secret_hash, status)
         VALUES ('owner_canary', $1, 'active')`,
        [licenseHash],
      );
      status = "created";
    }
    await client.query("COMMIT");
    return status;
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
  license_secret_hash: Buffer;
  status: string;
}

async function provisionMySql(): Promise<ProvisioningStatus> {
  const pool = createMySqlPool(databaseUrl);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<OwnerLicenseRow[]>(
      "SELECT license_id, license_secret_hash, status FROM licenses WHERE source = 'owner_canary' FOR UPDATE",
    );
    const row = rows[0];
    let status: ProvisioningStatus;
    if (row) {
      if (!sameHash(row.license_secret_hash, licenseHash)) throw new Error("OWNER_LICENSE_CONFLICT");
      await connection.execute<ResultSetHeader>(
        "UPDATE licenses SET status = 'active', revoked_at = NULL WHERE license_id = ?",
        [row.license_id],
      );
      status = row.status === "active" ? "already_exists" : "reactivated";
    } else {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO licenses (license_id, source, license_secret_hash, status)
         VALUES (?, 'owner_canary', ?, 'active')`,
        [randomUUID(), licenseHash],
      );
      status = "created";
    }
    await connection.commit();
    return status;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

const status = databaseProvider === "mysql"
  ? await provisionMySql()
  : await provisionPostgres();
process.stdout.write(`${JSON.stringify({ status, source: "owner_canary" })}\n`);
