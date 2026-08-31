import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdVitals } from "../../kernel/db/schema";
import { joinQueue, openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";
import type { Readings } from "./vitals-rules";

/**
 * ═══ VD-1 T2 — THE FOUR SANITY GATES, THROUGH THE SERVICE ═══
 *
 * The pure predicates are proved in `vitals-rules.test.ts`. What is proved HERE is the property
 * the whole task exists for: **the number the gate refused is not in the table.** A gate that
 * returns the right verdict and lets the row land anyway is worth nothing, and the only way to
 * know which happened is to select the row afterwards — so every leg below does.
 *
 * The two specimens are real. `4.8` is Savitri Devi's weight at Bay 01 with a dead scale, typed
 * for 48; `45` is an SpO₂ off a cold finger on a patient who is talking. Both were chart facts on
 * the ordinary path before this file existed.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const TUE = new Date("2026-08-18T04:00:00.000Z");
const DOB_ELDERLY = new Date(Date.UTC(1954, 0, 15)); // exactly 72 at MON
const DOB_CHILD = new Date(Date.UTC(2023, 0, 15)); // exactly 3 at MON
const adultOk = { heightCm: 151, weightKg: 49.2, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("VD-1 T2 — the sanity gates", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let savitri: { id: string; uhid: string };
  let child: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    savitri = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ELDERLY });
    child = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_CHILD, guardian: { name: "G", relationship: "mother" } });
  });

  const visit = async (patientId: string, at: Date): Promise<string> =>
    (await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at)).encounter.id;
  const rowsFor = async (encounterId: string): Promise<unknown[]> =>
    db.select().from(opdVitals).where(eq(opdVitals.encounterId, encounterId));

  it("the slipped digit: 4.8 kg on a 72-year-old is refused, lands NOTHING, and names the number meant", async () => {
    const enc = await visit(savitri.id, MON);
    await expect(recordVitals(db, vd.actor, enc, { ...adultOk, weightKg: 4.8 }, MON))
      .rejects.toMatchObject({
        code: "vitals_gate",
        detail: { gates: [{ key: "weightKg", kind: "slipped_digit", value: 4.8, suggestion: 48 }] },
      });
    expect(await rowsFor(enc)).toHaveLength(0);

    // The override is a named human disagreeing, and the value is then recorded WITH the
    // disagreement rather than quietly accepted.
    const r = await recordVitals(db, vd.actor, enc, { ...adultOk, weightKg: 4.8 }, MON, {
      overrides: { weightKg: "confirmed_real" },
    });
    expect(r.vitals.weightKg).toBe(4.8);
    expect((r.vitals.readings as Readings).weightKg!.note).toContain("override: confirmed_real");
  });

  it("the gate is ABOVE the paediatric bands — a 14 kg three-year-old is not a slipped digit", async () => {
    const enc = await visit(child.id, MON);
    const r = await recordVitals(db, vd.actor, enc, { heightCm: 92, weightKg: 14, tempC: 37.2, spo2: 98, pulse: 100, muacCm: 13.4 }, MON);
    expect(r.vitals.weightKg).toBe(14);
  });

  it("the probe error: 45 % never reaches the chart column or the flags, and IS in the log", async () => {
    const enc = await visit(savitri.id, MON);
    // A re-clip that reads 94: the 94 is charted, the 45 is held beside it.
    const r = await recordVitals(db, vd.actor, enc, { ...adultOk }, MON, {
      readings: {
        bp: { takes: [[120, 80]], source: "device" },
        spo2: { takes: [45, 94], source: "device" },
        pulse: { takes: [72], source: "device" }, tempC: { takes: [37.0], source: "device" },
        heightCm: { takes: [151], source: "typed" }, weightKg: { takes: [49.2], source: "typed" },
      },
    });
    expect(r.vitals.spo2).toBe(94);
    expect(r.flags).toEqual([]); // 45 would have been a danger flag — it is not a reading
    const stored = r.vitals.readings as Readings;
    expect(stored.spo2!.takes).toEqual([94]);
    expect(stored.spo2!.held).toEqual([45]);
  });

  it("a probe error with NO surviving take makes the save incomplete — you cannot chart it, and you cannot skip it", async () => {
    const enc = await visit(savitri.id, MON);
    await expect(recordVitals(db, vd.actor, enc, { ...adultOk, spo2: 45 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["spo2"] } });
    expect(await rowsFor(enc)).toHaveLength(0);

    const r = await recordVitals(db, vd.actor, enc, { ...adultOk, spo2: 45 }, MON, { overrides: { spo2: "confirmed_real" } });
    expect(r.vitals.spo2).toBe(45);
    expect(r.flags).toContainEqual({ vital: "spo2", value: 45, bound: "min", limit: 90 });
  });

  it("the shrinking adult: a height 4 cm from the last recorded one is held, then keeps BOTH numbers", async () => {
    const first = await visit(savitri.id, MON);
    await recordVitals(db, vd.actor, first, adultOk, MON); // 151 cm on record

    const second = await visit(savitri.id, TUE);
    await expect(recordVitals(db, vd.actor, second, { ...adultOk, heightCm: 147 }, TUE))
      .rejects.toMatchObject({
        code: "vitals_gate",
        detail: { gates: [{ key: "heightCm", kind: "shrinking_adult", value: 147, suggestion: 151 }] },
      });
    expect(await rowsFor(second)).toHaveLength(0);

    const r = await recordVitals(db, vd.actor, second, { ...adultOk, heightCm: 147 }, TUE, {
      overrides: { heightCm: "confirmed_after_remeasure" },
    });
    expect(r.vitals.heightCm).toBe(147);
  });

  it("the carried lock: a carried key must arrive with the carried NUMBER, or name a preset reason", async () => {
    const first = await visit(savitri.id, MON);
    await recordVitals(db, vd.actor, first, adultOk, MON);

    const second = await visit(savitri.id, TUE);
    const carried = { carriedForward: ["heightCm" as const] };
    // Carrying the value it actually is: fine, and it is not "missing" either.
    const ok = await recordVitals(db, vd.actor, second, { ...adultOk, heightCm: 151 }, TUE, carried);
    expect(ok.vitals.carriedForward).toEqual(["heightCm"]);

    // A DIFFERENT number under a carry-forward claim is the lock, and it fires ahead of the
    // shrinking-adult gate — "why is this changing" is asked before "is this number real".
    const third = await visit(savitri.id, TUE);
    await expect(recordVitals(db, vd.actor, third, { ...adultOk, heightCm: 147 }, TUE, carried))
      .rejects.toMatchObject({ code: "carried_value_locked", detail: { locked: [{ key: "heightCm", carried: 151, supplied: 147 }] } });
    expect(await rowsFor(third)).toHaveLength(0);

    // Unlocked with a preset reason, the OLD value stays beside the new one on the reading.
    const r = await recordVitals(db, vd.actor, third, { ...adultOk, heightCm: 147 }, TUE, {
      ...carried,
      unlockReasons: { heightCm: "yearly_remeasure_due" },
      overrides: { heightCm: "confirmed_after_remeasure" },
    });
    expect(r.vitals.heightCm).toBe(147);
    expect((r.vitals.readings as Readings).heightCm!.note).toContain("unlocked: yearly_remeasure_due (was 151)");
  });

  /**
   * ═══ THE BILL-FIRST WALK-IN, FOUND BY THE RC-1 LANE'S CLOSE REVIEWER ═══
   *
   * Not this phase's defect and squarely this phase's file. `POST /opd/walk-in {join:"defer"}`
   * opens a `registered` encounter with NO queue entry; `listVisits` has no queue join, so that
   * visit shows up on the vitals worklist; and `recordVitals` dereferenced the absent entry.
   *
   * The leg that matters is the second assertion, not the first: a refusal that still wrote a row
   * would be the worse bug, because the vitals would exist on a patient the doctor can never be
   * shown. Both halves are asserted, and then the ordinary path is proved to still work once the
   * token exists — a guard that refuses everybody is not a fix.
   */
  it("a deferred bill-first visit is refused by name — and writes nothing — until it joins a queue", async () => {
    const deferred = await openVisit(
      db, clerk.actor,
      { patientId: savitri.id, departmentId: deptId, doctorId: dra.doctorId, join: "defer" }, MON,
    );
    expect(deferred.queueEntry).toBeNull();
    expect(deferred.tokenNo).toBeNull();

    await expect(recordVitals(db, vd.actor, deferred.encounter.id, adultOk, MON))
      .rejects.toMatchObject({ code: "unknown_queue_entry" });
    expect(await rowsFor(deferred.encounter.id)).toHaveLength(0);

    // …and the same visit records normally the moment billing releases its token.
    await joinQueue(db, clerk.actor, deferred.encounter.id, MON);
    const r = await recordVitals(db, vd.actor, deferred.encounter.id, adultOk, MON);
    expect(r.vitals.sbp).toBe(120);
    expect(r.encounter.status).toBe("waiting");
  });
});