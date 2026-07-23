import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createConnection } from "mysql2/promise";

function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const path = process.env[`${name}_FILE`];
  if (path) return readFileSync(path, "utf8").trim();
  throw new Error(`${name} is required`);
}

const requested = process.argv[2];
const migrationName = requested ? basename(requested) : "";
if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(migrationName) || migrationName !== requested) {
  throw new Error("Pass one migration filename from database/mysql");
}

const migrationPath = resolve(process.cwd(), "database", "mysql", migrationName);
const sql = readFileSync(migrationPath, "utf8");
const connection = await createConnection({
  uri: secret("DATABASE_URL"),
  multipleStatements: true,
});

try {
  await connection.query(sql);
} finally {
  await connection.end();
}

process.stdout.write(`${JSON.stringify({ status: "applied", migration: migrationName })}\n`);
