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

/** Plan 10 D11: the enum widens when a real provider lands; a new member's config key becomes
 * required-only-when-selected via a zod refinement at that point, not here. */
const notifyProviderSchema = z.enum(["console"]);
export type NotifyProvider = z.infer<typeof notifyProviderSchema>;

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
  // Plan 10 (notifications gateway). All three defaulted — the B1 scar: this schema is parsed
  // through the WHOLE environment by every caller of loadConfig(), so nothing added here may
  // require a value or a new .env entry anywhere (server or CI).
  WORKER_NOTIFY_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  NOTIFY_PROVIDER: notifyProviderSchema.default("console"),
  NOTIFY_STUCK_AFTER_MS: z.coerce.number().int().positive().default(300000),
  // Plan 11a D6/D7 (retention). All three defaulted, same B1 scar as the block above: no .env
  // entry is required anywhere, on the server or in CI.
  //
  // RETENTION_ENABLED DEFAULTS TO FALSE AND THE MECHANISM SHIPS INERT (Global Constraint 5, owner
  // ruling 6): the sweep drops whole months of clinical records, and the owner flips this only
  // with a window counsel has signed. Changing this default is on the plan's HALT list.
  //
  // IT IS AN ENUM OF TWO EXACT STRINGS, NOT `z.coerce.boolean()`, and that is the whole reason it
  // is spelled out: `z.coerce.boolean()` reads the string "false" as TRUE (a non-empty string is
  // truthy), so the one value an operator would most plausibly write to keep retention off would
  // have switched it on. Anything other than "true" or "false" — "1", "yes", "TRUE" — fails
  // config parsing loudly at boot rather than being guessed at in either direction.
  RETENTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RETENTION_EVENTS_MONTHS: z.coerce.number().int().positive().default(120),
  NOTIFY_RETAIN_DAYS: z.coerce.number().int().positive().default(180),
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
  workerNotifyIntervalMs: number;
  notifyProvider: NotifyProvider;
  notifyStuckAfterMs: number;
  // Plan 11a D6/D7. `retentionEnabled` is FALSE unless an operator says otherwise, in as many
  // letters; `worker/jobs.ts` threads all three into `retentionSweep` through the registration,
  // which is where Global Constraint 14 is discharged rather than at the parse.
  retentionEnabled: boolean;
  retentionEventsMonths: number;
  notifyRetainDays: number;
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
    workerNotifyIntervalMs: parsed.WORKER_NOTIFY_INTERVAL_MS,
    notifyProvider: parsed.NOTIFY_PROVIDER,
    notifyStuckAfterMs: parsed.NOTIFY_STUCK_AFTER_MS,
    retentionEnabled: parsed.RETENTION_ENABLED,
    retentionEventsMonths: parsed.RETENTION_EVENTS_MONTHS,
    notifyRetainDays: parsed.NOTIFY_RETAIN_DAYS,
  };
}
