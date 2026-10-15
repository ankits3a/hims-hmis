import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "./helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { opdEncounters } from "../src/kernel/db/schema";
import { toCollectList } from "../src/modules/billing/to-collect";
import { istDay } from "../src/modules/billing/time";
import { completeConsultation, startConsultation } from "../src/modules/opd/consultation";
import { grantFeeBypass, openVisit } from "../src/modules/opd/encounters";
import { listQueue, queueWithoutMoney } from "../src/modules/opd/queue";
import { recordVitals } from "../src/modules/opd/vitals";
import type { BillingBaseFixture } from "./helpers/billing";
import type { Db } from "../src/kernel/db/client";

const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
const DAY = 86_400_000;

/**
 * ═══ "TO COLLECT" (OWNER, 2026-10-09) ═══
 *
 * *"'To collect' list for desk, with money-off-doctor release: yes."* A visit the desk let through
 * unpaid is on the desk's list while it waits, while it is with the doctor and after it is finished;
 * it leaves when the fee is settled; one older than seven days is not listed. Billing is real.
 *
 * `NOW` is today (the code reads the IST day off the clock it is handed), at 10:30 IST.
 */
describe("the desk's 'To collect' list", () => {
  const NOW = new Date(`${istDay(new Date())}T05:00:00.000Z`);
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let cashier: Awaited<ReturnType<typeof mkCashier>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    base = await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    cashier = await mkCashier(db, "cash1");
  });

  async function letThrough(name: string, at: Date = NOW): Promise<{ encounterId: string; patientId: string; tokenNo: number }> {
    const patient = await mkPatient(db, clerk.actor, { name });
    const open = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, at);
    await grantFeeBypass(db, clerk.actor, open.encounter.id, `VIP — ${name}`, at);
    await recordVitals(db, vd.actor, open.encounter.id, adultOk, at);
    return { encounterId: open.encounter.id, patientId: patient.id, tokenNo: open.queueEntry.tokenNo };
  }
  const later = (min: number): Date => new Date(NOW.getTime() + min * 60_000);
  const list = async (at: Date = later(30)) => toCollectList(db, cashier.actor, at);

  it("lists a let-through unpaid visit while waiting, with the doctor and after completion — gone first — with the amount, who, when and why", async () => {
    const waiting = await letThrough("Waiting One");
    const withDoctor = await letThrough("With Doctor");
    const done = await letThrough("Seen And Gone");
    await startConsultation(db, dra.actor, done.encounterId, later(5));
    await completeConsultation(db, dra.actor, done.encounterId, { testsOrderedReturnToday: false }, later(10));
    await startConsultation(db, dra.actor, withDoctor.encounterId, later(12));

    const rows = await list();
    expect(rows.map((r) => [r.patientName, r.state])).toEqual([["Seen And Gone", "done"], ["With Doctor", "with_doctor"], ["Waiting One", "waiting"]]);
    expect(rows[2]).toMatchObject({
      encounterId: waiting.encounterId, tokenNo: waiting.tokenNo, doctorName: expect.any(String), serviceDate: istDay(NOW),
      amountDuePaise: 50_000, letThroughBy: "clerk", reason: "VIP — Waiting One", minutesSince: 30,
    });
    expect(Date.parse(rows[2]!.letThroughAt)).toBe(NOW.getTime());
  });

  it("the row goes the moment the fee is settled — nobody clears anything", async () => {
    const a = await letThrough("Pays Later");
    const b = await letThrough("Still Owes");
    expect((await list()).map((r) => r.patientName).sort()).toEqual(["Pays Later", "Still Owes"]);

    // Seen and gone before paying: the counter's ordinary bill still settles a finished visit.
    await startConsultation(db, dra.actor, a.encounterId, later(5));
    await completeConsultation(db, dra.actor, a.encounterId, { testsOrderedReturnToday: false }, later(10));
    expect((await list()).find((r) => r.encounterId === a.encounterId)).toMatchObject({ state: "done" });

    await openSessionFor(db, cashier, 200_000);
    await issuePaidInvoice(db, cashier, { patientId: a.patientId, serviceId: base.consultNewServiceId, encounterId: a.encounterId }, later(20));
    expect((await list()).map((r) => r.encounterId)).toEqual([b.encounterId]);
  });

  it("seven days back is listed, eight is not; a paid visit, an unpaid one with no bypass and an abandoned one never are", async () => {
    await letThrough("Seven Days", new Date(NOW.getTime() - 7 * DAY));
    await letThrough("Eight Days", new Date(NOW.getTime() - 8 * DAY));
    const noBypass = await letThrough("No Bypass");
    await db.update(opdEncounters).set({ feeBypassBy: null, feeBypassReason: null, feeBypassAt: null }).where(eq(opdEncounters.id, noBypass.encounterId));
    const abandoned = await letThrough("Abandoned");
    await db.update(opdEncounters).set({ status: "abandoned" }).where(eq(opdEncounters.id, abandoned.encounterId));

    expect((await list()).map((r) => r.patientName)).toEqual(["Seven Days"]);
  });

  it("nothing of it reaches the doctor: the doctor's copy of the queue has no key or word of the list", async () => {
    await letThrough("In The Line");
    expect(await list()).toHaveLength(1);
    const mine = queueWithoutMoney((await listQueue(db, dra.actor, dra.doctorId, istDay(NOW), later(1)))!);
    expect(mine.ordered).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/collect|amountDue|letThrough|VIP —/i);
  });
});
