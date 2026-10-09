import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { ownerMoney } from "../billing";
import { grantFeeBypass, openVisit } from "./encounters";
import { istDate } from "./time";
import { opdAppointments, opdSuggestionEvents, opdTermMisses } from "../../kernel/db/schema";
import { ownerAppointments, ownerLearning } from "./owner-reads";
import type { Db } from "../../kernel/db/client";

/**
 * THE OWNER'S APPOINTMENTS AND LEARNING PAGES (owner 2026-10-09). Counts only. The dates are plain
 * calendar days handed to the read — nothing here asks the clock what day it is, except the learning
 * window, whose `now` is injected.
 */
const DAY = "2026-03-10";
const WEEK_BEFORE = "2026-03-03";

describe("OPD — the owner's appointments and learning reads", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>; let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    clerk = await mkUser(db, "or_clerk", ["front_office"]);
    dra = await mkDoctor(db, { username: "or_dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    drb = await mkDoctor(db, { username: "or_drb", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  });

  const book = async (doctorId: string, status: string, serviceDate = DAY): Promise<void> => {
    seq += 1;
    const p = await mkPatient(db, clerk.actor, { name: `Appt ${String(seq)}`, phone: String(9200000000 + seq) });
    const slot = new Date(Date.parse(`${serviceDate}T04:00:00Z`) + seq * 600_000);
    await db.insert(opdAppointments).values({
      id: newId(), appointmentNo: `A${String(seq).padStart(10, "0")}`, patientId: p.id, doctorId, departmentId: deptId,
      serviceDate, slotStart: slot, slotEnd: new Date(slot.getTime() + 600_000), status, bookedBy: clerk.id, updatedBy: clerk.id,
    });
  };

  it("counts by what became of each booking, by doctor, on the slot's day — a moved or cancelled one is not in the total", async () => {
    for (const s of ["checked_in", "checked_in", "booked", "no_show", "cancelled", "rescheduled"]) await book(dra.doctorId, s);
    for (const s of ["checked_in", "needs_rebooking"]) await book(drb.doctorId, s);
    await book(dra.doctorId, "checked_in", WEEK_BEFORE);
    await book(dra.doctorId, "booked", WEEK_BEFORE);
    await book(dra.doctorId, "cancelled", WEEK_BEFORE);

    const r = await ownerAppointments(db, { from: DAY, to: DAY }, { from: WEEK_BEFORE, to: WEEK_BEFORE });
    expect(r).toMatchObject({ from: DAY, to: DAY, total: 6, came: 3, toCome: 1, missed: 1, needRebooking: 1, cancelled: 1 });
    expect(r.previous).toEqual({ from: WEEK_BEFORE, to: WEEK_BEFORE, total: 2 });
    expect(r.doctors.map((d) => [d.id, d.total, d.came])).toEqual([[dra.doctorId, 4, 2], [drb.doctorId, 2, 1]]);
    expect(JSON.stringify(r)).not.toMatch(/Appt \d|patientId|appointmentNo|A0000/);

    const both = await ownerAppointments(db, { from: WEEK_BEFORE, to: DAY }, null);
    expect({ total: both.total, previous: both.previous }).toEqual({ total: 8, previous: null });
  });

  it("learning: the share tapped is of suggestions somebody ACTED on, and both numbers are of the last seven days", async () => {
    const now = new Date("2026-03-10T10:00:00Z");
    const at = (daysAgo: number): Date => new Date(now.getTime() - daysAgo * 86_400_000);
    const ev = (outcome: string, daysAgo: number) => ({ id: newId(), userId: clerk.id, kind: "medicine", source: "suggested", outcome, createdAt: at(daysAgo) });
    await db.insert(opdSuggestionEvents).values([
      ev("accepted", 1), ev("accepted", 2), ev("accepted", 3), ev("dismissed", 1), ev("manual", 2), ev("shown", 1), ev("shown", 1),
      ev("accepted", 9), ev("dismissed", 30),
    ]);
    await db.insert(opdTermMisses).values([
      { id: newId(), kind: "medicine", term: "pan forty", stage: "search", userId: clerk.id, createdAt: at(1) },
      { id: newId(), kind: "medicine", term: "telma h", stage: "voice", userId: clerk.id, createdAt: at(6) },
      { id: newId(), kind: "test", term: "old one", stage: "search", userId: clerk.id, createdAt: at(8) },
    ]);
    const r = await ownerLearning(db, clerk.actor, true, now);
    expect(r).toEqual({ on: true, mayUndo: false, nicknames: [], tapped: { accepted: 3, acted: 5 }, misses: 2 });
    /* The words that matched nothing stay on the admin screen: only how many. */
    expect(JSON.stringify(r)).not.toMatch(/pan forty|telma/);
    const quiet = await ownerLearning(db, clerk.actor, false, new Date("2027-01-01T00:00:00Z"));
    expect(quiet).toMatchObject({ on: false, tapped: null, misses: 0 });
  });

  /**
   * The money page's "Let through unpaid" (billing's `ownerMoney`) reads this module's bypass columns:
   * the seam is proved here, where the bypass is granted the way the desk grants it.
   */
  it("money: a visit the desk let through is counted only while its fee is unsettled", async () => {
    const now = new Date();
    const today = istDate(now);
    await activateOpdVisitDefinition(db);
    const base = await seedBillingBase(db);
    const cashier = await mkCashier(db, "or_cashier");
    await openSessionFor(db, cashier, 200_000);
    const p = await mkPatient(db, clerk.actor, { name: "Let Through", phone: "9200099001" });
    const opened = await openVisit(db, clerk.actor, { patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, now);
    const count = async (): Promise<number> => (await ownerMoney(db, { from: today, to: today }, null, now)).letThroughUnpaid;
    expect(await count()).toBe(0); // unsettled, but nobody let it through
    await grantFeeBypass(db, clerk.actor, opened.encounter.id, "emergency — sent straight through", now);
    expect(await count()).toBe(1);
    await issuePaidInvoice(db, cashier, { patientId: p.id, serviceId: base.consultNewServiceId, encounterId: opened.encounter.id }, now);
    expect(await count()).toBe(0);
  });
});
