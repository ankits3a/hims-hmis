import { IPD_INTENTS, newId } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { withTx } from "../../../kernel/db/client";
import { appendEvent } from "../../../kernel/events/append";
import type { Db } from "../../../kernel/db/client";
import { EV, IPD_GOAL_CLEAN_REASONS, IPD_GOAL_EVENTS, IPD_GOAL_QUERIES, IPD_GOAL_TEMPLATES } from "../goals";
import type { GoalMeasured, GoalResult } from "../goals";

/**
 * E0.5 (#717) — "DONE MEANS" FOR THE IPD GOAL LEDGER (plan §1, §6; decision 0072).
 *
 * The window is a fixed past month passed EXPLICITLY; no query compares anything to the wall clock, so these
 * instants never age into a different answer. Every expected number is computed by hand in the comment beside
 * it (percentile_cont: position (n-1)·p, linear between neighbours).
 */
const FROM = new Date("2026-03-01T00:00:00.000Z");
const TO = new Date("2026-03-29T00:00:00.000Z");
const at = (iso: string): Date => new Date(`${iso}:00.000Z`);

const EXPECTED_IDS = [
  "G1", "G2", "G3", "G4", "G5a", "G5b", "G5c", "G6a", "G6b", "G7", "G8", "G9a", "G9b", "G9c", "G10",
  "G11a", "G11b", "G11c",
];
const NOT_INSTRUMENTED = ["G5a", "G5c", "G6b", "G9a", "G9b", "G9c", "G11a", "G11c"];

function measured(r: GoalResult): GoalMeasured {
  if (r.status !== "measured") throw new Error(`expected measured, got ${r.status}: ${r.source}`);
  return r;
}
const byKey = (r: GoalMeasured) => Object.fromEntries((r.breakdown ?? []).map((b) => [b.key, b]));

describe("IPD goal queries — done means (E0.5, #717)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  async function ev(name: string, occurredAt: Date, payload: Record<string, unknown>, actorId = "U-TEST"): Promise<void> {
    await withTx(db, (tx) => appendEvent(tx, {
      name, version: 1, occurredAt, actor: { type: "user", id: actorId }, module: "ipd", payload, siteId: "main",
    }));
  }
  /** An IPD act: carries §0B provenance unless a test strips it. */
  const act = (name: string, occurredAt: Date, payload: Record<string, unknown>) =>
    ev(name, occurredAt, { provenance: "person", ...payload });

  async function bed(kind: string, code: string): Promise<string> {
    const id = newId();
    await db.execute(sql`insert into resources (id, kind, code, name, status, created_by, updated_by)
      values (${id}, ${kind}, ${code}, ${code}, 'available', 'U-TEST', 'U-TEST')`);
    return id;
  }
  async function move(resourceId: string, from: string, to: string, when: Date, reason: string | null = null): Promise<void> {
    await db.execute(sql`insert into resource_status_history (id, resource_id, from_status, to_status, reason, at, actor_id)
      values (${newId()}, ${resourceId}, ${from}, ${to}, ${reason}, ${when.toISOString()}::timestamptz, 'U-TEST')`);
  }
  async function note(status: string, when: Date, templateKey: string = IPD_GOAL_TEMPLATES.dailyTotals): Promise<void> {
    await db.execute(sql`insert into notifications (id, audience, template_key, params, dedupe_key, occurred_at, expires_at, status)
      values (${newId()}, 'patient', ${templateKey}, '{}'::jsonb, ${newId()}, ${when.toISOString()}::timestamptz,
              ${when.toISOString()}::timestamptz + interval '1 day', ${status})`);
  }
  const run = (id: string, groupBy?: "day") => IPD_GOAL_QUERIES[id]!.run(db, { from: FROM, to: TO, groupBy });

  it("names one query per goal and sub-measure, G1–G11, each with metric, unit, target data and window", () => {
    expect(Object.keys(IPD_GOAL_QUERIES)).toEqual(EXPECTED_IDS);
    for (const [id, q] of Object.entries(IPD_GOAL_QUERIES)) {
      expect([id, q.id, q.metric.length > 10, q.window.length > 0]).toEqual([id, id, true, true]);
    }
    expect(IPD_GOAL_QUERIES.G2!.target).toEqual([
      { measure: "median", op: "<=", value: 30, unit: "minutes" },
      { measure: "p90", op: "<=", value: 90, unit: "minutes" },
    ]);
  });

  it("an instrument event never retypes an event an intent already emits", () => {
    const intentEvents = new Set(Object.values(IPD_INTENTS).flatMap((d) => [...d.events]));
    for (const name of Object.values(IPD_GOAL_EVENTS)) expect([name, intentEvents.has(name)]).toEqual([name, false]);
    for (const name of Object.values(EV)) expect([name, intentEvents.has(name)]).toEqual([name, true]);
  });

  describe("on empty data (the M0 gate: every §6 query runs and returns 0 rows)", () => {
    beforeAll(async () => { await truncateAll(db); });

    it.each(EXPECTED_IDS)("%s returns no rows and a null value", async (id) => {
      const r = await run(id);
      expect(r.rows).toEqual([]);
      expect(r.value).toBeNull();
      if (r.status === "measured") expect((r.breakdown ?? []).every((b) => b.value === null || b.n === 0)).toBe(true);
    });

    it.each(NOT_INSTRUMENTED)("%s says which instrument is missing instead of a number", async (id) => {
      const r = await run(id);
      expect(r.status).toBe("not_instrumented");
      expect(r.status === "not_instrumented" && r.source.length > 10).toBe(true);
    });
  });

  describe("on seeded data in a fixed window", () => {
    beforeAll(async () => {
      await truncateAll(db);
      const [A1, A2, A3, A4, A6] = [newId(), newId(), newId(), newId(), newId()];

      // G1 census: two nights.
      await ev(IPD_GOAL_EVENTS.censusTaken, at("2026-03-02T18:30"), { censusDate: "2026-03-03", hmisAdmissions: 8, incumbentAdmissions: 2, incumbentOccupiedBeds: 40 });
      await ev(IPD_GOAL_EVENTS.censusTaken, at("2026-03-03T18:30"), { censusDate: "2026-03-04", hmisAdmissions: 10, incumbentAdmissions: 0, incumbentOccupiedBeds: 25 });

      // G2 request → bed.
      await act(EV.admissionRequested, at("2026-03-02T10:00"), { admissionId: A1, source: "opd_advice" });
      await act(EV.bedReserved, at("2026-03-02T10:20"), { admissionId: A1 }); // 20 min (first bed act wins)
      await act(EV.bedAssigned, at("2026-03-02T10:40"), { admissionId: A1 });
      await act(EV.admissionRequested, at("2026-03-03T09:00"), { admissionId: A2, source: "opd_advice" });
      await act(EV.bedAssigned, at("2026-03-03T10:00"), { admissionId: A2 }); // 60 min
      await act(EV.admissionRequested, at("2026-03-04T08:00"), { admissionId: A3, source: "direct" });
      await act(EV.admitted, at("2026-03-04T08:10"), { admissionId: A3 }); // 10 min
      await act(EV.admissionRequested, at("2026-03-05T08:00"), { admissionId: A4, source: "opd_advice" }); // no bed yet
      await act(EV.admissionRequested, at("2026-03-28T23:00"), { admissionId: A6, source: "opd_advice" });
      await act(EV.bedAssigned, at("2026-03-29T00:30"), { admissionId: A6 }); // found after the window

      // G3 bed turnaround.
      const b1 = await bed("bed", "B1");
      const b2 = await bed("bed", "B2");
      const b3 = await bed("bed", "B3");
      const room = await bed("room", "R1");
      await move(b1, "occupied", "cleaning", at("2026-03-02T12:00"), IPD_GOAL_CLEAN_REASONS.routine);
      await move(b1, "cleaning", "available", at("2026-03-02T12:30")); // routine 30
      await move(b2, "occupied", "cleaning", at("2026-03-03T09:00"), IPD_GOAL_CLEAN_REASONS.terminal);
      await move(b2, "cleaning", "available", at("2026-03-03T10:30")); // terminal 90
      await move(b1, "available", "occupied", at("2026-03-03T11:00"));
      await move(b1, "occupied", "cleaning", at("2026-03-04T14:00"), "discharge cascade");
      await move(b1, "cleaning", "available", at("2026-03-04T14:50")); // routine 50
      await move(b3, "occupied", "cleaning", at("2026-03-04T15:00"));
      await move(b3, "cleaning", "blocked", at("2026-03-04T15:20")); // not a turn
      await move(room, "occupied", "cleaning", at("2026-03-04T15:00"));
      await move(room, "cleaning", "available", at("2026-03-04T15:05")); // not a bed

      // G4 fit → gate. A2 is cashless (payer authorisation on file).
      await act(EV.fitDeclared, at("2026-03-10T09:00"), { admissionId: A1 });
      await act(EV.gatePassScanned, at("2026-03-10T11:00"), { admissionId: A1 }); // cash 120
      await act(EV.payerAuthRecorded, at("2026-03-03T11:00"), { admissionId: A2 });
      await act(EV.fitDeclared, at("2026-03-11T08:00"), { admissionId: A2 });
      await act(EV.fitDeclared, at("2026-03-11T10:00"), { admissionId: A2 }); // re-declared: the clock restarts
      await act(EV.gatePassScanned, at("2026-03-11T14:00"), { admissionId: A2 }); // cashless 240
      await act(EV.fitDeclared, at("2026-03-12T10:00"), { admissionId: A3 });
      await act(EV.gatePassScanned, at("2026-03-12T13:00"), { admissionId: A3 }); // cash 180
      for (const [a, d] of [[A1, "10"], [A2, "11"], [A3, "12"]] as const) {
        await act(EV.discharged, at(`2026-03-${d}T14:00`), { admissionId: a });
      }

      // G5b rent lines: A1 03-05 twice, A1 03-06 once, A2 03-05 three times.
      for (const [a, d] of [[A1, "2026-03-05"], [A1, "2026-03-05"], [A1, "2026-03-06"], [A2, "2026-03-05"], [A2, "2026-03-05"], [A2, "2026-03-05"]] as const) {
        await act(IPD_GOAL_EVENTS.rentPosted, at(`${d}T18:30`), { admissionId: a, rentDate: d, chargeLineId: newId() });
      }

      // G6a doses: three scanned, one override.
      for (let i = 0; i < 3; i++) {
        await act(EV.doseGiven, at(`2026-03-06T0${i}:00`), { admissionId: A1, patientCheck: { kind: "scan", wristbandCode: "W1" }, labelCode: "L1", wardId: "W-MED" });
      }
      await act(EV.doseGiven, at("2026-03-06T04:00"), {
        admissionId: A1, patientCheck: { kind: "override", overrideReason: "scanner_down", note: "x" }, labelCode: "L1", wardId: "W-MED",
      });

      // G7 early-warning breaches.
      const [x1, x2, x3, x4] = ["X1", "X2", "X3", "X4"];
      await ev(IPD_GOAL_EVENTS.ewsBreached, at("2026-03-08T10:00"), { alertId: x1, admissionId: A1 });
      await ev(IPD_GOAL_EVENTS.ewsAcknowledged, at("2026-03-08T10:20"), { alertId: x1, byKind: "doctor" }); // hit
      await ev(IPD_GOAL_EVENTS.ewsBreached, at("2026-03-08T11:00"), { alertId: x2, admissionId: A1 });
      await ev(IPD_GOAL_EVENTS.ewsAcknowledged, at("2026-03-08T11:45"), { alertId: x2, byKind: "doctor" }); // 45 min: miss
      await ev(IPD_GOAL_EVENTS.ewsBreached, at("2026-03-08T12:00"), { alertId: x3, admissionId: A1 });
      await ev(IPD_GOAL_EVENTS.ewsAcknowledged, at("2026-03-08T12:05"), { alertId: x3, byKind: "nurse" }); // not a doctor: miss
      await ev(IPD_GOAL_EVENTS.ewsBreached, at("2026-03-08T13:00"), { alertId: x4, admissionId: A1 });
      await ev(IPD_GOAL_EVENTS.ewsAcknowledged, at("2026-03-08T13:30"), { alertId: x4, byKind: "resident" }); // exactly 30: hit

      // G8 timing.
      for (const [intent, durationMs, taps, inputMode] of [
        ["admit", 180_000, 6, "typed"], ["admit", 300_000, 9, "typed"], ["admit", 240_000, 8, "typed"],
        ["administer_dose", 12_000, 2, "scan"], ["administer_dose", 18_000, 3, "scan"],
        ["record_vitals", 20_000, 7, "typed"], ["record_vitals", 8_000, 1, "voice"], ["record_vitals", 12_000, 1, "voice"],
      ] as const) {
        await ev(IPD_GOAL_EVENTS.intentTimed, at("2026-03-09T10:00"), { intent, durationMs, taps, inputMode });
      }

      // G10 family messages.
      for (const s of ["sent", "sent", "sent", "undeliverable", "queued", "suppressed"]) await note(s, at("2026-03-07T03:30"));
      await note("sent", at("2026-03-07T03:30"), "lab.report_ready"); // another template
      await ev(IPD_GOAL_EVENTS.trackerOpened, at("2026-03-10T13:00"), { admissionId: A1 }, "P-FAMILY");

      // G11b: two defective acts — no provenance, and a blank actor.
      await ev(EV.admissionRequested, at("2026-03-20T10:00"), { admissionId: newId(), source: "direct" });
      await ev(EV.admissionRequested, at("2026-03-20T11:00"), { admissionId: newId(), source: "direct", provenance: "person" }, " ");
    });

    it("G1: 18 of 20 new admissions in HMIS = 90 %; latest incumbent beds 25", async () => {
      const r = measured(await run("G1"));
      expect([r.value, r.numerator, r.denominator]).toEqual([90, 18, 20]);
      expect(byKey(r).incumbent_beds_latest?.value).toBe(25);
    });

    it("G2: [10, 20, 60] → median 20, p90 52; opd_advice [20, 60] → 40 / 56; direct 10", async () => {
      const r = measured(await run("G2"));
      expect([r.value, r.p90, r.denominator]).toEqual([20, 52, 3]);
      expect(byKey(r)).toEqual({
        direct: { key: "direct", value: 10, p90: 10, n: 1 },
        opd_advice: { key: "opd_advice", value: 40, p90: 56, n: 2 },
      });
      expect(r.rows).toHaveLength(3);
    });

    it("G2 by day: one key per IST day the bed was found", async () => {
      const r = measured(await run("G2", "day"));
      expect((r.breakdown ?? []).map((b) => [b.key, b.value])).toEqual([
        ["2026-03-02", 20], ["2026-03-03", 60], ["2026-03-04", 10],
      ]);
    });

    it("G3: beds only, cleaning → available; routine [30, 50] → 40, terminal 90; overall median 50, p90 82", async () => {
      const r = measured(await run("G3"));
      expect([r.value, r.p90, r.denominator]).toEqual([50, 82, 3]);
      expect(byKey(r)).toEqual({
        routine: { key: "routine", value: 40, p90: 48, n: 2 },
        terminal: { key: "terminal", value: 90, p90: 90, n: 1 },
      });
    });

    it("G4: fit (latest before the scan) → gate; cash [120, 180] → 150, cashless 240; overall 180", async () => {
      const r = measured(await run("G4"));
      expect([r.value, r.denominator]).toEqual([180, 3]);
      expect(Object.fromEntries((r.breakdown ?? []).map((b) => [b.key, [b.value, b.n]]))).toEqual({ cash: [150, 2], cashless: [240, 1] });
    });

    it("G5b: 6 rent lines, two (admission, night) pairs repeated → 1 + 2 = 3 duplicate lines", async () => {
      const r = measured(await run("G5b"));
      expect([r.value, r.denominator, r.rows.length]).toEqual([3, 6, 2]);
    });

    it("G6a: 3 of 4 doses scanned (band + label) = 75 %; the override is the row to chase", async () => {
      const r = measured(await run("G6a"));
      expect([r.value, r.numerator, r.denominator, r.rows.length]).toEqual([75, 3, 4, 1]);
      expect(byKey(r)["W-MED"]?.value).toBe(75);
    });

    it("G7: breaches acked by a doctor within 30 min (inclusive) — X1, X4 of four = 50 %", async () => {
      const r = measured(await run("G7"));
      expect([r.value, r.numerator, r.denominator, r.rows.length]).toEqual([50, 2, 4, 2]);
    });

    it("G8: admit median 4 min and 8 taps; dose 15 s; vitals typed 20 s, voice 10 s", async () => {
      const r = measured(await run("G8"));
      expect(r.value).toBe(4);
      const k = byKey(r);
      expect([k.admit_minutes?.value, k.admit_taps?.value, k.dose_seconds?.value, k.vitals_typed_seconds?.value, k.vitals_voice_seconds?.value])
        .toEqual([4, 8, 15, 20, 10]);
    });

    it("G10: daily totals sent 3 of 4 settled (queued and suppressed excluded) = 75 %; tracker opened 1 of 3 discharges", async () => {
      const r = measured(await run("G10"));
      expect([r.value, r.numerator, r.denominator]).toEqual([75, 3, 4]);
      expect([byKey(r).tracker_opened?.value, byKey(r).tracker_opened?.n]).toEqual([33.33, 3]);
    });

    it("G11b: acts without actor or provenance — exactly the two seeded", async () => {
      const r = measured(await run("G11b"));
      expect([r.value, r.rows.length]).toEqual([2, 2]);
      expect(r.denominator).toBeGreaterThan(20);
    });

    it.each(NOT_INSTRUMENTED)("%s stays not instrumented with data present", async (id) => {
      expect((await run(id)).status).toBe("not_instrumented");
    });
  });
});
