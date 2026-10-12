import { and, eq, sum } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, IPD_INTENTS, ipdRateServiceCode, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissionDeposits, ipdAdmissions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { BillingError, recordReceipt } from "../billing";
import { listPatientCoverages } from "../patients";
import { listPriceList } from "../tariff";
import {
  isIcuClass, lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission,
} from "./admission-core";
import { admissionPlanned, depositTaken } from "./admission-events";
import { grantedApproval } from "./approval-types";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_ADMIT } from "./manifest";
import type { Actor, IpdBedClass, IpdClassQuote, IpdIntentName, IpdPayerKind } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/**
 * E1.2 (#719) — THE DEPOSIT (decision 0072 answer 3) and the desk's payer-and-plan step.
 *
 * Every rupee is read from the ACTIVE tariff (the rate card E0.4 carries the classes' daily components); nothing here
 * types or guesses a price. A component with no rate refuses `rate_missing` naming the class and the component.
 * The percentages and day counts are the ruling's, held in one place below.
 */
export const IPD_DEPOSIT_POLICY = {
  /** Medical admission: three days of the class's daily charges. */
  medicalDays: 3,
  /** ICU: three ICU days. */
  icuDays: 3,
  /** Planned surgery: 50 % of the procedure estimate or package (basis points). */
  surgeryShareBps: 5_000,
  /** Running-bill alerts (E2.x reads them): top-up at 75 % used, escalation at 90 %. */
  topUpAlertPercent: 75,
  escalationPercent: 90,
} as const;

/** The daily components a deposit counts (decision 0072 answer 2: room rent, nursing charge, doctor visit). */
export const IPD_DEPOSIT_COMPONENTS = ["room", "nursing", "visit"] as const;

/**
 * DECIDED (E1.2): the cashless non-payables deposit per class is configuration on the tariff — a service
 * `IPD_NONPAY_DEPOSIT_<CLASS>` priced by billing in the tariff screen like every other figure. No rate → `rate_missing`.
 */
export function ipdNonPayableDepositCode(cls: IpdBedClass): string {
  return `IPD_NONPAY_DEPOSIT_${cls.toUpperCase()}`;
}

/** The rupee the deposit is rounded UP to: a counter takes whole rupees. */
const roundUpToRupee = (paise: number): number => Math.ceil(paise / 100) * 100;

export type PriceBook = Map<string, number>;

/** The active tariff's prices by service code (one read per desk action). */
export async function loadPriceBook(db: Db, at: Date): Promise<PriceBook> {
  return new Map((await listPriceList(db, at)).map((r) => [r.code, r.pricePaise] as const));
}

type DepositBasis = Output<"plan_admission">["depositBasis"];
export type DepositQuote = {
  perDay: { room: number; nursing: number; visit: number } | null;
  missing: string[];
  estimatePaise: number | null;
  depositPaise: number | null;
  basis: DepositBasis;
};

export type DepositQuoteArgs = {
  payerKind: IpdPayerKind | null;
  requestedClass: IpdBedClass;
  plan: { kind: "medical" } | { kind: "surgical"; procedureEstimatePaise: number };
  /** An emergency admission not yet stabilised: no deposit (decision 0072). */
  emergencyUnstabilised: boolean;
};

/** Pure: the class's daily rates, the 3-day estimate and the deposit by decision 0072's rules. */
export function quoteDeposit(prices: PriceBook, args: DepositQuoteArgs): DepositQuote {
  const rated = IPD_BED_CLASS_INFO[args.requestedClass].billsAs ?? args.requestedClass;
  const missing: string[] = [];
  const rate = (c: (typeof IPD_DEPOSIT_COMPONENTS)[number]): number => {
    const p = prices.get(ipdRateServiceCode(rated, c));
    if (p === undefined) missing.push(c);
    return p ?? 0;
  };
  const room = rate("room");
  const nursing = rate("nursing");
  const visit = rate("visit");
  const perDay = missing.length === 0 ? { room, nursing, visit } : null;
  const dayTotal = room + nursing + visit;
  const icu = isIcuClass(args.requestedClass);
  const days = icu ? IPD_DEPOSIT_POLICY.icuDays : IPD_DEPOSIT_POLICY.medicalDays;
  const estimatePaise = perDay === null ? null : dayTotal * days;

  if (args.emergencyUnstabilised) return { perDay, missing, estimatePaise, depositPaise: 0, basis: "emergency_exempt" };
  if (args.payerKind === "pmjay" || args.payerKind === "state_scheme") {
    return { perDay, missing, estimatePaise, depositPaise: 0, basis: "scheme_zero" };
  }
  if (args.payerKind === "insurance_cashless" || args.payerKind === "corporate") {
    const nonPay = prices.get(ipdNonPayableDepositCode(rated));
    if (nonPay === undefined) missing.push("non_payables");
    return { perDay, missing, estimatePaise, depositPaise: nonPay ?? null, basis: "cashless_non_payables" };
  }
  if (args.plan.kind === "surgical") {
    const share = roundUpToRupee((args.plan.procedureEstimatePaise * IPD_DEPOSIT_POLICY.surgeryShareBps) / 10_000);
    return { perDay, missing, estimatePaise, depositPaise: share, basis: "surgery_estimate_share" };
  }
  return {
    perDay, missing, estimatePaise, depositPaise: estimatePaise, basis: icu ? "icu_class_days" : "medical_class_days",
  };
}

/** The class cards the sheet offers (§4.9 B "class cards with estimate and deposit side by side"). */
export async function classQuotes(
  db: Db, a: AdmissionRow, classes: readonly IpdBedClass[], freeByClass: Record<string, number>, at: Date,
): Promise<IpdClassQuote[]> {
  const prices = await loadPriceBook(db, at);
  const plan = a.planKind === "surgical" && a.procedureEstimatePaise !== null
    ? { kind: "surgical" as const, procedureEstimatePaise: a.procedureEstimatePaise }
    : { kind: "medical" as const };
  return classes.map((cls) => {
    const q = quoteDeposit(prices, {
      payerKind: (a.payerKind ?? "cash") as IpdPayerKind, requestedClass: cls, plan,
      emergencyUnstabilised: a.source === "er" && a.stabilisedAt === null,
    });
    return {
      class: cls, label: IPD_BED_CLASS_INFO[cls].label, perDay: q.perDay, missing: q.missing,
      estimatePaise: q.estimatePaise, depositPaise: q.depositPaise, depositBasis: q.basis, freeBeds: freeByClass[cls] ?? 0,
    };
  });
}

// ═══════════════════════════════════════════ plan_admission ═══════════════════════════════════════════

export async function planAdmission(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"plan_admission">> {
  const input: Input<"plan_admission"> = IPD_INTENTS.plan_admission.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "plan_admission", input.idempotencyKey, input, async () => {
    const first = await readAdmission(db, input.admissionId);
    if (input.coverageId !== undefined) {
      const covers = await listPatientCoverages(db, actor, first.patientId, { reason: "ipd admission payer" });
      if (!covers.some((c) => c.id === input.coverageId)) throw new IpdRefusal("state_changed", "Coverage is not this patient's");
    }
    const prices = await loadPriceBook(db, at);
    const q = quoteDeposit(prices, {
      payerKind: input.payerKind, requestedClass: input.requestedClass, plan: input.plan,
      emergencyUnstabilised: first.source === "er" && first.stabilisedAt === null,
    });
    if (q.missing.length > 0 || q.estimatePaise === null || q.depositPaise === null) {
      throw new IpdRefusal("rate_missing", undefined, {
        class: input.requestedClass, missing: q.missing,
        serviceCodes: q.missing.map((m) => (m === "non_payables" ? ipdNonPayableDepositCode(input.requestedClass)
          : ipdRateServiceCode(IPD_BED_CLASS_INFO[input.requestedClass].billsAs ?? input.requestedClass, m as "room"))),
      });
    }
    return withTx(db, async (tx) => {
      const a = await lockAdmission(tx, input.admissionId);
      const emergencyOpen = a.source === "er" && a.state === "admitted";
      if (a.state !== "requested" && a.state !== "reserved" && !emergencyOpen) throw new IpdRefusal("admission_wrong_state");
      if (!emergencyOpen && a.expiresAt.getTime() < at.getTime()) throw new IpdRefusal("advice_expired");
      // An admitted emergency patient's class is the bed's; the plan records payer and deposit only.
      const requestedClass = emergencyOpen ? a.requestedClass as IpdBedClass : input.requestedClass;
      await tx.update(ipdAdmissions).set({
        payerKind: input.payerKind, coverageId: input.coverageId ?? null, requestedClass, icu: emergencyOpen ? a.icu : isIcuClass(requestedClass),
        planKind: input.plan.kind, procedureEstimatePaise: input.plan.kind === "surgical" ? input.plan.procedureEstimatePaise : null,
        estimatePaise: q.estimatePaise, depositRequiredPaise: q.depositPaise, depositBasis: q.basis, updatedAt: at,
      }).where(eq(ipdAdmissions.id, a.id));
      await appendEvent(tx, admissionPlanned.make({
        payload: { admissionId: a.id, payerKind: input.payerKind, requestedClass, depositBasis: q.basis, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return {
        admissionId: a.id, requestedClass, estimatePaise: q.estimatePaise!, depositRequiredPaise: q.depositPaise!, depositBasis: q.basis,
      };
    });
  }, at);
}

// ═══════════════════════════════════════════ take_deposit ═══════════════════════════════════════════

/** Σ deposits taken for one admission (the receipts linked to it). */
export async function depositPaidPaise(db: Db | Tx, admissionId: string): Promise<number> {
  const rows = await db.select({ total: sum(ipdAdmissionDeposits.amountPaise) }).from(ipdAdmissionDeposits)
    .where(eq(ipdAdmissionDeposits.admissionId, admissionId));
  return Number(rows[0]?.total ?? 0);
}

const LEDGER_TENDERS = new Set(["cash", "upi", "card"]);
const OPEN_FOR_DEPOSIT = new Set(["requested", "reserved", "admitted", "transferring", "fit_declared"]);

/**
 * Billing's advance, taken for one admission (a thin wrapper over `recordReceipt`): the cashier's open session, the
 * cash law (269ST: refused as `cash_limit_reached`, other tenders offered) and the receipt number are billing's.
 * DECIDED rules (decision 0072): a scheme patient pays nothing — a receipt is refused unless an approver marked a line
 * non-covered, and then for at most that line's amount; an emergency patient is not asked before stabilisation. The
 * receipt names the payer (a relative may pay; a refund goes back to them).
 */
export async function takeDeposit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"take_deposit">> {
  const input: Input<"take_deposit"> = IPD_INTENTS.take_deposit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  if (!LEDGER_TENDERS.has(input.tender)) {
    throw new IpdError("tender_not_supported", `the billing ledger takes cash, UPI and card; ${input.tender} is taken at the billing desk`);
  }
  return onceIpd(db, actor, "take_deposit", input.idempotencyKey, input, async () => {
    const a = await readAdmission(db, input.admissionId);
    if (!OPEN_FOR_DEPOSIT.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    if (a.payerKind === null) throw new IpdRefusal("plan_missing");
    if (a.source === "er" && a.stabilisedAt === null) throw new IpdRefusal("deposit_before_stabilisation");
    let nonCoveredApprovalId: string | null = null;
    if (a.payerKind === "pmjay" || a.payerKind === "state_scheme") {
      const approval = await grantedApproval(db, input.nonCoveredApprovalId, "non_covered", [a.id]);
      if (approval === null) throw new IpdRefusal("scheme_patient_no_deposit");
      const usedRows = await db.select({ total: sum(ipdAdmissionDeposits.amountPaise) }).from(ipdAdmissionDeposits)
        .where(and(eq(ipdAdmissionDeposits.admissionId, a.id), eq(ipdAdmissionDeposits.nonCoveredApprovalId, approval.id)));
      const used = Number(usedRows[0]?.total ?? 0);
      if (approval.amountPaise !== null && used + input.amountPaise > approval.amountPaise) {
        throw new IpdRefusal("scheme_patient_no_deposit", "More than the non-covered line", {
          approvedPaise: approval.amountPaise, alreadyTakenPaise: used,
        });
      }
      nonCoveredApprovalId = approval.id;
    }
    const payerLine = `${input.payer.name} (${input.payer.relation})`;
    let receipt: { receiptId: string; receiptNo: string; totalPaise: number };
    try {
      receipt = await recordReceipt(db, actor, {
        patientId: a.patientId,
        tenders: [{ mode: input.tender as "cash" | "upi" | "card", amountPaise: input.amountPaise, ...(input.tenderRef === undefined ? {} : { refText: input.tenderRef }) }],
        ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
        note: `IPD deposit for admission ${a.id}; paid by ${payerLine}`,
      }, at);
    } catch (e) {
      if (e instanceof BillingError && e.code === "cash_threshold_blocked") {
        throw new IpdRefusal("cash_limit_reached", undefined, { tendersOffered: ["upi", "card"] });
      }
      throw e;
    }
    // The receipt is billing's committed fact; the link is ours. Written next, in its own transaction: should it
    // fail, the money is still on the patient's advance (never lost) and the desk links it by retrying this key.
    return withTx(db, async (tx) => {
      await tx.insert(ipdAdmissionDeposits).values({
        id: newId(), admissionId: a.id, receiptId: receipt.receiptId, receiptNo: receipt.receiptNo, amountPaise: receipt.totalPaise,
        tender: input.tender, payerName: input.payer.name, payerRelation: input.payer.relation, payerPhone: input.payer.phone ?? null,
        nonCoveredApprovalId, takenBy: actor.id, takenAt: at,
      });
      await appendEvent(tx, depositTaken.make({
        payload: { admissionId: a.id, receiptId: receipt.receiptId, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return {
        receiptId: receipt.receiptId, receiptNo: receipt.receiptNo, amountPaise: receipt.totalPaise,
        depositTotalPaise: await depositPaidPaise(tx, a.id),
      };
    });
  }, at);
}
