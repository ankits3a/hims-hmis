import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, IpdNonPayableInputSchema, ipdRateServiceCode, newId } from "@hmis/contracts";
import {
  approvals, ipdPayerAuths, ipdPayerNonPayables, services,
} from "../../kernel/db/schema";
import { coverageSumInsuredPaise } from "../patients";
import { loadPricingContext } from "../tariff";
import { holdsPermission, readAdmission, requireIpdPermission } from "./admission-core";
import { IPD_APPROVAL_TYPE_KEYS } from "./approval-types";
import { priceComponent } from "./charges";
import { loadPriceBook } from "./deposit";
import { IpdError } from "./errors";
import { IPD_ADMIT, IPD_BILL_VIEW, IPD_PAYER_TERMS } from "./manifest";
import { capWarningOf, splitBill, splitTermsOf } from "./payer-split";
import type {
  Actor, IpdBedClass, IpdNonPayable, IpdPayerSplit, IpdRateComponent, IpdRoomRentCapWarning,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ipdChargeLines } from "../../kernel/db/schema";
import type { AdmissionRow } from "./admission-core";
import type { PriceBook } from "./deposit";
import type { NonPayables, SplitLineInput, SplitTerms } from "./payer-split";

/**
 * E2.2 (#726) — the payer split's reads and the few writes around it. The split itself is computed on read
 * (`payer-split.ts`, pure); this file loads its inputs: the admission's authorisation rows, the coverage's sum insured
 * (only for a cap stated as a % of it), the scheme's granted non-covered approvals and the non-payables list. A printed
 * interim bill keeps what it said (`ipd_payer_split_snapshots`).
 */

type ChargeLineRow = typeof ipdChargeLines.$inferSelect;

/** The split's terms for one admission, from its record. */
export async function loadSplitTerms(db: Db | Tx, a: AdmissionRow): Promise<SplitTerms> {
  const rows = await db.select().from(ipdPayerAuths).where(eq(ipdPayerAuths.admissionId, a.id))
    .orderBy(asc(ipdPayerAuths.recordedAt), asc(ipdPayerAuths.id));
  const needsSi = rows.some((r) => r.roomRentCapSiBp !== null);
  const si = needsSi && a.coverageId !== null ? await coverageSumInsuredPaise(db, a.coverageId) : null;
  let nonCovered = 0;
  if (a.payerKind === "pmjay" || a.payerKind === "state_scheme") {
    const granted = await db.select({ amount: approvals.amountPaise }).from(approvals).where(and(
      eq(approvals.typeKey, IPD_APPROVAL_TYPE_KEYS.non_covered), eq(approvals.status, "granted"), eq(approvals.subjectId, a.id),
    ));
    nonCovered = granted.reduce((t, r) => t + (r.amount ?? 0), 0);
  }
  return splitTermsOf(a.payerKind, rows, si, nonCovered);
}

/** The live non-payables list, lower-cased for matching. */
export async function loadNonPayables(db: Db | Tx): Promise<NonPayables> {
  const rows = await db.select().from(ipdPayerNonPayables).where(isNull(ipdPayerNonPayables.retiredAt));
  return {
    services: new Set(rows.filter((r) => r.matchKind === "service").map((r) => r.matchValue.toLowerCase())),
    categories: new Set(rows.filter((r) => r.matchKind === "category").map((r) => r.matchValue.toLowerCase())),
  };
}

/** Computes the split for an admission's posted lines (the interim bill passes the lines it already read). */
export async function computePayerSplit(db: Db | Tx, a: AdmissionRow, lines: readonly ChargeLineRow[]): Promise<IpdPayerSplit> {
  const terms = await loadSplitTerms(db, a);
  const ids = [...new Set(lines.map((l) => l.serviceId))];
  const cats = ids.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: services.id, category: services.category }).from(services).where(inArray(services.id, ids)))
      .map((s) => [s.id, s.category] as const));
  const inputs: SplitLineInput[] = lines.map((l) => ({
    id: l.id, serviceDate: l.serviceDate, component: l.component as IpdRateComponent, billedClass: l.billedClass as IpdBedClass | null,
    serviceCode: l.serviceCode, category: cats.get(l.serviceId) ?? null, taxablePaise: l.taxablePaise, netPaise: l.netPaise, source: l.source,
    reversalOf: l.reversalOf, postedAt: l.postedAt.toISOString(),
  }));
  return splitBill(inputs, terms, await loadNonPayables(db));
}

// ═══════════════════════════════════════ room-rent cap warning ═══════════════════════════════════════

/**
 * The room rent per day of a class: on the admission's LOCKED tariff version once admitted (what the stay will be
 * charged), else from the active price book. Null when the class carries no rent or the rate is missing.
 */
async function rentPerDay(db: Db, a: AdmissionRow, cls: IpdBedClass, at: Date, book?: PriceBook): Promise<number | null> {
  const rated = IPD_BED_CLASS_INFO[cls].billsAs ?? cls;
  if (a.tariffVersionId !== null) {
    const priced = priceComponent(await loadPricingContext(db, { at, tariffVersionId: a.tariffVersionId }), rated, "room");
    return priced.ok ? priced.line.netPaise : null;
  }
  return (book ?? await loadPriceBook(db, at)).get(ipdRateServiceCode(rated, "room")) ?? null;
}

/** Cap warnings for the admit sheet's class cards (null per class when none applies). */
export async function capWarningsFor(
  db: Db, a: AdmissionRow, classes: readonly IpdBedClass[], at: Date, book: PriceBook,
): Promise<Map<IpdBedClass, IpdRoomRentCapWarning | null>> {
  const out = new Map<IpdBedClass, IpdRoomRentCapWarning | null>();
  const terms = await loadSplitTerms(db, a);
  for (const cls of classes) {
    out.set(cls, terms.mode !== "insured" ? null : capWarningOf(cls, terms.roomRentCapPaise, await rentPerDay(db, a, cls, at, book)));
  }
  return out;
}

/**
 * `roomRentCapWarning(admissionId, targetClass)` — the per-day difference and the proportional effect in words, for
 * the transfer/class-change lane's upgrade consent and the admit sheet. `ipd.bill.view` or `ipd.admit` (the desks
 * that counsel the upgrade); no doctor holds either. Null: no cap on record, not insured, critical care, or within it.
 */
export async function roomRentCapWarning(
  db: Db, actor: Actor, admissionId: string, targetClass: IpdBedClass, at: Date = new Date(),
): Promise<IpdRoomRentCapWarning | null> {
  if (!(await holdsPermission(db, actor, IPD_BILL_VIEW))) await requireIpdPermission(db, actor, IPD_ADMIT);
  const a = await readAdmission(db, admissionId);
  const terms = await loadSplitTerms(db, a);
  if (terms.mode !== "insured") return null;
  return capWarningOf(targetClass, terms.roomRentCapPaise, await rentPerDay(db, a, targetClass, at));
}

// ═══════════════════════════════════════ the non-payables list ═══════════════════════════════════════

const viewOf = (r: typeof ipdPayerNonPayables.$inferSelect): IpdNonPayable => ({
  id: r.id, matchKind: r.matchKind as "service" | "category", matchValue: r.matchValue, reason: r.reason, createdAt: r.createdAt.toISOString(),
});

export async function listPayerNonPayables(db: Db, actor: Actor): Promise<IpdNonPayable[]> {
  await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  const rows = await db.select().from(ipdPayerNonPayables).where(isNull(ipdPayerNonPayables.retiredAt))
    .orderBy(asc(ipdPayerNonPayables.matchKind), asc(ipdPayerNonPayables.matchValue));
  return rows.map(viewOf);
}

/** The billing manager adds a service code or tariff category insurers never pay (`ipd.payer.terms`, review 11). */
export async function addPayerNonPayable(db: Db, actor: Actor, raw: unknown, at: Date = new Date()): Promise<IpdNonPayable> {
  const input = IpdNonPayableInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  const [row] = await db.insert(ipdPayerNonPayables).values({
    id: newId(), matchKind: input.matchKind, matchValue: input.matchValue, reason: input.reason, createdBy: actor.id, createdAt: at,
  }).onConflictDoNothing().returning();
  if (row === undefined) throw new IpdError("non_payable_exists", "That item is already on the non-payables list");
  return viewOf(row);
}

/** Retires a row (never deleted: a printed split may have relied on it). */
export async function retirePayerNonPayable(db: Db, actor: Actor, id: string, at: Date = new Date()): Promise<void> {
  await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  const done = await db.update(ipdPayerNonPayables).set({ retiredAt: at, retiredBy: actor.id })
    .where(and(eq(ipdPayerNonPayables.id, id), isNull(ipdPayerNonPayables.retiredAt))).returning({ id: ipdPayerNonPayables.id });
  if (done.length === 0) throw new IpdError("non_payable_not_found", "No live non-payable row with that id");
}
