import { setupTestDb, truncateAll } from "./helpers/db";
import { issuePaidInvoice, issuePaidInvoiceByTender, openSessionFor, seedBillingBase } from "./helpers/billing";
import { markEnteredInError } from "../src/modules/billing/receipts";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { collectDeskProviders } from "../src/kernel/desk/registry";
import { receipts } from "../src/kernel/db/schema";
import { eq } from "drizzle-orm";
import { addDays, liveFactsFor, sumWindow } from "../src/kernel/desk/rollup";
import { mergeBuckets, totalsOf } from "../src/kernel/desk/range";
import { billingRange } from "../src/modules/billing/range";
import type { DeskProvider } from "../src/kernel/desk/types";
import type { RangeDimension } from "../src/kernel/desk/range";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ PHASE STAFF-REPORTS T5 — THE MONEY, AND IT MUST RECONCILE TOO ═══
 *
 * `range-parity.test.ts` pins OPD's counts against the pulse. This is the same property for the
 * half that matters most: **if a money column on a report disagrees with the money column on the
 * dashboard, somebody has to explain the gap to an owner, and neither screen says which is right.**
 *
 * `billing.collectedPaise` and its siblings come from `cashierDay`, and it does three things a
 * rewrite would not:
 *
 *   1. cuts on `service_day` (the stored IST day), never `created_at`;
 *   2. **EXCLUDES entered-in-error documents** — a voided receipt is not money;
 *   3. sums receipt totals and subtracts NO credit note and NO refund.
 *
 * The second is the one that would have gone unnoticed. It is undocumented in the fact's own
 * comment, and getting it wrong makes every figure slightly too big — which looks like a busy month
 * rather than a bug.
 */
const T0 = new Date("2026-08-17T06:30:00.000Z"); // Monday, noon IST
const DAY = "2026-08-17";

/** The money measures both instruments claim to count. */
const RECONCILED = [
  "billing.receipts",
  "billing.collectedPaise",
  "billing.cashPaise",
  "billing.upiPaise",
  "billing.cardPaise",
  "billing.invoicesIssued",
  "billing.invoicedPaise",
] as const;

describe("staff-reports T5 — the money reconciles against the pulse", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let providers: DeskProvider[];
  let cashier: Awaited<ReturnType<typeof mkUser>>;
  let other: Awaited<ReturnType<typeof mkUser>>;
  let fx: Awaited<ReturnType<typeof seedBillingBase>>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    /* `mkPatient` mints a UHID, which needs `registration_config`; `seedBillingBase` does not seed
     * it because billing tests usually bring their own patient. */
    await seedOpdBase(db);
    fx = await seedBillingBase(db);
    await ensureRole(db, "desk_cashier");
    for (const p of ["billing.session.own", "billing.invoice.issue", "billing.invoice.read", "billing.receipt.record"]) {
      await grantPermissionToRole(db, registry, "desk_cashier", p);
    }
    cashier = await mkUser(db, "cashier_a", ["desk_cashier", "cashier"]);
    other = await mkUser(db, "cashier_b", ["desk_cashier", "cashier"]);
    await openSessionFor(db, cashier, 100_000);
    await openSessionFor(db, other, 100_000);
    providers = collectDeskProviders(registry);
  });

  let phone = 9876550000;
  const bill = async (
    u: Awaited<ReturnType<typeof mkUser>>, mode: "cash" | "upi" | "card" = "cash",
  ): Promise<void> => {
    phone += 1;
    const p = await mkPatient(db, u.actor, { phone: String(phone) });
    if (mode === "cash") {
      await issuePaidInvoice(db, u, { patientId: p.id, serviceId: fx.genericServiceId }, T0);
      return;
    }
    await issuePaidInvoiceByTender(
      db, u, { patientId: p.id, serviceId: fx.genericServiceId, mode, refText: `ref-${String(phone)}` }, T0,
    );
  };

  const pulse = async (
    u: Awaited<ReturnType<typeof mkUser>>, from: string, to: string,
  ): Promise<Record<string, number>> => {
    const days: { day: string; facts: Record<string, number>; provisional: boolean }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.push({
        day: d, provisional: false,
        facts: await liveFactsFor(providers, { db, actor: u.actor, reader: u.actor, date: d, now: T0 }),
      });
    }
    return sumWindow(days);
  };

  const breakdown = async (
    from: string, to: string, groupBy: RangeDimension[], userIds?: string[],
  ): Promise<Record<string, number>> => totalsOf(mergeBuckets(
    await billingRange({ db, reader: cashier.actor, filters: { from, to, userIds }, groupBy, now: T0 }),
    groupBy,
  ));

  const compare = (a: Record<string, number>, b: Record<string, number>): void => {
    for (const m of RECONCILED) expect([m, b[m] ?? 0]).toEqual([m, a[m] ?? 0]);
  };

  it("one cashier, one day: every money measure matches", async () => {
    await bill(cashier, "cash");
    await bill(cashier, "upi");

    compare(await pulse(cashier, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [cashier.id]));
  });

  /** The tender split must add up to what was collected, in both instruments. */
  it("the tender split sums to the collected total", async () => {
    await bill(cashier, "cash");
    await bill(cashier, "upi");
    await bill(cashier, "card");

    const t = await breakdown(DAY, DAY, ["userId"], [cashier.id]);
    expect(t["billing.cashPaise"]! + t["billing.upiPaise"]! + t["billing.cardPaise"]!)
      .toBe(t["billing.collectedPaise"]);
  });

  it("two cashiers: each reconciles against their own drawer, not the hospital's", async () => {
    await bill(cashier, "cash");
    await bill(other, "cash");
    await bill(other, "upi");

    compare(await pulse(cashier, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [cashier.id]));
    compare(await pulse(other, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [other.id]));
  });

  /**
   * THE TOTAL MUST NOT DEPEND ON THE GROUPING. A payer or service-head column cannot change how
   * much money came in — but a GROUP BY that drops a NULL dimension, or a key that fails to merge,
   * is exactly how it would.
   */
  it("the total is the same however the money is sliced", async () => {
    await bill(cashier, "cash");
    await bill(other, "upi");

    const groupings: RangeDimension[][] = [
      ["userId"], ["day"], ["payer"], ["userId", "day"], ["userId", "payer"],
    ];
    const first = await breakdown(DAY, DAY, groupings[0]!);
    for (const g of groupings.slice(1)) {
      const got = await breakdown(DAY, DAY, g);
      for (const m of RECONCILED) expect([g.join("+"), m, got[m] ?? 0]).toEqual([g.join("+"), m, first[m] ?? 0]);
    }
  });

  /**
   * ═══ THE SERVICE HEAD ═══
   *
   * `invoice_lines.category` is denormalised onto the line, so this needs no tariff join — and it
   * records what the line was billed AS at the time, which is what a historical report must show
   * even after somebody re-categorises the service.
   */
  it("splits the invoiced money by service head", async () => {
    await bill(cashier, "cash");
    const rows = mergeBuckets(
      await billingRange({
        db, reader: cashier.actor, filters: { from: DAY, to: DAY, userIds: [cashier.id] },
        groupBy: ["serviceCategory"], now: T0,
      }),
      ["serviceCategory"],
    );
    const withCategory = rows.filter((r) => r.key.serviceCategory !== undefined);
    expect(withCategory.length).toBeGreaterThan(0);
    expect(withCategory.every((r) => (r.measures["billing.lineGrossPaise"] ?? 0) > 0)).toBe(true);
  });

  /**
   * A window with no money agrees at zero — and says nothing rather than asserting zeros nobody
   * measured, which is `dropEmptyBuckets`' job one level down.
   */
  it("an empty window reconciles too", async () => {
    compare(await pulse(cashier, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [cashier.id]));
  });

  /**
   * ═══ THE TRAP THIS WHOLE FILE WAS WRITTEN AROUND — A VOIDED RECEIPT IS NOT MONEY ═══
   *
   * `cashierDay` excludes entered-in-error documents, and nothing in the fact's own comment says
   * so. A range query that counted them would make every figure SLIGHTLY TOO BIG — which reads as a
   * busy month, not as a bug, and would be found (if ever) by a cashier whose day book disagreed
   * with a report nobody thought to distrust.
   *
   * This is the assertion that proves the range inherited the exclusion rather than merely matching
   * on a fixture where nothing was ever voided.
   */
  it("a VOIDED receipt is excluded by both instruments, not just by the pulse", async () => {
    await bill(cashier, "cash");
    await bill(cashier, "cash");

    const before = await breakdown(DAY, DAY, ["userId"], [cashier.id]);
    expect(before["billing.receipts"]).toBe(2);

    const live = await db.select({ id: receipts.id }).from(receipts)
      .where(eq(receipts.receivedBy, cashier.id));
    await markEnteredInError(
      db, cashier.actor, { receiptId: live[0]!.id, reason: "keyed against the wrong patient" }, T0,
    );

    const after = await breakdown(DAY, DAY, ["userId"], [cashier.id]);
    expect(after["billing.receipts"]).toBe(1);
    expect(after["billing.collectedPaise"]).toBeLessThan(before["billing.collectedPaise"]!);
    // And the two instruments still agree AFTER the void — which is the point. Either both
    // exclude it or neither does; a divergence here is the report and the day book disagreeing.
    compare(await pulse(cashier, DAY, DAY), after);
  });

  /**
   * ═══ A DAY OUTSIDE THE WINDOW IS NOT COUNTED ═══
   *
   * The pulse asks day by day and the range asks once with `between`, so an off-by-one at either
   * end shows up here and nowhere else.
   */
  it("money on the days either side of the window is excluded by both", async () => {
    await bill(cashier, "cash");
    const before = new Date(`${addDays(DAY, -1)}T06:30:00.000Z`);
    const after = new Date(`${addDays(DAY, 1)}T06:30:00.000Z`);
    phone += 1;
    const p1 = await mkPatient(db, cashier.actor, { phone: String(phone) });
    await issuePaidInvoice(db, cashier, { patientId: p1.id, serviceId: fx.genericServiceId }, before);
    phone += 1;
    const p2 = await mkPatient(db, cashier.actor, { phone: String(phone) });
    await issuePaidInvoice(db, cashier, { patientId: p2.id, serviceId: fx.genericServiceId }, after);

    compare(await pulse(cashier, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [cashier.id]));
    expect((await breakdown(DAY, DAY, ["userId"], [cashier.id]))["billing.receipts"]).toBe(1);
  });
});
