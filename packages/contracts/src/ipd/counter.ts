import { z } from "zod";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema } from "./common";
import { IpdRoundIdentitySchema } from "./rounds";

/**
 * #787 (IP counter) — CHARGE TO IP at the OPD pharmacy counter (PHARM-OPD). The pharmacist finds the admission by its IP
 * number or by the patient's UHID, sees the bed and the ward to confirm the right patient, and the sale goes on the
 * admission's running bill (intent `counter_charge`). Returns credit it (`counter_return`). A pharmacist's screen: the
 * amounts are shown (the attendant is told what went on the bill); nothing here reaches a doctor (decision 0058).
 */

/** The admission the counter charges: identity by the shared rule (a sealed patient shows the alias, no bed or ward). */
export const IpdCounterAdmissionSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  identity: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
});
export type IpdCounterAdmission = z.infer<typeof IpdCounterAdmissionSchema>;

/** One medicine of the counter's shelf (PHARM-OPD); Schedule X is never offered. */
export const IpdCounterShelfEntrySchema = z.object({
  medicineId: z.string(),
  itemId: z.string(),
  brandName: z.string(),
  strengthLabel: z.string().nullable(),
  scheduleFlag: z.string().nullable(),
  baseUom: z.string(),
  available: z.number().int(),
});
export type IpdCounterShelfEntry = z.infer<typeof IpdCounterShelfEntrySchema>;

/** One counter sale on the admission and what may still come back of each item. */
export const IpdCounterSaleSchema = z.object({
  saleId: IpdIdSchema,
  soldAt: IpdInstantSchema,
  lines: z.array(z.object({ itemId: z.string(), name: z.string(), units: z.number().int(), returned: z.number().int() })),
});
export type IpdCounterSale = z.infer<typeof IpdCounterSaleSchema>;
export const IpdCounterSalesSchema = z.object({ admissionId: IpdIdSchema, sales: z.array(IpdCounterSaleSchema) });
export type IpdCounterSales = z.infer<typeof IpdCounterSalesSchema>;

/** The stock ledger's `ref_type` for a counter sale's issue and for its returns (`ref_id` `<sale>:<return>`). */
export const IPD_COUNTER_SALE_REF = "ipd_counter_sale";
export const IPD_COUNTER_RETURN_REF = "ipd_counter_return";

export const IPD_COUNTER_ROUTES = {
  lookup: "/ipd/counter/admission",
  shelf: "/ipd/counter/shelf",
  sales: "/ipd/counter/admissions/:admissionId/sales",
  charge: "/ipd/counter/charge",
  returnSale: "/ipd/counter/return",
} as const;
