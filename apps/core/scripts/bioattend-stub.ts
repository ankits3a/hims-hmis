/**
 * ═══ A TEST DOUBLE FOR THE ATTENDANCE SYSTEM ("bioattend") ═══
 *
 * A small HTTP server that speaks the eight endpoints of the bioattend API guide (2026-10-09) under
 * `/api/hmis/v1`, and can POST a correctly signed punch webhook. HMIS's real API key works only from
 * the production server, so this is what the tests, staging and a screen walk talk to instead.
 *
 *     pnpm --filter @hmis/core exec tsx scripts/bioattend-stub.ts --port 4610
 *     # then, for the api and worker:  BIOATTEND_BASE_URL=http://127.0.0.1:4610/api/hmis/v1
 *
 * THE FIXTURE IS FIXED GIVEN A "TODAY": thirty people over the month before today's (LOCKED) and
 * today's month up to today (open). It holds every status in the guide and one the guide does not
 * know (`comp_off`), a night shift that crosses midnight, a person who left, a person with no
 * Aadhaar, and two people sharing one mobile. Nothing in it is a real person, number or secret:
 * the key, the signing secret and the Aadhaar key default to the guide's own DUMMY test values.
 *
 * It refuses a wrong key (401), and `failNext` makes the next calls answer 429, 503 or 403 on demand.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { aadhaarHash, verhoeffValid } from "../src/modules/attendance/aadhaar";
import { addDays, chunkRange, daysInclusive, isIsoDate, istClock, istDate, monthStart, previousMonth } from "../src/modules/attendance/ist";
import { bioattendSignature } from "../src/modules/attendance/webhook";

export const STUB_API_KEY = `bio_${"5e".repeat(32)}`;
/** The guide's dummy values ("Test vector" sections) — public by design. */
export const STUB_WEBHOOK_SECRET = "ab".repeat(32);
export const STUB_AADHAAR_KEY = "0f".repeat(32);
export const STUB_BASE_PATH = "/api/hmis/v1";

export type StubStaff = {
  pin: string; name: string; dept: string; post: string; gender: string | null; mobile: string | null; status: "active" | "left";
  joining_date: string; date_of_leaving: string | null; work_days: string | null; aadhaar_hash: string | null;
};
export type StubPunch = { id: number; pin: string; ts: string; direction: string; verify: string; device: string; origin: string };
export type StubDay = {
  pin: string; date: string; first_in: string | null; last_out: string | null; hours_worked: number; ot_minutes: number;
  shift_name: string | null; status: string; day_type: string | null; locked: boolean;
};

/** Twelve digits with a valid Verhoeff check digit, made from a seed. Made up — not anybody's number. */
export function madeUpAadhaar(seed: number): string {
  const body = `${2 + (seed % 8)}${String(10_000_000_000 + seed * 7_919_191).slice(1, 11)}`;
  for (let c = 0; c <= 9; c++) if (verhoeffValid(`${body}${c}`)) return `${body}${c}`;
  throw new Error("no check digit");
}

const PEOPLE: readonly [pin: string, name: string, dept: string, post: string, gender: string | null][] = [
  ["301", "Dr Meera Nair", "Medicine", "Professor", "F"], ["302", "Dr Rohit Sharma", "Medicine", "Assoc Prof", "M"],
  ["303", "Dr Farah Khan", "Medicine", "Senior Resident", "F"], ["304", "Dr A Kumar", "Medicine", "Asst Prof", "M"],
  ["305", "Dr Sunil Verma", "Surgery", "Professor", "M"], ["306", "Dr Kavita Rao", "Surgery", "Asst Prof", "F"],
  ["307", "Dr Imran Ali", "Surgery", "Junior Resident", "M"], ["308", "Dr Neha Joshi", "Obstetrics", "Assoc Prof", "F"],
  ["309", "Dr Pooja Singh", "Obstetrics", "Senior Resident", "F"], ["310", "Sr Anita Thomas", "Nursing", "Staff Nurse", "F"],
  ["311", "Sr Lata Pawar", "Nursing", "Staff Nurse", "F"], ["312", "Sr Rekha Yadav", "Nursing", "Ward In-charge", "F"],
  ["313", "Br Sanjay Gupta", "Nursing", "Staff Nurse", "M"], ["314", "Ramesh Patil", "Front Office", "Receptionist", "M"],
  ["315", "Sunita Devi", "Front Office", "Receptionist", "F"], ["316", "Vikram Chauhan", "Billing", "Cashier", "M"],
  ["317", "Priya Menon", "Billing", "Billing Manager", "F"], ["318", "Arjun Reddy", "Pharmacy", "Pharmacist", "M"],
  ["319", "Deepa Iyer", "Pharmacy", "Pharmacist in Charge", "F"], ["320", "Mohan Lal", "Housekeeping", "Attendant", "M"],
  ["321", "Sohan Lal", "Housekeeping", "Attendant", "M"], ["322", "Geeta Kumari", "Laboratory", "Lab Technician", "F"],
  ["323", "Dr Vivek Saxena", "Laboratory", "Pathologist", "M"], ["324", "Nisha Agarwal", "Radiology", "Radiographer", "F"],
  ["325", "Prof S Banerjee", "Anatomy", "Professor", "M"], ["326", "Dr Ritu Malhotra", "Anatomy", "Tutor", "F"],
  ["327", "Prof K Subramaniam", "Physiology", "Professor", "M"], ["328", "Dr Leena Dsouza", "Physiology", "Tutor", "F"],
  ["329", "Harish Chand", "Accounts", "Accountant", "M"], ["330", "Jyoti Bakshi", "Administration", "Office Superintendent", null],
];
const NIGHT_PIN = "310";
const LEFT_PIN = "328";
const NO_AADHAAR_PIN = "312";
const SHARED_MOBILE_PINS = ["320", "321"];
/** Pin 304 is the guide's example person: this number and key give the guide's test-vector hash. */
const GUIDE_AADHAAR = "234567890124";

const WORKED = ["on_time", "on_time", "on_time", "late", "on_time", "below_min_full", "on_time", "below_min_half", "single_punch", "on_time", "on_call_worked"] as const;
const weekday = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
const pad = (n: number): string => String(n).padStart(2, "0");

export type StubFixture = { today: string; staff: StubStaff[]; days: StubDay[]; punches: StubPunch[]; holidays: { date: string; name: string; dept: string | null; cancelled: boolean }[];
  leaves: { pin: string; date: string; reason: string }[]; shifts: Record<string, unknown>[] };

export function buildFixture(today: string, aadhaarKey: string = STUB_AADHAAR_KEY): StubFixture {
  const prev = previousMonth(today);
  const first = prev.from;
  const leftOn = addDays(prev.from, 14);
  const staff: StubStaff[] = PEOPLE.map(([pin, name, dept, post, gender], i) => ({
    pin, name, dept, post, gender,
    mobile: SHARED_MOBILE_PINS.includes(pin) ? "9811100020" : pin === "304" ? "9876501234" : `98${String(11_100_000 + i * 137).padStart(8, "0")}`,
    status: pin === LEFT_PIN ? "left" : "active",
    joining_date: "2024-07-01", date_of_leaving: pin === LEFT_PIN ? leftOn : null,
    work_days: name.startsWith("Dr") || name.startsWith("Prof") ? "0,1,2,3,4,5" : null,
    aadhaar_hash: pin === NO_AADHAAR_PIN ? null : aadhaarHash(pin === "304" ? GUIDE_AADHAAR : madeUpAadhaar(i + 1), aadhaarKey),
  }));
  const holidays = [
    { date: addDays(prev.from, 9), name: "Founders Day", dept: null, cancelled: false },
    { date: addDays(prev.from, 9), name: "Founders Day", dept: "Nursing", cancelled: true },
    { date: addDays(prev.from, 19), name: "College Annual Day", dept: "Anatomy", cancelled: false },
    { date: addDays(today, 5), name: "Diwali", dept: null, cancelled: false },
  ];
  const leaves = [
    { pin: "302", date: addDays(prev.from, 5), reason: "Conference" }, { pin: "302", date: addDays(prev.from, 6), reason: "Conference" },
    { pin: "315", date: addDays(today, -1), reason: "Personal" }, { pin: "304", date: addDays(today, 3), reason: "Conference" },
  ];
  const days: StubDay[] = [];
  const punches: Omit<StubPunch, "id">[] = [];
  for (const [i, s] of staff.entries()) {
    for (let date = first; date <= today; date = addDays(date, 1)) {
      if (s.date_of_leaving !== null && date > s.date_of_leaving) break;
      const locked = date <= prev.to;
      const night = s.pin === NIGHT_PIN;
      const shift = night ? "Night" : s.dept === "Nursing" ? "Ward day" : "OPD day";
      const wd = weekday(date);
      const n = daysInclusive(first, date) + i * 3;
      const holiday = holidays.find((h) => h.date === date && !h.cancelled && (h.dept === null || h.dept === s.dept) && !holidays.some((c) => c.date === date && c.cancelled && c.dept === s.dept));
      const leave = leaves.find((l) => l.pin === s.pin && l.date === date);
      let status: string;
      if (leave !== undefined) status = "approved_leave";
      else if (holiday !== undefined) status = n % 9 === 0 ? "worked_on_holiday" : "holiday";
      else if (wd === 6) status = n % 11 === 0 ? "worked_on_off_day" : "weekly_off";
      else if (s.pin === "329" && n % 13 === 0) status = "no_shift";
      else if (s.pin === "323" && wd === 5) status = "on_call";
      else if (s.pin === "330" && date === addDays(today, -1)) status = "comp_off"; // a value the guide of 2026-10-09 does not list
      else if (n % 17 === 0) status = "absent";
      else status = WORKED[n % WORKED.length]!;
      const worked = !["approved_leave", "holiday", "weekly_off", "absent", "on_call", "no_shift", "comp_off"].includes(status);
      const isToday = date === today;
      const lateBy = status === "late" ? 25 + (n % 20) : n % 9;
      const inAt = night ? `20:${pad(n % 10)}` : `${pad(8 + Math.floor((50 + lateBy) / 60))}:${pad((50 + lateBy) % 60)}`;
      const single = status === "single_punch" || (isToday && worked);
      const short = status === "below_min_half" ? 3 : status === "below_min_full" ? 6 : 8;
      const outAt = night ? `08:${pad(n % 10)}` : `${pad(9 + short)}:${pad(n % 60)}`;
      days.push({
        pin: s.pin, date, first_in: worked ? inAt : null, last_out: worked && !single ? outAt : null,
        hours_worked: worked && !single ? (night ? 12 : short) : 0, ot_minutes: worked && !single && n % 6 === 0 ? 15 : 0,
        shift_name: status === "no_shift" ? null : shift, status, day_type: s.pin === "311" && n % 23 === 0 && worked ? "worked_double_dn" : null, locked,
      });
      if (!worked) continue;
      const verify = ["face", "fingerprint", "card"][n % 3]!;
      const device = s.dept === "Nursing" ? "Ward-2" : ["Anatomy", "Physiology"].includes(s.dept) ? "College Gate" : "OPD";
      punches.push({ pin: s.pin, ts: `${date} ${inAt}:${pad(n % 60)}`, direction: "in", verify, device, origin: "device" });
      // Many devices send `in` for every punch (the guide says so); the night nurse's last punch falls on the NEXT date.
      if (!single) punches.push({ pin: s.pin, ts: `${night ? addDays(date, 1) : date} ${outAt}:${pad((n * 7) % 60)}`, direction: n % 2 === 0 ? "out" : "in", verify, device, origin: n % 41 === 0 ? "synthesized" : "device" });
    }
  }
  punches.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.pin < b.pin ? -1 : 1));
  const shifts = [
    { id: 1, name: "OPD day", dept: null, checkin_time: "09:00", checkout_time: "17:00", crosses_midnight: false, grace_minutes: 10, kind: "fixed_day", weekly_off_days: "6" },
    { id: 2, name: "Ward day", dept: "Nursing", checkin_time: "08:00", checkout_time: "20:00", crosses_midnight: false, grace_minutes: 10, kind: "fixed_day", weekly_off_days: "6" },
    { id: 3, name: "Night", dept: "Nursing", checkin_time: "20:00", checkout_time: "08:00", crosses_midnight: true, grace_minutes: 15, kind: "fixed_night", weekly_off_days: "6" },
  ];
  return { today, staff, days, punches: punches.map((p, i) => ({ id: 40_001 + i, ...p })), holidays, leaves, shifts };
}

export type StubOptions = { today?: string; apiKey?: string; webhookSecret?: string; aadhaarKey?: string };
export type BioattendStub = ReturnType<typeof createBioattendStub>;

export function createBioattendStub(opts: StubOptions = {}) {
  const apiKey = opts.apiKey ?? STUB_API_KEY;
  const secret = opts.webhookSecret ?? STUB_WEBHOOK_SECRET;
  const fx = buildFixture(opts.today ?? istDate(new Date()), opts.aadhaarKey ?? STUB_AADHAAR_KEY);
  const seen: { path: string; query: string; status: number }[] = [];
  let failing: { status: 403 | 429 | 503; error: string; times: number } | null = null;

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  function rangeOf(q: URLSearchParams): { from: string; to: string } | string {
    const date = q.get("date");
    const from = date ?? q.get("from") ?? fx.today;
    const to = date ?? q.get("to") ?? fx.today;
    if (!isIsoDate(from)) return "from must be YYYY-MM-DD";
    if (!isIsoDate(to)) return "to must be YYYY-MM-DD";
    if (from > to) return "from must not be after to";
    if (daysInclusive(from, to) > 62) return "range must be at most 62 days";
    return { from, to };
  }

  function rosterFor(from: string, to: string, pin: string | null): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const s of fx.staff) {
      if (s.status !== "active" || (pin !== null && s.pin !== pin)) continue;
      for (const c of chunkRange(from, to, 1)) {
        const off = weekday(c.from) === 6;
        const holiday = fx.holidays.find((h) => h.date === c.from && !h.cancelled && (h.dept === null || h.dept === s.dept))?.name ?? null;
        const night = s.pin === NIGHT_PIN;
        out.push({
          pin: s.pin, date: c.from, shift_name: off ? null : night ? "Night" : s.dept === "Nursing" ? "Ward day" : "OPD day",
          start: off ? null : night ? "20:00" : s.dept === "Nursing" ? "08:00" : "09:00", end: off ? null : night ? "08:00" : s.dept === "Nursing" ? "20:00" : "17:00",
          off, holiday, leave: fx.leaves.some((l) => l.pin === s.pin && l.date === c.from),
        });
      }
    }
    return out;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname.startsWith(STUB_BASE_PATH) ? url.pathname.slice(STUB_BASE_PATH.length) : null;
    const done = (status: number, body: unknown): void => { seen.push({ path: path ?? url.pathname, query: url.search, status }); json(res, status, body); };
    if (path === null || req.method !== "GET") return done(404, { ok: false, error: "not_found" });
    if (req.headers["x-hmis-key"] !== apiKey) return done(401, { ok: false, error: "bad_or_missing_key" });
    if (failing !== null && failing.times > 0) {
      failing.times -= 1;
      return done(failing.status, { ok: false, error: failing.error });
    }
    const q = url.searchParams;
    const pin = q.get("pin");
    const mine = <T extends { pin: string }>(rows: T[]): T[] => (pin === null ? rows : rows.filter((r) => r.pin === pin));
    if (path === "/staff") {
      const hash = q.get("aadhaar_hash");
      return done(200, { ok: true, staff: mine(fx.staff).filter((s) => hash === null || s.aadhaar_hash === hash) });
    }
    if (path === "/punches") {
      const after = Number(q.get("after_id") ?? "0");
      const limit = Number(q.get("limit") ?? "500");
      if (!Number.isInteger(after) || after < 0) return done(400, { ok: false, error: "after_id must be a whole number" });
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return done(400, { ok: false, error: "limit must be 1 to 1000" });
      const rest = mine(fx.punches).filter((p) => p.id > after);
      const page = rest.slice(0, limit);
      return done(200, { ok: true, next_after_id: page.length === 0 ? after : page[page.length - 1]!.id, more: rest.length > page.length, punches: page });
    }
    if (path === "/on-duty") {
      const inNow = fx.days.filter((d) => d.date === fx.today && d.first_in !== null && d.last_out === null);
      return done(200, {
        ok: true, as_of: `${fx.today} 16:20:00`,
        on_duty: inNow.map((d) => { const s = fx.staff.find((x) => x.pin === d.pin)!; return { pin: s.pin, name: s.name, dept: s.dept, post: s.post, in_since: `${d.date} ${d.first_in}:00`, device: "OPD" }; }),
      });
    }
    if (path === "/shifts") return done(200, { ok: true, shifts: fx.shifts });
    const r = rangeOf(q);
    if (typeof r === "string") return done(400, { ok: false, error: r });
    const within = <T extends { date: string }>(rows: T[]): T[] => rows.filter((x) => x.date >= r.from && x.date <= r.to);
    if (path === "/attendance") return done(200, { ok: true, attendance: mine(within(fx.days)) });
    if (path === "/leaves") return done(200, { ok: true, leaves: mine(within(fx.leaves)) });
    if (path === "/holidays") return done(200, { ok: true, holidays: within(fx.holidays) });
    if (path === "/roster") return done(200, { ok: true, roster: rosterFor(r.from, r.to, pin) });
    return done(404, { ok: false, error: "not_found" });
  }

  const server: Server = createServer(handle);

  return {
    fixture: fx,
    apiKey,
    webhookSecret: secret,
    server,
    /** Listens on 127.0.0.1 and answers the base URL to give `BIOATTEND_BASE_URL`. Port 0 = any free port. */
    listen: (port = 0): Promise<string> => new Promise((resolve) => {
      server.listen(port, "127.0.0.1", () => {
        const a = server.address();
        resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : port}${STUB_BASE_PATH}`);
      });
    }),
    close: (): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); }),
    /** Every request answered so far: path, query string and status. */
    requests: (): readonly { path: string; query: string; status: number }[] => seen,
    forgetRequests: (): void => { seen.length = 0; },
    /** The next `times` authenticated calls answer this instead: 429 rate_limited, 503 api_not_configured, or 403. */
    failNext: (status: 403 | 429 | 503, times = 1): void => {
      failing = { status, times, error: status === 429 ? "rate_limited" : status === 503 ? "api_not_configured" : "ip_not_allowed_for_this_key" };
    },
    /** An admin corrects a day upstream. */
    setDay: (pin: string, date: string, patch: Partial<StubDay>): void => {
      const d = fx.days.find((x) => x.pin === pin && x.date === date);
      if (d === undefined) throw new Error(`stub: no day ${pin} ${date}`);
      Object.assign(d, patch);
    },
    /** A device records a punch. Returns it, with the next id. */
    addPunch: (pin: string, ts: string, more: Partial<Omit<StubPunch, "id" | "pin" | "ts">> = {}): StubPunch => {
      const p: StubPunch = { id: (fx.punches[fx.punches.length - 1]?.id ?? 40_000) + 1, pin, ts, direction: "in", verify: "face", device: "OPD", origin: "device", ...more };
      fx.punches.push(p);
      return p;
    },
    /** The request bioattend would send for these punches: the exact body bytes and the two signed headers. */
    signedWebhook: (punches: readonly StubPunch[], at: { timestamp?: number; sentAt?: string; secret?: string } = {}): { body: string; headers: Record<string, string> } => {
      const timestamp = String(at.timestamp ?? Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ event: "punches", sent_at: at.sentAt ?? `${fx.today} 16:20:00`, punches });
      return { body, headers: { "content-type": "application/json", "x-bioattend-timestamp": timestamp, "x-bioattend-signature": bioattendSignature(at.secret ?? secret, timestamp, Buffer.from(body, "utf8")) } };
    },
  };
}

/** POST a signed webhook the way bioattend does. Returns the HTTP status HMIS answered. */
export async function postWebhook(url: string, signed: { body: string; headers: Record<string, string> }): Promise<number> {
  return (await fetch(url, { method: "POST", headers: signed.headers, body: signed.body })).status;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const secretFile = arg("webhook-secret-file");
  const stub = createBioattendStub({
    today: arg("today"), apiKey: arg("key"),
    webhookSecret: secretFile === undefined ? undefined : readFileSync(secretFile, "utf8").trim(),
  });
  const base = await stub.listen(Number(arg("port") ?? "4610"));
  console.log(`bioattend stub: ${base}  (today ${stub.fixture.today}, ${stub.fixture.staff.length} people, ${stub.fixture.days.length} days, ${stub.fixture.punches.length} punches)`);
  console.log(`  X-HMIS-Key for it: ${stub.apiKey}   (a dummy — this stub's own, not bioattend's)`);
  const hook = arg("webhook");
  if (hook !== undefined) {
    // `--webhook <url>`: one new punch for pin 304 "now", delivered signed, so a walk can watch it arrive.
    const now = new Date();
    const p = stub.addPunch("304", `${istDate(now)} ${istClock(now)}`);
    console.log(`  webhook ${hook} -> HTTP ${await postWebhook(hook, stub.signedWebhook([p]))}`);
  }
}

if (require.main === module) void main();
