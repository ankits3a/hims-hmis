import { and, eq, isNull } from "drizzle-orm";
import { CANTEEN_MEAL_SERVICE_CODE, IPD_CANTEEN_COMPONENT } from "@hmis/contracts";
import { ipdAdmissions, ipdBedStays, ipdChargeLines, services } from "../../kernel/db/schema";
import { TariffError, priceInvoiceLines } from "../tariff";
import { lockAdmission, readAdmission } from "./admission-core";
import { liveBills } from "./bill-cover";
import { insertLine, lockedVersion, pricingFor } from "./charges";
import { IPD_NURSING_STATES } from "./nursing";
import { placesOf } from "./rounds-read";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * CN-1 CANTEEN (#977, decision 0088) — WHAT THE CANTEEN NEEDS FROM AN ADMISSION, AND THE ONE DOOR ONTO ITS RUNNING BILL.
 *
 * - `canteenAdmissionFacts`: open or not, the patient, the bed and its billed class (bed-class meal inclusion). "Open" is
 *   the IP counter's rule (`counter-charge.ts`): a nursing state and no settled final bill.
 * - `openAdmissionAtBed`: the admission whose open stay is on a bed (the bed QR asks this on every request).
 * - `postCanteenChargeIn`: one canteen sale line → one `ipd.canteen` line (component `canteen`), priced by the tariff
 *   engine from the taxable value the canteen split out of its inclusive menu price — so the final bill's invoice, which
 *   the same engine prices, carries exactly the stay's amount. The service is `CANTEEN_MEAL` (category `canteen_food`,
 *   5%) or, for food to the patient as part of the stay, `CANTEEN_DIET` (category `inpatient_diet`, exempt). One IP line
 *   per canteen sale line, ever (`ipd_charge_lines_canteen_ux`). Never TPA-payable (`payer-split.ts`).
 */

export const CANTEEN_DIET_SERVICE_CODE = "CANTEEN_DIET";

export type CanteenAdmissionFacts = {
  admissionId: string;
  patientId: string;
  state: string;
  /** null when open; else why the canteen may not charge it. */
  closed: "admission_closed" | "ipd_bill_settled" | null;
  bedId: string | null;
  billedClass: string | null;
};

async function closedReason(exec: Db | Tx, a: AdmissionRow): Promise<CanteenAdmissionFacts["closed"]> {
  if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) return "admission_closed";
  if ((await liveBills(exec, a.id)).some((b) => b.kind === "final")) return "ipd_bill_settled";
  return null;
}

export async function canteenAdmissionFacts(exec: Db | Tx, admissionId: string): Promise<CanteenAdmissionFacts | null> {
  const a = (await (exec as Db).select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) return null;
  const stay = (await (exec as Db).select({ bedId: ipdBedStays.bedId, billedClass: ipdBedStays.billedClass }).from(ipdBedStays)
    .where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))))[0];
  return {
    admissionId: a.id, patientId: a.patientId, state: a.state, closed: await closedReason(exec, a),
    bedId: stay?.bedId ?? null, billedClass: stay?.billedClass ?? null,
  };
}

/**
 * The canteen counter's lookup by IP number (`IP26-000123` or `IP26-123`): the open admission, its bed and ward and its
 * billed class — never the patient's name or anything clinical (the attendant gives the number; the bed confirms it).
 * Null when no admission has that number; `closed` says why the canteen may not charge it.
 */
export async function canteenAdmissionByNo(exec: Db | Tx, q: string): Promise<(CanteenAdmissionFacts & { admissionNo: string; bedCode: string | null; wardName: string | null }) | null> {
  const m = /^IP(\d{2})-?(\d{1,6})$/.exec(q.trim().toUpperCase());
  if (m === null) return null;
  const no = `IP${m[1]!}-${m[2]!.padStart(6, "0")}`;
  const a = (await (exec as Db).select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(eq(ipdAdmissions.admissionNo, no)))[0];
  if (a === undefined) return null;
  const facts = (await canteenAdmissionFacts(exec, a.id))!;
  const place = (await placesOf(exec as Db, [a.id])).get(a.id);
  return { ...facts, admissionNo: no, bedCode: place?.bedCode ?? null, wardName: place?.wardName ?? null };
}

/** The admission whose open stay is on `bedId`, or null. */
export async function openAdmissionAtBed(exec: Db | Tx, bedId: string): Promise<string | null> {
  const stay = (await (exec as Db).select({ admissionId: ipdBedStays.admissionId }).from(ipdBedStays)
    .where(and(eq(ipdBedStays.bedId, bedId), isNull(ipdBedStays.endedAt))))[0];
  return stay?.admissionId ?? null;
}

export type CanteenChargeInput = {
  saleLineId: string;
  /** The IST day of the sale. */
  serviceDate: string;
  qty: number;
  /** The taxable value of ONE unit (the canteen's inclusive menu price with the tax split out). */
  taxableUnitPaise: number;
  /** Food to the in-patient as part of the stay: the exempt diet service. */
  inpatientDiet: boolean;
};

export type CanteenChargeResult =
  | { ok: true; lineId: string; netPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; gstRateBps: number; exempt: boolean }
  | { ok: false; reason: "admission_closed" | "ipd_bill_settled" | "service_missing" | "tariff_missing"; detail?: string };

/** In the caller's transaction, under the admission's lock. A repeat of the same sale line returns its line unchanged. */
export async function postCanteenChargeIn(tx: Tx, actor: Actor, admissionId: string, input: CanteenChargeInput, at: Date): Promise<CanteenChargeResult> {
  const a = await lockAdmission(tx, admissionId);
  const closed = await closedReason(tx, a);
  if (closed !== null) return { ok: false, reason: closed };
  const db = tx as unknown as Db;
  const versionId = await lockedVersion(db, a);
  if (versionId === null) return { ok: false, reason: "tariff_missing" };
  if (a.tariffVersionId === null) await tx.update(ipdAdmissions).set({ tariffVersionId: versionId }).where(eq(ipdAdmissions.id, a.id));
  const code = input.inpatientDiet ? CANTEEN_DIET_SERVICE_CODE : CANTEEN_MEAL_SERVICE_CODE;
  const svc = (await tx.select().from(services).where(eq(services.code, code)))[0];
  if (svc === undefined || !svc.active) return { ok: false, reason: "service_missing" };
  const ctx = await pricingFor(db, new Map(), versionId, at);
  let priced;
  try {
    [priced] = priceInvoiceLines(ctx, [{ lineId: input.saleLineId, serviceId: svc.id, qty: input.qty, prepaidUnitPaise: input.taxableUnitPaise }]);
  } catch (e) {
    if (e instanceof TariffError) return { ok: false, reason: "service_missing", detail: `${e.code}: ${e.message}` };
    throw e;
  }
  const p = priced!;
  const fresh = await readAdmission(tx, admissionId);
  const lineId = await insertLine(tx, {
    admission: fresh, serviceDate: input.serviceDate, component: IPD_CANTEEN_COMPONENT, billedClass: null, priced: p, code: svc.code, versionId,
    source: "ipd.canteen", canteenSaleLineId: input.saleLineId, actor, at,
  });
  const id = lineId ?? (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.canteenSaleLineId, input.saleLineId), eq(ipdChargeLines.source, "ipd.canteen"))))[0]!.id;
  return {
    ok: true, lineId: id, netPaise: p.netPaise, taxablePaise: p.taxableBasePaise, cgstPaise: p.gst.cgstPaise, sgstPaise: p.gst.sgstPaise,
    gstRateBps: p.gst.rateBps, exempt: p.gst.exempt,
  };
}
