import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { MON, seedPharmacyBase } from "./helpers/pharmacy";
import { ensureRole, testCfg } from "./helpers/opd";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import { seedPharmacyDemo } from "../scripts/seed-pharmacy-demo";
import { TICKETS, standUpPharmacyDay } from "../scripts/dev-pharmacy-standup";
import { assignRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { events, opdEncounters, patients } from "../src/kernel/db/schema";
import { prescriptionIssued } from "../src/modules/opd/events";
import { claimDispense, handlePrescriptionIssued, verifyDispense } from "../src/modules/pharmacy";
import type { PharmacyDayReport, TicketReport } from "../scripts/dev-pharmacy-standup";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ PD-0 — THE PHARMACY'S DAY ═══
 *
 * The assertion that matters is not "ten rows were written". It is that each ticket TEACHES what its
 * name says when the counter reads it — the X ticket refuses at the claim, the allergy ticket refuses
 * at verify, the claimed ticket refuses a second pharmacist — and that the day can be run twice
 * without doubling, including by the worker the script stands in for.
 */
describe("dev-pharmacy-standup — the demo QUEUE (PD-0)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  /** 11:30 IST on the fixture's Monday — inside the doctor's 09:00–13:00, and the spread stays today. */
  const DAY = new Date(MON.getTime() + 2 * 60 * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    /* `seed:pharmacy-demo`'s own suite does the same: nothing else creates `materials_head`. */
    await ensureRole(db, "materials_head");
    await grantPermissionToRole(db, fx.registry, "materials_head", "materials.items.manage");
    await assignRole(db, { userId: fx.pharmacist.id, roleKey: "materials_head", scopeType: "hospital" });
    await ensurePharmacyCounter(db, fx.pharmacist.actor);
    await seedPharmacyDemo(db, DAY);
  });
  afterEach(() => { fx.unregister(); });

  const ticket = (report: PharmacyDayReport, teaches: string): TicketReport => {
    const t = report.tickets.find((r) => r.teaches === teaches);
    if (t === undefined) throw new Error(`no ticket teaching "${teaches}"`);
    return t;
  };

  it("queues ten tickets, one of them already held by the SECOND pharmacist", async () => {
    const report = await standUpPharmacyDay(db, testCfg, DAY);

    expect(report.tickets.map((t) => t.made)).toEqual(TICKETS.map(() => true));
    /* Read through `listQueue`, as the counter reads it — not a row count of pharmacy_dispenses. */
    expect({ reader: report.queueReader, rows: report.queueRows }).toEqual({ reader: "ph.incharge", rows: 10 });
    expect(report.tickets.map((t) => [t.teaches, t.status, t.claimedBy])).toEqual(TICKETS.map((t) => [
      t.teaches,
      t.claimedByAnother === true ? "claimed" : "queued",
      t.claimedByAnother === true ? "ph.mehta" : null,
    ]));
    /* The fixture registered ph.mehta and nobody else; the script files no registration. */
    expect(report.registeredPharmacists).toEqual(["ph.mehta"]);
    expect(report.ceremonies).toEqual([
      "opd_visit: already active", "tariff: a version is already active, left alone",
      "doctor of record: an existing MED profile",
    ]);
  });

  it("each shelf ticket's fact is the one its name claims", async () => {
    const report = await standUpPharmacyDay(db, testCfg, DAY);

    expect(ticket(report, "out of stock").shelf[0]).toMatchObject({ drug: "Amlong 5", wanted: 30, sellable: 0, fefo: null });
    expect(ticket(report, "partial stock").shelf[0]).toMatchObject({ drug: "Glycomet 500", wanted: 270, sellable: 200 });
    /* PD-D4's amber row: typed text the catalogue cannot place on any item. */
    expect(ticket(report, "unresolved free-text line").shelf[0]).toEqual({ drug: "Ascoril LS syrup", wanted: 150, sellable: null, fefo: null });
    /* FEFO offers the batch that dies twelve days in — inside a thirty-day course (E8). */
    const pan = ticket(report, "near-expiry batch").shelf[0]!;
    expect(pan).toMatchObject({ drug: "Pan 40", wanted: 30, sellable: 220 });
    /* the batch number carries its challan's digits whole — `DEMO/NEAR/20260817` — as the shelf seed's do */
    expect(pan.fefo).toEqual({ batchNo: "PAN040-20260817", expiryDate: "2026-08-29" });
    /* and the aged challan's expired stock is on the shelf and in none of these numbers */
    expect(ticket(report, "happy path").shelf.map((f) => f.sellable)).toEqual([200, 200]);
  });

  it("the counter refuses exactly where each ticket says it will", async () => {
    const report = await standUpPharmacyDay(db, testCfg, DAY);
    const at = new Date(DAY.getTime() + 60_000);

    // E17 — Schedule X refuses the whole claim, not the line.
    await expect(claimDispense(db, fx.incharge.actor, { dispenseId: ticket(report, "Schedule X — refused at the claim").dispenseId!, door: "token" }, at))
      .rejects.toMatchObject({ code: "schedule_x_not_dispensed_here" });
    // E1 — a second pharmacist is refused, and told who holds it (PD-1).
    await expect(claimDispense(db, fx.incharge.actor, { dispenseId: ticket(report, "claimed by a second pharmacist").dispenseId!, door: "token" }, at))
      .rejects.toMatchObject({ code: "dispense_not_in_state", detail: { claimedByName: "ph.mehta" } });
    // The allergy recorded after the issue is met at verify, on the dispensed medicine.
    const allergic = ticket(report, "allergy collision").dispenseId!;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: allergic, door: "token" }, at);
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, allergic, { lines: [{ lineIdx: 0, qtyBase: 15 }, { lineIdx: 1, qtyBase: 6 }] }, at))
      .rejects.toMatchObject({ code: "allergy_block" });
  });

  it("runs twice without doubling — and the worker it stands in for finds every event already handled", async () => {
    const first = await standUpPharmacyDay(db, testCfg, DAY);
    const again = await standUpPharmacyDay(db, testCfg, new Date(DAY.getTime() + 5 * 60_000));

    expect(again.tickets.map((t) => t.made)).toEqual(TICKETS.map(() => false));
    expect(again.queueRows).toBe(10);
    expect(again.tickets.map((t) => t.dispenseId)).toEqual(first.tickets.map((t) => t.dispenseId));
    /* and a re-run still says who holds the claimed one — read off the queue row, not remembered */
    expect(again.tickets.map((t) => t.claimedBy)).toEqual(first.tickets.map((t) => t.claimedBy));
    const phones = TICKETS.map((t) => t.person.phone);
    const people = await db.select({ phone: patients.phone }).from(patients);
    expect(people.filter((p) => phones.includes(p.phone ?? "")).length).toBe(10);
    const visits = await db.select({ id: opdEncounters.id }).from(opdEncounters).where(eq(opdEncounters.serviceDate, "2026-08-17"));
    expect(visits.length).toBe(10);
    /* The near-expiry batch is posted once per day, not once per run. */
    expect(ticket(again, "near-expiry batch").shelf[0]!.sellable).toBe(ticket(first, "near-expiry batch").shelf[0]!.sellable);

    const issued = await db.select({ eventId: events.eventId, payload: events.payload }).from(events)
      .where(and(eq(events.name, prescriptionIssued.name)));
    expect(issued.length).toBe(10);
    for (const e of issued) {
      const res = await withTx(db, (tx) => handlePrescriptionIssued(tx, e.eventId, e.payload, DAY));
      expect(res).toEqual({ handled: false, dispenseId: null });
    }
  });
});
