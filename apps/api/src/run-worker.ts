import { readFile } from "node:fs/promises";

const WORKER_PATH = "/v1/internal/run-due-trading-cycles";

async function secretFromFile(): Promise<string> {
  const path = process.env.WORKER_SECRET_FILE;
  if (!path) throw new Error("WORKER_SECRET_FILE is required");
  const secret = (await readFile(path, "utf8")).trim();
  if (secret.length < 32) throw new Error("The worker secret is invalid");
  return secret;
}

async function run(): Promise<void> {
  const origin = new URL(process.env.PUBLIC_API_URL ?? "https://api.daytradingbot.net");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") {
    throw new Error("PUBLIC_API_URL must be a bare HTTPS origin");
  }
  const response = await fetch(new URL(WORKER_PATH, origin), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${await secretFromFile()}` },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`Browser trading worker returned HTTP ${response.status}`);
  const payload = await response.json() as { claimed?: unknown; completed?: unknown; failed?: unknown };
  if (![payload.claimed, payload.completed, payload.failed].every(Number.isInteger)) {
    throw new Error("Browser trading worker returned an invalid response");
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Browser trading worker failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
