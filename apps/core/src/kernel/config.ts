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
  /*
   * FD-8 — the triage advisor's gateway. ALL OPTIONAL and unset by default: with no key the desk
   * routes on its own keyword table and never makes a network call, which is the shipped behaviour
   * and the one every existing test sees. `TRIAGE_API_KEY` is a SECRET and belongs in `.env`
   * (gitignored) or the deploy environment — never in source, never in the browser bundle. The call
   * is made server-side for exactly that reason.
   *
   * ═══ FD-11 — THE GATEWAY IS GROQ NOW, AND THE DEFAULT MODEL WAS A LANDMINE ═══
   *
   * The owner moved the router off Omniroute. Nothing in the code named it — the client has always
   * been env-driven and OpenAI-shaped — EXCEPT this default, which was `auto/best-fast`: an
   * Omniroute routing alias that exists on no other provider. Setting only the URL and the key
   * would have left every call 404-ing, and the failure is SILENT by design: `suggestDepartments`
   * falls back to the keyword table on any error, so the desk would have looked like it worked
   * while the model was never once consulted. A default that is wrong everywhere except one vendor
   * is worse than no default.
   *
   * `openai/gpt-oss-120b` is MEASURED, not chosen from the docs — and the docs would have been
   * wrong: Groq's published production list leads with `llama-3.3-70b-versatile`, which this
   * account does not offer at all (`GET /models` returns 14 models and no llama chat model).
   *
   * Scored on the real triage prompt over twelve Hinglish complaints against the hospital's own
   * twelve departments, each case marked with the department a clerk would call correct:
   *
   *     groq   openai/gpt-oss-120b    12/12 top-1   median 620 ms   ← default
   *     groq   openai/gpt-oss-20b     11/12 top-1   median 469 ms   ("gala kharab hai" -> Orthopaedics)
   *     nvidia openai/gpt-oss-20b     11/12 top-1   median 6210 ms, p90 300 s
   *     nvidia nemotron-70b-instruct   HTTP 404 — listed by /models, not served on the key
   *
   * The 20b was the first default and it is wrong about a sore throat, sending it to Orthopaedics
   * instead of ENT. 150 ms is a cheap price for that, and with `triage-cache.ts` in front it is
   * paid once per distinct complaint rather than once per patient.
   *
   * NVIDIA (build.nvidia.com) is FREE and cannot serve this path: same model, same answers, but a
   * 6.2 s median and a 300 s p90 against a 6 s budget means it would time out into the keyword
   * table more often than not. Its only honest use here is off the counter's critical path.
   */
  TRIAGE_BASE_URL: z.string().url().optional(),
  TRIAGE_API_KEY: z.string().min(1).optional(),
  TRIAGE_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  /*
   * Omniroute measured 22-34 s and often over 40, which is what put this timeout here: a counter
   * cannot wait, so the budget is short and a timeout is an ORDINARY outcome — the keyword table
   * answers. Groq measured 478 ms median / 488 ms max on the same prompt, so 6 s is now ~12x the
   * worst observed call rather than a guillotine. It stays at 6 s deliberately: the number exists
   * for the bad network day, not for the good one.
   */
  TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
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
  // Plan 11c D6 — the TENTH job's cadence: how often `sweepInterfaceHeartbeats` looks for a device
  // that has gone quiet. Defaulted, like every `WORKER_*_INTERVAL_MS` above and for the same B1
  // scar: this schema is parsed through the WHOLE environment by every caller of `loadConfig()`,
  // so a key that required a value would break every deployment and every CI job that has no .env
  // entry for it. NO .env CHANGE IS NEEDED ANYWHERE for this plan.
  //
  // A PLAIN POSITIVE INT, deliberately NOT the `RETENTION_ENABLED` two-string-enum shape. That
  // spelling exists because `z.coerce.boolean()` reads "false" as TRUE; there is no analogous trap
  // in a number, and copying the enum here would be cargo cult. 60 000 is one minute: the smallest
  // per-device window an operator may set is 30 s (`INTERFACE_STALE_AFTER_MIN_MS`), so a slower
  // grid than this would make the shortest legal window unobservable, and a faster one would spend
  // reads on a registry that changes at human speed.
  //
  // WHERE THIS KEY DEMONSTRABLY TAKES EFFECT (GC10, the NOTIFY_STUCK_AFTER_MS scar) is
  // `kernel/worker/jobs.ts`'s registration, asserted in `worker/jobs.test.ts` (Book V12) with a
  // value that is NOT this default. Asserting that it PARSES would discharge nothing.
  WORKER_INTERFACE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  // PLAN 17a T5 / DD20 — how often the lab SLA sweep looks. 60 000 rather than the obvious five
  // minutes, and `docker/prod/prometheus/alerts.yml` leg 1a is the reason: it thresholds every
  // INTERVAL job at 300 s staleness, so a 300 000 ms job pages the on-call the first time it is one
  // tick late, for ever. Plan 15 T4 chose 60 000 for the same constraint and recorded the same
  // reasoning; widening a live production alert to suit a new job is the wrong trade.
  WORKER_LAB_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  /**
   * PLAN 11h T9 — THE ONE CHOKE MODULE'S CONFIGURATION (deferred note 5, owner ruling 2026-08-25).
   *
   * All three default to EMPTY and the path is inert unless all three are set — the B1 scar again:
   * this schema is parsed through the whole environment by every caller of `loadConfig()`, so a key
   * that required a value would break every deployment and every CI job at once. CI sets none of
   * them, which is exactly the intent: **CI must never contact a provider.**
   *
   * These name a PROVIDER, not an architecture. Note 5 requires the router and the voice path to
   * land behind a single choke module that becomes 12a's `InferenceClient`, so this is the only
   * place in the codebase that will ever hold an outbound AI credential.
   */
  /**
   * PLAN 11h CLOSE / DD8 — the per-actor search rate limit. Both defaulted (the B1 scar), so no
   * .env changes anywhere. See `kernel/search/rate-limit.ts` for why these numbers.
   */
  SEARCH_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  SEARCH_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  SPEECH_PROVIDER: z.enum(["", "workers-ai"]).default(""),
  SPEECH_ACCOUNT_ID: z.string().default(""),
  SPEECH_API_TOKEN: z.string().default(""),
  /**
   * ═══ FD-12 — THE ABDM (ABHA) GATEWAY SEAM ═══
   *
   * All three default to EMPTY and the ABHA creation/verification path is INERT unless all three
   * are set — the same B1 discipline as the block above, and for the same reason: this schema is
   * parsed through the whole environment by every caller of `loadConfig()`, so a key that demanded
   * a value would break every deployment and every CI job at once. **CI must never contact ABDM.**
   *
   * WHAT IS AND IS NOT GATED BY THESE. Recording an ABHA number the patient reads off their phone
   * needs no gateway and works today at `self_declared` — that is ordinary data capture and it is
   * the common case at an Indian counter. What needs ABDM is CREATING an ABHA and VERIFYING one by
   * OTP, because only the gateway can do either. The screen asks `GET /patients/abha/capability`
   * and says plainly which of the two it is offering, rather than showing a button that fails.
   *
   * These are unset everywhere today: obtaining them is an ABDM registration the hospital must
   * make (owner/procurement), not something this lane can decide.
   */
  ABDM_BASE_URL: z.string().default(""),
  ABDM_CLIENT_ID: z.string().default(""),
  ABDM_CLIENT_SECRET: z.string().default(""),
  /**
   * PLAN 09 / DD14 — THE FIVE STRUCTURAL-OFF FLAGS. Every one DEFAULTED, every one a two-string
   * enum, and neither of those is a style choice.
   *
   * DEFAULTED because of the B1 scar: this schema is parsed through the WHOLE environment by every
   * caller of `loadConfig()`, so a key that required a value would break every deployment and every
   * CI job that has no `.env` entry for it. **No .env change is needed anywhere for this plan.**
   *
   * `z.enum(["true","false"])` AND NEVER `z.coerce.boolean()`, which reads the string "false" as
   * TRUE (a non-empty string is truthy) — so the one value an operator would most plausibly write
   * to keep a lane OFF would have switched it on. Anything else — "1", "yes", "TRUE" — fails config
   * parsing loudly at boot rather than being guessed at in either direction. `RETENTION_ENABLED`
   * above is the shipped precedent and this is the same spelling deliberately.
   *
   * WHAT EACH ONE IS OFF FOR, and WHICH GATE LIFTS IT — the mapping is stated once, here, and
   * nowhere else (DD14/O-8):
   */
  /** Selling an instrument at the hospital counter. OFF by the standing ruling that sales open
   *  NEXT phase; E-32's guardrails ship with this plan regardless. Lifted by the owner when the
   *  sale lane opens. */
  MEMBERSHIP_SALES_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Composing the two membership `AdjustmentSource`s into `priceDraft` (DD2). OFF until DD8's
   *  ORDERED flip has run — recognition deployed, import run, reconcile queue cleared — because a
   *  counter discount cannot be backfilled, so arming benefits before recognition is live means
   *  refusing a paying member or honouring off-system. Not a legal gate: an operational ordering. */
  MEMBER_BENEFITS_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Whether the accrual consumer WRITES payable rows (DD7). The consumer registers and advances
   *  its cursor either way — that is the whole point — so this flag decides writes, never delivery.
   *  Lifted only by the owner, on CA/counsel register items 2 and 3 (O-8, NOT ruled this phase). */
  COMMISSION_ACCRUAL_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Receivable expectation creation and statement matching. Lifted by the owner on CA/counsel
   *  register item 2 (O-8). */
  RECEIVABLE_COMMISSION_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Issuing NEW coupon codes (campaign creation). Redeeming an already-issued coupon is ON and
   *  unflagged. Lifted by the owner on CA/counsel register item 5 and the advertising rules (O-8). */
  COUPON_ISSUANCE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
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
  /** FD-8 — the triage advisor. `baseUrl`/`apiKey` null ⇒ the desk uses its own keyword table only. */
  triage: { baseUrl: string | null; apiKey: string | null; model: string; timeoutMs: number };
  notifyStuckAfterMs: number;
  // Plan 11a D6/D7. `retentionEnabled` is FALSE unless an operator says otherwise, in as many
  // letters; `worker/jobs.ts` threads all three into `retentionSweep` through the registration,
  // which is where Global Constraint 14 is discharged rather than at the parse.
  retentionEnabled: boolean;
  retentionEventsMonths: number;
  notifyRetainDays: number;
  // Plan 11c D6. Reaches `sweepInterfaceHeartbeats` — the tenth job — through `worker/jobs.ts`'s
  // registration and nowhere else, which is where GC10 is discharged rather than at the parse.
  workerInterfaceSweepIntervalMs: number;
  workerLabSweepIntervalMs: number;
  searchRateLimit: number;
  searchRateWindowSec: number;
  speechProvider: "" | "workers-ai";
  speechAccountId: string;
  speechApiToken: string;
  /**
   * FD-12 — the ABDM (ABHA) gateway. Shaped like `triage` above because it is the same kind of
   * thing: an external provider whose absence is a NORMAL state, not a misconfiguration. All three
   * null ⇒ the counter can still RECORD an ABHA the patient reads out, and cannot create or verify
   * one. `modules/patients/abdm.ts` is the only reader.
   */
  abdm: { baseUrl: string | null; clientId: string | null; clientSecret: string | null };
  /**
   * Plan 09 / DD14. All five FALSE unless an operator says otherwise, in as many letters. Where
   * each one takes effect is its own task's business — `priceDraft` for benefits (T4), the accrual
   * handler for the two commission flags (T6/T7) — and that is where the take-effect legs live,
   * not at the parse (GC10, the NOTIFY_STUCK_AFTER_MS scar).
   */
  membershipSalesEnabled: boolean;
  memberBenefitsEnabled: boolean;
  commissionAccrualEnabled: boolean;
  receivableCommissionEnabled: boolean;
  couponIssuanceEnabled: boolean;
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
    triage: {
      baseUrl: parsed.TRIAGE_BASE_URL ?? null,
      apiKey: parsed.TRIAGE_API_KEY ?? null,
      model: parsed.TRIAGE_MODEL,
      timeoutMs: parsed.TRIAGE_TIMEOUT_MS,
    },
    notifyStuckAfterMs: parsed.NOTIFY_STUCK_AFTER_MS,
    retentionEnabled: parsed.RETENTION_ENABLED,
    retentionEventsMonths: parsed.RETENTION_EVENTS_MONTHS,
    notifyRetainDays: parsed.NOTIFY_RETAIN_DAYS,
    workerInterfaceSweepIntervalMs: parsed.WORKER_INTERFACE_SWEEP_INTERVAL_MS,
    workerLabSweepIntervalMs: parsed.WORKER_LAB_SWEEP_INTERVAL_MS,
    searchRateLimit: parsed.SEARCH_RATE_LIMIT,
    searchRateWindowSec: parsed.SEARCH_RATE_WINDOW_SEC,
    abdm: {
      baseUrl: parsed.ABDM_BASE_URL === "" ? null : parsed.ABDM_BASE_URL,
      clientId: parsed.ABDM_CLIENT_ID === "" ? null : parsed.ABDM_CLIENT_ID,
      clientSecret: parsed.ABDM_CLIENT_SECRET === "" ? null : parsed.ABDM_CLIENT_SECRET,
    },
    speechProvider: parsed.SPEECH_PROVIDER,
    speechAccountId: parsed.SPEECH_ACCOUNT_ID,
    speechApiToken: parsed.SPEECH_API_TOKEN,
    membershipSalesEnabled: parsed.MEMBERSHIP_SALES_ENABLED,
    memberBenefitsEnabled: parsed.MEMBER_BENEFITS_ENABLED,
    commissionAccrualEnabled: parsed.COMMISSION_ACCRUAL_ENABLED,
    receivableCommissionEnabled: parsed.RECEIVABLE_COMMISSION_ENABLED,
    couponIssuanceEnabled: parsed.COUPON_ISSUANCE_ENABLED,
  };
}
