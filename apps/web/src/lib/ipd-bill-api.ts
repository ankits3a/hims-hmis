import { api } from "./api";
import type { IpdInterimBill, IpdSplitSnapshot } from "@hmis/contracts";

/**
 * E2.1 (#725) — the interim bill's wire (spec §4.3, §4.9 H). The shape is the contract's `IpdInterimBill`
 * (`packages/contracts/src/ipd/charges.ts`); the path is copied from `IPD_CHARGE_ROUTES` because the web bundle imports
 * the contract package for TYPES only. Served under `ipd.bill.view` only — a doctor never reaches it (decision 0058).
 */
export function getInterimBill(admissionId: string): Promise<IpdInterimBill> {
  return api("GET", `/ipd/admissions/${encodeURIComponent(admissionId)}/interim-bill`);
}

/** E2.2 (#726) — keeps the payer split as printed (`IPD_PAYER_ROUTES.printSnapshot`), then the browser prints. */
export function printInterimBill(admissionId: string): Promise<IpdSplitSnapshot> {
  return api("POST", `/ipd/admissions/${encodeURIComponent(admissionId)}/interim-bill/print`, {});
}
