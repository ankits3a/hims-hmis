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
/**
 * PHASE O T4 — A SECOND PROVIDER KNOB, BECAUSE PUSH NEEDS NOTHING BOUGHT. WhatsApp and SMS wait
 * on a BSP contract and a DLT header; Chrome push needs three generated keys and is the channel
 * RO-4 asked for first. One knob would have made the hospital wait for the purchases.
 */
const notifyPushProviderSchema = z.enum(["console", "webpush"]);
export type NotifyPushProvider = z.infer<typeof notifyPushProviderSchema>;

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
  /**
   * ═══ WHERE A PHOTOGRAPHED SLIP'S BYTES LIVE ═══
   *
   * Owner ruling, 2026-09-14: disk now, Cloudflare R2 or S3 later. The DEFAULT is a path beside the
   * database's own data rather than inside the repo, because a document written into a checkout is
   * a document lost at the next deploy — and it is a path an operator can mount, back up and move,
   * which is the whole point of it not being in Postgres.
   *
   * This is NOT a secret and belongs in the deploy environment. When the object-store adapter
   * arrives it takes its own keys; this one stays for the disk fallback.
   */
  DOCUMENT_STORE_PATH: z.string().trim().min(1).default("/var/lib/hmis/documents"),
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
  NOTIFY_PUSH_PROVIDER: notifyPushProviderSchema.default("console"),
  /**
   * PHASE O T4 — the channel ladder's cadence. A minute, not five: the `now` lane's patience is
   * five minutes, and a sweep that ran every five could spend the whole of it before noticing.
   */
  WORKER_REACH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().default(""),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().default(""),
  /** `mailto:` or an https URL — the push services require a way to contact the sender. */
  WEB_PUSH_VAPID_SUBJECT: z.string().default(""),
  /*
   * PHASE 11i T3 (§2b row 22) — WHICH BOX AM I LOOKING AT.
   *
   * UAT runs the PRODUCTION image against a different database, on the same host, behind a Caddy
   * that serves the same SPA. Two browser tabs, identical in every pixel, one of which must never
   * hold a real person. A receptionist being trained on UAT who registers the patient standing in
   * front of them has created a record in the wrong hospital, and nothing on either screen would
   * have told them.
   *
   * Optional and EMPTY BY DEFAULT: production's environment file never sets it and
   * `deploy-parity.test.ts` asserts the production template does not carry the key. So the banner
   * is not something production turns off — it is something only a non-production deployment can
   * turn ON, which is the only direction that fails safe.
   */
  HMIS_ENVIRONMENT_LABEL: z.string().trim().max(24).default(""),
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
  /*
   * TRIAGE'S FIRST MODEL: TYPESAFE (owner, 2026-09-19 — "priority", the chat model above its
   * fallback). Its own keys rather than the copilot's, for the reason the COPILOT_* block gives: two
   * jobs that happen to share a provider, which a hospital may want on and off separately. All
   * optional; unset, triage runs exactly as before. `modules/opd/triage-choice.ts` carries the
   * measurement behind the model version and the 0.6 line.
   */
  TRIAGE_TYPESAFE_API_KEY: z.string().min(1).optional(),
  TRIAGE_TYPESAFE_BASE_URL: z.string().url().default("https://api.typesafe.ai/v1"),
  TRIAGE_TYPESAFE_MODEL: z.string().min(1).default("jev-1.13.0"),
  TRIAGE_TYPESAFE_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  TRIAGE_TYPESAFE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  /**
   * ═══ FD-COPILOT — THE DESK COPILOT'S INTENT ROUTER ═══
   *
   * Its own keys rather than a reuse of `TRIAGE_*`, because the two are different jobs that happen
   * to speak the same protocol: triage suggests a department to a clerk who can overrule it, and
   * this decides which TOOL runs against a patient's record. A hospital may reasonably want one on
   * and the other off, or the same model at two different budgets, and one shared key would make
   * that a code change.
   *
   * ALL FOUR DEFAULTED OR OPTIONAL — the B1 scar the blocks above and below carry: no `.env` entry
   * is required anywhere, on the server or in CI, and with `COPILOT_BASE_URL`/`COPILOT_API_KEY`
   * unset the copilot answers from its phrasebook alone and the desk never learns the difference
   * except in the long tail of phrasings.
   *
   * Measured on this box, 2026-09-17, on the real routing prompt over eight counter questions in
   * English, Hinglish and Devanagari, including the owner's own two:
   *
   *     groq  openai/gpt-oss-120b   8/8 correct   356-571 ms   ← default
   *
   * Cheaper than triage per call: the prompt is a menu of five tool names and one masked sentence,
   * and the reply is a dozen tokens. Only a question the phrasebook misses is ever sent, so spend
   * is proportional to novelty rather than to traffic.
   */
  COPILOT_BASE_URL: z.string().url().optional(),
  COPILOT_API_KEY: z.string().min(1).optional(),
  COPILOT_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  /*
   * SHORTER THAN TRIAGE'S SIX SECONDS, and deliberately. Triage runs while a clerk is still typing
   * a complaint and has something else to look at; this runs after they have pressed Enter and are
   * watching an empty answer box. 3 s is ~5x the worst call observed above, and a miss is an
   * ordinary outcome — the desk says it did not understand, which is true and instant.
   */
  COPILOT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /*
   * ═══ THE COPILOT'S FIRST MODEL: TYPESAFE (owner, 2026-09-19 — "priority", the chat model above
   * is its fallback) ═══
   *
   * A classifier handed the tool menu itself: it returns one of the tools, or "none", and how sure
   * it is. `kernel/copilot/choice-route.ts` carries the measurement. Same B1 scar as every block
   * here: no key is required anywhere, and with COPILOT_TYPESAFE_API_KEY unset the router runs
   * exactly as it did before this block existed.
   *
   * THE MODEL IS A VERSION, NEVER AN ALIAS. `jev-latest` moves when the vendor ships, and the
   * confidence line below was measured against 1.13.0 — moving is a config change made on purpose,
   * after re-measuring.
   *
   * TIMEOUT 1 s: p90 was 350 ms on a warm connection and ~680 ms cold. It is shorter than the chat
   * model's 3 s because the chat model is still behind it — a slow classifier must leave the clerk
   * time for the fallback, not spend it.
   *
   * MIN CONFIDENCE 0.6: at or above it, 61 of 64 counter questions were answered and none wrong;
   * below it, the question goes to the chat model.
   */
  COPILOT_TYPESAFE_API_KEY: z.string().min(1).optional(),
  COPILOT_TYPESAFE_BASE_URL: z.string().url().default("https://api.typesafe.ai/v1"),
  COPILOT_TYPESAFE_MODEL: z.string().min(1).default("jev-1.13.0"),
  COPILOT_TYPESAFE_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  COPILOT_TYPESAFE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
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
   * ABDM S0 — the rest of what the connector needs (plan 2026-09-25-abdm-connector.md §3). The same
   * B1 discipline: every key DEFAULTS, so an environment that names none of them parses and the
   * connector is OFF. `ABDM_BASE_URL` above keeps its name and is the HIE-CM GATEWAY base.
   *
   *   ABDM_BASE_URL          gateway: sandbox https://dev.abdm.gov.in/api/hiecm · production
   *                          https://apis.abdm.gov.in/api/hiecm (NHA wrapper application-v3.properties)
   *   ABDM_ABHA_BASE_URL     the ABHA (M1) API base — S1's, optional here
   *   ABDM_CM_ID             `X-CM-ID`: `sbx` (sandbox, the default) | `abdm` (production) — NHA wrapper
   *                          README. EMPTY reads as the default; anything else fails at boot.
   *   ABDM_HIP_ID            this hospital's HFR facility id, sent as `X-HIP-ID`
   *   ABDM_HIU_ID            optional — the HIU id, once M3 is on
   *   ABDM_CALLBACK_BASE_URL the bridge URL registered with ABDM: https://<host>/api/abdm/callbacks
   *   ABDM_JWT_AUDIENCE      the `aud` a callback JWT must carry. UNVERIFIED: `account` is what the
   *                          open-source Care connector checks; confirm on the sandbox portal.
   *
   * `configured` (below) needs the gateway, the client id and secret, the HIP id and the callback
   * base — the least with which a callback can be verified and answered.
   */
  ABDM_ABHA_BASE_URL: z.string().default(""),
  ABDM_CM_ID: z.enum(["", "sbx", "abdm"]).default(""),
  ABDM_HIP_ID: z.string().default(""),
  ABDM_HIU_ID: z.string().default(""),
  ABDM_CALLBACK_BASE_URL: z.string().default(""),
  ABDM_JWT_AUDIENCE: z.string().default("account"),
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
  documentStorePath: string;
  workerDispatchIntervalMs: number;
  workerTimersIntervalMs: number;
  workerTempRolesIntervalMs: number;
  workerDailyTickMs: number;
  workerNotifyIntervalMs: number;
  notifyProvider: NotifyProvider;
  notifyPushProvider: NotifyPushProvider;
  workerReachIntervalMs: number;
  /**
   * The three VAPID keys, or NULL when push is on the console sink. Null-or-complete rather
   * than three independent nullable strings: two keys out of three is not a usable
   * configuration, and `adaptersFor` should not have to re-check what the parse already knows.
   */
  webPushVapid: { publicKey: string; privateKey: string; subject: string } | null;
  /** 11i T3 — "UAT", "TRAINING", …; `null` on production, where the key is never set. */
  environmentLabel: string | null;
  /** FD-8 — the triage advisor. `baseUrl`/`apiKey` null ⇒ the desk uses its own keyword table only. */
  triage: { baseUrl: string | null; apiKey: string | null; model: string; timeoutMs: number };
  /** 2026-09-19 — triage's FIRST model, a classifier (TypeSafe). Null key ⇒ skipped, `triage` above answers. */
  triageChoice: { baseUrl: string; apiKey: string | null; model: string; timeoutMs: number; minConfidence: number };
  /** FD-COPILOT — the desk copilot's intent router. Null ⇒ phrasebook only, which is a supported way to run. */
  copilot: { baseUrl: string | null; apiKey: string | null; model: string; timeoutMs: number };
  /** 2026-09-19 — the router's FIRST model, a classifier (TypeSafe). Null key ⇒ skipped, `copilot` above answers. */
  copilotChoice: { baseUrl: string; apiKey: string | null; model: string; timeoutMs: number; minConfidence: number };
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
   * thing: an external provider whose absence is a NORMAL state, not a misconfiguration. Not
   * `configured` ⇒ the counter can still RECORD an ABHA the patient reads out, and cannot create or
   * verify one, and every ABDM route answers 503.
   *
   * ABDM S0 — `configured` is computed HERE, once, and read by both readers:
   * `modules/patients/abdm.ts` (the counter's capability) and `modules/abdm` (the connector). Two
   * copies of the rule would let the counter say "connected" while the callbacks answer 503.
   * `clientSecret` is a NON-ENUMERABLE property: readable by the one caller that sends it, absent
   * from every `JSON.stringify`, spread and `inspect` of the config.
   */
  abdm: {
    /** The HIE-CM gateway base. */
    baseUrl: string | null;
    abhaBaseUrl: string | null;
    clientId: string | null;
    clientSecret: string | null;
    cmId: "sbx" | "abdm";
    hipId: string | null;
    hiuId: string | null;
    callbackBaseUrl: string | null;
    jwtAudience: string;
    configured: boolean;
  };
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

/**
 * PHASE O T4 — REFUSED AT BOOT, NOT DISCOVERED AT SEND TIME.
 *
 * `NOTIFY_PUSH_PROVIDER=webpush` with a missing key is a deployment that starts, looks healthy,
 * and drops every push on the floor at 02:00 with a stack trace nobody is reading. The boot
 * refusal is the cheap half of `boot-check-warn-vs-refuse`: this is a CONFIGURATION defect the
 * operator can fix in thirty seconds, and no amount of running will reveal it.
 *
 * The console sink ignores the keys entirely, so a hospital that has not generated them yet
 * boots normally — which is every hospital until somebody runs `web-push generate-vapid-keys`.
 */
function vapidFrom(parsed: {
  NOTIFY_PUSH_PROVIDER: NotifyPushProvider;
  WEB_PUSH_VAPID_PUBLIC_KEY: string;
  WEB_PUSH_VAPID_PRIVATE_KEY: string;
  WEB_PUSH_VAPID_SUBJECT: string;
}): { publicKey: string; privateKey: string; subject: string } | null {
  if (parsed.NOTIFY_PUSH_PROVIDER !== "webpush") return null;
  const missing = (
    [
      ["WEB_PUSH_VAPID_PUBLIC_KEY", parsed.WEB_PUSH_VAPID_PUBLIC_KEY],
      ["WEB_PUSH_VAPID_PRIVATE_KEY", parsed.WEB_PUSH_VAPID_PRIVATE_KEY],
      ["WEB_PUSH_VAPID_SUBJECT", parsed.WEB_PUSH_VAPID_SUBJECT],
    ] as const
  ).filter(([, v]) => v.trim() === "").map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `NOTIFY_PUSH_PROVIDER=webpush requires ${missing.join(", ")} — set them or leave the provider on "console"`,
    );
  }
  return {
    publicKey: parsed.WEB_PUSH_VAPID_PUBLIC_KEY,
    privateKey: parsed.WEB_PUSH_VAPID_PRIVATE_KEY,
    subject: parsed.WEB_PUSH_VAPID_SUBJECT,
  };
}

/** ABDM S0 — see `AppConfig.abdm`. The secret is attached non-enumerable, never copied by value. */
function abdmFrom(parsed: {
  ABDM_BASE_URL: string; ABDM_ABHA_BASE_URL: string; ABDM_CLIENT_ID: string; ABDM_CLIENT_SECRET: string;
  ABDM_CM_ID: "" | "sbx" | "abdm"; ABDM_HIP_ID: string; ABDM_HIU_ID: string; ABDM_CALLBACK_BASE_URL: string;
  ABDM_JWT_AUDIENCE: string;
}): AppConfig["abdm"] {
  const orNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());
  const clientSecret = parsed.ABDM_CLIENT_SECRET === "" ? null : parsed.ABDM_CLIENT_SECRET;
  const abdm = {
    baseUrl: orNull(parsed.ABDM_BASE_URL),
    abhaBaseUrl: orNull(parsed.ABDM_ABHA_BASE_URL),
    clientId: orNull(parsed.ABDM_CLIENT_ID),
    cmId: parsed.ABDM_CM_ID === "" ? "sbx" : parsed.ABDM_CM_ID,
    hipId: orNull(parsed.ABDM_HIP_ID),
    hiuId: orNull(parsed.ABDM_HIU_ID),
    callbackBaseUrl: orNull(parsed.ABDM_CALLBACK_BASE_URL),
    jwtAudience: orNull(parsed.ABDM_JWT_AUDIENCE) ?? "account",
    configured: false,
  } as AppConfig["abdm"];
  Object.defineProperty(abdm, "clientSecret", { value: clientSecret, enumerable: false, writable: false });
  abdm.configured =
    abdm.baseUrl !== null && abdm.clientId !== null && clientSecret !== null &&
    abdm.hipId !== null && abdm.callbackBaseUrl !== null;
  return abdm;
}

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
    documentStorePath: parsed.DOCUMENT_STORE_PATH,
    environmentLabel: parsed.HMIS_ENVIRONMENT_LABEL === "" ? null : parsed.HMIS_ENVIRONMENT_LABEL,
    workerDispatchIntervalMs: parsed.WORKER_DISPATCH_INTERVAL_MS,
    workerTimersIntervalMs: parsed.WORKER_TIMERS_INTERVAL_MS,
    workerTempRolesIntervalMs: parsed.WORKER_TEMP_ROLES_INTERVAL_MS,
    workerDailyTickMs: parsed.WORKER_DAILY_TICK_MS,
    workerNotifyIntervalMs: parsed.WORKER_NOTIFY_INTERVAL_MS,
    notifyProvider: parsed.NOTIFY_PROVIDER,
    notifyPushProvider: parsed.NOTIFY_PUSH_PROVIDER,
    workerReachIntervalMs: parsed.WORKER_REACH_INTERVAL_MS,
    webPushVapid: vapidFrom(parsed),
    triage: {
      baseUrl: parsed.TRIAGE_BASE_URL ?? null,
      apiKey: parsed.TRIAGE_API_KEY ?? null,
      model: parsed.TRIAGE_MODEL,
      timeoutMs: parsed.TRIAGE_TIMEOUT_MS,
    },
    triageChoice: {
      baseUrl: parsed.TRIAGE_TYPESAFE_BASE_URL,
      apiKey: parsed.TRIAGE_TYPESAFE_API_KEY ?? null,
      model: parsed.TRIAGE_TYPESAFE_MODEL,
      timeoutMs: parsed.TRIAGE_TYPESAFE_TIMEOUT_MS,
      minConfidence: parsed.TRIAGE_TYPESAFE_MIN_CONFIDENCE,
    },
    copilot: {
      baseUrl: parsed.COPILOT_BASE_URL ?? null,
      apiKey: parsed.COPILOT_API_KEY ?? null,
      model: parsed.COPILOT_MODEL,
      timeoutMs: parsed.COPILOT_TIMEOUT_MS,
    },
    copilotChoice: {
      baseUrl: parsed.COPILOT_TYPESAFE_BASE_URL,
      apiKey: parsed.COPILOT_TYPESAFE_API_KEY ?? null,
      model: parsed.COPILOT_TYPESAFE_MODEL,
      timeoutMs: parsed.COPILOT_TYPESAFE_TIMEOUT_MS,
      minConfidence: parsed.COPILOT_TYPESAFE_MIN_CONFIDENCE,
    },
    notifyStuckAfterMs: parsed.NOTIFY_STUCK_AFTER_MS,
    retentionEnabled: parsed.RETENTION_ENABLED,
    retentionEventsMonths: parsed.RETENTION_EVENTS_MONTHS,
    notifyRetainDays: parsed.NOTIFY_RETAIN_DAYS,
    workerInterfaceSweepIntervalMs: parsed.WORKER_INTERFACE_SWEEP_INTERVAL_MS,
    workerLabSweepIntervalMs: parsed.WORKER_LAB_SWEEP_INTERVAL_MS,
    searchRateLimit: parsed.SEARCH_RATE_LIMIT,
    searchRateWindowSec: parsed.SEARCH_RATE_WINDOW_SEC,
    abdm: abdmFrom(parsed),
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
