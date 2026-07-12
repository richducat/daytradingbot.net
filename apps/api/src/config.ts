import { readFileSync } from "node:fs";
import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_SITE_URL: z.url().default("https://daytradingbot.net"),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_ID: z.string().min(1).optional(),
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

type Environment = Record<string, string | undefined>;

function secretValue(env: Environment, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;

  const path = env[`${name}_FILE`];
  if (!path) return undefined;

  return readFileSync(path, { encoding: "utf8" }).trim();
}

export function loadConfig(env: Environment = process.env): ApiConfig {
  return ConfigSchema.parse({
    NODE_ENV: env.NODE_ENV,
    API_HOST: env.API_HOST,
    API_PORT: env.API_PORT,
    DATABASE_URL: secretValue(env, "DATABASE_URL"),
    PUBLIC_SITE_URL: env.PUBLIC_SITE_URL,
    STRIPE_SECRET_KEY: secretValue(env, "STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: secretValue(env, "STRIPE_WEBHOOK_SECRET"),
    STRIPE_PRICE_ID: env.STRIPE_PRICE_ID,
  });
}

