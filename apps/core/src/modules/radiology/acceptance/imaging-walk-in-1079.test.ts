import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { setupRadiologyFixture } from "../../../../test/helpers/radiology";
import { WALK_IN_PRICES, setupImagingWalkIn } from "../../../../test/helpers/imaging-walk-in";
import {
  counterparties, imagingStudies, invoiceLines, invoices, opdEncounters, opdQueueEntries, orderItems, orders,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { listVisits } from "../../opd";
import * as radiology from "../index";
import { handleOrderPlaced } from "../consumers";
import type { ImagingWalkInFixture } from "../../../../test/helpers/imaging-walk-in";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { OrderKindDecl } from "../../../kernel/orders/kinds";

/**
 * ACCEPTANCE — issue #1079, spec docs/specs/1079-imaging-walk-in-visit.md (owner APPROVED 2026-11-14): the
 * imaging-only walk-in visit for an outside referral (D1–D4).
 *
 * A patient with no visit today brings an outside doctor's slip to the imaging desk. The desk's act
 * `placeWalkInOrder` opens a `V` visit of type `imaging` in the `RAD` department under the radiologist
 * of record and places the order under `external_prescription` with the referrer typed off the slip, in
 * one transaction. The visit carries no consult fee (decision 0003 ruling 2), joins no OPD queue and is
 * not on the OPD visit list.
 *
 * Every instant is written by hand and passed in; nothing here reads the clock. The act is looked up on
 * the module's public index, so before the build each check fails on its own line, not on an import.
 */

type Fn = (...args: never[]) => Promise<unknown>;
function act<T extends Fn>(name: string): T {
  const fn = (radiology as Record<string, unknown>)[name];
  expect({ name, type: typeof fn }).toEqual({ name, type: "function" });
  return fn as T;
}

type WalkInInput = {
  patientId: string;
  doctorId?: string;
  priority?: "routine" | "urgent" | "stat";
  indication: string;
  items: { serviceId: string }[];
  referrer: { name: string; registrationNo: string };
};
type WalkInResult = { encounterNo: string; visitOpened: boolean; orderId: string; orderNo: string; itemIds: string[] };
type PlaceWalkInOrder = (
  db: Db, actor: Actor, decls: readonly OrderKindDecl[], input: WalkInInput, idemKey?: string, now?: Date,
) => Promise<WalkInResult>;
type WalkInNow = (db: Db, actor: Actor, input: { studyId: string; now?: Date }) => Promise<unknown>;
type CollectAtDesk = (
  db: Db, actor: Actor,
  input: { encounterNo: string; studyIds: string[]; addOns?: never[]; tender: { mode: "cash"; amountPaise: number } },
  idempotencyKey: string, now?: Date,
) => Promise<{ invoiceId: string }>;

const DAY = "2026-08-31";
/** 11:37 IST on the fixture's service day. */
const NOW = new Date("2026-08-31T06:07:00.000Z");
/** 15:20 IST, the same IST day. */
const LATER_TODAY = new Date("2026-08-31T09:50:00.000Z");
const SLIP = { name: "Dr. Anil Verma", registrationNo: "BMC/44117" };

describe("spec #1079 — the imaging-only walk-in visit for an outside referral", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let w: ImagingWalkInFixture;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    w = await setupImagingWalkIn(db, fx, { serviceDate: DAY });
  });
  afterEach(() => { w.restore(); jest.restoreAllMocks(); });

  const slip = (code: string, over: Partial<WalkInInput> = {}): WalkInInput => ({
    patientId: w.patientId, priority: "routine", indication: "Pain right upper abdomen, ?gall stones",
    items: [{ serviceId: fx.services[code]! }], referrer: SLIP, ...over,
  });
  const visitsOf = (patientId: string) =>
    db.select().from(opdEncounters).where(eq(opdEncounters.patientId, patientId));

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1079 D1: a patient with no visit today gets one V visit of type imaging, no consult fee line, and one imaging order under the outside prescription", async () => {
    expect(await visitsOf(w.patientId)).toHaveLength(0);
    const placed = await act<PlaceWalkInOrder>("placeWalkInOrder")(db, w.desk, fx.decls, slip("USG-ABDO"), undefined, NOW);

    /** One visit: `V…`, type `imaging`, the RAD department, the radiologist of record, today. */
    const visits = await visitsOf(w.patientId);
    expect(visits).toHaveLength(1);
    const visit = visits[0]!;
    expect({
      visitNo: visit.visitNo.startsWith("V"), type: visit.type, departmentId: visit.departmentId,
      doctorId: visit.doctorId, serviceDate: visit.serviceDate,
    }).toEqual({ visitNo: true, type: "imaging", departmentId: w.radDepartmentId, doctorId: w.radiologistDoctorId, serviceDate: DAY });
    expect({ encounterNo: placed.encounterNo, visitOpened: placed.visitOpened }).toEqual({ encounterNo: visit.visitNo, visitOpened: true });

    /** One imaging order on that visit, under the outside prescription, the slip's doctor as its referrer. */
    const onVisit = await db.select().from(orders).where(eq(orders.encounterNo, visit.visitNo));
    expect(onVisit).toHaveLength(1);
    const order = onVisit[0]!;
    expect({ id: order.id, kind: order.kind, authority: order.authority, clinician: order.orderingClinicianId })
      .toEqual({ id: placed.orderId, kind: "imaging", authority: "external_prescription", clinician: w.radiologistUserId });
    const [referrer] = await db.select().from(counterparties).where(eq(counterparties.id, order.externalReferrerId!));
    expect({ name: referrer?.name, payeeClass: referrer?.payeeClass, code: referrer?.code })
      .toEqual({ name: SLIP.name, payeeClass: "external_rmp", code: "RMP-BMC44117" });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items.map((i) => i.serviceId)).toEqual([fx.services["USG-ABDO"]]);

    /** Nothing is billed by the walk-in itself: the visit opened with no invoice and so no consult fee line. */
    expect(await db.select().from(invoices).where(eq(invoices.patientId, w.patientId))).toHaveLength(0);

    /** And the desk's own bill for this visit charges the study and nothing else — no consult fee line. */
    const created = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging", patientId: w.patientId,
      encounterNo: visit.visitNo, groupId: placed.orderId, itemIds: placed.itemIds,
    }));
    const studyId = created[0]!.studyId;
    await act<WalkInNow>("walkInNow")(db, w.desk, { studyId, now: NOW });
    const bill = await act<CollectAtDesk>("collectAtDesk")(db, w.desk, {
      encounterNo: visit.visitNo, studyIds: [studyId], addOns: [],
      tender: { mode: "cash", amountPaise: WALK_IN_PRICES["USG-ABDO"]! },
    }, "walk-in-d1-collect", NOW);
    const billed = await db.select({ serviceId: invoiceLines.serviceId }).from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(eq(invoices.patientId, w.patientId));
    expect(billed.map((l) => l.serviceId)).toEqual([fx.services["USG-ABDO"]]);
    expect(billed.map((l) => l.serviceId)).not.toContain(w.billing.consultNewServiceId);
    expect(billed.map((l) => l.serviceId)).not.toContain(w.billing.consultRenewalServiceId);
    const [linked] = await db.select({ invoiceLineId: imagingStudies.invoiceLineId }).from(imagingStudies).where(eq(imagingStudies.id, studyId));
    expect(linked?.invoiceLineId).not.toBeNull();
    expect(bill.invoiceId).toBeTruthy();
  });

  /* ─────────────────────────────── D2 ─────────────────────────────── */

  it("spec #1079 D2: a second call the same day reuses the open visit", async () => {
    const place = act<PlaceWalkInOrder>("placeWalkInOrder");
    const first = await place(db, w.desk, fx.decls, slip("USG-ABDO"), undefined, NOW);
    const second = await place(db, w.desk, fx.decls, slip("XR-CHEST", {
      indication: "Cough for three weeks", referrer: { name: "Dr. Sunita Rai", registrationNo: "JMC 2209" },
    }), undefined, LATER_TODAY);

    expect({ encounterNo: second.encounterNo, visitOpened: second.visitOpened })
      .toEqual({ encounterNo: first.encounterNo, visitOpened: false });
    const visits = await visitsOf(w.patientId);
    expect(visits.map((v) => v.visitNo)).toEqual([first.encounterNo]);
    const onVisit = await db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.encounterNo, first.encounterNo), eq(orders.kind, "imaging")));
    expect(onVisit.map((o) => o.id).sort()).toEqual([first.orderId, second.orderId].sort());
  });

  /* ─────────────────────────────── D3 ─────────────────────────────── */

  it("spec #1079 D3: the walk-in visit is absent from the default OPD visit list, and joins no OPD queue", async () => {
    const placed = await act<PlaceWalkInOrder>("placeWalkInOrder")(db, w.desk, fx.decls, slip("XR-CHEST"), undefined, NOW);

    /** The row exists — the list asked for every type finds it, so the absence below is not vacuous. */
    const everyType = await listVisits(db, { serviceDate: DAY, type: "any" });
    expect(everyType.map((v) => v.visitNo)).toContain(placed.encounterNo);

    /** The default list is the OPD's: it still shows the day's OPD visit, and not the walk-in. */
    const opd = await listVisits(db, { serviceDate: DAY });
    expect(opd.map((v) => v.visitNo)).toContain(fx.visitNo);
    expect(opd.map((v) => v.visitNo)).not.toContain(placed.encounterNo);
    expect(await listVisits(db, { patientId: w.patientId })).toHaveLength(0);

    const [visit] = await visitsOf(w.patientId);
    expect(await db.select().from(opdQueueEntries).where(inArray(opdQueueEntries.encounterId, [visit!.id]))).toHaveLength(0);
  });

  /* ─────────────────────────────── D4 ─────────────────────────────── */

  it("spec #1079 D4: the call without the referrer's name and registration number is refused, and leaves no visit behind", async () => {
    const place = act<PlaceWalkInOrder>("placeWalkInOrder");
    const refusals: unknown[] = [];
    for (const referrer of [
      undefined,
      { name: "", registrationNo: "BMC/44117" },
      { name: "Dr. Anil Verma", registrationNo: "" },
      { name: "   ", registrationNo: "  " },
    ]) {
      const input = { ...slip("USG-ABDO"), referrer } as WalkInInput;
      refusals.push(await place(db, w.desk, fx.decls, input, undefined, NOW).then(
        () => "placed",
        (e: unknown) => (e as { code?: unknown }).code,
      ));
    }
    expect(refusals).toEqual(["referrer_required", "referrer_required", "referrer_required", "referrer_required"]);
    expect(await visitsOf(w.patientId)).toHaveLength(0);
    expect(await db.select().from(orders).where(eq(orders.patientId, w.patientId))).toHaveLength(0);
  });
});
