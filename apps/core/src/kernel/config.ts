import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

let envLoaded = false;

/** Loads <cwd>/.env once. Existing process.env values always win (CI stays authoritative). */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const candidate = resolve(process.cwd(), ".env");
  if (!existsSync(candidate)) return;
  const parsed = parseEnv(readFileSync(candidate, "utf8")) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  SECRET_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "SECRET_KEY must be 64 lowercase hex chars (32 bytes)"),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
  SECOND_FACTOR_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),
  BREAK_GLASS_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  TEMP_ROLE_MAX_TTL_MINUTES: z.coerce.number().int().positive().default(720),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  secretKey: Buffer;
  sessionTtlMinutes: number;
  secondFactorWindowMinutes: number;
  breakGlassTtlMinutes: number;
  tempRoleMaxTtlMinutes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadEnv();
  const parsed = configSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    secretKey: Buffer.from(parsed.SECRET_KEY, "hex"),
    sessionTtlMinutes: parsed.SESSION_TTL_MINUTES,
    secondFactorWindowMinutes: parsed.SECOND_FACTOR_WINDOW_MINUTES,
    breakGlassTtlMinutes: parsed.BREAK_GLASS_TTL_MINUTES,
    tempRoleMaxTtlMinutes: parsed.TEMP_ROLE_MAX_TTL_MINUTES,
  };
}
