import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, mkBillingManager, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { loadConfig } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import { runDispatchCycle } from "../../kernel/events/dispatcher";
import { buildSubscriptionBus } from "../../kernel/worker/jobs";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  commissionAccruals, counterparties, eventCursors, eventDeadLetters, eventDeliveries, events,
  membershipInstances, membershipPlans, partnerAgreements, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import {
  allocateReceipt, getInvoice, issueCreditNote, issueInvoice, issueRefundVoucher, payRefundVoucher,
  recordReceipt, requestRefund, reverseAllocation,
} from "../billing";
import { accrualLedger, payableTotalPaise } from "./accrual";
import {
  ACCRUAL_EVENT_NAMES, PARTNERS_ACCRUAL_CONSUMER, accrualConsumer, commissionAccrualEnabled,
  handleAccrualEvent,
} from "./consumer";
import { partnersManifest } from "./manifest";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";

/**
 * PLAN 09 T6 — DD7's WIRING, driven through a REAL dispatch cycle rather than by calling the
 * handler by hand. Assertion Book rows F4, F5 and F3c live here, plus A8's dead-letter leg.
 *
 * ═══ WHY THIS FILE BUILDS A BUS AND NOT A HANDLER ═══
 *
 * The failure DD7 exists to prevent is not an arithmetic one — `accrual.test.ts` covers the
 * arithmetic — it is a WIRING one, and the wiring failures this repository has actually shipped
 * were all invisible to a test that called the handler directly: a manifest installed nowhere, a
 * consumers-map entry deleted, a subscription declared for an event nobody emits. So every leg
 * below goes `partnersManifest` → `buildSubscriptionBus` → `runDispatchCycle`, which is the exact
 * path `registerAllJobs` drives in the worker. `worker-runtime.e2e.test.ts` closes the last gap by
 * reading the registry out of a BOOTED `WorkerModule` instead of building one here.
 *
 * ═══ THE FLAG IS OFF BY DEFAULT IN THIS FILE, DELIBERATELY ═══
 *
 * `beforeEach` DELETES `COMMISSION_ACCRUAL_ENABLED` rather than setting it, because the state this
 * hospital will actually run in for months is the OFF one, and DD7's whole claim is about what
 * happens then: the consumer still registers, the cursor still advances, and nothing is written.
 * Legs that need the lane armed say so in one line.
 */
const FLAG = "COMMISSION_ACCRUAL_ENABLED";
const CLERK: Actor = { type: "user", id: "partners-consumer-clerk" };

const NOW = new Date("2026-08-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");
const CARD_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_TO = new Date("2026-12-31T00:00:00Z");
const PAYEE = { payeeName: "Asha Devi", payeeIdType: "aadhaar", payeeIdRef: "XXXX-XXXX-1234" };

describe("the accrual consumer: DD7's registration, its flag, and its cursor", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  let manager: { id: string; actor: Actor };
  let patientId: string;
  let counterpartyId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    delete process.env[FLAG]; // DD14: FALSE unless an operator says otherwise
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "t6_consumer_cashier");
    await openSessionFor(db, cashier, 100_000_000);
    manager = await mkBillingManager(db, "t6_consumer_manager");
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Sunanda Kale", sex: "female", ageYears: 44 }));
    patientId = patient.id;

    counterpartyId = newId();
    const planId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Channel Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM, effectiveTo: null,
      status: "active", createdBy: "test",
      terms: { payableRateBps: 1000, eligibleCategories: ["consultation"], kicker: null },
    });
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-PLAN-${planId.slice(-6)}`, title: "Invented Partner Card", kind: "card",
      counterpartyId, benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    const instanceId = newId();
    await db.insert(membershipInstances).values({
      id: instanceId, planId, counterpartyId, cardCode: `IC-${instanceId.slice(-6)}`,
      holderName: "Sunanda Kale", patientId, validFrom: CARD_FROM, validTo: CARD_TO,
      status: "active", origin: "import", verified: true,
      partnerSaleRef: `INV-SALE-${instanceId.slice(-6)}`,
    });
  });

  /** The bus the worker builds, built the way the worker builds it. */
  const accrualBus = () => {
    const registry = new ModuleRegistry();
    registry.install(partnersManifest);
    return buildSubscriptionBus(registry, { [PARTNERS_ACCRUAL_CONSUMER]: accrualConsumer(db) });
  };

  const cycle = (now = NOW, opts: { maxAttempts?: number } = {}): Promise<number> =>
    runDispatchCycle(db, accrualBus(), { now, maxAttempts: opts.maxAttempts ?? 5 });

  const cursor = async (): Promise<number> => {
    const rows = await db.select().from(eventCursors).where(eq(eventCursors.consumer, PARTNERS_ACCRUAL_CONSUMER));
    return rows[0]?.lastSeq ?? -1;
  };
  /**
   * The highest seq this consumer's own subscription covers. NOT the head of the log: the
   * dispatcher's window is filtered by `name = any(...)`, so `event_cursors.last_seq` tracks the
   * last SUBSCRIBED event and an `advance.received` or a `consumer.poisoned` behind it leaves the
   * cursor legitimately short of the global maximum. Measured here, not assumed — the first draft
   * of these two legs compared against the global head and failed 22 vs 20.
   */
  const maxSubscribedSeq = async (): Promise<number> => {
    const rows = await db.select({ seq: events.seq, name: events.name }).from(events).orderBy(asc(events.seq));
    const mine = rows.filter((r) => ACCRUAL_EVENT_NAMES.includes(r.name));
    expect(mine.length).toBeGreaterThan(0); // never let this helper make a leg pass vacuously
    return mine[mine.length - 1]!.seq;
  };

  /** A consultation invoice, paid in full at the counter. base 100 000 → target 10 000 at 1 000 bps. */
  async function paidConsultation(qty = 2, at = NOW): Promise<string> {
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 * qty }] },
    }, at);
    return issued.invoiceId;
  }

  // ── the declaration itself ──────────────────────────────────────────────────────────────────

  it("declares EXACTLY the four DD7 names, all on one consumer key, and §3 Q4 is why it is four", () => {
    expect(partnersManifest.subscriptions.map((s) => s.event).sort()).toEqual([
      "allocation.reversed", "credit_note.issued", "payment.received", "payment.refunded",
    ]);
    expect([...new Set(partnersManifest.subscriptions.map((s) => s.consumer))]).toEqual([PARTNERS_ACCRUAL_CONSUMER]);
    // The exported list and the manifest are ONE fact: `replayAccruals` walks the list and the
    // dispatcher walks the manifest, and a backfill that scanned a different set of names from the
    // one the live lane consumes would be a replay that silently disagreed with production.
    expect([...ACCRUAL_EVENT_NAMES].sort()).toEqual(partnersManifest.subscriptions.map((s) => s.event).sort());
  });

  it("the bus the worker builds carries this consumer and refuses to build without its handler", () => {
    const registry = new ModuleRegistry();
    registry.install(partnersManifest);
    const pairs = buildSubscriptionBus(registry, { [PARTNERS_ACCRUAL_CONSUMER]: accrualConsumer(db) })
      .consumers()
      .map((c) => [c.consumer, [...c.events].sort()]);
    expect(pairs).toEqual([[
      PARTNERS_ACCRUAL_CONSUMER,
      ["payment.received", "payment.refunded", "allocation.reversed", "credit_note.issued"].sort(),
    ]]);
    // Declaring the four without the handler is a BOOT ERROR by design — which is why the manifest
    // edit and the `workerConsumers` edit are one commit.
    expect(() => buildSubscriptionBus(registry, {})).toThrow(/partners\.accrual/);
  });

  it("an event this consumer does not subscribe to is a no-op, not a parse failure", async () => {
    const e: DispatchedEvent = {
      seq: 1, eventId: newId(), name: "invoice.issued", payload: {}, patientId: null,
      correlationId: null, occurredAt: NOW,
    };
    expect(await handleAccrualEvent(db, e)).toEqual({ outcome: "not_subscribed" });
  });

  // ── F4 and F5: the flag decides WRITES, never registration and never the cursor ──────────────

  it("F4/F5 — with the flag OFF: NO accrual row exists, AND the cursor still advances. Both, separately.", async () => {
    await paidConsultation();
    await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }] }, NOW);

    expect(commissionAccrualEnabled()).toBe(false);
    await cycle();

    // (a) F4 — the flag is LOAD-BEARING. Nothing is written.
    expect(await db.select().from(commissionAccruals)).toEqual([]);

    // (b) F5 — and nothing is STUCK. The cursor is at the head of the log and every delivery this
    //     consumer owns is `done`, which is what makes the flag flip a two-step operation rather
    //     than an archaeology project: register always, advance always, write only when armed.
    expect(await cursor()).toBe(await maxSubscribedSeq());
    const deliveries = await db.select().from(eventDeliveries).where(eq(eventDeliveries.consumer, PARTNERS_ACCRUAL_CONSUMER));
    expect(deliveries.length).toBeGreaterThan(0);
    expect([...new Set(deliveries.map((d) => d.status))]).toEqual(["done"]);
  });

  it("with the flag ON the SAME cycle writes the accrual — so the OFF leg above is a discrimination", async () => {
    process.env[FLAG] = "true";
    await paidConsultation();
    await cycle();
    expect((await accrualLedger(db, { counterpartyId })).map((r) => r.amountPaise)).toEqual([10_000]);
    expect(await cursor()).toBe(await maxSubscribedSeq());
  });

  // ── F3c: the two names a first reading would have missed ────────────────────────────────────

  it("F3c — `allocation.reversed` reverses: a consumer on the two PAYMENT names would keep the money", async () => {
    process.env[FLAG] = "true";
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 }],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    const receipt = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }] }, NOW);
    const applied = await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId: issued.invoiceId, amountPaise: 100_000 }, NOW);
    await cycle();
    expect(await payableTotalPaise(db, counterpartyId)).toBe(10_000);

    // `reverseAllocation` emits `allocation.reversed` and NO refund event — measured in §3 Q4.
    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "posted to the wrong bill" }, NOW);
    const emitted = await db.select({ name: events.name }).from(events).orderBy(asc(events.seq));
    expect(emitted.map((e) => e.name)).toContain("allocation.reversed");
    expect(emitted.map((e) => e.name)).not.toContain("payment.refunded");

    await cycle();
    expect(await payableTotalPaise(db, counterpartyId)).toBe(0);
  });

  it("`credit_note.issued` reaches the consumer, and a note on an INELIGIBLE line moves the accrual UP", async () => {
    process.env[FLAG] = "true";
    // consultation qty 2 (eligible, base 100 000) + pharmacy qty 1 (base 50 000 + 6 000 GST),
    // netPayable 156 000, on the dues lane so the payment is a separate, part settlement.
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 },
        { lineId: newId(), serviceId: base.genericServiceId, qty: 1 },
      ],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(156_000);
    const lineIds = (await getInvoice(db, issued.invoiceId))!.lines.map((l) => l.id);

    const receipt = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 78_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId: issued.invoiceId, amountPaise: 78_000 }, NOW);
    await cycle();
    // targetBase = divHalfUp(100 000 × 78 000, 156 000) = 50 000 → target 5 000
    expect(await payableTotalPaise(db, counterpartyId)).toBe(5_000);

    // A refund note over the PHARMACY line — which is not eligible, so it shrinks what is
    // settleable and does not shrink the eligible base. The same 78 000 now covers a larger share
    // of the partner's own base, and the delta is POSITIVE.
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: issued.invoiceId, reason: "the medicine was returned unopened",
      lines: [{ invoiceLineId: lineIds[1]!, qty: 1 }], // the STORED id, never the draft id (§3 Q4)
    }, NOW);
    await cycle();
    // settleable = 156 000 − 56 000 = 100 000 · eligibleBase still 100 000 · collected 78 000
    // targetBase = divHalfUp(100 000 × 78 000, 100 000) = 78 000 → target 7 800
    expect((await accrualLedger(db, { counterpartyId })).map((r) => [r.basisEventName, r.amountPaise])).toEqual([
      ["payment.received", 5_000],
      ["credit_note.issued", 2_800],
    ]);
  });

  // ── `payment.refunded` carries no invoice, and the two shapes that follow from that ──────────

  /**
   * PLAN 09a / DD1 — RENAMED AND RE-SCOPED, BECAUSE THE RULING REMOVED WHAT THIS USED TO PROVE.
   *
   * It was `… and the accrual comes back down`, asserting a −5 000 row on `payment.refunded`.
   * Under the clamp that row CANNOT EXIST, and the reason is a billing guard rather than an
   * accrual one: `issueRefundVoucher` caps a refund at `min(received, refundableSurplus)`, the
   * surplus of cash held over what is still owed. So after ANY legal refund `collected >= settleable`,
   * the ratio is >= 1, and the clamp has already pinned the target at `eligibleBase`. **A refund
   * moves cash, and under SERVICE DELIVERED the commission followed the SERVICE when the credit
   * note was issued.** That is the owner's ruling working, not a gap in it.
   *
   * WHAT THIS STILL PROVES, and it is the reason the test survives: `payment.refunded` carries
   * `{voucherId, patientId, amountPaise, method}` and NO invoice, so the consumer must read
   * `refund_vouchers.invoice_id` and RECOMPUTE — and a recomputation that lands on the same number
   * must append nothing (`appendAccrualDelta` writes nothing when the delta is zero).
   *
   * §2.67 — WHAT THIS DOES NOT DISCRIMINATE, said plainly rather than implied. A consumer that
   * failed to resolve the voucher and SKIPPED would also append nothing, so this assertion cannot
   * separate the two. The resolution itself is pinned by the ADVANCE-refund test below (an
   * unresolvable voucher is skipped rather than erroring) and by the shipped code path; **I have
   * not built a mutant that removes the resolution, and I make no claim that this test would kill
   * one.** Restoring a discriminating shape needs a scenario where a refund can drive `collected`
   * below `settleable`, and the billing cap above means no such scenario exists today.
   */
  it("`payment.refunded` is resolved through `refund_vouchers` and correctly appends NOTHING — the credit note already moved it", async () => {
    process.env[FLAG] = "true";
    const invoiceId = await paidConsultation(2);
    const lineId = (await getInvoice(db, invoiceId))!.lines[0]!.id;
    await cycle();
    expect(await payableTotalPaise(db, counterpartyId)).toBe(10_000);

    /**
     * ONE OF TWO CONSULTATIONS WAS NOT GIVEN, so half the service is gone the moment the note is
     * issued — DD1's ruling, and the old comment here ("the note alone moves NOTHING … the ratio
     * is unchanged") was the CASH-HELD reading whose unchanged ratio of 2.0 was the defect itself.
     * eligibleBase 100 000 - 50 000 = 50 000 · settleable 100 000 - 50 000 = 50 000 · collected
     * still 100 000 -> scaled 100 000, CLAMPED to 50 000 -> target 5 000, delta -5 000.
     */
    const note = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "one consultation was not given",
      lines: [{ invoiceLineId: lineId, qty: 1 }],
    }, NOW);
    await cycle();
    expect(await payableTotalPaise(db, counterpartyId)).toBe(5_000);

    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: note.creditNoteId, amountPaise: 50_000,
      reasonClass: "genuine", reason: "the consultation was not given",
    });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "approved for the test" });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: note.creditNoteId, amountPaise: 50_000,
      reasonClass: "genuine", reason: "the consultation was not given",
      approvalId: asked.approvalId, method: "cash",
    }, NOW);
    // ISSUED is not PAID — the money has not left the drawer.
    await cycle();
    expect(await payableTotalPaise(db, counterpartyId)).toBe(5_000);

    await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW);
    await cycle();
    /**
     * collected 100 000 - 50 000 = 50 000 · settleable 50 000 · eligibleBase 50 000 -> scaled
     * 50 000, target 5 000 — the number it already was. TWO rows, not three.
     */
    expect((await accrualLedger(db, { counterpartyId })).map((r) => [r.basisEventName, r.amountPaise])).toEqual([
      ["payment.received", 10_000],
      ["credit_note.issued", -5_000],
    ]);
    expect(await payableTotalPaise(db, counterpartyId)).toBe(5_000);
  });


  it("an ADVANCE refund names no invoice at all, and is a fact the consumer skips rather than an error", async () => {
    process.env[FLAG] = "true";
    // An unallocated receipt is an advance: `advance.received`, no invoice anywhere.
    await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 30_000 }] }, NOW);
    const asked = await requestRefund(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 30_000,
      reasonClass: "genuine", reason: "the patient did not stay",
    });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "approved for the test" });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 30_000,
      reasonClass: "genuine", reason: "the patient did not stay",
      approvalId: asked.approvalId, method: "cash",
    }, NOW);
    await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW);

    const refunded = (await db
      .select({ seq: events.seq, eventId: events.eventId, name: events.name, payload: events.payload,
        patientId: events.patientId, correlationId: events.correlationId, occurredAt: events.occurredAt })
      .from(events).where(eq(events.name, "payment.refunded")))[0]!;
    expect(await handleAccrualEvent(db, { ...refunded, occurredAt: new Date(refunded.occurredAt) }))
      .toEqual({ outcome: "no_invoice" });

    await cycle();
    expect(await db.select().from(commissionAccruals)).toEqual([]);
    expect(await cursor()).toBe(await maxSubscribedSeq());
  });

  // ── A8: a poison row parks, and the lane keeps moving ────────────────────────────────────────

  it("A8 — a poison event PARKS after its attempts and the NEXT event still processes", async () => {
    process.env[FLAG] = "true";
    // A `credit_note.issued` row whose payload this consumer cannot read. It is inserted directly
    // because nothing in billing can emit one — `defineEvent().make()` parses before it appends —
    // and a lane that has never met a malformed event is a lane nobody has tested A8 on.
    await db.insert(events).values({
      eventId: newId(), name: "credit_note.issued", version: 1, occurredAt: NOW,
      actorType: "system", actorId: "corrupt-producer", module: "billing",
      payload: { creditNoteNo: "CN-1", kind: "refund" }, // no invoiceId, no creditNoteId, no netPaise
    });
    const poisonSeq = await maxSubscribedSeq();
    await paidConsultation(); // the GOOD event, behind the poison one in the log

    // maxAttempts 2 so the row parks on the second cycle; the second cycle's `now` is past the
    // 2-second backoff the first one set.
    await cycle(NOW, { maxAttempts: 2 });
    expect(await db.select().from(commissionAccruals)).toEqual([]); // in-order: the poison HOLDS the lane
    await cycle(new Date(NOW.getTime() + 10_000), { maxAttempts: 2 });

    const parked = await db.select().from(eventDeadLetters).where(eq(eventDeadLetters.consumer, PARTNERS_ACCRUAL_CONSUMER));
    expect(parked).toHaveLength(1);
    expect(parked[0]!.seq).toBe(poisonSeq);
    // Parked is RESOLVED: the cursor moves past it and one bad row does not stop a hospital's
    // commission ledger for ever.
    expect(await payableTotalPaise(db, counterpartyId)).toBe(10_000);
    expect(await cursor()).toBe(await maxSubscribedSeq());
    const poisoned = await db.select().from(events).where(eq(events.name, "consumer.poisoned"));
    expect(poisoned).toHaveLength(1);
  });

  // ── the flag reader itself ──────────────────────────────────────────────────────────────────

  it("commissionAccrualEnabled agrees with loadConfig on every spelling, including the ones both refuse", () => {
    // The duplicate spelling exists because `loadConfig()` cannot run on this code path in CI (it
    // requires DATABASE_URL and SECRET_KEY, which the worker's caller cannot hand down here — F1's
    // scar). This leg is what stops the duplicate drifting into a DISAGREEMENT.
    const withFlag = (value?: string): NodeJS.ProcessEnv =>
      (value === undefined ? {} : { [FLAG]: value }) as NodeJS.ProcessEnv;
    const viaConfig = (value?: string): boolean =>
      loadConfig({
        DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
        ...(value === undefined ? {} : { [FLAG]: value }),
      } as NodeJS.ProcessEnv).commissionAccrualEnabled;

    expect(commissionAccrualEnabled(withFlag("true"))).toBe(true);
    expect(viaConfig("true")).toBe(true);
    expect(commissionAccrualEnabled(withFlag("false"))).toBe(false);
    expect(viaConfig("false")).toBe(false);
    expect(commissionAccrualEnabled(withFlag(undefined))).toBe(false); // DD14
    expect(viaConfig(undefined)).toBe(false);

    // The `z.coerce.boolean()` trap in both directions: under coercion "false" is a non-empty
    // string and therefore TRUE, which would arm a commission ledger for an operator who wrote the
    // value that means off.
    for (const bad of ["1", "TRUE", ""]) {
      expect(() => commissionAccrualEnabled(withFlag(bad))).toThrow();
      expect(() => viaConfig(bad)).toThrow();
    }
  });
});
