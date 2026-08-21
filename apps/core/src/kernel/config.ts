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
  // 2x the slowest INTERVAL job's cadence, NOT 2x the daily jobs': a daily job that has not
  // run since yesterday must never make the worker read stale (D7/D9). Defaulted here so no
  // .env changes anywhere — the hard-fail-on-missing rule is untouched, nothing new is required.
  WORKER_STALE_AFTER_MS: z.coerce.number().int().positive().default(60000),
  // D9: the six sweeps' cadences. Every key defaults in this schema, so no .env change is
  // needed anywhere (server or CI) — Plan 08.5 flag 8. The daily jobs' IST clock instants
  // (guardians 00:05 / no-shows 23:55 / daily-close 23:59) are CODE CONSTANTS beside their
  // registration in kernel/worker/jobs.ts, not config: design decisions from the roadmap, not
  // deployment knobs.
  WORKER_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_TIMERS_INTERVAL_MS: z.coerce.number().int().positive().default(20000),
  WORKER_TEMP_ROLES_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  WORKER_DAILY_TICK_MS: z.coerce.number().int().positive().default(30000),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  secretKey: Buffer;
  sessionTtlMinutes: number;
  secondFactorWindowMinutes: number;
  breakGlassTtlMinutes: number;
  tempRoleMaxTtlMinutes: number;
  workerStaleAfterMs: number;
  workerDispatchIntervalMs: number;
  workerTimersIntervalMs: number;
  workerTempRolesIntervalMs: number;
  workerDailyTickMs: number;
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
    workerStaleAfterMs: parsed.WORKER_STALE_AFTER_MS,
    workerDispatchIntervalMs: parsed.WORKER_DISPATCH_INTERVAL_MS,
    workerTimersIntervalMs: parsed.WORKER_TIMERS_INTERVAL_MS,
    workerTempRolesIntervalMs: parsed.WORKER_TEMP_ROLES_INTERVAL_MS,
    workerDailyTickMs: parsed.WORKER_DAILY_TICK_MS,
  };
}
