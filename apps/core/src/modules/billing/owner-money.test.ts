import { eq } from "drizzle-orm";
import { addDayIso, monthSoFar } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issuePaidInvoice, issuePaidInvoiceByTender, mkCashier, openSessionFor, seedBillingBase, submitCountFor } from "../../../test/helpers/billing";
import { mkPatient } from "../../../test/helpers/opd";
import { cashierSessions, registrationConfig } from "../../kernel/db/schema";
import { dayBook } from "./daily-close";
import { drawerState, ownerMoney } from "./owner-money";
import { markEnteredInError } from "./receipts";
import { istDay } from "./time";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Db } from "../../kernel/db/client";

/**
 * THE OWNER'S MONEY PAGE (owner 2026-10-09). The day must reconcile to the day book exactly — one
 * money read that disagrees with another is two truths — and a drawer is said in words.
 * The clock is the real one, injected: every date below is derived from `NOW`, never written down.
 */
const NOW = new Date();
const TODAY = istDay(NOW);
const LAST_WEEK = new Date(NOW.getTime() - 7 * 86_400_000);

describe("billing — the owner's money page", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let asha: Awaited<ReturnType<typeof mkCashier>>;
  let bimal: Awaited<ReturnType<typeof mkCashier>>;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    asha = await mkCashier(db, "om_asha");
    bimal = await mkCashier(db, "om_bimal");
    await openSessionFor(db, asha, 200_000);
    await openSessionFor(db, bimal, 200_000);
    patientId = (await mkPatient(db, asha.actor, { name: "Ramesh Kale", phone: "9876540321" })).id;
  });

  it("a day reconciles to the day book, mode for mode, and an entered-in-error receipt leaves both", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, NOW);
    await issuePaidInvoiceByTender(db, asha, { patientId, serviceId: base.genericServiceId, mode: "upi", refText: "u1" }, NOW);
    await issuePaidInvoiceByTender(db, bimal, { patientId, serviceId: base.genericServiceId, mode: "card", refText: "c1" }, NOW);
    const wrong = await issuePaidInvoice(db, bimal, { patientId, serviceId: base.genericServiceId }, NOW);
    await markEnteredInError(db, bimal.actor, { receiptId: wrong.receiptId!, reason: "took the wrong patient's money" }, NOW);

    const book = await dayBook(db, TODAY);
    const m = await ownerMoney(db, { from: TODAY, to: TODAY }, null, NOW);
    expect(m.byMode).toEqual(book.receipts.byMode);
    expect({ collectedPaise: m.collectedPaise, receipts: m.receipts }).toEqual({ collectedPaise: book.receipts.totalPaise, receipts: book.receipts.count });
    expect(m.receipts).toBe(3);
    expect(m.previous).toBeNull();
    /* Each drawer's amount is its own live receipts; the two add up to the day. */
    expect(m.cashiers.map((c) => c.state)).toEqual(["open", "open"]);
    expect(m.cashiers.reduce((n, c) => n + c.collectedPaise, 0)).toBe(m.collectedPaise);
    expect(m.cashiers.every((c) => c.variancePaise === null && c.openedDay === TODAY)).toBe(true);
    /* Nothing here names a patient or a document. */
    expect(JSON.stringify(m)).not.toMatch(/Ramesh|INV\/|RCT\/|patientId|invoiceNo/);
  });

  it("compares with the range it is given, and always carries the month so far and last month to the same day", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, NOW);
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, LAST_WEEK);
    const day = istDay(LAST_WEEK);
    const m = await ownerMoney(db, { from: TODAY, to: TODAY }, { from: day, to: day }, NOW);
    expect(m.previous).toEqual({ from: day, to: day, collectedPaise: m.collectedPaise });
    const months = monthSoFar(TODAY);
    expect({ from: m.month.now.from, to: m.month.now.to }).toEqual(months.now);
    expect({ from: m.month.before.from, to: m.month.before.to }).toEqual(months.before);
    const inThisMonth = day >= months.now.from ? 2 : 1;
    expect(m.month.now.collectedPaise).toBe(m.collectedPaise * inThisMonth);
    expect(m.month.before.collectedPaise).toBe(day >= months.before.from && day <= months.before.to ? m.collectedPaise : 0);
    /* A range that ended yesterday does not list today's open drawers that took nothing in it. */
    const y = addDayIso(TODAY, -1);
    const past = await ownerMoney(db, { from: y, to: y }, null, NOW);
    expect(past.collectedPaise).toBe(0);
    expect(past.cashiers).toEqual([]);
  });

  it("a counted drawer is exact, short or excess — in words, with the difference", async () => {
    expect(drawerState("open", null)).toBe("open");
    expect(drawerState("closed", 0)).toBe("exact");
    expect(drawerState("closing", -12_000)).toBe("short");
    expect(drawerState("closed", 500)).toBe("excess");

    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, NOW);
    await submitCountFor(db, asha, { "50000": 1 }); // ₹500 counted against float + takings: short
    const row = (await db.select().from(cashierSessions).where(eq(cashierSessions.cashierUserId, asha.id)))[0]!;
    expect(row.variancePaise).toBeLessThan(0);
    const m = await ownerMoney(db, { from: TODAY, to: TODAY }, null, NOW);
    const mine = m.cashiers.find((c) => c.collectedPaise > 0)!;
    expect(mine).toMatchObject({ state: "short", variancePaise: row.variancePaise });
    expect(typeof mine.name).toBe("string");
    expect(m.cashiers.find((c) => c.collectedPaise === 0)).toMatchObject({ state: "open", variancePaise: null });
  });
});
