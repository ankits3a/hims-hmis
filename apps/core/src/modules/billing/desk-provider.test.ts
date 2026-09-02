import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  issuePaidInvoice, issuePaidInvoiceByTender, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import { mkPatient } from "../../../test/helpers/opd";
import { billingDeskProvider, cashierDay } from "./desk-provider";
import { liveExpectedCashPaise } from "./sessions";
import { issueInvoice, previewInvoice } from "./invoices";
import { newId } from "@hmis/contracts";
import { formatPaise } from "../../kernel/report/money";
import { cashierSessions } from "../../kernel/db/schema";
import { dayBook } from "./daily-close";
import { markEnteredInError } from "./receipts";
import { receipts, registrationConfig } from "../../kernel/db/schema";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07c SPIKE S1 — **THE PER-CASHIER TENDER SPLIT MUST RECONCILE TO THE DAY BOOK.**
 *
 * The phase document is blunt about the consequence: *"It must reconcile to `dayBook` when summed
 * across all cashiers — if it does not, the report is wrong and the phase stops."* This suite is
 * that spike, executed rather than reasoned about.
 *
 * It is the assertion that matters most in the whole task, because a per-person collections figure
 * that is merely CLOSE to the day book is worse than none at all: two cashiers reconcile their own
 * drawers against one set of numbers and the manager reconciles the hospital against another, and
 * the difference surfaces as an unexplained variance that somebody has to answer for personally.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const DAY = "2026-08-17";

describe("billing desk provider — the per-cashier day (07c T2, spike S1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: Awaited<ReturnType<typeof seedBillingBase>>;
  let asha: Awaited<ReturnType<typeof mkCashier>>;
  let bimal: Awaited<ReturnType<typeof mkCashier>>;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    // The UHID allocator needs its config row — the `receipts.test.ts` / `allocations.test.ts`
    // precedent, since `seedBillingBase` seeds billing and not registration.
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    asha = await mkCashier(db, "asha_cashier");
    bimal = await mkCashier(db, "bimal_cashier");
    await openSessionFor(db, asha, 200000);
    await openSessionFor(db, bimal, 200000);
    patientId = (await mkPatient(db, asha.actor, { name: "Ramesh Kale", phone: "9876540021" })).id;
  });

  const ctxFor = (u: { id: string }, date = DAY): DeskProviderCtx => {
    const actor = { type: "user" as const, id: u.id };
    return { db, actor, reader: actor, date, now: T0 };
  };

  /**
   * S1, AND IT IS THE WHOLE POINT. Four receipts, two cashiers, three tender modes and one voided
   * document — the shape a real day has. Summed across cashiers the split must equal `dayBook`
   * EXACTLY, mode by mode, and it is exact rather than close because both sides apply the same
   * entered-in-error exclusion (imported, not re-written) and cut the day on the same stored
   * `service_day`.
   */
  it("S1: summed across every cashier, the split equals the day book mode for mode", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    await issuePaidInvoiceByTender(db, asha, { patientId, serviceId: base.genericServiceId, mode: "upi", refText: "upi-1" }, T0);
    await issuePaidInvoiceByTender(db, bimal, { patientId, serviceId: base.genericServiceId, mode: "card", refText: "card-1" }, T0);
    await issuePaidInvoice(db, bimal, { patientId, serviceId: base.genericServiceId }, T0);

    const book = await dayBook(db, DAY);
    const a = await cashierDay(db, asha.id, DAY);
    const b = await cashierDay(db, bimal.id, DAY);

    expect({
      cash: a.byMode.cash + b.byMode.cash,
      upi: a.byMode.upi + b.byMode.upi,
      card: a.byMode.card + b.byMode.card,
    }).toEqual(book.receipts.byMode);
    expect(a.receipts + b.receipts).toBe(book.receipts.count);
    expect(a.totalPaise + b.totalPaise).toBe(book.receipts.totalPaise);
  });

  /**
   * THE HALF THAT ACTUALLY DISCRIMINATES. Both sides being merely "a sum of tenders" would
   * reconcile trivially; what makes the reconciliation meaningful is that both sides DROP the same
   * voided receipt. A cashier's own figure that still counted money the hospital has declared was
   * never received would over-state their drawer and under-explain their variance.
   */
  it("S1: an entered-in-error receipt leaves BOTH the day book and the cashier's own figure", async () => {
    const paid = await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    const kept = await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    expect(kept.receiptId).not.toBeNull();

    const before = await cashierDay(db, asha.id, DAY);
    await markEnteredInError(db, asha.actor, { receiptId: paid.receiptId!, reason: "took the wrong patient's money" }, T0);
    const after = await cashierDay(db, asha.id, DAY);
    const book = await dayBook(db, DAY);

    expect(after.receipts).toBe(before.receipts - 1);
    expect(after.byMode.cash).toBe(book.receipts.byMode.cash);
    expect(after.receipts).toBe(book.receipts.count);
  });

  it("one cashier's card never carries another cashier's money", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);

    const mine = await cashierDay(db, asha.id, DAY);
    const theirs = await cashierDay(db, bimal.id, DAY);
    expect(mine.receipts).toBe(1);
    expect(theirs).toEqual({ receipts: 0, totalPaise: 0, byMode: { cash: 0, upi: 0, card: 0 }, invoicesIssued: 0, invoicedPaise: 0 });
  });

  it("the card renders rupees, and cash is its own figure — the one a drawer is counted against", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    const [card] = await billingDeskProvider.load(ctxFor(asha));
    const stats = new Map((card?.stats ?? []).map((s) => [s.key, s.value]));

    const total = (await db.select({ t: receipts.totalPaise }).from(receipts).where(eq(receipts.receivedBy, asha.id)))[0]!.t;
    expect(stats.get("desk.billing.collected")).toBe(stats.get("desk.billing.cash"));
    expect(stats.get("desk.billing.cash")).toMatch(/^₹[\d,]+\.\d\d$/);
    expect(stats.get("desk.billing.receipts")).toBe("1");
    expect(total).toBeGreaterThan(0);
  });

  /** A day this cashier did not work is zeroes on every mode, not a missing section (E-4). */
  it("a day with no collections is a zeroed section rather than an absent one", async () => {
    const [section] = await billingDeskProvider.report!(ctxFor(asha, "2026-09-30"));
    expect(section!.rows).toEqual([
      ["report.mode.cash", "₹0.00"], ["report.mode.upi", "₹0.00"], ["report.mode.card", "₹0.00"],
    ]);
    expect(section!.totals).toEqual(["report.col.total", "₹0.00"]);
  });

  /**
   * PLAN 07c T8 — the facts a brief adds up. MONEY IS PAISE HERE, deliberately, while the CARD
   * above renders rupees: the card is read once and the facts are summed over 183 days, and a
   * rupee string cannot be added at all.
   */
  it("T8: the facts are integers in paise, and they agree with the card they sit beside", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    const facts = await billingDeskProvider.facts!(ctxFor(asha));
    const day = await cashierDay(db, asha.id, DAY);

    expect(facts["billing.collectedPaise"]).toBe(day.totalPaise);
    expect(facts["billing.cashPaise"]).toBe(day.byMode.cash);
    expect(facts["billing.receipts"]).toBe(1);
    for (const [k, v] of Object.entries(facts)) {
      expect({ [k]: Number.isInteger(v) && v >= 0 }).toEqual({ [k]: true });
    }
  });

  // ═══ FD-1 T3 — the drawer on the card: float, and the cash it should hold NOW (the close's formula) ═══
  it("the drawer: my float and the cash I should hold now — the close's own arithmetic, live; no session says so", async () => {
    await issuePaidInvoice(db, asha, { patientId, serviceId: base.genericServiceId }, T0);
    const [card] = await billingDeskProvider.load(ctxFor(asha));
    const stat = (k: string): string | undefined => card!.stats!.find((s) => s.key === k)?.value;
    expect(stat("desk.billing.float")).toBe(formatPaise(200000));
    const session = (await db.select().from(cashierSessions).where(eq(cashierSessions.cashierUserId, asha.id)))[0]!;
    const live = await liveExpectedCashPaise(db, session);
    const cash = (await db.select().from(receipts).where(eq(receipts.cashierSessionId, session.id)))
      .reduce((n, r) => n + r.totalPaise - r.changeGivenPaise, 0);
    expect(live).toBe(200000 + cash);
    expect(cash).toBeGreaterThan(0);
    expect(stat("desk.billing.expectedCash")).toBe(formatPaise(live));
    // change handed back leaves the drawer: a second sale tendered ₹5 over, ₹5 handed back —
    // receipts are append-only, so the declaration rides the issue itself (07b T5)
    const lines = [{ lineId: newId(), serviceId: base.genericServiceId, qty: 1 }];
    const preview = await previewInvoice(db, { lines }, T0);
    await issueInvoice(db, asha.actor, {
      draftId: newId(), patientId, lines,
      receipt: { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise + 500 }], changeGivenPaise: 500 },
    }, T0);
    expect(await liveExpectedCashPaise(db, session)).toBe(live + preview.totals.netPayablePaise);   // +tender −change = +net
    const [after] = await billingDeskProvider.load(ctxFor(asha));
    expect(after!.stats!.find((s) => s.key === "desk.billing.expectedCash")!.value).toBe(formatPaise(live + preview.totals.netPayablePaise));
    expect(stat("desk.billing.noDrawer")).toBeUndefined();
    // Bimal's drawer is his own: float only, nothing of Asha's cash
    const [bimalCard] = await billingDeskProvider.load(ctxFor(bimal));
    expect(bimalCard!.stats!.find((s) => s.key === "desk.billing.expectedCash")!.value).toBe(formatPaise(200000));
    // a cashier with no drawer open
    const carol = await mkCashier(db, "carol_cashier");
    const [carolCard] = await billingDeskProvider.load(ctxFor(carol));
    expect(carolCard!.stats!.find((s) => s.key === "desk.billing.noDrawer")!.value).toBe("—");
    expect(carolCard!.stats!.find((s) => s.key === "desk.billing.float")).toBeUndefined();
  });
});
