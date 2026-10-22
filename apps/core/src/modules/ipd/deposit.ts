import { and, eq, inArray, sql, sum } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, IPD_INTENTS, IPD_REFUSALS, ipdRateServiceCode, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { IPD_OPEN_ADMISSION_STATES, approvals, ipdAdmissionDeposits, ipdAdmissions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { BillingError, recordCashThresholdBlocked, recordReceiptInTx, registerReceiptGuard } from "../billing";
import type { CashThresholdDetail } from "../billing";
import { listPatientCoverages } from "../patients";
import { listPriceList } from "../tariff";
import {
  isIcuClass, lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission,
} from "./admission-core";
import { admissionPlanned, depositTaken } from "./admission-events";
import { IPD_APPROVAL_TYPE_KEYS, grantedApproval } from "./approval-types";
import { evaluateDepositLadderSafely } from "./deposit-ladder";
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

/** The class a plan is quoted for: an admitted emergency patient's class is the bed's (the plan records payer only). */
function planClass(a: AdmissionRow, asked: IpdBedClass): IpdBedClass {
  return a.source === "er" && a.state === "admitted" ? a.requestedClass as IpdBedClass : asked;
}

/** Quotes or refuses `rate_missing` naming the class, the components and their tariff codes. Never a guess. */
export function quoteOrRefuse(prices: PriceBook, args: DepositQuoteArgs): DepositQuote & { depositPaise: number } {
  const q = quoteDeposit(prices, args);
  // Refused only when the DEPOSIT needs a missing rate; a ₹0 basis (scheme, unstabilised emergency) or a surgery
  // share stands without the class's daily rates, and the estimate is then shown as not available.
  if (q.depositPaise === null) {
    const cls = args.requestedClass;
    throw new IpdRefusal("rate_missing", undefined, {
      class: cls, missing: q.missing,
      serviceCodes: q.missing.map((m) => (m === "non_payables" ? ipdNonPayableDepositCode(cls)
        : ipdRateServiceCode(IPD_BED_CLASS_INFO[cls].billsAs ?? cls, m as "room"))),
    });
  }
  return q as DepositQuote & { depositPaise: number };
}

export function planOf(a: AdmissionRow): DepositQuoteArgs["plan"] {
  return a.planKind === "surgical" && a.procedureEstimatePaise !== null
    ? { kind: "surgical", procedureEstimatePaise: a.procedureEstimatePaise } : { kind: "medical" };
}

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
    return withTx(db, async (tx) => {
      const a = await lockAdmission(tx, input.admissionId);
      const emergencyOpen = a.source === "er" && a.state === "admitted";
      if (a.state !== "requested" && a.state !== "reserved" && !emergencyOpen) throw new IpdRefusal("admission_wrong_state");
      if (!emergencyOpen && a.source !== "er" && a.expiresAt.getTime() < at.getTime()) throw new IpdRefusal("advice_expired");
      // Review #6: the class is resolved FIRST and the quote is for the class actually recorded.
      const requestedClass = planClass(a, input.requestedClass);
      const q = quoteOrRefuse(prices, {
        payerKind: input.payerKind, requestedClass, plan: input.plan, emergencyUnstabilised: a.source === "er" && a.stabilisedAt === null,
      });
      await tx.update(ipdAdmissions).set({
        payerKind: input.payerKind, coverageId: input.coverageId ?? null, requestedClass, icu: emergencyOpen ? a.icu : isIcuClass(requestedClass),
        planKind: input.plan.kind, procedureEstimatePaise: input.plan.kind === "surgical" ? input.plan.procedureEstimatePaise : null,
        estimatePaise: q.estimatePaise, depositRequiredPaise: q.depositPaise, depositBasis: q.basis, updatedAt: at,
      }).where(eq(ipdAdmissions.id, a.id));
      await appendEvent(tx, admissionPlanned.make({
        payload: { admissionId: a.id, payerKind: input.payerKind, requestedClass, depositBasis: q.basis, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return { admissionId: a.id, requestedClass, estimatePaise: q.estimatePaise, depositRequiredPaise: q.depositPaise, depositBasis: q.basis };
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
const SCHEME_PAYERS = new Set(["pmjay", "state_scheme"]);
/** The receipt purpose this module's own deposit writes under; the receipt guard lets it through (it checks the same rule). */
export const IPD_DEPOSIT_PURPOSE = "ipd_deposit";

/**
 * A scheme admission's money headroom: Σ GRANTED non-covered approvals (each must name its amount) minus Σ every
 * receipt this patient has had since the admission was requested (entered-in-error receipts excepted), whichever
 * route took it. ONE cap for both doors — the admission desk's deposit and the generic billing receipt. The caller
 * holds the admission row lock, which serialises every receipt for the admission through this check.
 */
export async function schemeHeadroom(tx: Tx, a: AdmissionRow): Promise<{ approvedPaise: number; usedPaise: number }> {
  const approved = await tx.select({ amount: approvals.amountPaise }).from(approvals).where(and(
    eq(approvals.typeKey, IPD_APPROVAL_TYPE_KEYS.non_covered), eq(approvals.status, "granted"), eq(approvals.subjectId, a.id),
  ));
  const used = (await tx.execute(sql`
    select coalesce(sum(r.total_paise), 0)::bigint as used from receipts r
    where r.patient_id = ${a.patientId} and r.received_at >= ${a.requestedAt}
      and not exists (select 1 from entered_in_error_marks m where m.doc_type = 'receipt' and m.doc_id = r.id)
  `)).rows as { used: string | number }[];
  return { approvedPaise: approved.reduce((t, r) => t + (r.amount ?? 0), 0), usedPaise: Number(used[0]?.used ?? 0) };
}

/**
 * THE RECEIPT GUARD (review RED 3): an inpatient on a ₹0 scheme is never asked for money through ANY receipt route
 * unless approvers marked lines non-covered, and then only up to their total. Registered on billing's seam by
 * `IpdModule` (and by tests). The admission desk's own deposit passes (`IPD_DEPOSIT_PURPOSE`): it checks the same cap
 * under the same lock.
 */
export async function ipdSchemeReceiptGuard(tx: Tx, ctx: { patientId: string; totalPaise: number; purpose: string | null }): Promise<void> {
  if (ctx.purpose === IPD_DEPOSIT_PURPOSE) return;
  const open = (await tx.select().from(ipdAdmissions).where(and(
    eq(ipdAdmissions.patientId, ctx.patientId), inArray(ipdAdmissions.state, [...IPD_OPEN_ADMISSION_STATES]),
  )))[0];
  if (open === undefined || open.payerKind === null || !SCHEME_PAYERS.has(open.payerKind)) return;
  const a = await lockAdmission(tx, open.id);
  const head = await schemeHeadroom(tx, a);
  if (head.usedPaise + ctx.totalPaise > head.approvedPaise) {
    const words = IPD_REFUSALS.scheme_patient_no_deposit;
    throw new BillingError("receipt_guard_refused", words.rule, {
      code: "scheme_patient_no_deposit", fix: words.fix, admissionId: a.id, approvedPaise: head.approvedPaise, usedPaise: head.usedPaise,
    });
  }
}

export function registerIpdReceiptGuard(): () => void {
  return registerReceiptGuard("ipd.scheme", ipdSchemeReceiptGuard);
}

type DepositOut = Output<"take_deposit">;
async function priorDeposit(db: Db | Tx, actorId: string, key: string, admissionId: string): Promise<DepositOut | null> {
  const row = (await db.select().from(ipdAdmissionDeposits)
    .where(and(eq(ipdAdmissionDeposits.takenBy, actorId), eq(ipdAdmissionDeposits.idempotencyKey, key))))[0];
  if (row === undefined) return null;
  return { receiptId: row.receiptId, receiptNo: row.receiptNo, amountPaise: row.amountPaise, depositTotalPaise: await depositPaidPaise(db, admissionId) };
}

/**
 * Billing's advance, taken for one admission. Review RED 1: the receipt (`recordReceiptInTx`) and the admission link
 * commit in ONE transaction, and the intent's idempotency key is a unique column on the link — so a retry either finds
 * the committed pair and answers it, or finds nothing because nothing was written. Money is never taken twice.
 * The admission row is locked first: two deposits for one admission (and the receipt guard) queue on it, so the scheme
 * cap is a sum-under-lock, not a read-then-write (review #4). The cashier's open session and the cash law (269ST:
 * refused as `cash_limit_reached`, other tenders offered) are billing's; the refused-cash audit is written after the
 * rollback. DECIDED rules (decision 0072): a scheme patient pays nothing unless a GRANTED non-covered approval carries
 * an amount, and never beyond the approved total; an emergency patient is not asked before stabilisation.
 */
export async function takeDeposit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<DepositOut> {
  const input: Input<"take_deposit"> = IPD_INTENTS.take_deposit.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const at = opts.now ?? new Date();
  if (!LEDGER_TENDERS.has(input.tender)) {
    throw new IpdError("tender_not_supported", `the billing ledger takes cash, UPI and card; ${input.tender} is taken at the billing desk`);
  }
  const key = input.idempotencyKey.toLowerCase();
  const done = await priorDeposit(db, actor.id, key, input.admissionId);
  if (done !== null) return done;
  let patientId: string | null = null;
  try {
    const taken = await withTx(db, async (tx) => {
      const a = await lockAdmission(tx, input.admissionId);
      patientId = a.patientId;
      const again = await priorDeposit(tx, actor.id, key, a.id);
      if (again !== null) return again;
      if (!OPEN_FOR_DEPOSIT.has(a.state)) throw new IpdRefusal("admission_wrong_state");
      if (a.payerKind === null) throw new IpdRefusal("plan_missing");
      if (a.source === "er" && a.stabilisedAt === null) throw new IpdRefusal("deposit_before_stabilisation");
      let nonCoveredApprovalId: string | null = null;
      if (SCHEME_PAYERS.has(a.payerKind)) {
        const approval = await grantedApproval(tx, input.nonCoveredApprovalId, "non_covered", [a.id]);
        if (approval === null || approval.amountPaise === null) throw new IpdRefusal("scheme_patient_no_deposit");
        const head = await schemeHeadroom(tx, a);
        if (head.usedPaise + input.amountPaise > head.approvedPaise) {
          throw new IpdRefusal("scheme_patient_no_deposit", "More than the non-covered lines", {
            approvedPaise: head.approvedPaise, alreadyTakenPaise: head.usedPaise,
          });
        }
        nonCoveredApprovalId = approval.id;
      }
      const receipt = await recordReceiptInTx(tx, actor, {
        patientId: a.patientId,
        tenders: [{ mode: input.tender as "cash" | "upi" | "card", amountPaise: input.amountPaise, ...(input.tenderRef === undefined ? {} : { refText: input.tenderRef }) }],
        ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
        note: `IPD deposit for admission ${a.id}; paid by ${input.payer.name} (${input.payer.relation})`,
      }, at, { purpose: IPD_DEPOSIT_PURPOSE });
      await tx.insert(ipdAdmissionDeposits).values({
        id: newId(), admissionId: a.id, receiptId: receipt.receiptId, receiptNo: receipt.receiptNo, amountPaise: receipt.totalPaise,
        tender: input.tender, payerName: input.payer.name, payerRelation: input.payer.relation, payerPhone: input.payer.phone ?? null,
        nonCoveredApprovalId, idempotencyKey: key, takenBy: actor.id, takenAt: at,
      });
      if (a.depositCheckPending) await tx.update(ipdAdmissions).set({ depositCheckPending: false, updatedAt: at }).where(eq(ipdAdmissions.id, a.id));
      await appendEvent(tx, depositTaken.make({
        payload: { admissionId: a.id, receiptId: receipt.receiptId, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
      return {
        receiptId: receipt.receiptId, receiptNo: receipt.receiptNo, amountPaise: receipt.totalPaise,
        depositTotalPaise: await depositPaidPaise(tx, a.id),
      };
    });
    // E2.3 (#727): a receipt moves the deposit ladder (a top-up re-arms a fired level). After the commit, caught and logged
    // (review 8): the money is taken whatever the ladder does, and the nightly run evaluates every admission again.
    await evaluateDepositLadderSafely(db, input.admissionId, at, "deposit");
    return taken;
  } catch (e) {
    if (e instanceof BillingError && e.code === "cash_threshold_blocked" && patientId !== null) {
      await recordCashThresholdBlocked(db, actor, patientId, e.detail as CashThresholdDetail);
      throw new IpdRefusal("cash_limit_reached", undefined, { tendersOffered: ["upi", "card"] });
    }
    // A concurrent retry with the same key lost the unique race: the winner's committed pair is the answer.
    const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
    if (c.code === "23505" && c.constraint === "ipd_admission_deposits_key_ux") {
      const winner = await priorDeposit(db, actor.id, key, input.admissionId);
      if (winner !== null) return winner;
    }
    throw e;
  }
}
