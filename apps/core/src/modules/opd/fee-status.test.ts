import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantCreditExtend, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { allocateReceipt, encounterFeeStatuses, issueInvoice, recordReceipt, registerFeeSettledHook } from "../billing";
import { events } from "../../kernel/db/schema";
import { joinQueue, openVisit } from "./encounters";
import { queueFeeSettledHook } from "./queue";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * RC-1 T3 / D1+D2 — THE STAMP IS THE LEDGER, READ; THE FLIP IS THE LEDGER, NARRATED.
 *
 * `encounterFeeStatuses` is the one projection (free · settled · credit · unsettled), and the
 * assertion book's discriminator is here by execution: an encounter whose only settled invoice
 * carries a NON-FEE service stays `unsettled` — a projection reading "any invoice exists" dies on
 * exactly that input. The flip half registers OPD's real hook and proves `queue.fee_settled`
 * appends when a live token's fee settles, and does NOT append for a pharmacy-only invoice or a
 * deferred visit with no token on the board.
 */
describe("RC-1 T3 — fee status projection and the board flip", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Actor;
  let deptId: string;
  let roomId: string;
  let doctorId: string;
  let unregister: () => void;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // The production wiring is `opd.module.ts`'s onModuleInit; a unit suite registers the same
    // hook by hand (the registerOpdEncounterResolver precedent).
    unregister = registerFeeSettledHook("opd_queue_flip", queueFeeSettledHook);
  });
  afterAll(async () => {
    unregister();
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    base = await seedBillingBase(db);
    clerk = (await mkUser(db, "fs_clerk", ["front_office", "cashier"])).actor;
    ({ doctorId } = await mkDoctor(db, { username: "fs_dr", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
    await openSessionFor(db, { id: clerk.id }, 200_000);
  });

  const newVisit = async (phone: string) => {
    const patient = await mkPatient(db, clerk, { phone });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId });
    return { patientId: patient.id, encounter: opened.encounter, tokenNo: opened.tokenNo };
  };
  const payFee = (patientId: string, encounterId: string, draftId: string) =>
    issueInvoice(db, clerk, {
      draftId, patientId, encounterId,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    });
  const flips = async () => db.select().from(events).where(eq(events.name, "queue.fee_settled"));

  it("the projection: unsettled → settled on payment; revisit is free; a synthetic batch answers in one call", async () => {
    const v = await newVisit("9899100001");
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");

    await payFee(v.patientId, v.encounter.id, "fs-d1");
    const after = await encounterFeeStatuses(db, [
      v.encounter,
      { id: "revisit-synthetic", visitType: "revisit" }, // the free branch needs no row at all
    ]);
    expect(after.get(v.encounter.id)).toBe("settled");
    expect(after.get("revisit-synthetic")).toBe("free");
  });

  it("A-b discriminator: a SETTLED invoice for a NON-FEE service leaves the fee unsettled", async () => {
    const v = await newVisit("9899100002");
    await issueInvoice(db, clerk, {
      draftId: "fs-d2", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 59_000 }] }, // 50,000 + 12% GST → settled
    });
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");
    // …and the flip hook, fed by that very settle, appended NOTHING for the token.
    expect(await flips()).toHaveLength(0);
  });

  it("credit extension reads as credit, and flips the board the moment it is extended", async () => {
    await grantCreditExtend(db, "cashier");
    const v = await newVisit("9899100003");
    await issueInvoice(db, clerk, {
      draftId: "fs-d3", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "employer letter on file" },
    });
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("credit");
    const flipped = await flips();
    expect(flipped).toHaveLength(1);
    expect((flipped[0]!.payload as { status: string; via: string; tokenNo: number })).toMatchObject({
      status: "credit", via: "credit_extended", tokenNo: v.tokenNo,
    });
  });

  it("the flip: paying a live token's fee appends queue.fee_settled with the token and doctor-day", async () => {
    const v = await newVisit("9899100004");
    await payFee(v.patientId, v.encounter.id, "fs-d4");
    const flipped = await flips();
    expect(flipped).toHaveLength(1);
    const p = flipped[0]!.payload as { tokenNo: number; doctorId: string; status: string; via: string };
    expect(p.tokenNo).toBe(v.tokenNo);
    expect(p.doctorId).toBe(doctorId);
    expect(p.status).toBe("settled");
    expect(p.via).toBe("invoice");
  });

  it("a DEFERRED visit settling flips nothing — its token is born PAID at joinQueue instead", async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899100005" });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    await payFee(patient.id, opened.encounter.id, "fs-d5");
    expect(await flips()).toHaveLength(0); // nothing on the board to flip

    const joined = await joinQueue(db, clerk, opened.encounter.id);
    const status = (await encounterFeeStatuses(db, [opened.encounter])).get(opened.encounter.id);
    expect(status).toBe("settled"); // the stamp the slip prints from — born PAID
    expect(joined.tokenNo).toBe(1);
  });

  it("an allocation that CLOSES the fee invoice later in the day flips the board too", async () => {
    await grantCreditExtend(db, "cashier");
    const v = await newVisit("9899100006");
    const issued = await issueInvoice(db, clerk, {
      draftId: "fs-d6", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "pays after darshan" },
    });
    const beforeCount = (await flips()).length; // 1 — the credit extension itself
    const receipt = await recordReceipt(db, clerk, { patientId: v.patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] });
    const allocated = await allocateReceipt(db, clerk, {
      receiptId: receipt.receiptId,
      invoiceId: issued.invoiceId,
      amountPaise: 50_000,
    });
    expect(allocated.settlement.state).toBe("settled");
    const after = await flips();
    expect(after.length).toBe(beforeCount + 1);
    expect((after[after.length - 1]!.payload as { via: string }).via).toBe("allocation");
  });
});
