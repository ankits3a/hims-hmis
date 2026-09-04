import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, labAnalytes, labCriticalCalls } from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import { acknowledgeCritical, openCriticalCalls } from "./criticals";
import { deskOrder } from "./desk";
import { enterResult } from "./results";
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

  /** A potassium of 6.8 at 02:00 IST, keyed by the technologist who is alone (E34 / 02 F1). */
  async function criticalCall(): Promise<{ callId: string; resultId: string }> {
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
    const entered = await enterResult(db, fx.bench.actor, {
      orderItemId: placed.itemIds[0]!, analyteId: k!.id, value: "6.8", entryMode: "manual",
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
});
