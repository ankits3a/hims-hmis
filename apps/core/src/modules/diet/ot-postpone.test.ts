import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dietNpo, events } from "../../kernel/db/schema";
import { mkOtPatient, seedOtBase } from "../../../test/helpers/ot";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ist } from "../../../test/helpers/diet";
import { bookCase, cancelCase, postponeCase } from "../ot";
import { npoAt } from "../ipd";
import { backfillOtNpo, handleDietEvent, istDayStart } from "./index";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";

/**
 * An OT postponement (a new list date) is an EVENT of its own (`case.postponed`): diet's consumer moves the case's NPO
 * to the new day at once — not only when that day's list is published — and the eMAR's NPO (`npoAt`, read on
 * `diet_npo`) follows. A cancellation lifts it. Explicit IST instants; nothing reads the real clock.
 */
jest.setTimeout(240_000);

/** The newest appended event of a name, as the dispatcher would hand it to a consumer. */
async function dispatched(db: Db, name: string): Promise<DispatchedEvent> {
  const rows = (await db.select().from(events).where(eq(events.name, name))).sort((a, b) => Number(b.seq) - Number(a.seq));
  const e = rows[0];
  if (e === undefined) throw new Error(`no ${name} event was appended`);
  return { seq: e.seq, eventId: randomUUID(), name: e.name, payload: e.payload, patientId: e.patientId, correlationId: null, occurredAt: e.occurredAt } as DispatchedEvent;
}

describe("OT postpone → NPO moves (diet consumer, eMAR follows)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  it("a postponement emits case.postponed; the consumer shifts the NPO to the new day; a cancellation lifts it", async () => {
    await truncateAll(db);
    const f = await seedOtBase(db);
    const patientId = await mkOtPatient(db, f.coordinator, "Kamla Devi");
    const kase = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc", surgeonId: f.surgeon.id, listDate: "2026-09-02", payerClass: "self_pay",
    });
    const now = ist("2026-09-01T10:00:00");
    await backfillOtNpo(db, now);
    expect(await npoAt(db, patientId, ist("2026-09-02T09:00:00"))).toMatchObject({ source: "ot_booking" });

    await postponeCase(db, f.coordinator, { caseId: kase.caseId, reason: "patient_unfit", newListDate: "2026-09-05" });
    const postponed = await dispatched(db, "case.postponed");
    expect(postponed.payload).toMatchObject({ caseId: kase.caseId, patientId, fromListDate: "2026-09-02", newListDate: "2026-09-05", reason: "patient_unfit" });

    await handleDietEvent(db, postponed, now);
    const rows = await db.select().from(dietNpo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startsAt.toISOString()).toBe(istDayStart("2026-09-05").toISOString());
    // The eMAR reads the same row: no NPO on the old day, NPO (from the OT booking) on the new one.
    expect(await npoAt(db, patientId, ist("2026-09-02T09:00:00"))).toBeNull();
    expect(await npoAt(db, patientId, ist("2026-09-05T09:00:00"))).toMatchObject({ source: "ot_booking" });
    // A redelivery writes nothing new.
    await handleDietEvent(db, postponed, now);
    expect(await db.select().from(dietNpo)).toHaveLength(1);

    await cancelCase(db, f.coordinator, { caseId: kase.caseId, reason: "patient declined", attribution: "patient" });
    await handleDietEvent(db, await dispatched(db, "case.cancelled"), now);
    expect(await npoAt(db, patientId, ist("2026-09-05T09:00:00"))).toBeNull();
    // A late redelivery of the postponement after the cancel does not bring the NPO back (the consumer re-reads the case).
    await handleDietEvent(db, postponed, now);
    expect(await npoAt(db, patientId, ist("2026-09-05T09:00:00"))).toBeNull();
  });
});
