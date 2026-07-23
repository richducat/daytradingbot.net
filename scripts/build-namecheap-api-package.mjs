import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = path.join(root, "apps", "api");
const output = path.join(root, "artifacts", "namecheap-api");
const apiPackage = JSON.parse(await readFile(path.join(apiRoot, "package.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "database", "mysql"), { recursive: true });
await mkdir(path.join(output, "dist"), { recursive: true });

const productionModules = [
  "apply-mysql-migration.js",
  "commerce-mysql.js",
  "commerce.js",
  "config.js",
  "index.js",
  "licensing-mysql.js",
  "licensing.js",
  "provision-owner-license.js",
  "server.js",
  "verify-mysql-commercial.js",
  "webapp.js",
];
for (const moduleName of productionModules) {
  await cp(path.join(apiRoot, "dist", moduleName), path.join(output, "dist", moduleName));
}

await cp(
  path.join(root, "database", "mysql", "0001_commercial_schema.sql"),
  path.join(output, "database", "mysql", "0001_commercial_schema.sql"),
);
await cp(
  path.join(root, "deploy", "namecheap", "api", "0002_web_sessions_only.sql"),
  path.join(output, "database", "mysql", "0002_web_sessions_only.sql"),
);
await cp(
  path.join(root, "deploy", "namecheap", "api", "0003_remove_shared_host_trading.sql"),
  path.join(output, "database", "mysql", "0003_remove_shared_host_trading.sql"),
);
await cp(path.join(root, ".env.example"), path.join(output, ".env.example"));
await cp(
  path.join(root, "deploy", "namecheap", "api", "README.md"),
  path.join(output, "README.md"),
);
await cp(
  path.join(root, "deploy", "namecheap", "api", "recover-api-health.sh"),
  path.join(output, "recover-api-health.sh"),
);
await chmod(path.join(output, "recover-api-health.sh"), 0o755);

const productionPackage = {
  name: apiPackage.name,
  version: apiPackage.version,
  private: true,
  type: "module",
  engines: { node: ">=22 <23" },
  scripts: {
    start: "node dist/index.js",
    "migrate:mysql": "node dist/apply-mysql-migration.js",
    "verify:mysql": "node dist/verify-mysql-commercial.js",
  },
  dependencies: apiPackage.dependencies,
  overrides: apiPackage.overrides,
};

await writeFile(
  path.join(output, "package.json"),
  `${JSON.stringify(productionPackage, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${output}\n`);
