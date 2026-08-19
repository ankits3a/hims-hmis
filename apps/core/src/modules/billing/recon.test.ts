import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  issuePaidInvoiceByTender, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import {
  events, receiptTenders, receipts, reconBatches, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { loadBillingConfig } from "./config";
import { recordReceipt } from "./receipts";
import { listMismatches, setDegraded, uploadSettlement } from "./recon";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T9, D7/E-25/E-26 -- tender lifecycle, degraded mode, statement-upload reconciliation.
 * Assertion Book K31 (compare vs EXPECTED-NET) / K32 (re-upload cannot rewrite a reconciled
 * tender).
 *
 * THE SEEDED FIXTURE (test/helpers/billing.ts `seedBillingBase`): OPD-CONSULT-NEW priced 50000
 * paise, category "consultation" (GST-EXEMPT, sac 999312) -- gross 50000, no discount, no GST
 * heads, netPayable 50000 exactly (no rounding remainder; the same fixture invoices.test.ts's
 * overpayment test uses). `billing_config`: `feeBps { upi: 0, card: 150 }`, `reconTolerancePaise
 * 100` (mirrors seed-billing.ts).
 *
 * THE HAND-DERIVATION every card-mode number below rests on (modules/tariff/money.ts):
 *   percentAmount(50000, 150) = divHalfUp(50000*150, 10000) = divHalfUp(7,500,000, 10000)
 *                              = floor((15,000,000 + 10,000) / 20,000) = floor(750.5) = 750
 *   expectedNetPaise = amountPaise - fee = 50000 - 750 = 49250
 * (the same value invoices.test.ts's B2B test independently pins on the SAME stamp).
 *
 * `expectedNetPaise` is CONSUMED here, read straight off `receipt_tenders.expected_net_paise` --
 * it is stamped once, by `insertReceiptWithTenders` (invoices.ts) at CAPTURE, and nothing in this
 * suite or in recon.ts recomputes it (self-review 12; T9 task notes).
 */
describe("recon.ts: tender lifecycle, degraded mode, statement-upload reconciliation (D7/E-25/E-26)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  const NOW = new Date("2026-08-19T06:00:00Z");
  const ACTOR: Actor = { type: "user", id: "recon-uploader" };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function mkTestPatient(name = "Recon Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "recon-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 40 }));
    return patient.id;
  }

  async function cashierWithSession(username: string): Promise<{ id: string; actor: Actor }> {
    const cashier = await mkCashier(db, username);
    await openSessionFor(db, cashier, 100_000);
    return cashier;
  }

  function csvOf(rows: string[]): string {
    return ["ref,settledPaise,settledOn", ...rows].join("\n");
  }

  /** One settled invoice, paid by a single CARD tender carrying the given ref (D7/E-26 fixture). */
  async function cardTender(
    cashier: { id: string; actor: Actor },
    ref: string,
  ): Promise<{ patientId: string; tenderId: string; receiptId: string }> {
    const patientId = await mkTestPatient();
    const result = await issuePaidInvoiceByTender(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, mode: "card", refText: ref,
    });
    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.receiptId, result.receiptId!));
    return { patientId, tenderId: tenders[0]!.id, receiptId: result.receiptId! };
  }

  test("1) a malformed CSV row refuses with recon_parse_failed NAMING THE LINE NUMBER; the batch is not persisted", async () => {
    const cashier = await cashierWithSession("cashier-recon-1");
    await cardTender(cashier, "CARD-REF-1");

    const csv = csvOf([
      "CARD-REF-1,49250,2026-08-19",
      "CARD-REF-2,abc,2026-08-19", // line 3 -- settledPaise is not an integer
    ]);

    await expect(uploadSettlement(db, ACTOR, { csv, source: "card" }, NOW)).rejects.toMatchObject({
      code: "recon_parse_failed",
      detail: { line: 3 },
    });
    expect(await db.select().from(reconBatches)).toHaveLength(0);
    const tenders = await db.select().from(receiptTenders);
    expect(tenders.every((t) => t.state === "captured")).toBe(true); // nothing touched
  });

  test("2) settled within tolerance of the STAMPED expected-net -> reconciled + tender.reconciled + reconciledAt", async () => {
    const cashier = await cashierWithSession("cashier-recon-2");
    const { tenderId, receiptId } = await cardTender(cashier, "CARD-REF-2");

    const result = await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-2,49250,2026-08-19"]), source: "card" }, NOW);
    expect(result).toMatchObject({ rowsTotal: 1, rowsMatched: 1, rowsMismatched: 0, rowsUnmatched: 0, unmatchedRefs: [] });

    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(tenders[0]).toMatchObject({ state: "reconciled", settledPaise: 49250, expectedNetPaise: 49250 });
    expect(tenders[0]!.reconciledAt).not.toBeNull();

    const recEvents = await db.select().from(events).where(eq(events.name, "tender.reconciled"));
    expect(recEvents).toHaveLength(1);
    expect(recEvents[0]!.payload).toMatchObject({ tenderId, receiptId, settledPaise: 49250, expectedNetPaise: 49250 });
  });

  test("3) settled outside tolerance -> mismatched + tender.mismatched + mismatchNote carrying both numbers", async () => {
    const cashier = await cashierWithSession("cashier-recon-3");
    const { tenderId } = await cardTender(cashier, "CARD-REF-3");

    // |49000 - 49250| = 250 > reconTolerancePaise (100, seedBillingBase).
    const result = await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-3,49000,2026-08-19"]), source: "card" }, NOW);
    expect(result).toMatchObject({ rowsMatched: 0, rowsMismatched: 1, rowsUnmatched: 0 });

    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(tenders[0]!.state).toBe("mismatched");
    expect(tenders[0]!.mismatchNote).toEqual(expect.stringContaining("49000"));
    expect(tenders[0]!.mismatchNote).toEqual(expect.stringContaining("49250"));

    const mmEvents = await db.select().from(events).where(eq(events.name, "tender.mismatched"));
    expect(mmEvents).toHaveLength(1);
  });

  test("4) the compare is settled vs EXPECTED-NET, never the gross tender amount -- the card hand-derivation", async () => {
    const cashier = await cashierWithSession("cashier-recon-4");
    const { tenderId } = await cardTender(cashier, "CARD-REF-4");
    // amountPaise 50000, feeBps.card 150 -> percentAmount(50000,150)=750 -> expectedNetPaise=49250
    // (the file-header derivation). Settling at exactly 49250 must reconcile; settling at the
    // GROSS amount 50000 would sit 750p away -- past the 100p tolerance -- which is exactly
    // M-N1's flip (compared against the tender's gross `amountPaise` instead of `expectedNetPaise`).
    const preTenders = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(preTenders[0]!.expectedNetPaise).toBe(49250);

    const result = await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-4,49250,2026-08-19"]), source: "card" }, NOW);
    expect(result.rowsMatched).toBe(1);
    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(tenders[0]!.state).toBe("reconciled");
  });

  test("5) an unmatched ref is REPORTED in the batch and the response, never guessed onto a tender", async () => {
    const cashier = await cashierWithSession("cashier-recon-5");
    const { tenderId } = await cardTender(cashier, "CARD-REF-5");

    const result = await uploadSettlement(db, ACTOR, { csv: csvOf(["NO-SUCH-REF,12345,2026-08-19"]), source: "card" }, NOW);
    expect(result).toMatchObject({ rowsTotal: 1, rowsMatched: 0, rowsMismatched: 0, rowsUnmatched: 1, unmatchedRefs: ["NO-SUCH-REF"] });

    const batches = await db.select().from(reconBatches);
    expect(batches[0]).toMatchObject({ rowsUnmatched: 1 });
    const tenders = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(tenders[0]!.state).toBe("captured"); // untouched -- never guessed onto this tender
  });

  test("6) re-upload is idempotent: an already-reconciled tender is never re-matched", async () => {
    const cashier = await cashierWithSession("cashier-recon-6");
    const { tenderId } = await cardTender(cashier, "CARD-REF-6");

    await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-6,49250,2026-08-19"]), source: "card" }, NOW);
    const first = (await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId)))[0]!;
    expect(first.state).toBe("reconciled");

    // A second upload of the SAME ref carrying a DIFFERENT settled amount -- the conditional
    // UPDATE (WHERE state='captured') must find zero rows to touch, so nothing about this row
    // may change: not its state, not its settledPaise, not its reconciledAt.
    const LATER = new Date("2026-08-19T09:00:00Z");
    await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-6,1,2026-08-19"]), source: "card" }, LATER);
    const second = (await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId)))[0]!;
    expect(second.state).toBe(first.state);
    expect(second.settledPaise).toBe(first.settledPaise);
    expect(second.reconciledAt?.getTime()).toBe(first.reconciledAt?.getTime());

    const recEvents = await db.select().from(events).where(eq(events.name, "tender.reconciled"));
    expect(recEvents).toHaveLength(1); // no second event either
  });

  test("7) setDegraded flips config + degraded_mode.changed; a receipt recorded while ON is stamped degraded:true", async () => {
    const before = await loadBillingConfig(db);
    expect(before.degradedTender).toBe(false);

    const flipped = await setDegraded(db, ACTOR, true, "PSP outage -- manual ref capture", NOW);
    expect(flipped.degradedTender).toBe(true);
    const after = await loadBillingConfig(db);
    expect(after.degradedTender).toBe(true);

    const changeEvents = await db.select().from(events).where(eq(events.name, "degraded_mode.changed"));
    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0]!.payload).toMatchObject({ on: true, reason: "PSP outage -- manual ref capture" });

    // Degraded mode's WHOLE additional effect is this stamp -- refText for upi/card is already
    // unconditional via `tender_ref_required` (invoices.ts) -- asserted here, where the flag lives.
    const cashier = await cashierWithSession("cashier-recon-7");
    const patientId = await mkTestPatient();
    const receiptResult = await recordReceipt(db, cashier.actor, {
      patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }],
    }, NOW);
    const receiptRows = await db.select().from(receipts).where(eq(receipts.id, receiptResult.receiptId));
    expect(receiptRows[0]!.degraded).toBe(true);
  });

  test("8) listMismatches returns open mismatches with receipt/patient context", async () => {
    const cashier = await cashierWithSession("cashier-recon-8");
    const { tenderId, receiptId, patientId } = await cardTender(cashier, "CARD-REF-8");
    await uploadSettlement(db, ACTOR, { csv: csvOf(["CARD-REF-8,49000,2026-08-19"]), source: "card" }, NOW);

    const mismatches = await listMismatches(db, ACTOR);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      tenderId, receiptId, patientId, mode: "card", amountPaise: 50_000,
      expectedNetPaise: 49_250, settledPaise: 49_000, restricted: false,
    });
    expect(mismatches[0]!.name).toBe("Recon Patient");
  });

  test("9) a duplicate ref within one upload refuses with duplicate_ref; the batch is not persisted", async () => {
    const cashier = await cashierWithSession("cashier-recon-9");
    await cardTender(cashier, "CARD-REF-9");

    const csv = csvOf(["CARD-REF-9,49250,2026-08-19", "CARD-REF-9,49250,2026-08-19"]);
    await expect(uploadSettlement(db, ACTOR, { csv, source: "card" }, NOW)).rejects.toMatchObject({ code: "duplicate_ref" });
    expect(await db.select().from(reconBatches)).toHaveLength(0);
  });
});
