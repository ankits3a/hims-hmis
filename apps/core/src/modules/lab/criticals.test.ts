import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { events, labAnalytes, labCriticalCalls } from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import {
  acknowledgeCritical, CRITICAL_CALL_TARGET_MINUTES, nextRung, openCriticalCalls, RUNGS,
} from "./criticals";
import { deskOrder } from "./desk";
import { chooseReportedResult, enterResult, LAB_RESULTS_INTERFACE } from "./results";
import { printLabels } from "./specimens";
import type { CriticalAttempt } from "./criticals";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T6 / DD12 — **THE CALL LADDER**, which is A5's second half: the call is opened at ENTRY
 * (asserted in `results.test.ts`) and closes on a READ-BACK and on nothing else (asserted here).
 *
 * 02 §3.6 is the whole rule. A register that closed on an ATTEMPT would report a hospital in which
 * every critical value reached a clinician, which is exactly the claim the read-back exists to make
 * true rather than to assume.
 */
const AT = new Date("2026-08-30T20:30:00Z");

describe("lab critical calls (17b T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  /** An RFT tube received and ready for a potassium, and the `K` analyte it reports. */
  async function receivedRftItem(): Promise<{ orderItemId: string; analyteId: string }> {
    const serviceIds = [serviceIdForLabCode("RFT")];
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: serviceIds.map((serviceId) => ({ serviceId })),
      credit: { reason: "counter order" }, placedAt: AT,
    }, AT));
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
    }, AT);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }, AT));
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, AT));
    }
    const [k] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "K"));
    return { orderItemId: placed.itemIds[0]!, analyteId: k!.id };
  }

  /** A potassium of 6.8 at 02:00 IST, keyed by the technologist who is alone (E34 / 02 F1). */
  async function criticalCall(): Promise<{ callId: string; resultId: string }> {
    const { orderItemId, analyteId } = await receivedRftItem();
    const entered = await enterResult(db, fx.bench.actor, {
      orderItemId, analyteId, value: "6.8", entryMode: "manual",
    }, AT);
    return { callId: entered.criticalCallId!, resultId: entered.resultId };
  }

  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  it("three failed attempts leave the call OPEN and on the handover list", async () => {
    const { callId } = await criticalCall();

    for (const outcome of ["no_answer", "engaged", "message_left"] as const) {
      const out = await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
        callId, attempt: { contact: "ward 3 extension 214", outcome },
      }, AT));
      expect(out.closed).toBe(false);
    }

    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    expect((call!.attempts as CriticalAttempt[]).map((a) => a.outcome))
      .toEqual(["no_answer", "engaged", "message_left"]);
    expect([call!.closedAt, call!.readbackText, call!.closedBy]).toEqual([null, null, null]);
    expect(await openCriticalCalls(db, fx.bench.actor)).toHaveLength(1);
    expect(await eventsNamed("lab.critical_acknowledged")).toHaveLength(0);
  });

  it("a READ-BACK closes it, names the closer, and counts the attempts it took", async () => {
    const { callId, resultId } = await criticalCall();
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId, attempt: { contact: "ward 3 extension 214", outcome: "no_answer" },
    }, AT));

    const out = await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId,
      attempt: { contact: "Dr Rao, mobile", outcome: "spoke" },
      readback: "potassium six point eight, repeat sample sent",
    }, AT));
    expect([out.closed, out.attempts]).toEqual([true, 2]);

    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    expect(call!.closedBy).toBe(fx.bench.id);
    expect(call!.readbackText).toBe("potassium six point eight, repeat sample sent");
    expect(await openCriticalCalls(db, fx.bench.actor)).toHaveLength(0);

    const acked = await eventsNamed("lab.critical_acknowledged");
    expect(acked).toHaveLength(1);
    expect(acked[0]!.payload).toMatchObject({ callId, resultId, attempts: 2 });
  });

  it("a second read-back is refused critical_already_closed — not a borrowed already_verified", async () => {
    const { callId } = await criticalCall();
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId, readback: "six point eight",
    }, AT));
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, fx.pathologist.actor, {
      callId, readback: "six point eight, again",
    }, AT))).rejects.toMatchObject({ code: "critical_already_closed" });

    const [call] = await db.select().from(labCriticalCalls).where(eq(labCriticalCalls.id, callId));
    /** The FIRST closer stands — a second read-back does not overwrite who answered the telephone. */
    expect(call!.closedBy).toBe(fx.bench.id);
    expect(await eventsNamed("lab.critical_acknowledged")).toHaveLength(1);
  });

  it("a blank read-back with no attempt records nothing, and a caller without the grant is refused", async () => {
    const { callId } = await criticalCall();
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, { callId }, AT)))
      .rejects.toMatchObject({ code: "catalogue_invalid" });
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId, readback: "   ",
    }, AT))).rejects.toMatchObject({ code: "catalogue_invalid" });

    const stranger = await mkUser(db, "ward.clerk2", ["nurse"]);
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, stranger.actor, {
      callId, readback: "six point eight",
    }, AT))).rejects.toMatchObject({ code: "permission_denied" });

    expect(await openCriticalCalls(db, fx.bench.actor)).toHaveLength(1);
  });

  /* ═══════ 17d T3 — THE LADDER IS NAMED AND THE CLOCK IS VISIBLE (design EdgeCases #17) ═══════ */

  /**
   * The board's case: *"Potassium 6.8 at 21:10; OPD over, ordering doctor's phone off."* The call
   * opened itself and every attempt was logged — and the technologist was left dialling ONE number
   * with nothing saying who to try next.
   */
  it("17d T3: `nextRung` walks down the ladder, and only SPEAKING to somebody retires their rung", () => {
    // MUTANT: counting any attempt as retiring the rung — three unanswered rings would "finish" the
    // ordering doctor, which is the exact distinction 02 §3.6 draws between an attempt and an
    // acknowledgement.
    expect(nextRung([])).toBe("ordering_clinician");
    expect(nextRung([
      { at: AT.toISOString(), by: "u", contact: "mobile", outcome: "no_answer", rung: "ordering_clinician" },
      { at: AT.toISOString(), by: "u", contact: "mobile", outcome: "engaged", rung: "ordering_clinician" },
      { at: AT.toISOString(), by: "u", contact: "ward clerk", outcome: "message_left", rung: "ordering_clinician" },
    ])).toBe("ordering_clinician");

    expect(nextRung([
      { at: AT.toISOString(), by: "u", contact: "mobile", outcome: "spoke", rung: "ordering_clinician" },
    ])).toBe("duty_officer");

    /** Every rung spoken to and the call still open is a REAL state: the read-back is not keyed yet. */
    expect(nextRung(RUNGS.map((rung) => (
      { at: AT.toISOString(), by: "u", contact: "x", outcome: "spoke" as const, rung }
    )))).toBeNull();

    /** A pre-17d row carries no rung at all and must not retire one by accident. */
    expect(nextRung([{ at: AT.toISOString(), by: "u", contact: "x", outcome: "spoke" }]))
      .toBe("ordering_clinician");
  });

  it("17d T3: the open ladder carries the rung to try, the minutes open and the advisory target", async () => {
    const { callId } = await criticalCall();
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId, attempt: { contact: "Dr Rao, mobile", outcome: "no_answer", rung: "ordering_clinician" },
    }, AT));

    const [open] = await openCriticalCalls(db, fx.bench.actor, new Date(AT.getTime() + 22 * 60_000));
    expect(open!.attempts[0]!.rung).toBe("ordering_clinician");
    // Unanswered: the doctor's rung is NOT retired, so the ladder still points at them.
    expect(open!.nextRung).toBe("ordering_clinician");
    expect([open!.minutesOpen, open!.targetMinutes]).toEqual([22, CRITICAL_CALL_TARGET_MINUTES]);

    await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId, attempt: { contact: "Dr Rao, mobile", outcome: "spoke", rung: "ordering_clinician" },
    }, AT));
    const [after] = await openCriticalCalls(db, fx.bench.actor, AT);
    expect(after!.nextRung).toBe("duty_officer");
  });

  /**
   * D5 — THE TARGET REFUSES NOTHING. A technologist holding a potassium of 6.8 is never told by
   * software that they may not make a phone call, and the ladder never blocks the read-back either.
   */
  it("17d T3 / D5: a call far past its target still accepts every rung and still closes", async () => {
    const { callId } = await criticalCall();
    const late = new Date(AT.getTime() + 5 * 60 * 60_000);
    const out = await withTx(db, (tx) => acknowledgeCritical(tx, fx.bench.actor, {
      callId,
      attempt: { contact: "the patient's son", outcome: "spoke", rung: "patient_or_attendant" },
      readback: "six point eight, coming to casualty now",
    }, late));
    expect(out.closed).toBe(true); // THE KILL: a clock that became a gate
  });

  /* ──────── 17-E T7 — the SECOND way a ladder value stops being current ──────── */

  /**
   * **F17 READS SUPERSESSION, AND A MACHINE'S RERUN NEVER SUPERSEDES.**
   *
   * `openCriticalCalls` computes its retraction from `supersedes_result_id` alone. That was complete
   * when the only way to replace a value was a human re-keying it. 17-E T7 added a second way and it
   * writes NULL in that column on purpose: an analyser re-running a tube leaves both runs live, and
   * the bench chooses between them with a reason.
   *
   * So against the code this assertion guards: a call opens on a potassium of 6.8, the analyser
   * re-runs at 4.2, the bench formally chooses the 4.2 — and the ladder still shows 6.8 with
   * `supersededBy: null`. **The person on the telephone reports a number the laboratory has decided
   * the report will not carry**, which is the exact failure F17 exists to prevent, reached by a path
   * F17 cannot see.
   *
   * The retraction is rendered (`lab-bench.tsx`, `lab.bench.retracted`), so this is a gap in the
   * computation and not a missing surface.
   */
  it("17-E T7: a call on the run the bench REJECTED shows the chosen value as its retraction", async () => {
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", "lab.criticals.close");
    const bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    const { orderItemId, analyteId } = await receivedRftItem();

    /** The machine's first run — critical, so the ladder opens on it. */
    const first = await enterResult(db, bridge.actor, {
      orderItemId, analyteId, value: "6.8", entryMode: "interface",
    }, AT);
    expect(first.criticalCallId).not.toBeNull();

    /** The repeat. No supersession: both runs live, which is D9/Q5 and is asserted in rerun-choice. */
    const second = await enterResult(db, bridge.actor, {
      orderItemId, analyteId, value: "4.2", entryMode: "interface",
    }, new Date(AT.getTime() + 600_000));

    /**
     * BEFORE THE CHOICE THERE IS NO RETRACTION, and that is right: both runs are candidates and the
     * laboratory has not rejected either. A ladder that cried "retracted" here would be telling the
     * caller to stand down on a decision nobody had made.
     */
    const before = await openCriticalCalls(db, fx.bench.actor);
    expect(before).toHaveLength(1);
    expect({ value: before[0]!.value, retracted: before[0]!.supersededBy }).toEqual({
      value: "6.8000", retracted: null,
    });

    /** The bench chooses the repeat, with the reason the server requires. */
    await chooseReportedResult(db, fx.bench.actor, {
      resultId: second.resultId,
      reason: "first run drawn from the cannulated arm, repeat from the other side",
    });

    /**
     * **THE KILL.** The ladder must now say the value it is about is not the one being reported.
     *
     * `flag: null` on the retraction is the SEED's range book, not a lost flag: `flagFor` returns
     * null when a range carries no low/high, and the catalogue gives `K` critical bands without a
     * reference band — which is also why 6.8 reads `HH` and 4.2 reads nothing. The VALUE is the
     * load-bearing half here; the flag is asserted so a successor who gives `K` a reference range
     * sees this line rather than discovering the coupling from a mystery failure.
     */
    const after = await openCriticalCalls(db, fx.bench.actor);
    expect(after).toHaveLength(1);
    expect({ value: after[0]!.value, retracted: after[0]!.supersededBy }).toEqual({
      value: "6.8000",
      retracted: { value: "4.2000", flag: null },
    });
  });
});
