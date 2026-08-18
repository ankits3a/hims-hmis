import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { withTx } from "../../kernel/db/client";
import {
  allocations, events, invoiceLines, invoices, opdEncounters, receipts, receiptTenders, registrationConfig,
} from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { updateBillingConfig } from "./config";
import {
  CREDIT_APPROVAL_SUBJECT, CREDIT_APPROVAL_TYPE, CREDIT_EXTEND_PERMISSION, DISCOUNT_APPROVAL_SUBJECT,
  DISCOUNT_APPROVAL_TYPE, discountSubjectId, getInvoice, invoiceSettlement, issueInvoice, listInvoices,
  outstandingOf, previewInvoice,
} from "./invoices";
import { istDay } from "./time";
import type { AdjustmentCandidate } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T5, D2 — `issueInvoice`: the one-transaction issue.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts
 * `seedBillingBase`, mirroring scripts/seed-billing.ts):
 *   · tariff: three services at 50000 paise each on one activated version — GENERIC-SERVICE in
 *     category "pharmacy" (GST sac 3004, TAXABLE at 1200 bps) and OPD-CONSULT-NEW /
 *     OPD-CONSULT-RENEWAL in category "consultation" (sac 999312, EXEMPT).
 *   · one D-8 manual cap: charity maxBps 5000, approvalAboveBps 3000.
 *   · billing_config: creditCapPaise 500_000 · outstandingCapPaise 2_000_000 mode "warn" ·
 *     feeBps { upi: 0, card: 150 } · cash warn 15_000_000 / block 20_000_000 / PAN 5_000_000.
 *
 * THE MONEY ARITHMETIC, from the shipped engine (modules/tariff/money.ts):
 *   divHalfUp(n, d) = floor((2n + d) / 2d)          taxHead(base, rateBps) = divHalfUp(base·rateBps, 20000)
 *   At 1200 bps: taxHead(base) = floor((6·base + 50) / 100), per head, cgst and sgst alike.
 *   roundTotalToRupee(t) = divHalfUp(t, 100)·100    (§170, applied ONCE to the invoice raw total)
 *
 * DISCLOSED SHAPING: ONE `opd_encounters` row is inserted directly (the `intendedPayer` /
 * `encounterId` round-trip in test 1). Opening a real visit needs the whole Class-A workflow
 * definition plus departments, doctors and an appointment — out of all proportion to reading two
 * columns. Billing's own code still reads it only through `getEncounter` (spec §4).
 */
describe("issueInvoice: the one-transaction issue (D2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  // A fixed instant so every document number and service day is hand-derivable:
  // 2026-08-19T06:00:00Z + 5:30 = 2026-08-19 11:30 IST -> IST day "2026-08-19", fiscal year
  // 2026-27 (Apr-Mar), rendered "26-27" -> the first invoice of a fresh database is
  // "INV/26-27/000001" and its receipt "RCP/26-27/000001" (16 chars, the GST serial ceiling).
  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function mkTestPatient(name = "Invoice Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "invoice-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 35 }));
    return patient.id;
  }

  async function cashierWithSession(username: string): Promise<{ id: string; actor: Actor }> {
    const cashier = await mkCashier(db, username);
    await openSessionFor(db, cashier, 100_000);
    return cashier;
  }

  async function mkManager(username: string): Promise<{ id: string; actor: Actor }> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await assignRole(db, { userId: id, roleKey: "billing_manager", scopeType: "hospital" });
    return { id, actor: { type: "user", id } };
  }

  /** The billing manifest ships in T11; the permission string is declared here so the kernel's own
   * registry-checked grant path (never a raw role_permissions insert) can be used in this task. */
  async function grantCreditExtend(): Promise<void> {
    const registry = new ModuleRegistry();
    registry.install({
      key: "billing", title: "Billing", menu: [], permissions: [CREDIT_EXTEND_PERMISSION], subscriptions: [],
    });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "cashier", CREDIT_EXTEND_PERMISSION);
  }

  async function grantedApproval(input: {
    typeKey: string; subjectType: string; subjectId: string; patientId: string; amountPaise?: number;
    requester: Actor; approver: Actor;
  }): Promise<string> {
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, input.requester, {
        typeKey: input.typeKey,
        subject: { type: input.subjectType, id: input.subjectId },
        patientId: input.patientId,
        amountPaise: input.amountPaise,
        requestNote: "filed by the counter before the invoice exists",
      }),
    );
    await approveRequest(db, input.approver, { approvalId: filed.approvalId, note: "approved for the test" });
    return filed.approvalId;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(patientId: string, intendedPayer: string): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, patientId, workflowInstanceId: newId(), serviceDate: SERVICE_DAY, visitType: "new",
      intendedPayer, openedBy: "shaped", updatedBy: "shaped",
    });
    return id;
  }

  async function rowCounts(): Promise<{ invoices: number; lines: number; receipts: number; allocations: number }> {
    return {
      invoices: (await db.select().from(invoices)).length,
      lines: (await db.select().from(invoiceLines)).length,
      receipts: (await db.select().from(receipts)).length,
      allocations: (await db.select().from(allocations)).length,
    };
  }

  // ==========================================================================================
  // 1 — the happy path. HAND-DERIVED, line by line, from the seeded fixture above:
  //
  //   L1 GENERIC qty 1, charity flat_paise 4980
  //      gross 50000 · cap: 4980·10000 = 49,800,000 <= 5000·50000 = 250,000,000 -> allowed
  //      approval: 4980·10000 = 49,800,000 > 3000·50000 = 150,000,000 ? NO -> requiresApproval false
  //      base 50000 - 4980 = 45020 · head floor((6·45020 + 50)/100) = floor(2701.7) = 2701
  //      net 45020 + 2701 + 2701 = 50422
  //   L2 GENERIC qty 1, charity flat_paise 4960
  //      base 45040 · head floor((6·45040 + 50)/100) = floor(2702.9) = 2702 · net 45040+2702+2702 = 50444
  //   L3 OPD-CONSULT-NEW qty 1, exempt: base 50000, heads 0, net 50000
  //
  //   gross 150000 · discount 9940 · taxableBase 140060 · cgst 2701+2702 = 5403 · sgst 5403
  //   taxableTurnover 45020+45040 = 90060 · exemptTurnover 50000
  //   rawTotal 50422 + 50444 + 50000 = 150866
  //   netPayable divHalfUp(150866,100)·100 = floor((301732+100)/200)·100 = 1509·100 = 150900
  //   rounding 150900 - 150866 = +34
  //
  //   THE §15 PIN (K18/M-I2): the invoice's heads are the SUM OF THE LINE HEADS, 5403. Recomputing
  //   one from an invoice-level base gives a DIFFERENT number in both available shapes —
  //   taxHead(140060,1200) = floor((840360+50)/100) = 8404, and taxHead(90060,1200) =
  //   floor((540360+50)/100) = 5404. Neither is 5403.
  // ==========================================================================================
  test("happy path: totals persist verbatim, lines carry the contest record, the receipt allocates in full", async () => {
    const cashier = await cashierWithSession("cashier-happy");
    const patientId = await mkTestPatient();
    const encounterId = await shapeEncounter(patientId, "tpa");
    const draftId = newId();

    const result = await issueInvoice(
      db,
      cashier.actor,
      {
        draftId,
        patientId,
        encounterId,
        lines: [
          { lineId: "L1", serviceId: base.genericServiceId, qty: 1, manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 4980, reason: "charity" } },
          { lineId: "L2", serviceId: base.genericServiceId, qty: 1, manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 4960, reason: "charity" } },
          { lineId: "L3", serviceId: base.consultNewServiceId, qty: 1 },
        ],
        receipt: { tenders: [{ mode: "cash", amountPaise: 150_900 }] },
      },
      NOW,
    );

    expect(result.invoiceNo).toBe("INV/26-27/000001");
    expect(result.invoiceNo).toHaveLength(16); // the GST serial ceiling (D5)
    expect(result.receiptNo).toBe("RCP/26-27/000001");
    expect(result.allocatedPaise).toBe(150_900);
    expect(result.unallocatedPaise).toBe(0);
    expect(result.creditExtended).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.totals).toMatchObject({
      grossPaise: 150_000, discountPaise: 9_940, taxableBasePaise: 140_060,
      cgstPaise: 5_403, sgstPaise: 5_403,
      taxableTurnoverPaise: 90_060, exemptTurnoverPaise: 50_000,
      rawTotalPaise: 150_866, netPayablePaise: 150_900, roundingPaise: 34,
    });

    const found = await getInvoice(db, result.invoiceId);
    expect(found).not.toBeNull();
    expect(found!.invoice).toMatchObject({
      invoiceNo: "INV/26-27/000001", patientId, encounterId,
      tariffVersionId: base.tariffVersionId, intendedPayer: "tpa",
      grossPaise: 150_000, discountPaise: 9_940, taxableBasePaise: 140_060,
      cgstPaise: 5_403, sgstPaise: 5_403, // Sigma of the LINE heads — never recomputed (§15.1)
      rawTotalPaise: 150_866, roundingPaise: 34, netPayablePaise: 150_900,
      creditExtended: false, issuedBy: cashier.id, serviceDay: SERVICE_DAY,
    });

    expect(found!.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(found!.lines.map((l) => l.taxableBasePaise)).toEqual([45_020, 45_040, 50_000]);
    expect(found!.lines.map((l) => l.cgstPaise)).toEqual([2_701, 2_702, 0]);
    expect(found!.lines.map((l) => l.sgstPaise)).toEqual([2_701, 2_702, 0]);
    expect(found!.lines.map((l) => l.netPaise)).toEqual([50_422, 50_444, 50_000]);
    expect(found!.lines.map((l) => l.exempt)).toEqual([false, false, true]);
    expect(found!.lines.map((l) => l.sacCode)).toEqual(["3004", "3004", "999312"]);
    // the D-8 contest record persists verbatim
    expect((found!.lines[0]!.candidates as AdjustmentCandidate[]).length).toBeGreaterThan(0);
    expect(found!.lines[0]!.winner).toMatchObject({ sourceKey: "manual", amountPaise: 4_980, requiresApproval: false });
    expect(found!.lines[2]!.winner).toBeNull();

    const tenders = await db.select().from(receiptTenders);
    expect(tenders).toHaveLength(1);
    expect(tenders[0]).toMatchObject({ mode: "cash", amountPaise: 150_900, state: "captured", expectedNetPaise: null });

    const allocated = await db.select().from(allocations);
    expect(allocated).toHaveLength(1);
    expect(allocated[0]).toMatchObject({ invoiceId: result.invoiceId, receiptId: result.receiptId, kind: "apply", amountPaise: 150_900 });

    const issued = await db.select().from(events).where(eq(events.name, "invoice.issued"));
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ patientId, encounterId, correlationId: result.invoiceId, module: "billing" });
    expect(issued[0]!.payload).toMatchObject({ invoiceId: result.invoiceId, invoiceNo: "INV/26-27/000001", netPayablePaise: 150_900 });
    const recorded = await db.select().from(events).where(eq(events.name, "receipt.recorded"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ receiptId: result.receiptId, totalPaise: 150_900 });
    const received = await db.select().from(events).where(eq(events.name, "payment.received"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ correlationId: result.invoiceId });
    expect(received[0]!.payload).toMatchObject({ invoiceId: result.invoiceId, amountPaise: 150_900 });
    expect(await db.select().from(events).where(eq(events.name, "advance.received"))).toHaveLength(0);
  });

  test("the settlement reader derives `settled` from the ledger, with nothing outstanding", async () => {
    const cashier = await cashierWithSession("cashier-settled");
    const patientId = await mkTestPatient();
    // GENERIC qty 1, no discount: base 50000, head floor((300000+50)/100) = floor(3000.5) = 3000,
    // net 50000 + 3000 + 3000 = 56000, netPayable divHalfUp(56000,100)·100 = 56000, rounding 0.
    const result = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });
    expect(result.totals.netPayablePaise).toBe(56_000);
    expect(result.allocatedPaise).toBe(56_000);

    expect(await invoiceSettlement(db, result.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await outstandingOf(db, result.invoiceId)).toBe(0);
  });

  test("no receipt and no credit block: unsettled_issue_refused, and the transaction persists NOTHING", async () => {
    const cashier = await cashierWithSession("cashier-refused");
    const patientId = await mkTestPatient();

    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }],
      }, NOW),
    ).rejects.toMatchObject({ code: "unsettled_issue_refused" });

    // Atomicity proved from ROW COUNTS, not from the thrown error (K16).
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
    expect(await db.select().from(events).where(eq(events.name, "invoice.issued"))).toHaveLength(0);
  });

  test("the credit lane without billing.credit.extend is refused: credit_permission_required", async () => {
    const cashier = await cashierWithSession("cashier-nocreditperm");
    const patientId = await mkTestPatient();

    // netPayable 56000, receipt 20000 -> remainder 36000 > 0, so the credit lane is entered.
    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 20_000 }] },
        credit: { reason: "patient will clear the balance tomorrow" },
      }, NOW),
    ).rejects.toMatchObject({ code: "credit_permission_required" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("with the permission and a remainder under the cap: credit extended, reason stored, state partial", async () => {
    await grantCreditExtend();
    const cashier = await cashierWithSession("cashier-credit-ok");
    const patientId = await mkTestPatient();

    // netPayable 56000 (derived in test 2) - receipt 20000 = remainder 36000 <= creditCap 500000.
    const result = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 20_000 }] },
      credit: { reason: "patient will clear the balance tomorrow" },
    }, NOW);

    expect(result.allocatedPaise).toBe(20_000);
    expect(result.creditExtended).toBe(true);
    expect(result.settlement).toEqual({ state: "partial", outstandingPaise: 36_000 });

    const found = await getInvoice(db, result.invoiceId);
    expect(found!.invoice).toMatchObject({
      creditExtended: true, creditReason: "patient will clear the balance tomorrow", creditApprovalId: null,
    });
    const extended = await db.select().from(events).where(eq(events.name, "invoice.credit_extended"));
    expect(extended).toHaveLength(1);
    expect(extended[0]!.payload).toMatchObject({ invoiceId: result.invoiceId, remainderPaise: 36_000 });

    expect(await invoiceSettlement(db, result.invoiceId)).toEqual({ state: "partial", outstandingPaise: 36_000 });
  });

  test("a remainder above the per-invoice credit cap needs an approval: credit_approval_required", async () => {
    await grantCreditExtend();
    const cashier = await cashierWithSession("cashier-credit-cap");
    const patientId = await mkTestPatient();

    // GENERIC qty 12: gross 600000, base 600000, head floor((3600000+50)/100) = floor(36000.5) =
    // 36000, net 672000, netPayable 672000 (rounding 0). 672000 > creditCap 500000.
    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 12 }],
        credit: { reason: "corporate patient, bill raised against the employer" },
      }, NOW),
    ).rejects.toMatchObject({ code: "credit_approval_required" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("a granted billing_credit_extension approval bound to the draft issues; a wrong-subject one is refused", async () => {
    await grantCreditExtend();
    const cashier = await cashierWithSession("cashier-credit-approved");
    const manager = await mkManager("manager-credit");
    const patientId = await mkTestPatient();

    const draftId = newId();
    const approvalId = await grantedApproval({
      typeKey: CREDIT_APPROVAL_TYPE, subjectType: CREDIT_APPROVAL_SUBJECT, subjectId: draftId,
      patientId, amountPaise: 672_000, requester: cashier.actor, approver: manager.actor,
    });

    const result = await issueInvoice(db, cashier.actor, {
      draftId, patientId,
      lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 12 }],
      credit: { reason: "corporate patient, bill raised against the employer", approvalId },
    }, NOW);
    expect(result.totals.netPayablePaise).toBe(672_000);
    expect(result.creditExtended).toBe(true);
    const found = await getInvoice(db, result.invoiceId);
    expect(found!.invoice.creditApprovalId).toBe(approvalId);

    // The SAME approval cannot cover a different draft, and an approval filed against some other
    // subject cannot cover this one (M-I1): the binding is checked, not merely the grant.
    const strayApprovalId = await grantedApproval({
      typeKey: CREDIT_APPROVAL_TYPE, subjectType: CREDIT_APPROVAL_SUBJECT, subjectId: newId(),
      patientId, amountPaise: 672_000, requester: cashier.actor, approver: manager.actor,
    });
    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 12 }],
        credit: { reason: "second bill on the same employer", approvalId: strayApprovalId },
      }, NOW),
    ).rejects.toMatchObject({ code: "approval_subject_mismatch" });
    expect(await listInvoices(db, { patientId })).toHaveLength(1);
  });

  test("the per-patient outstanding cap warns in warn mode and refuses in block mode", async () => {
    await grantCreditExtend();
    const cashier = await cashierWithSession("cashier-outstanding");
    const patientId = await mkTestPatient();
    // Lower the cap to Rs 400 so one 56000-paise credit invoice already exceeds it; the mode stays
    // the seeded "warn" for the first leg.
    await withTx(db, (tx) => updateBillingConfig(tx, { outstandingCapPaise: 40_000 }));

    // prospective outstanding = 0 + 56000 > 40000 -> WARNED, and the invoice still issues.
    const warned = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }],
      credit: { reason: "regular patient, settles weekly" },
    }, NOW);
    expect(warned.warnings).toEqual(["outstanding_cap"]);
    expect(await outstandingOf(db, warned.invoiceId)).toBe(56_000);

    await withTx(db, (tx) => updateBillingConfig(tx, { outstandingCapMode: "block" }));
    // prospective = 56000 already carried + 56000 = 112000 > 40000 -> REFUSED.
    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }],
        credit: { reason: "regular patient, settles weekly" },
      }, NOW),
    ).rejects.toMatchObject({ code: "outstanding_cap_exceeded" });
    expect(await listInvoices(db, { patientId })).toHaveLength(1);
  });

  test("a requiresApproval discount needs a granted billing_discount approval bound to draft+line+amount", async () => {
    const cashier = await cashierWithSession("cashier-discount");
    const manager = await mkManager("manager-discount");
    const patientId = await mkTestPatient();

    // GENERIC qty 1, charity flat_paise 20000: cap 20000·10000 = 200,000,000 <= 250,000,000 so it
    // is grantable, but 200,000,000 > 3000·50000 = 150,000,000 so it needs approval.
    // base 50000 - 20000 = 30000 · head floor((180000+50)/100) = floor(1800.5) = 1800
    // net 30000 + 1800 + 1800 = 33600 · netPayable 33600 (rounding 0).
    const draftId = newId();
    const line = {
      lineId: "L1", serviceId: base.genericServiceId, qty: 1,
      manualDiscount: { discountCategory: "charity" as const, kind: "flat_paise" as const, value: 20_000, reason: "hardship" },
    };

    await expect(
      issueInvoice(db, cashier.actor, {
        draftId, patientId, lines: [line],
        receipt: { tenders: [{ mode: "cash", amountPaise: 33_600 }] },
      }, NOW),
    ).rejects.toMatchObject({ code: "discount_approval_missing" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });

    const approvalId = await grantedApproval({
      typeKey: DISCOUNT_APPROVAL_TYPE, subjectType: DISCOUNT_APPROVAL_SUBJECT,
      subjectId: discountSubjectId(draftId, "L1"), patientId, amountPaise: 20_000,
      requester: cashier.actor, approver: manager.actor,
    });
    const result = await issueInvoice(db, cashier.actor, {
      draftId, patientId, lines: [line],
      receipt: { tenders: [{ mode: "cash", amountPaise: 33_600 }] },
      discountApprovals: { L1: approvalId },
    }, NOW);

    expect(result.totals).toMatchObject({ taxableBasePaise: 30_000, cgstPaise: 1_800, sgstPaise: 1_800, netPayablePaise: 33_600 });
    const found = await getInvoice(db, result.invoiceId);
    expect(found!.lines[0]!.winner).toMatchObject({ amountPaise: 20_000, requiresApproval: true });
    expect((found!.lines[0]!.candidates as AdjustmentCandidate[])[0]).toMatchObject({ sourceKey: "manual", discountCategory: "charity" });
  });

  test("assertPaise belts the boundary BEFORE pricing: a fractional discount is invalid_paise, not a pricing error", async () => {
    const cashier = await cashierWithSession("cashier-paise");
    const patientId = await mkTestPatient();

    // ORDERING, not merely refusal: line 1 names a service the engine does not know, so if pricing
    // ran first the error would be `unknown_service`. It is `invalid_paise`, so the belt ran first.
    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [
          { lineId: "L1", serviceId: "no-such-service-id", qty: 1 },
          {
            lineId: "L2", serviceId: base.genericServiceId, qty: 1,
            manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 100.5, reason: "half a paisa" },
          },
        ],
        receipt: { tenders: [{ mode: "cash", amountPaise: 1_000 }] },
      }, NOW),
    ).rejects.toMatchObject({ code: "invalid_paise" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("overpayment is not an error: the surplus stays unallocated and rides back as advance.received", async () => {
    const cashier = await cashierWithSession("cashier-overpay");
    const patientId = await mkTestPatient();

    // OPD-CONSULT-NEW qty 1 is EXEMPT: gross 50000, heads 0, net 50000, netPayable 50000.
    const result = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [{ lineId: "L1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 60_000 }] },
    }, NOW);

    expect(result.totals.netPayablePaise).toBe(50_000);
    expect(result.allocatedPaise).toBe(50_000);
    expect(result.unallocatedPaise).toBe(10_000);
    expect(result.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const allocated = await db.select().from(allocations);
    expect(allocated).toHaveLength(1);
    expect(allocated[0]!.amountPaise).toBe(50_000);
    const advance = await db.select().from(events).where(eq(events.name, "advance.received"));
    expect(advance).toHaveLength(1);
    expect(advance[0]!.payload).toMatchObject({ receiptId: result.receiptId, amountPaise: 10_000 });
  });

  test("a upi or card tender without a settlement reference is refused: tender_ref_required", async () => {
    const cashier = await cashierWithSession("cashier-noref");
    const patientId = await mkTestPatient();

    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.consultNewServiceId, qty: 1 }],
        receipt: { tenders: [{ mode: "upi", amountPaise: 50_000 }] },
      }, NOW),
    ).rejects.toMatchObject({ code: "tender_ref_required" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("a receipt requires the ACTING cashier's own open session: no_open_session", async () => {
    const cashier = await mkCashier(db, "cashier-nosession"); // deliberately never opened
    const patientId = await mkTestPatient();

    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId,
        lines: [{ lineId: "L1", serviceId: base.consultNewServiceId, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
      }, NOW),
    ).rejects.toMatchObject({ code: "no_open_session" });
    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("previewInvoice prices exactly what issueInvoice would and persists NOTHING", async () => {
    const patientId = await mkTestPatient();
    const encounterId = await shapeEncounter(patientId, "corporate");

    const preview = await previewInvoice(db, {
      encounterId,
      lines: [
        { lineId: "L1", serviceId: base.genericServiceId, qty: 1, manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 4980, reason: "charity" } },
        { lineId: "L2", serviceId: base.genericServiceId, qty: 1, manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 4960, reason: "charity" } },
        { lineId: "L3", serviceId: base.consultNewServiceId, qty: 1 },
      ],
    }, NOW);

    // The same hand-derivation as test 1 — the preview is the identical pricing pass.
    expect(preview.tariffVersionId).toBe(base.tariffVersionId);
    expect(preview.intendedPayer).toBe("corporate");
    expect(preview.lines.map((l) => l.netPaise)).toEqual([50_422, 50_444, 50_000]);
    expect(preview.totals).toMatchObject({ cgstPaise: 5_403, sgstPaise: 5_403, rawTotalPaise: 150_866, netPayablePaise: 150_900, roundingPaise: 34 });
    expect(preview.totals.taxSummary).toHaveLength(2);

    await expect(
      previewInvoice(db, { encounterId: "no-such-encounter", lines: [{ lineId: "L1", serviceId: base.genericServiceId, qty: 1 }] }, NOW),
    ).rejects.toMatchObject({ code: "unknown_encounter" });

    expect(await rowCounts()).toEqual({ invoices: 0, lines: 0, receipts: 0, allocations: 0 });
  });

  test("the B2B columns round-trip onto the invoice row (ruling 4: the whole Phase-1 provision)", async () => {
    const cashier = await cashierWithSession("cashier-b2b");
    const patientId = await mkTestPatient();

    const result = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      buyerGstin: "27AAAAA0000A1Z5",
      buyerLegalName: "Acme Health Services LLP",
      lines: [{ lineId: "L1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "card", amountPaise: 50_000, refText: "CARD-AUTH-77" }] },
    }, NOW);

    const listed = await listInvoices(db, { patientId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: result.invoiceId, buyerGstin: "27AAAAA0000A1Z5", buyerLegalName: "Acme Health Services LLP",
    });

    // expectedNetPaise is stamped AT CAPTURE (self-review 12): card fee 150 bps on 50000 is
    // percentAmount(50000,150) = divHalfUp(7,500,000, 10000) = floor((15,000,000+10,000)/20,000) =
    // floor(750.5) = 750, so the expected settlement is 50000 - 750 = 49250.
    const tenders = await db.select().from(receiptTenders);
    expect(tenders).toHaveLength(1);
    expect(tenders[0]).toMatchObject({ mode: "card", amountPaise: 50_000, refText: "CARD-AUTH-77", expectedNetPaise: 49_250 });
  });
});
