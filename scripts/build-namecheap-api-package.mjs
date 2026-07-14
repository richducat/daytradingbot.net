import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = path.join(root, "apps", "api");
const output = path.join(root, "artifacts", "namecheap-api");
const apiPackage = JSON.parse(await readFile(path.join(apiRoot, "package.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "database", "mysql"), { recursive: true });
await cp(path.join(apiRoot, "dist"), path.join(output, "dist"), { recursive: true });
await cp(
  path.join(root, "database", "mysql"),
  path.join(output, "database", "mysql"),
  { recursive: true },
);
await cp(path.join(root, ".env.example"), path.join(output, ".env.example"));
await cp(
  path.join(root, "deploy", "namecheap", "api", "README.md"),
  path.join(output, "README.md"),
);

const productionPackage = {
  name: apiPackage.name,
  version: apiPackage.version,
  private: true,
  type: "module",
  engines: { node: ">=22 <23" },
  scripts: {
    start: "node dist/index.js",
    "run:web-worker": "node dist/run-worker.js",
    "verify:mysql": "node dist/verify-mysql-commercial.js",
  },
  dependencies: apiPackage.dependencies,
};

await writeFile(
  path.join(output, "package.json"),
  `${JSON.stringify(productionPackage, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${output}\n`);
