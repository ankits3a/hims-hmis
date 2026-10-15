import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { STUB_API_KEY, createBioattendStub } from "../../../scripts/bioattend-stub";
import {
  attDays, attHolidays, attLeaves, attOnDuty, attPunches, attRoster, attShifts, attStaff, attSyncState, events, users,
} from "../../kernel/db/schema";
import { createUser } from "../../kernel/auth/identity";
import { addDays, monthStart, previousMonth } from "./ist";
import { forgetAttendanceSecrets } from "./secrets";
import { REFUSED_BACKOFF_MS, syncAttendance } from "./sync";
import type { Db } from "../../kernel/db/client";
import type { BioattendStub } from "../../../scripts/bioattend-stub";
import type { AttendanceConfig } from "./secrets";
import type { FetchLike } from "./client";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * `syncAttendance` against the test double (`scripts/bioattend-stub.ts`) over real HTTP.
 *
 * THE CLOCK IS THE TEST'S OWN. `syncAttendance(db, cfg, now)` takes its instant, and the stub is
 * built for the IST date of that same instant, so nothing here reads the machine's clock.
 */
const TODAY = "2026-03-10";
/** 2026-03-10 11:00 IST — mid-morning, outside the nightly window. */
const NOW = new Date("2026-03-10T05:30:00Z");
/** 2026-03-10 01:40 IST — inside it. */
const NIGHT = new Date("2026-03-09T20:10:00Z");
const noSleep = async (): Promise<void> => {};

describe("syncAttendance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let stub: BioattendStub;
  let base: string;
  let dir: string;
  let cfg: AttendanceConfig;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    dir = mkdtempSync(join(tmpdir(), "hmis-att-sync-"));
  });
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    forgetAttendanceSecrets();
    stub = createBioattendStub({ today: TODAY });
    base = await stub.listen(0);
    writeFileSync(join(dir, "api-key.txt"), `${STUB_API_KEY}\n`);
    cfg = { baseUrl: base, syncEnabled: true, selfShowsTimes: false, apiKeyFile: join(dir, "api-key.txt"), webhookSecretFile: null, aadhaarKeyFile: null };
  });
  afterEach(async () => { await stub.close(); });

  const run = (now: Date = NOW, over: Partial<AttendanceConfig> = {}, deps: Parameters<typeof syncAttendance>[3] = {}) =>
    syncAttendance(db, { ...cfg, ...over }, now, { sleep: noSleep, ...deps });
  const count = async (t: PgTable): Promise<number> =>
    ((await db.select({ n: sql<number>`count(*)::int` }).from(t))[0] as { n: number }).n;
  const stage = async (name: string) => (await db.select().from(attSyncState).where(eq(attSyncState.stage, name)))[0];
  const eventsNamed = async (name: string) => (await db.select().from(events).where(eq(events.name, name)).orderBy(asc(events.seq)));

  describe("integration OFF makes ZERO outbound calls", () => {
    it("no API key file", async () => {
      expect(await run(NOW, { apiKeyFile: null })).toEqual({ ran: false, why: "not_configured" });
      expect(await run(NOW, { apiKeyFile: join(dir, "nothing-here.txt") })).toEqual({ ran: false, why: "not_configured" });
      expect(stub.requests()).toEqual([]);
    });
    it("a key file with nothing usable in it", async () => {
      writeFileSync(join(dir, "empty.txt"), "\n");
      expect(await run(NOW, { apiKeyFile: join(dir, "empty.txt") })).toEqual({ ran: false, why: "not_configured" });
      expect(stub.requests()).toEqual([]);
    });
    it("the key is there but the master switch is off", async () => {
      expect(await run(NOW, { syncEnabled: false })).toEqual({ ran: false, why: "switched_off" });
      expect(stub.requests()).toEqual([]);
      expect(await count(attSyncState)).toBe(0);
    });
    it("no config at all — the census tests' registration", async () => {
      expect(await syncAttendance(db, undefined, NOW)).toEqual({ ran: false, why: "not_configured" });
      expect(stub.requests()).toEqual([]);
    });
    it("and with BOTH there it calls", async () => {
      const out = await run();
      expect(out.ran).toBe(true);
      expect(stub.requests().length).toBeGreaterThan(0);
    });
  });

  it("the first run ever: the whole punch history, both months of days, the staff list and the reference data", async () => {
    const out = await run();
    if (!out.ran) throw new Error("did not run");
    expect(out.stages).toEqual({ punches: "ok", today: "ok", reference: "ok", months: "ok" });
    expect(out.refused).toBe(false);
    expect(await count(attPunches)).toBe(stub.fixture.punches.length);
    expect(await count(attDays)).toBe(stub.fixture.days.length);
    expect(await count(attStaff)).toBe(30);
    expect(await count(attShifts)).toBe(3);
    expect(await count(attRoster)).toBe(29 * 16); // 29 active people, yesterday … today+14
    expect(await count(attHolidays)).toBe(1); // only Diwali (today+5) is inside the window
    expect(await count(attLeaves)).toBe(2);
    expect(await count(attOnDuty)).toBeGreaterThan(0);
    expect((await stage("punches"))!.cursor).toBe(stub.fixture.punches[stub.fixture.punches.length - 1]!.id);
    // Every call carried the key, and every one was answered 200.
    expect(stub.requests().every((r) => r.status === 200)).toBe(true);
    // No ranged call asked for more than 62 days (the stub answers 400 to one that does).
    expect(stub.requests().filter((r) => r.path === "/attendance").map((r) => r.query)).toEqual([
      `?date=${TODAY}`, `?from=${monthStart(TODAY)}&to=${TODAY}`, `?from=${previousMonth(TODAY).from}&to=${previousMonth(TODAY).to}`,
    ]);
    // One summary event, counts only.
    const done = await eventsNamed("attendance.sync_completed");
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ punches: stub.fixture.punches.length, staff: 30, shifts: 3 });
    expect(Object.values(done[0]!.payload as Record<string, unknown>).every((v) => typeof v === "number")).toBe(true);
  });

  it("a night shift is stored as it was sent: the last punch on the NEXT date, the times as text, no day shifted", async () => {
    await run();
    const worked = stub.fixture.days.find((d) => d.pin === "310" && d.last_out !== null)!;
    const next = addDays(worked.date, 1);
    const punches = await db.select().from(attPunches).where(eq(attPunches.pin, "310")).orderBy(asc(attPunches.ts));
    // In at 20:xx on the day, out at 08:xx on the NEXT calendar date — each filed under its own date.
    expect(punches.filter((p) => p.day === worked.date).map((p) => p.ts.slice(0, 13))).toContain(`${worked.date} 20`);
    expect(punches.filter((p) => p.day === next).map((p) => p.ts.slice(0, 13))).toContain(`${next} 08`);
    expect(punches.every((p) => p.day === p.ts.slice(0, 10))).toBe(true);
    const day = (await db.select().from(attDays).where(and(eq(attDays.pin, "310"), eq(attDays.date, worked.date))))[0]!;
    expect(day).toMatchObject({ date: worked.date, shiftName: "Night", firstIn: worked.first_in, lastOut: worked.last_out });
    expect(day.firstIn).toMatch(/^20:\d\d$/);
    expect(day.lastOut).toMatch(/^08:\d\d$/);
  });

  it("a second run two minutes later asks only for what is new and writes no event when nothing changed", async () => {
    await run();
    stub.forgetRequests();
    const again = await run(new Date(NOW.getTime() + 120_000));
    if (!again.ran) throw new Error("did not run");
    expect(again.stages).toEqual({ punches: "ok", today: "ok", reference: "skipped", months: "skipped" });
    expect(stub.requests().map((r) => r.path)).toEqual(["/punches", "/attendance", "/on-duty"]);
    expect(stub.requests()[0]!.query).toBe(`?after_id=${stub.fixture.punches[stub.fixture.punches.length - 1]!.id}&limit=1000`);
    expect(again.counts).toMatchObject({ punches: 0, days: 0, staff: 0 });
    // on-duty is re-read every run, so its count alone makes the run "work"; the punch and day counts are zero.
    const p = stub.addPunch("304", `${TODAY} 11:01:07`);
    const third = await run(new Date(NOW.getTime() + 240_000));
    if (!third.ran) throw new Error("did not run");
    expect(third.counts.punches).toBe(1);
    expect((await stage("punches"))!.cursor).toBe(p.id);
  });

  it("the reference data is re-read after thirty minutes, not before", async () => {
    await run();
    stub.forgetRequests();
    await run(new Date(NOW.getTime() + 29 * 60_000));
    expect(stub.requests().some((r) => r.path === "/staff")).toBe(false);
    await run(new Date(NOW.getTime() + 30 * 60_000));
    expect(stub.requests().filter((r) => ["/staff", "/leaves", "/roster", "/holidays", "/shifts"].includes(r.path)).map((r) => r.path)).toEqual(["/staff", "/leaves", "/roster", "/holidays", "/shifts"]);
  });

  it("punches paging RESUMES FROM THE CURSOR after a crash mid-page, with no duplicate and no gap", async () => {
    // bioattend stops answering from the THIRD page of punches on (pages of 500 here: the fixture has
    // 1 700-odd), for longer than the client retries — the run ends with two pages stored.
    let punchCalls = 0;
    const hardStop: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/punches")) {
        punchCalls += 1;
        u.searchParams.set("limit", "500");
        if (punchCalls >= 3) throw new Error("ECONNRESET");
      }
      const res = await fetch(u, init);
      return { status: res.status, text: () => res.text() };
    };
    const first = await syncAttendance(db, cfg, NOW, { sleep: noSleep, fetch: hardStop, backoffMs: 1 });
    if (!first.ran) throw new Error("did not run");
    expect(first.stages.punches).toBe("network");
    // Two whole pages landed, and the cursor sits exactly at the end of the second.
    expect(await count(attPunches)).toBe(1000);
    const cursor = (await stage("punches"))!.cursor!;
    expect(cursor).toBe(stub.fixture.punches[999]!.id);
    expect((await stage("punches"))!).toMatchObject({ lastOutcome: "network", lastError: "network" });

    // The next run starts from that cursor — not from zero — and finishes the history.
    stub.forgetRequests();
    const second = await run(new Date(NOW.getTime() + 120_000));
    if (!second.ran) throw new Error("did not run");
    expect(stub.requests().filter((r) => r.path === "/punches")[0]!.query).toBe(`?after_id=${cursor}&limit=1000`);
    expect(await count(attPunches)).toBe(stub.fixture.punches.length);
    expect(second.counts.punches).toBe(stub.fixture.punches.length - 1000);
    const ids = (await db.select({ id: attPunches.id }).from(attPunches).orderBy(asc(attPunches.id))).map((r) => r.id);
    expect(ids).toEqual(stub.fixture.punches.map((p) => p.id));
  });

  it("the first history load is bounded per run and carries on from the cursor in the next", async () => {
    const one = await run(NOW, {}, { pagesPerRun: 1 });
    if (!one.ran) throw new Error("did not run");
    expect(await count(attPunches)).toBe(1000);
    expect(stub.requests().filter((r) => r.path === "/punches")).toHaveLength(1);
    await run(new Date(NOW.getTime() + 120_000), {}, { pagesPerRun: 1 });
    expect(await count(attPunches)).toBe(stub.fixture.punches.length);
  });

  it("a punch the webhook already delivered is not stored twice by the pull", async () => {
    await run();
    const p = stub.addPunch("304", `${TODAY} 12:00:00`);
    await db.insert(attPunches).values({ id: p.id, pin: p.pin, ts: p.ts, day: TODAY, direction: "in", verify: "face", device: "OPD", origin: "device", receivedVia: "webhook" });
    const out = await run(new Date(NOW.getTime() + 120_000));
    if (!out.ran) throw new Error("did not run");
    expect(out.counts.punches).toBe(0);
    expect((await db.select().from(attPunches).where(eq(attPunches.id, p.id)))).toHaveLength(1);
    expect((await db.select().from(attPunches).where(eq(attPunches.id, p.id)))[0]!.receivedVia).toBe("webhook");
    expect((await stage("punches"))!.cursor).toBe(p.id);
  });

  describe("a day that changes upstream", () => {
    it("today's row is updated on the next run", async () => {
      await run();
      stub.setDay("304", TODAY, { status: "late", first_in: "09:41", last_out: "17:02", hours_worked: 7.5 });
      const out = await run(new Date(NOW.getTime() + 120_000));
      if (!out.ran) throw new Error("did not run");
      expect(out.counts.days).toBe(1);
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "304"), eq(attDays.date, TODAY))))[0]).toMatchObject({ status: "late", firstIn: "09:41", lastOut: "17:02", hoursWorked: 7.5 });
    });

    it("an OPEN past day is updated by the nightly re-read; a LOCKED one is never overwritten", async () => {
      await run();
      const open = addDays(TODAY, -3);
      const locked = addDays(previousMonth(TODAY).from, 2);
      const before = (await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, locked))))[0]!;
      expect(before.locked).toBe(true);
      stub.setDay("305", open, { status: "absent", first_in: null, last_out: null, hours_worked: 0 });
      stub.setDay("305", locked, { status: "absent", first_in: null, last_out: null, hours_worked: 0 });

      // Mid-morning: the months stage is not due, so the past day is still the old one.
      await run(new Date(NOW.getTime() + 120_000));
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, open))))[0]!.status).not.toBe("absent");

      // 01:40 IST the next night: the open month is re-read.
      const night = new Date(NIGHT.getTime() + 86_400_000);
      stub.forgetRequests();
      const out = await run(night);
      if (!out.ran) throw new Error("did not run");
      expect(out.stages.months).toBe("ok");
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, open))))[0]).toMatchObject({ status: "absent", firstIn: null, hoursWorked: 0 });
      // The previous month is wholly locked here, so it was not even asked for…
      expect(stub.requests().filter((r) => r.path === "/attendance" && r.query.includes("from=")).map((r) => r.query)).toEqual([`?from=${monthStart(TODAY)}&to=${addDays(TODAY, 1)}`]);
      // …and the locked row is exactly as it was.
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, locked))))[0]).toEqual(before);
    });

    it("a locked row is not overwritten even when bioattend sends a different one for it", async () => {
      await run();
      const locked = addDays(previousMonth(TODAY).from, 2);
      const before = (await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, locked))))[0]!;
      // Make HMIS believe one previous-month day is still open, so the nightly re-read fetches that month.
      await db.update(attDays).set({ locked: false }).where(and(eq(attDays.pin, "306"), eq(attDays.date, locked)));
      stub.setDay("305", locked, { status: "absent", first_in: null, last_out: null, hours_worked: 0, locked: false });
      stub.forgetRequests();
      await run(new Date(NIGHT.getTime() + 86_400_000));
      expect(stub.requests().some((r) => r.query === `?from=${previousMonth(TODAY).from}&to=${previousMonth(TODAY).to}`)).toBe(true);
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "305"), eq(attDays.date, locked))))[0]).toEqual(before);
      // The open one WAS brought up to date (and is locked again, as upstream says).
      expect((await db.select().from(attDays).where(and(eq(attDays.pin, "306"), eq(attDays.date, locked))))[0]!.locked).toBe(true);
    });

    it("the nightly re-read happens once a night, inside 01:30-02:00 IST only", async () => {
      await run();
      const at = (hhmm: string) => new Date(`2026-03-11T${hhmm}:00+05:30`);
      const due = async (now: Date) => { const o = await run(now); if (!o.ran) throw new Error("did not run"); return o.stages.months; };
      expect(await due(at("01:29"))).toBe("skipped");
      expect(await due(at("01:30"))).toBe("ok");
      expect(await due(at("01:32"))).toBe("skipped"); // already done for this date
      expect(await due(at("02:00"))).toBe("skipped");
      expect(await due(new Date(at("01:45").getTime() + 86_400_000))).toBe("ok");
    });
  });

  describe("a refusal from bioattend", () => {
    it.each([
      [401, "bad_key", () => { writeFileSync(join(dir, "api-key.txt"), `bio_${"00".repeat(32)}\n`); forgetAttendanceSecrets(); }],
      [403, "ip_not_allowed", () => { stub.failNext(403, 50); }],
    ])("HTTP %i is NOT retried: one call, the run ends, and one event tells somebody", async (status, outcome, arrange) => {
      arrange();
      const out = await run();
      if (!out.ran) throw new Error("did not run");
      expect(out.refused).toBe(true);
      expect(stub.requests()).toHaveLength(1); // not retried, and no later stage tried its luck
      expect(stub.requests()[0]!.status).toBe(status);
      expect(out.stages).toEqual({ punches: `${outcome} (HTTP ${status})` });
      expect((await eventsNamed("attendance.sync_refused")).map((e) => e.payload)).toEqual([{ status, outcome }]);
      expect((await stage("punches"))!).toMatchObject({ lastOutcome: outcome, lastError: `${outcome} (HTTP ${status})`, lastOkAt: null });
      expect(await count(attPunches)).toBe(0);
    });

    it("the job stays away for ten minutes, and tells somebody at most once an hour", async () => {
      stub.failNext(403, 1000);
      await run();
      expect(await run(new Date(NOW.getTime() + 120_000))).toEqual({ ran: false, why: "backing_off" });
      expect(stub.requests()).toHaveLength(1);
      for (let m = 10; m < 60; m += 10) await run(new Date(NOW.getTime() + m * 60_000));
      expect(stub.requests()).toHaveLength(6); // 0, 10, 20, 30, 40, 50 minutes — one call each
      expect(await eventsNamed("attendance.sync_refused")).toHaveLength(1);
      await run(new Date(NOW.getTime() + REFUSED_BACKOFF_MS * 6));
      expect(await eventsNamed("attendance.sync_refused")).toHaveLength(2);
    });

    it("no state row, event or error carries the key", async () => {
      stub.failNext(403, 5);
      await run();
      const written = JSON.stringify([await db.select().from(attSyncState), await db.select().from(events)]);
      expect(written).not.toContain(STUB_API_KEY);
      expect(written).not.toContain(base);
    });
  });

  it.each([429, 503] as const)("HTTP %i IS retried, and the run then succeeds", async (status) => {
    stub.failNext(status, 2);
    const out = await run();
    if (!out.ran) throw new Error("did not run");
    expect(out.refused).toBe(false);
    expect(out.stages.punches).toBe("ok");
    expect(stub.requests().slice(0, 3).map((r) => [r.path, r.status])).toEqual([["/punches", status], ["/punches", status], ["/punches", 200]]);
    expect(await count(attPunches)).toBe(stub.fixture.punches.length);
    expect(await eventsNamed("attendance.sync_refused")).toEqual([]);
  });

  it("a stage that fails does not stop the others, and says so in its own row", async () => {
    await run();
    // /punches is down for longer than the retries; today's attendance still arrives.
    stub.setDay("304", TODAY, { status: "late" });
    stub.failNext(503, 4);
    const out = await run(new Date(NOW.getTime() + 120_000));
    if (!out.ran) throw new Error("did not run");
    expect(out.stages).toMatchObject({ punches: "upstream_not_configured (HTTP 503)", today: "ok" });
    expect((await db.select().from(attDays).where(and(eq(attDays.pin, "304"), eq(attDays.date, TODAY))))[0]!.status).toBe("late");
  });

  it("the staff stage links people, keeps a link across refreshes, and a leave cancelled upstream disappears", async () => {
    const { id } = await createUser(db, { username: "a.kumar", fullName: "Dr A Kumar", password: "s3cret-pass" });
    await db.update(users).set({ phone: "9876501234" }).where(eq(users.id, id));
    const out = await run();
    if (!out.ran) throw new Error("did not run");
    expect(out.counts.linked).toBe(1);
    expect((await db.select().from(attStaff).where(eq(attStaff.pin, "304")))[0]).toMatchObject({ userId: id, linkSource: "mobile" });
    // The two who share a mobile are flagged, never linked.
    expect((await db.select({ n: attStaff.needsAttention }).from(attStaff).where(eq(attStaff.pin, "320")))[0]!.n).toBeNull(); // no login has that number yet

    expect(await count(attLeaves)).toBe(2);
    stub.fixture.leaves.splice(stub.fixture.leaves.findIndex((l) => l.pin === "304"), 1);
    stub.fixture.staff.find((s) => s.pin === "304")!.post = "Assoc Prof";
    const later = await run(new Date(NOW.getTime() + 31 * 60_000));
    if (!later.ran) throw new Error("did not run");
    expect(later.counts.staff).toBe(1);
    expect(await count(attLeaves)).toBe(1);
    expect((await db.select().from(attStaff).where(eq(attStaff.pin, "304")))[0]).toMatchObject({ userId: id, linkSource: "mobile", post: "Assoc Prof" });
  });
});
