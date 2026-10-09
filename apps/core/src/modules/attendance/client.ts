import { z } from "zod";

/**
 * ═══ THE BIOATTEND CLIENT — eight read-only GETs, per the API guide of 2026-10-09 ═══
 *
 * Plain `fetch`, the `X-HMIS-Key` header, a timeout, and the guide's error table turned into NAMED
 * outcomes so nothing downstream reads a status code.
 *
 * RETRY ONLY WHAT CAN CHANGE: 429, 503 and a network failure, with back-off. 400, 401 and 403 are
 * never retried — "they will fail the same way", and every refusal is logged on bioattend's side.
 *
 * THE KEY NEVER LEAVES THE HEADER. An error carries an outcome, a status and the PATH — no query
 * string that could be mistaken for a secret, no response body, and never the key.
 */
export type BioattendOutcome =
  | "bad_request" // 400 — a parameter this client built wrongly
  | "bad_key" // 401 bad_or_missing_key — no key, a wrong key, a revoked key
  | "ip_not_allowed" // 403 ip_not_allowed_for_this_key — right key, wrong source IP
  | "https_required" // 403 https_required
  | "wrong_host" // 403 use_https_biotime_crkmch_com
  | "forbidden" // 403, any other reason
  | "rate_limited" // 429 — or this client's own budget, before a call is made
  | "upstream_not_configured" // 503 api_not_configured
  | "network" // no answer: DNS, refused, reset, timeout
  | "bad_response"; // an answer that is not the guide's JSON

export class BioattendError extends Error {
  constructor(
    readonly outcome: BioattendOutcome,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(`bioattend ${path}: ${outcome}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "BioattendError";
  }
  /** 401/403 — the key or where we call from is wrong; a person must be told. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const RETRYABLE: ReadonlySet<BioattendOutcome> = new Set(["rate_limited", "upstream_not_configured", "network"]);

const text = z.string().nullable().optional().transform((v) => v ?? null);
const flag = z.boolean().nullable().optional().transform((v) => v === true);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
/** bioattend's `pin` is a string in the guide; a bare number is taken as the same pin. */
const pin = z.union([z.string().min(1), z.number().int()]).transform((v) => String(v));

export const punchSchema = z.object({
  id: z.number().int().positive(),
  pin,
  ts: stamp,
  direction: text,
  verify: text,
  device: text,
  origin: text,
});
export type BioPunch = z.infer<typeof punchSchema>;

const staffSchema = z.object({
  pin,
  name: z.string(),
  dept: text,
  post: text,
  gender: text,
  mobile: text,
  status: z.string(),
  joining_date: isoDate.nullable().optional().transform((v) => v ?? null),
  date_of_leaving: isoDate.nullable().optional().transform((v) => v ?? null),
  work_days: text,
  aadhaar_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional().transform((v) => v ?? null),
});
export type BioStaff = z.infer<typeof staffSchema>;

const daySchema = z.object({
  pin,
  date: isoDate,
  first_in: text,
  last_out: text,
  hours_worked: z.number().nullable().optional().transform((v) => v ?? null),
  ot_minutes: z.number().int().nullable().optional().transform((v) => v ?? null),
  shift_name: text,
  status: z.string(),
  day_type: text,
  locked: flag,
});
export type BioDay = z.infer<typeof daySchema>;

const onDutySchema = z.object({ pin, in_since: text, device: text });
export type BioOnDuty = z.infer<typeof onDutySchema>;
const leaveSchema = z.object({ pin, date: isoDate, reason: text });
export type BioLeave = z.infer<typeof leaveSchema>;
const holidaySchema = z.object({ date: isoDate, name: z.string(), dept: text, cancelled: flag });
export type BioHoliday = z.infer<typeof holidaySchema>;
const shiftSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  dept: text,
  checkin_time: text,
  checkout_time: text,
  crosses_midnight: flag,
  grace_minutes: z.number().int().nullable().optional().transform((v) => v ?? null),
  kind: text,
  weekly_off_days: text,
});
export type BioShift = z.infer<typeof shiftSchema>;
const rosterSchema = z.object({ pin, date: isoDate, shift_name: text, start: text, end: text, off: flag, holiday: text, leave: flag });
export type BioRoster = z.infer<typeof rosterSchema>;

/** The guide's limits. */
export const MAX_RANGE_DAYS = 62;
export const PUNCH_PAGE = 1000;
export const UPSTREAM_CALLS_PER_MINUTE = 120;

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type BioattendClientOptions = {
  baseUrl: string;
  /** Read at each call, so a rotated key is picked up without a restart. Null = not configured. */
  key: () => string | null;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** Extra attempts after the first, for 429 / 503 / network only. */
  retries?: number;
  backoffMs?: number;
  /** This client's own ceiling per rolling minute, kept under bioattend's 120. */
  callsPerMinute?: number;
};

export type BioattendClient = ReturnType<typeof createBioattendClient>;

export function createBioattendClient(opts: BioattendClientOptions) {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1_000;
  const perMinute = opts.callsPerMinute ?? 100;
  const sent: number[] = [];
  let calls = 0;

  function spend(path: string): void {
    const t = now();
    while (sent.length > 0 && t - sent[0]! >= 60_000) sent.shift();
    // Out of budget is a rate limit we impose on ourselves BEFORE bioattend has to: no call is made.
    if (sent.length >= perMinute) throw new BioattendError("rate_limited", null, path);
    sent.push(t);
    calls += 1;
  }

  async function once(path: string, query: string): Promise<unknown> {
    const key = opts.key();
    if (key === null) throw new BioattendError("bad_key", null, path);
    spend(path);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let status: number;
    let raw: string;
    try {
      const res = await doFetch(`${opts.baseUrl}${path}${query}`, { method: "GET", headers: { "X-HMIS-Key": key, Accept: "application/json" }, signal: ctl.signal });
      status = res.status;
      raw = await res.text();
    } catch {
      // The cause is dropped on purpose: a fetch error can quote the URL it was given.
      throw new BioattendError("network", null, path);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
    if (status === 400) throw new BioattendError("bad_request", status, path);
    if (status === 401) throw new BioattendError("bad_key", status, path);
    if (status === 403) {
      const named: Record<string, BioattendOutcome> = {
        ip_not_allowed_for_this_key: "ip_not_allowed", https_required: "https_required", use_https_biotime_crkmch_com: "wrong_host",
      };
      throw new BioattendError(named[error] ?? "forbidden", status, path);
    }
    if (status === 429) throw new BioattendError("rate_limited", status, path);
    if (status === 503) throw new BioattendError("upstream_not_configured", status, path);
    if (status !== 200 || typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      throw new BioattendError("bad_response", status, path);
    }
    return body;
  }

  async function get<T>(path: string, params: Record<string, string | number | undefined>, schema: z.ZodType<T>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const query = qs.size === 0 ? "" : `?${qs.toString()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const parsed = schema.safeParse(await once(path, query));
        if (!parsed.success) throw new BioattendError("bad_response", 200, path);
        return parsed.data;
      } catch (e) {
        // A refusal from our OWN budget (rate_limited with no status) is not retried: waiting it out
        // would hold the job's tick; the next tick resumes from the stored cursor.
        const ownBudget = e instanceof BioattendError && e.outcome === "rate_limited" && e.status === null;
        if (!(e instanceof BioattendError) || !RETRYABLE.has(e.outcome) || ownBudget || attempt >= retries) throw e;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  }

  const range = (from: string, to: string): Record<string, string> => (from === to ? { date: from } : { from, to });

  return {
    /** HTTP requests actually sent (budget refusals and "no key" are not requests). */
    callCount: (): number => calls,
    staff: async (): Promise<BioStaff[]> => (await get("/staff", {}, z.object({ staff: z.array(staffSchema) }))).staff,
    punches: (afterId: number, limit: number = PUNCH_PAGE): Promise<{ next_after_id: number; more: boolean; punches: BioPunch[] }> =>
      get("/punches", { after_id: afterId, limit }, z.object({ next_after_id: z.number().int().nonnegative(), more: z.boolean(), punches: z.array(punchSchema) })),
    attendance: async (from: string, to: string): Promise<BioDay[]> =>
      (await get("/attendance", range(from, to), z.object({ attendance: z.array(daySchema) }))).attendance,
    onDuty: (): Promise<{ as_of: string; on_duty: BioOnDuty[] }> =>
      get("/on-duty", {}, z.object({ as_of: z.string(), on_duty: z.array(onDutySchema) })),
    leaves: async (from: string, to: string): Promise<BioLeave[]> => (await get("/leaves", range(from, to), z.object({ leaves: z.array(leaveSchema) }))).leaves,
    holidays: async (from: string, to: string): Promise<BioHoliday[]> => (await get("/holidays", range(from, to), z.object({ holidays: z.array(holidaySchema) }))).holidays,
    shifts: async (): Promise<BioShift[]> => (await get("/shifts", {}, z.object({ shifts: z.array(shiftSchema) }))).shifts,
    roster: async (from: string, to: string): Promise<BioRoster[]> => (await get("/roster", range(from, to), z.object({ roster: z.array(rosterSchema) }))).roster,
  };
}
