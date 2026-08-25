import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { runDispatchCycle } from "../../kernel/events/dispatcher";
import { buildSubscriptionBus } from "../../kernel/worker/jobs";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  commissionAccruals, counterparties, eventCursors, events, membershipInstances, membershipPlans,
  partnerAgreements, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import {
  allocateReceipt, getInvoice, issueCreditNote, issueInvoice, recordReceipt, reverseAllocation,
} from "../billing";
import { accrualLedger } from "./accrual";
import { PARTNERS_ACCRUAL_CONSUMER, accrualConsumer } from "./consumer";
import { partnersManifest } from "./manifest";
import { replayAccruals } from "./replay";
import type { Db } from "../../kernel/db/client";

/**
 * DD7's SECOND STEP — **flag-on + replay reproduces exactly what live processing would have
 * produced.** That is the phase's headline promise ("turning the lane on is a flag flip against
 * tested code, not a new project") and this file is the only place it is a MEASUREMENT.
 *
 * ═══ HOW THE TWO LEDGERS ARE MADE COMPARABLE ═══
 *
 * The same scenario is built TWICE from the same fixed instants, on a truncated database each
 * time: once with the lane ARMED and driven by real `runDispatchCycle` calls, and once with the
 * lane OFF (cycles still run, the cursor still advances, nothing is written) followed by
 * `replayAccruals`. Ids differ between the two runs by construction — ULIDs are minted per run —
 * so the comparison projects each row onto `[basisEventName, kind, state, amountPaise]`, which is
 * every fact about the row that is not an identifier.
 */
const CLERK: Actor = { type: "user", id: "partners-replay-clerk" };
const FLAG = "COMMISSION_ACCRUAL_ENABLED";

const NOW = new Date("2026-08-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");
const CARD_FROM = new Date("2026-01-01T00:00:00Z");
const CARD_TO = new Date("2026-12-31T00:00:00Z");

type LedgerShape = [string | null, string, string, number][];

describe("the accrual replay: a backfill that is the same code, not a second implementation", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    delete process.env[FLAG];
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "t6_replay_cashier");
    await openSessionFor(db, cashier, 100_000_000);
  });

  const cycle = (): Promise<number> => {
    const registry = new ModuleRegistry();
    registry.install(partnersManifest);
    return runDispatchCycle(db, buildSubscriptionBus(registry, { [PARTNERS_ACCRUAL_CONSUMER]: accrualConsumer(db) }), { now: NOW });
  };

  /**
   * ONE partner, ONE member, ONE mixed invoice, and FOUR money events across THREE of the four
   * subscribed names — a part payment, a credit note on an INELIGIBLE line, the balance, and a
   * reversal of the balance. Every instant is fixed, so the two runs differ only in their ids.
   *
   * consultation qty 2 (eligible, base 100 000) + pharmacy qty 1 (base 50 000 + 6 000 GST) →
   * netPayable 156 000, on the dues lane.
   *   1. pay 78 000  → collected 78 000, settleable 156 000 → targetBase = divHalfUp(100 000 × 78 000,
   *                    156 000) = 50 000 → target 5 000 → delta +5 000
   *   2. credit the pharmacy line (56 000) → settleable 100 000, eligibleBase still 100 000 →
   *      targetBase = 78 000 → target 7 800 → delta +2 800
   *   3. pay the remaining 22 000 — which is what the invoice still owes AFTER the credit note
   *      (156 000 − 78 000 − 56 000), measured here as an over_allocation refusal on the first
   *      draft — → collected 100 000 = settleable 100 000 → targetBase = eligibleBase = 100 000 →
   *      target 10 000 → delta +2 200
   *   4. reverse that second allocation → collected 78 000 → target 7 800 → delta −2 200
   */
  async function buildScenario(afterStep: () => Promise<unknown> = async () => undefined): Promise<string> {
    const counterpartyId = newId();
    const planId = newId();
    const instanceId = newId();
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Replay Subject", sex: "male", ageYears: 61 }));
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
    await db.insert(membershipInstances).values({
      id: instanceId, planId, counterpartyId, cardCode: `IC-${instanceId.slice(-6)}`,
      holderName: "Replay Subject", patientId: patient.id, validFrom: CARD_FROM, validTo: CARD_TO,
      status: "active", origin: "import", verified: true, partnerSaleRef: `INV-SALE-${instanceId.slice(-6)}`,
    });

    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id,
      lines: [
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 },
        { lineId: newId(), serviceId: base.genericServiceId, qty: 1 },
      ],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    const lineIds = (await getInvoice(db, issued.invoiceId))!.lines.map((l) => l.id);

    const r1 = await recordReceipt(db, cashier.actor, { patientId: patient.id, tenders: [{ mode: "cash", amountPaise: 78_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: r1.receiptId, invoiceId: issued.invoiceId, amountPaise: 78_000 }, NOW);
    await afterStep();
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: issued.invoiceId, reason: "the medicine was returned unopened",
      lines: [{ invoiceLineId: lineIds[1]!, qty: 1 }],
    }, NOW);
    await afterStep();
    const r2 = await recordReceipt(db, cashier.actor, { patientId: patient.id, tenders: [{ mode: "cash", amountPaise: 22_000 }] }, NOW);
    const applied = await allocateReceipt(db, cashier.actor, { receiptId: r2.receiptId, invoiceId: issued.invoiceId, amountPaise: 22_000 }, NOW);
    await afterStep();
    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "posted to the wrong bill" }, NOW);
    await afterStep();
    return counterpartyId;
  }

  const shapeOf = async (counterpartyId: string): Promise<LedgerShape> =>
    (await accrualLedger(db, { counterpartyId })).map((r) => [r.basisEventName, r.kind, r.state, r.amountPaise]);

  it("flag-on + REPLAY reproduces EXACTLY what live processing produced, row for row", async () => {
    // ── run 1: the DISPATCHER drives the handler, one cycle after every money event ──
    process.env[FLAG] = "true";
    const liveCounterparty = await buildScenario(cycle);
    const live = await shapeOf(liveCounterparty);
    expect(live).toEqual([
      ["payment.received", "accrual", "accrued", 5_000],
      ["credit_note.issued", "accrual", "accrued", 2_800],
      ["payment.received", "accrual", "accrued", 2_200],
      ["allocation.reversed", "reversal", "accrued", -2_200],
    ]);

    // ── run 2: the REPLAY JOB drives the handler, at the same points ──
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "t6_replay_cashier");
    await openSessionFor(db, cashier, 100_000_000);
    const replayCounterparty = await buildScenario(() => replayAccruals(db));
    const replayed = await shapeOf(replayCounterparty);

    // IDENTICAL, row for row. That is the whole design claim: `replayAccruals` is not a second
    // implementation of DD12, it is `handleAccrualEvent` driven from the events table instead of
    // from a subscription bus, and a backfill written as its own arithmetic would be a second
    // place for the base to be wrong.
    expect(replayed).toEqual(live);
    expect(replayed).toEqual([
      ["payment.received", "accrual", "accrued", 5_000],
      ["credit_note.issued", "accrual", "accrued", 2_800],
      ["payment.received", "accrual", "accrued", 2_200],
      ["allocation.reversed", "reversal", "accrued", -2_200],
    ]);
  });

  it("a BACKFILL taken after the fact converges to the same TOTAL in fewer rows — DD12 property 4, stated exactly", async () => {
    // The lane was OFF for the whole life of this invoice, which is the state the hospital will
    // actually be in on the day the CA gate opens.
    delete process.env[FLAG];
    const counterpartyId = await buildScenario(cycle);
    expect(await db.select().from(commissionAccruals)).toEqual([]);
    const cursorRows = await db.select().from(eventCursors).where(eq(eventCursors.consumer, PARTNERS_ACCRUAL_CONSUMER));
    expect(cursorRows[0]!.lastSeq).toBeGreaterThan(0); // ... and nothing is stuck (DD7 / F5)

    process.env[FLAG] = "true";
    const counts = await replayAccruals(db);
    expect(counts.scanned).toBe(4);

    // ═══ WHAT A BACKFILL CAN AND CANNOT REPRODUCE, MEASURED RATHER THAN ASSUMED ═══
    //
    // `invoiceAccrualView` reports an invoice's LIVE money and takes no as-of parameter, so a
    // backfill run today sees the invoice as it stands today. The FIRST event replayed therefore
    // computes the FINAL target and appends it whole, and the three behind it find the subject
    // already at target and append nothing. The TOTAL is identical to the live run's — which is
    // exactly the guarantee DD12 property 4 states ("pay-then-credit and credit-then-pay converge
    // to the same total") — and the ROW GRANULARITY is coarser, because nothing in this system can
    // reconstruct what the invoice looked like at an instant that has passed.
    expect(await shapeOf(counterpartyId)).toEqual([
      ["payment.received", "accrual", "accrued", 7_800],
    ]);
    expect(counts.appended).toBe(1);
    expect(counts.noDelta).toBe(3);
    expect(counts.appendedPaise).toBe(7_800);
    // The live ledger above sums to 5 000 + 2 800 + 2 200 − 2 200 = 7 800. Same money, one row.
  });

  it("REFUSES to run with the flag off, rather than reporting a clean pass having written nothing", async () => {
    await buildScenario();
    await expect(replayAccruals(db)).rejects.toMatchObject({ code: "accrual_disabled" });
    // ... and the explicit env argument is honoured, so a caller can drive it without touching
    // the process environment.
    await expect(replayAccruals(db, { env: { COMMISSION_ACCRUAL_ENABLED: "false" } as NodeJS.ProcessEnv }))
      .rejects.toMatchObject({ code: "accrual_disabled" });
    expect(await db.select().from(commissionAccruals)).toEqual([]);
  });

  it("a WINDOWED replay walks only its window, and `lastSeq` says where it stopped", async () => {
    process.env[FLAG] = "true";
    const counterpartyId = await buildScenario();
    const accrualSeqs = (await db.select({ seq: events.seq, name: events.name }).from(events).orderBy(asc(events.seq)))
      .filter((r) => ["payment.received", "payment.refunded", "allocation.reversed", "credit_note.issued"].includes(r.name))
      .map((r) => r.seq);
    expect(accrualSeqs).toHaveLength(4);

    const first = await replayAccruals(db, { toSeq: accrualSeqs[1]! });
    expect(first.scanned).toBe(2);
    expect(first.lastSeq).toBe(accrualSeqs[1]);
    // No cycles ran during `buildScenario`, so this window sees the FINAL state and the first
    // event carries the whole 7 800 — the backfill shape above, in miniature.
    expect(await shapeOf(counterpartyId)).toEqual([["payment.received", "accrual", "accrued", 7_800]]);

    const rest = await replayAccruals(db, { fromSeq: accrualSeqs[1]! });
    expect(rest.scanned).toBe(2);
    expect(rest.appended).toBe(0);
    expect(rest.noDelta).toBe(2);
    expect(await shapeOf(counterpartyId)).toEqual([["payment.received", "accrual", "accrued", 7_800]]);
  });

  it("a replay of a batch SMALLER than the history still walks the whole history", async () => {
    process.env[FLAG] = "true";
    const counterpartyId = await buildScenario();
    const counts = await replayAccruals(db, { batchSize: 1 });
    expect(counts.scanned).toBe(4);
    expect(counts.lastSeq).toBeGreaterThan(0);
    expect(await shapeOf(counterpartyId)).toEqual([["payment.received", "accrual", "accrued", 7_800]]);
  });
});
