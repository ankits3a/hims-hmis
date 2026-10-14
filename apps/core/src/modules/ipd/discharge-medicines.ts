import { normalizeDrugName } from "../formulary";
import type { IpdMedicineFlag, IpdSummaryMedicine } from "@hmis/contracts";
import type { IpdOrderRow } from "./orders";

/**
 * E5.4 (#741) — "EVERY MEDICINE IN THE SUMMARY MUST MATCH AN ACTIVE ORDER, OR IT IS FLAGGED" (spec §4.8).
 *
 * A row the drafter copied from an order names that order (`orderId`): it matches only while that order is still active
 * and still carries that name. A typed row matches when an active drug order of the stay carries its name. Anything
 * else is flagged — `order_stopped` when a stopped or cancelled order carries the name, `no_active_order` otherwise.
 *
 * DECIDED (standard practice): a TYPED row is flagged and never refused — a take-home medicine is often new at discharge
 * and the doctor typed it under their own signature. A DRAFTED row (`source: "order"`) that no longer matches refuses
 * the signature (`medicine_not_on_active_order`, the intent's declared refusal): the machine copied it, the order
 * changed since, and a person must look.
 */

/** The same medicine by name: equal after the formulary's normalizer, or every word of one name is a word of the other. */
export function sameMedicineName(a: string, b: string): boolean {
  const x = normalizeDrugName(a);
  const y = normalizeDrugName(b);
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const xs = x.split(" ");
  const ys = y.split(" ");
  const [few, many] = xs.length <= ys.length ? [xs, new Set(ys)] : [ys, new Set(xs)];
  return few.every((w) => many.has(w));
}

export function medicineRowReason(m: Pick<IpdSummaryMedicine, "name" | "orderId">, drugOrders: readonly IpdOrderRow[]): IpdMedicineFlag["reason"] | null {
  if (m.orderId !== undefined) {
    const o = drugOrders.find((x) => x.id === m.orderId);
    if (o === undefined) return "no_active_order";
    if (o.status !== "active") return "order_stopped";
    return sameMedicineName(m.name, o.medicineName ?? "") ? null : "no_active_order";
  }
  const named = drugOrders.filter((o) => sameMedicineName(m.name, o.medicineName ?? ""));
  if (named.some((o) => o.status === "active")) return null;
  return named.length > 0 ? "order_stopped" : "no_active_order";
}

export function medicineFlagsOf(medicines: readonly IpdSummaryMedicine[], drugOrders: readonly IpdOrderRow[]): IpdMedicineFlag[] {
  return medicines.flatMap((m, index) => {
    const reason = medicineRowReason(m, drugOrders);
    return reason === null ? [] : [{ name: m.name, where: "medicines" as const, index, reason }];
  });
}
