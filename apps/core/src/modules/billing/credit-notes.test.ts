import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase,
  shapeInvoiceWithLine,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture, ShapedInvoiceLine } from "../../../test/helpers/billing";
import { createUser } from "../../kernel/auth/identity";
import { assignRole } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { withTx } from "../../kernel/db/client";
import { creditNoteLines, creditNotes, events, invoiceLines, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { TariffError, upsertAdjustmentRule } from "../tariff";
import {
  CLEARANCE_APPROVAL_SUBJECT, CLEARANCE_APPROVAL_TYPE, getCreditNote, issueCreditNote, listCreditNotes,
  refundableSurplusOf,
} from "./credit-notes";
import type { IssueCreditNoteInput, IssueCreditNoteResult } from "./credit-notes";
import { invoiceSettlement } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T7, D4 — credit notes: the cumulative partial-refund arithmetic, the clearance discount
 * under the ENGINE's own caps, and the exhausting correction.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts
 * `seedBillingBase`):
 *   · tariff: GENERIC-SERVICE priced 50000 paise in category "pharmacy" (sac 3004, TAXABLE at
 *     1200 bps) on one activated version.
 *   · one D-8 manual cap: charity maxBps 5000, approvalAboveBps 3000.
 *   · billing_config: creditCapPaise 500_000 · outstandingCapPaise 2_000_000 mode "warn".
 *
 * THE MONEY ARITHMETIC, from the shipped engine (modules/tariff/money.ts):
 *   divHalfUp(n, d) = floor((2n + d) / 2d)
 *   taxHead(base, rateBps) = divHalfUp(base·rateBps, 20000)
 *   percentAmount(gross, bps) = divHalfUp(gross·bps, 10000)
 *   roundTotalToRupee(t) = divHalfUp(t, 100)·100    (§170, applied ONCE per document)
 *
 * THE ENGINE-PRICED INVOICE used by the clearance and correction tests — GENERIC-SERVICE, qty 1:
 *   gross 50000, no discount, taxable base 50000.
 *   taxHead(50000, 1200) = divHalfUp(60,000,000, 20,000) = floor((120,000,000 + 20,000) / 40,000)
 *                        = floor(3000.5) = 3000 per head, cgst and sgst alike.
 *   line net = 50000 + 3000 + 3000 = 56000 -> raw total 56000.
 *   roundTotalToRupee(56000) = divHalfUp(56000, 100)·100 = floor((112,000 + 100) / 200)·100
 *                            = floor(560.5)·100 = 56000, rounding 0 -> net payable 56000.
 *   Clearance caps off that raw total: maxBps 5000 -> percentAmount(56000, 5000)
 *     = divHalfUp(280,000,000, 10,000) = floor((560,000,000 + 10,000) / 20,000) = floor(28000.5)
 *     = 28000 paise; approvalAboveBps 3000 -> percentAmount(56000, 3000)
 *     = divHalfUp(168,000,000, 10,000) = floor((336,000,000 + 10,000) / 20,000) = floor(16800.5)
 *     = 16800 paise.
 *   At qty 2: gross 100000, base 100000, taxHead(100000, 1200) = floor((240,000,000 + 20,000) /
 *     40,000) = floor(6000.5) = 6000 per head, line net 112000, rounding 0.
 *
 * THE B-06 LINE (golden/fixtures/b06.json, the plan's fully worked partial refund) is SHAPED, not
 * priced — `shapeInvoiceWithLine` carries the disclosure and the reason: the engine computes
 * gross = unitPaise × qty, and B-06's gross 10000 at qty 3 is not reachable from any integer unit
 * price. That is exactly the fixture D4 wants, because a credit note derives its shares from the
 * STORED line and never re-prices: a line the engine could not have produced cannot be
 * accidentally re-derived.
 *   stored line: qty 3, gross 10000, discount 1000, base 9000, cgst 540, sgst 540, net 10080.
 *   invoice raw total 10080 -> roundTotalToRupee(10080) = floor((20,160 + 100) / 200)·100
 *     = floor(101.3)·100 = 10100, rounding +20 -> net payable 10100.
 *   step 1 (p=0, k=1): gross divHalfUp(10000, 3) = floor((20,000 + 3) / 6) = 3333;
 *     discount divHalfUp(1000, 3) = floor((2,000 + 3) / 6) = 333; base divHalfUp(9000, 3) = 3000;
 *     heads divHalfUp(540, 3) = floor((1,080 + 3) / 6) = 180 each; raw 3000 + 180 + 180 = 3360.
 *   step 2 (p=1, k=1): gross divHalfUp(20000, 3) − 3333 = floor((40,000 + 3) / 6) − 3333
 *     = 6667 − 3333 = 3334; discount divHalfUp(2000, 3) − 333 = 667 − 333 = 334;
 *     base 6000 − 3000 = 3000; heads 360 − 180 = 180; raw 3360.
 *   step 3 (p=2, k=1): gross 10000 − 6667 = 3333; discount 1000 − 667 = 333; base 3000;
 *     heads 180; raw 3360. The line EXHAUSTS: 3333 + 3334 + 3333 = 10000, 333 + 334 + 333 = 1000,
 *     3 × 3000 = 9000, 3 × 180 = 540 per head, 3 × 3360 = 10080 = the stored line's net.
 *   Each note then takes its OWN single §170 rounding (D3): roundTotalToRupee(3360)
 *     = floor((6,720 + 100) / 200)·100 = floor(34.1)·100 = 3400, rounding +40 — so the notes'
 *     rounded nets sum to 10200 while their SHARES sum to the line's 10080 exactly. Rounding is a
 *     per-document act; the exhaustion invariant lives on the shares, which is where D4 puts it.
 */
describe("credit notes: cumulative partial refunds, clearance discounts, corrections (D4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  // The same fixed instant T5/T6 use: 2026-08-19T06:00:00Z + 5:30 = 11:30 IST -> IST day
  // "2026-08-19", fiscal year 2026-27 rendered "26-27", so the first credit note of a fresh
  // database is "CN/26-27/000001".
  const NOW = new Date("2026-08-19T06:00:00Z");

  /** golden/fixtures/b06.json's stored line, as an invoice line. See the header derivation. */
  const B06_LINE: Omit<ShapedInvoiceLine, "serviceId"> = {
    // 3333 × 3 = 9999 ≠ 10000: the engine's gross = unit × qty identity is precisely what makes
    // B-06 unreachable through pricing, which is why this row is shaped rather than priced.
    qty: 3,
    unitPaise: 3333,
    grossPaise: 10_000,
    discountPaise: 1_000,
    taxableBasePaise: 9_000,
    cgstPaise: 540,
    sgstPaise: 540,
  };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function mkTestPatient(name = "Credit Note Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "credit-note-clerk" };
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

  async function grantedApproval(input: {
    subjectId: string; patientId: string; amountPaise: number; requester: Actor; approver: Actor;
  }): Promise<string> {
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, input.requester, {
        typeKey: CLEARANCE_APPROVAL_TYPE,
        subject: { type: CLEARANCE_APPROVAL_SUBJECT, id: input.subjectId },
        patientId: input.patientId,
        amountPaise: input.amountPaise,
        requestNote: "clearance discount agreed at the dues counter",
      }),
    );
    await approveRequest(db, input.approver, { approvalId: filed.approvalId, note: "approved for the test" });
    return filed.approvalId;
  }

  /** The one shaped fixture, built once per test that needs it. */
  async function shapedB06(patientId: string): Promise<{ invoiceId: string; lineId: string; netPayablePaise: number }> {
    const shaped = await shapeInvoiceWithLine(db, {
      patientId,
      tariffVersionId: base.tariffVersionId,
      at: NOW,
      line: { serviceId: base.genericServiceId, serviceName: "Generic taxable service", ...B06_LINE },
    });
    expect(shaped).toMatchObject({ lineNetPaise: 10_080, rawTotalPaise: 10_080, netPayablePaise: 10_100, roundingPaise: 20 });
    return { invoiceId: shaped.invoiceId, lineId: shaped.lineId, netPayablePaise: shaped.netPayablePaise };
  }

  const codeOf = async (run: Promise<unknown>): Promise<{ code: unknown; detail: unknown }> => {
    try {
      await run;
    } catch (e) {
      const err = e as { code?: unknown; detail?: unknown };
      return { code: err.code, detail: err.detail };
    }
    throw new Error("expected the call to be refused, but it returned");
  };

  const creditNoteIssuedEvents = () => db.select().from(events).where(eq(events.name, "credit_note.issued"));

  // -------------------------------------------------------------------------------------------
  // 1-3: the cumulative rule (K24)
  // -------------------------------------------------------------------------------------------

  test("a partial refund credit note lands B-06's first step as rows and correlates to the invoice", async () => {
    const cashier = await cashierWithSession("cashier-cn-1");
    const patientId = await mkTestPatient();
    const shaped = await shapedB06(patientId);

    const cn = await issueCreditNote(
      db,
      cashier.actor,
      {
        kind: "refund", invoiceId: shaped.invoiceId,
        reason: "one of three units returned unused",
        lines: [{ invoiceLineId: shaped.lineId, qty: 1 }],
      },
      NOW,
    );

    // B-06 step 1, hand-derived in this file's header: 3333 / 333 / 3000 / 180 / 180 -> raw 3360,
    // and the note's OWN single §170 rounding of that raw total: +40 -> 3400.
    expect(cn).toMatchObject({
      creditNoteNo: "CN/26-27/000001", invoiceId: shaped.invoiceId, kind: "refund",
      grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180,
      rawTotalPaise: 3360, roundingPaise: 40, netPaise: 3400,
    });
    // settlementState(10100, 3400, 0): covered 3400, remainder 6700.
    expect(cn.settlement).toEqual({ state: "partial", outstandingPaise: 6700 });

    const found = await getCreditNote(db, cn.creditNoteId);
    expect(found!.creditNote).toMatchObject({
      invoiceId: shaped.invoiceId, kind: "refund", discountCategory: null, approvalId: null,
      reason: "one of three units returned unused", issuedBy: cashier.id,
      grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180,
      roundingPaise: 40, netPaise: 3400,
    });
    expect(found!.lines).toHaveLength(1);
    expect(found!.lines[0]).toMatchObject({
      invoiceLineId: shaped.lineId, qty: 1,
      grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180,
    });

    const issued = await creditNoteIssuedEvents();
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ patientId, correlationId: shaped.invoiceId, module: "billing" });
    expect(issued[0]!.payload).toMatchObject({
      creditNoteId: cn.creditNoteId, creditNoteNo: "CN/26-27/000001",
      invoiceId: shaped.invoiceId, kind: "refund", netPaise: 3400,
    });
  });

  test("the second and third refunds are CUMULATIVE and the three steps exhaust the line exactly", async () => {
    const cashier = await cashierWithSession("cashier-cn-2");
    const patientId = await mkTestPatient();
    const shaped = await shapedB06(patientId);

    const step = async (): Promise<IssueCreditNoteResult> =>
      issueCreditNote(
        db, cashier.actor,
        { kind: "refund", invoiceId: shaped.invoiceId, reason: "unit returned", lines: [{ invoiceLineId: shaped.lineId, qty: 1 }] },
        NOW,
      );

    const first = await step();
    const second = await step();
    const third = await step();

    // The whole point of D4: the SECOND step is 3334 / 334, not another 3333 / 333. A per-refund
    // share would repeat step 1 three times and leak a paise off gross and off discount (M-C1).
    expect(first).toMatchObject({ grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180, rawTotalPaise: 3360 });
    expect(second).toMatchObject({ grossPaise: 3334, discountPaise: 334, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180, rawTotalPaise: 3360 });
    expect(third).toMatchObject({ grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180, rawTotalPaise: 3360 });

    // The remainder-to-last invariant, read off the PERSISTED credit-note lines rather than off
    // the return values: cumulative credits exhaust every money field of the stored line EXACTLY.
    const rows = await db.select().from(creditNoteLines);
    expect(rows).toHaveLength(3);
    const sum = rows.reduce(
      (acc, row) => ({
        grossPaise: acc.grossPaise + row.grossPaise, discountPaise: acc.discountPaise + row.discountPaise,
        taxableBasePaise: acc.taxableBasePaise + row.taxableBasePaise,
        cgstPaise: acc.cgstPaise + row.cgstPaise, sgstPaise: acc.sgstPaise + row.sgstPaise,
        qty: acc.qty + row.qty,
      }),
      { grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0, qty: 0 },
    );
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.id, shaped.lineId));
    expect(sum).toEqual({
      grossPaise: line!.grossPaise, discountPaise: line!.discountPaise, taxableBasePaise: line!.taxableBasePaise,
      cgstPaise: line!.cgstPaise, sgstPaise: line!.sgstPaise, qty: line!.qty,
    });
    expect(sum).toEqual({ grossPaise: 10_000, discountPaise: 1_000, taxableBasePaise: 9_000, cgstPaise: 540, sgstPaise: 540, qty: 3 });
    // Σ of the credited nets = the stored line's own net, to the paise: 3 × 3360 = 10080.
    expect(sum.taxableBasePaise + sum.cgstPaise + sum.sgstPaise).toBe(line!.netPaise);
    expect(line!.netPaise).toBe(10_080);

    // Each note carries its own §170 rounding (D3), so the ROUNDED nets sum to 10200 — the
    // exhaustion invariant is on the shares, not on the per-document roundings.
    expect([first.netPaise, second.netPaise, third.netPaise]).toEqual([3400, 3400, 3400]);

    // The line is spent: a fourth unit does not exist.
    expect(
      await codeOf(
        issueCreditNote(
          db, cashier.actor,
          { kind: "refund", invoiceId: shaped.invoiceId, reason: "one more", lines: [{ invoiceLineId: shaped.lineId, qty: 1 }] },
          NOW,
        ),
      ),
    ).toMatchObject({ code: "credit_exceeds_line" });

    const listed = await listCreditNotes(db, { invoiceId: shaped.invoiceId });
    expect(listed.map((n) => n.creditNoteNo)).toEqual(["CN/26-27/000001", "CN/26-27/000002", "CN/26-27/000003"]);
  });

  test("a credit beyond the line's REMAINING qty is refused, counting what is already credited", async () => {
    const cashier = await cashierWithSession("cashier-cn-3");
    const patientId = await mkTestPatient();
    const shaped = await shapedB06(patientId);

    await issueCreditNote(
      db, cashier.actor,
      { kind: "refund", invoiceId: shaped.invoiceId, reason: "two units returned", lines: [{ invoiceLineId: shaped.lineId, qty: 2 }] },
      NOW,
    );

    // qty 3 on the line, 2 already credited: a further 2 is one more than exists.
    expect(
      await codeOf(
        issueCreditNote(
          db, cashier.actor,
          { kind: "refund", invoiceId: shaped.invoiceId, reason: "two more", lines: [{ invoiceLineId: shaped.lineId, qty: 2 }] },
          NOW,
        ),
      ),
    ).toEqual({ code: "credit_exceeds_line", detail: { qty: 3, prevQty: 2, addQty: 2 } });

    // Nothing partial landed: the refused note left exactly the one credit note behind.
    expect(await db.select().from(creditNotes)).toHaveLength(1);
  });

  test("a full credit note on a settled invoice makes the money already received refundable", async () => {
    const cashier = await cashierWithSession("cashier-cn-4");
    const patientId = await mkTestPatient();
    const invoice = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });
    expect(invoice.totals).toMatchObject({ rawTotalPaise: 56_000, netPayablePaise: 56_000, roundingPaise: 0 });
    expect(await refundableSurplusOf(db, invoice.invoiceId)).toBe(0);

    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.invoiceId));
    const cn = await issueCreditNote(
      db, cashier.actor,
      { kind: "refund", invoiceId: invoice.invoiceId, reason: "service not rendered", lines: [{ invoiceLineId: line!.id, qty: 1 }] },
      NOW,
    );
    expect(cn).toMatchObject({
      grossPaise: 50_000, discountPaise: 0, taxableBasePaise: 50_000, cgstPaise: 3000, sgstPaise: 3000,
      rawTotalPaise: 56_000, roundingPaise: 0, netPaise: 56_000,
    });

    // credited 56000 + allocated 56000 − net payable 56000 = 56000 of received money now owed back.
    expect(await refundableSurplusOf(db, invoice.invoiceId)).toBe(56_000);
    expect(await invoiceSettlement(db, invoice.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
  });

  // -------------------------------------------------------------------------------------------
  // 5-7: the clearance-discount lane (K25)
  // -------------------------------------------------------------------------------------------

  test("a clearance discount is capped by the ENGINE's own ACTIVE caps, and over_cap records the ask", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-cn-5");
    const patientId = await mkTestPatient();
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });
    expect(dues.totals).toMatchObject({ rawTotalPaise: 56_000, netPayablePaise: 56_000 });

    // The D-8 category is mandatory on this lane — the note is governed by the discount table or
    // it is not a clearance discount at all.
    const withoutCategory = {
      kind: "clearance_discount", invoiceId: dues.invoiceId, reason: "settled at the dues counter", askPaise: 10_000,
    } as unknown as IssueCreditNoteInput;
    await expect(issueCreditNote(db, cashier.actor, withoutCategory, NOW)).rejects.toBeInstanceOf(z.ZodError);

    // 10000 <= the 16800 approval threshold and <= the 28000 cap (header derivation): it issues,
    // with no approval and no tax head — the clearance lane credits value, not a line's tax.
    const ok = await issueCreditNote(
      db, cashier.actor,
      {
        kind: "clearance_discount", invoiceId: dues.invoiceId, reason: "settled at the dues counter",
        discountCategory: "charity", askPaise: 10_000,
      },
      NOW,
    );
    expect(ok).toMatchObject({
      kind: "clearance_discount",
      grossPaise: 10_000, discountPaise: 0, taxableBasePaise: 10_000, cgstPaise: 0, sgstPaise: 0,
      rawTotalPaise: 10_000, roundingPaise: 0, netPaise: 10_000,
    });
    expect(ok.settlement).toEqual({ state: "partial", outstandingPaise: 46_000 });
    const stored = await getCreditNote(db, ok.creditNoteId);
    expect(stored!.creditNote).toMatchObject({ discountCategory: "charity", approvalId: null });
    expect(stored!.lines).toHaveLength(0);

    // 30000 > the 28000 cap: refused, and the refusal records the ASKED paise (the M2 lesson).
    const over = await codeOf(
      issueCreditNote(
        db, cashier.actor,
        {
          kind: "clearance_discount", invoiceId: dues.invoiceId, reason: "half the bill",
          discountCategory: "charity", askPaise: 30_000,
        },
        NOW,
      ),
    );
    expect(over.code).toBe("over_cap");
    expect(over.detail).toMatchObject({ askedPaise: 30_000, capPaise: 28_000, discountCategory: "charity", maxBps: 5000 });

    // K25 / M-C2: the caps come from `loadRuleConfig`, which honours `active`. Retire the ONLY
    // charity cap through the tariff module's own API — the row survives in adjustment_rules and
    // `listAdjustmentRules` would still hand it over, but an INACTIVE rule governs nothing, so a
    // category with no live cap carries no authority and every ask is over it.
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, base.drafter, {
        ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity discount cap (retired)",
        params: { discountCategory: "charity", maxBps: 5000, approvalAboveBps: 3000 },
        active: false,
      }),
    );
    const retired = await codeOf(
      issueCreditNote(
        db, cashier.actor,
        {
          kind: "clearance_discount", invoiceId: dues.invoiceId, reason: "under the retired cap",
          discountCategory: "charity", askPaise: 10_000,
        },
        NOW,
      ),
    );
    expect(retired.code).toBe("over_cap");
    expect(retired.detail).toMatchObject({ askedPaise: 10_000, capPaise: 0, maxBps: null });
  });

  test("a clearance discount above the approval threshold is check-on-execute against the invoice", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-cn-6");
    const manager = await mkManager("manager-cn-6");
    const patientId = await mkTestPatient();
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });

    const ask = {
      kind: "clearance_discount" as const, invoiceId: dues.invoiceId,
      reason: "long-standing dues written down", discountCategory: "charity" as const, askPaise: 20_000,
    };

    // 20000 > the 16800 approval threshold and <= the 28000 cap: grantable, and gated.
    const ungated = await codeOf(issueCreditNote(db, cashier.actor, ask, NOW));
    expect(ungated.code).toBe("clearance_approval_required");
    expect(ungated.detail).toMatchObject({ askedPaise: 20_000, approvalAboveBps: 3000, thresholdPaise: 16_800 });

    // An approval granted against SOME OTHER invoice cannot cover this one.
    const strayId = await grantedApproval({
      subjectId: newId(), patientId, amountPaise: 20_000, requester: cashier.actor, approver: manager.actor,
    });
    expect(await codeOf(issueCreditNote(db, cashier.actor, { ...ask, approvalId: strayId }, NOW)))
      .toMatchObject({ code: "approval_subject_mismatch" });

    const approvalId = await grantedApproval({
      subjectId: dues.invoiceId, patientId, amountPaise: 20_000, requester: cashier.actor, approver: manager.actor,
    });
    const granted = await issueCreditNote(db, cashier.actor, { ...ask, approvalId }, NOW);
    expect(granted).toMatchObject({ netPaise: 20_000, roundingPaise: 0 });
    expect(granted.settlement).toEqual({ state: "partial", outstandingPaise: 36_000 });
    const stored = await getCreditNote(db, granted.creditNoteId);
    expect(stored!.creditNote).toMatchObject({ approvalId, discountCategory: "charity", kind: "clearance_discount" });
  });

  test("a clearance discount on an invoice with nothing outstanding is a disguised refund and is refused", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-cn-7");
    const patientId = await mkTestPatient();

    const settled = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });
    expect(await invoiceSettlement(db, settled.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(
      await codeOf(
        issueCreditNote(
          db, cashier.actor,
          {
            kind: "clearance_discount", invoiceId: settled.invoiceId, reason: "goodwill",
            discountCategory: "charity", askPaise: 10_000,
          },
          NOW,
        ),
      ),
    ).toEqual({ code: "clearance_requires_outstanding", detail: { askedPaise: 10_000, outstandingPaise: 0 } });

    // 56000 billed, 50000 taken at the counter: 6000 outstanding, and an ask beyond it is refused
    // the same way — a clearance discount can only shrink dues that exist.
    const partly = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.genericServiceId, receiptPaise: 50_000,
    });
    expect(await invoiceSettlement(db, partly.invoiceId)).toEqual({ state: "partial", outstandingPaise: 6_000 });
    expect(
      await codeOf(
        issueCreditNote(
          db, cashier.actor,
          {
            kind: "clearance_discount", invoiceId: partly.invoiceId, reason: "write the rest off",
            discountCategory: "charity", askPaise: 10_000,
          },
          NOW,
        ),
      ),
    ).toEqual({ code: "clearance_requires_outstanding", detail: { askedPaise: 10_000, outstandingPaise: 6_000 } });
  });

  // -------------------------------------------------------------------------------------------
  // 8-9: corrections exhaust (K26)
  // -------------------------------------------------------------------------------------------

  test("a partial correction is refused; the exhausting one issues", async () => {
    const cashier = await cashierWithSession("cashier-cn-8");
    const patientId = await mkTestPatient();
    const invoice = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.genericServiceId, qty: 2 });
    expect(invoice.totals).toMatchObject({ rawTotalPaise: 112_000, netPayablePaise: 112_000, roundingPaise: 0 });
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.invoiceId));

    // Half a correction is a refund wearing the wrong name — and refunds carry the voucher guards.
    const partial = await codeOf(
      issueCreditNote(
        db, cashier.actor,
        { kind: "correction", invoiceId: invoice.invoiceId, reason: "wrong patient", lines: [{ invoiceLineId: line!.id, qty: 1 }] },
        NOW,
      ),
    );
    expect(partial.code).toBe("correction_must_exhaust");
    expect(partial.detail).toMatchObject({ asked: [[line!.id, 1]], remaining: [[line!.id, 2]] });
    expect(await db.select().from(creditNotes)).toHaveLength(0);

    // The whole remaining value: gross 100000, base 100000, heads 6000 each, raw 112000, and the
    // §170 rounding of a rupee-exact total is zero.
    const full = await issueCreditNote(
      db, cashier.actor,
      { kind: "correction", invoiceId: invoice.invoiceId, reason: "wrong patient", lines: [{ invoiceLineId: line!.id, qty: 2 }] },
      NOW,
    );
    expect(full).toMatchObject({
      kind: "correction",
      grossPaise: 100_000, discountPaise: 0, taxableBasePaise: 100_000, cgstPaise: 6000, sgstPaise: 6000,
      rawTotalPaise: 112_000, roundingPaise: 0, netPaise: 112_000,
    });
    expect(full.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
  });

  test("a correction on a partly refunded invoice covers the REMAINDER exactly", async () => {
    const cashier = await cashierWithSession("cashier-cn-9");
    const patientId = await mkTestPatient();
    const shaped = await shapedB06(patientId);

    await issueCreditNote(
      db, cashier.actor,
      { kind: "refund", invoiceId: shaped.invoiceId, reason: "one unit returned", lines: [{ invoiceLineId: shaped.lineId, qty: 1 }] },
      NOW,
    );

    // p = 1, k = 2: gross divHalfUp(30000, 3) − divHalfUp(10000, 3) = 10000 − 3333 = 6667;
    // discount 1000 − 333 = 667; base 9000 − 3000 = 6000; heads 540 − 180 = 360 each;
    // raw 6000 + 360 + 360 = 6720 -> roundTotalToRupee(6720) = floor((13,440 + 100) / 200)·100
    // = floor(67.7)·100 = 6700, rounding −20.
    const correction = await issueCreditNote(
      db, cashier.actor,
      { kind: "correction", invoiceId: shaped.invoiceId, reason: "billed against the wrong episode" },
      NOW,
    );
    expect(correction).toMatchObject({
      kind: "correction",
      grossPaise: 6667, discountPaise: 667, taxableBasePaise: 6000, cgstPaise: 360, sgstPaise: 360,
      rawTotalPaise: 6720, roundingPaise: -20, netPaise: 6700,
    });

    // Refund + correction exhaust the line: 3333 + 6667 = 10000, 333 + 667 = 1000, 3000 + 6000 =
    // 9000, 180 + 360 = 540 per head. Credited 3400 + 6700 = 10100 = the invoice's net payable.
    const rows = await db.select().from(creditNoteLines);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((a, r) => a + r.grossPaise, 0)).toBe(10_000);
    expect(rows.reduce((a, r) => a + r.discountPaise, 0)).toBe(1_000);
    expect(rows.reduce((a, r) => a + r.taxableBasePaise, 0)).toBe(9_000);
    expect(rows.reduce((a, r) => a + r.cgstPaise, 0)).toBe(540);
    expect(rows.reduce((a, r) => a + r.sgstPaise, 0)).toBe(540);
    expect(await invoiceSettlement(db, shaped.invoiceId)).toEqual({ state: "settled", outstandingPaise: 0 });

    // Nothing remains to correct a second time.
    expect(
      await codeOf(
        issueCreditNote(db, cashier.actor, { kind: "correction", invoiceId: shaped.invoiceId, reason: "again" }, NOW),
      ),
    ).toMatchObject({ code: "correction_must_exhaust" });
  });

  // -------------------------------------------------------------------------------------------
  // 10-12: boundaries and the event
  // -------------------------------------------------------------------------------------------

  test("a credit note against an unknown invoice is refused", async () => {
    const cashier = await cashierWithSession("cashier-cn-10");
    const strayInvoiceId = newId();
    expect(
      await codeOf(
        issueCreditNote(
          db, cashier.actor,
          { kind: "refund", invoiceId: strayInvoiceId, reason: "no such bill", lines: [{ invoiceLineId: newId(), qty: 1 }] },
          NOW,
        ),
      ),
    ).toMatchObject({ code: "unknown_invoice" });
    expect(await db.select().from(creditNotes)).toHaveLength(0);
  });

  test("the clearance ask runs assertPaise at the module boundary", async () => {
    await grantCreditExtend(db);
    const cashier = await cashierWithSession("cashier-cn-11");
    const patientId = await mkTestPatient();
    const dues = await issueDuesInvoice(db, cashier, { patientId, serviceId: base.genericServiceId });

    const ask = (askPaise: number): Promise<unknown> =>
      issueCreditNote(
        db, cashier.actor,
        {
          kind: "clearance_discount", invoiceId: dues.invoiceId, reason: "typo at the counter",
          discountCategory: "charity", askPaise,
        },
        NOW,
      );

    // The inherited belt: `assertPaise` is the tariff engine's, so a bad amount leaves a billing
    // entry point as TariffError("invalid_paise") — the T2/T4 pattern, recorded and kept.
    await expect(ask(1000.5)).rejects.toBeInstanceOf(TariffError);
    expect(await codeOf(ask(1000.5))).toMatchObject({ code: "invalid_paise" });
    expect(await codeOf(ask(-1000))).toMatchObject({ code: "invalid_paise" });
    // Zero is not a fractional paise but it is not a discount either.
    expect(await codeOf(ask(0))).toMatchObject({ code: "invalid_paise" });
    expect(await db.select().from(creditNotes)).toHaveLength(0);
  });

  test("exactly one credit_note.issued is appended per note, inside the note's own transaction", async () => {
    const cashier = await cashierWithSession("cashier-cn-12");
    const patientId = await mkTestPatient();
    const shaped = await shapedB06(patientId);

    const first = await issueCreditNote(
      db, cashier.actor,
      { kind: "refund", invoiceId: shaped.invoiceId, reason: "unit one", lines: [{ invoiceLineId: shaped.lineId, qty: 1 }] },
      NOW,
    );
    const second = await issueCreditNote(
      db, cashier.actor,
      { kind: "refund", invoiceId: shaped.invoiceId, reason: "unit two", lines: [{ invoiceLineId: shaped.lineId, qty: 1 }] },
      NOW,
    );

    const issued = await creditNoteIssuedEvents();
    expect(issued).toHaveLength(2);
    expect(issued.map((e) => (e.payload as { creditNoteId: string }).creditNoteId).sort())
      .toEqual([first.creditNoteId, second.creditNoteId].sort());
    for (const event of issued) {
      expect(event).toMatchObject({ patientId, correlationId: shaped.invoiceId, module: "billing" });
    }
    expect(await db.select().from(creditNotes)).toHaveLength(2);
  });
});
