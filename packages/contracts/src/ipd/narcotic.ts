import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema } from "./common";

/**
 * 2026-10-14 — THE WARD NARCOTIC REGISTER (NDPS Act; NABH MOM: controlled drugs under lock, a running balance, a count by
 * two nurses at every shift change, a discrepancy reported to the nursing supervisor and the pharmacy). Read models and
 * routes; the acts are `record_narcotic_count` and `resolve_narcotic_exception` (intents-meds.ts). Quantities are in the
 * register's ONE unit per drug — the issue's base unit (ampoule, vial, tablet). No money (decision 0058).
 */

export const IPD_NARCOTIC_ENTRY_KINDS = ["received", "given", "wasted", "returned", "reversal", "transfer_out", "transfer_in"] as const;
export type IpdNarcoticEntryKind = (typeof IPD_NARCOTIC_ENTRY_KINDS)[number];

const IpdWardRefSchema = z.object({ id: z.string(), code: z.string(), name: z.string() });

/** One controlled drug's running balance on the ward since the last agreed count. */
export const IpdNarcoticDrugSchema = z.object({
  medicineId: IpdIdSchema,
  name: z.string(),
  unit: z.string(),
  /** The last agreed count (matched, or a mismatch resolved); 0 when the ward never counted this drug. */
  opening: z.number(),
  openingAt: IpdInstantSchema.nullable(),
  received: z.number(),
  /** Given doses, net of a dose later marked entered in error. */
  given: z.number(),
  wasted: z.number(),
  returned: z.number(),
  transferredIn: z.number(),
  transferredOut: z.number(),
  /** opening + received + transferred in − given − wasted − returned − transferred out. */
  expected: z.number(),
  lastCount: z.object({ at: IpdInstantSchema, counted: z.number(), variance: z.number(), byName: z.string(), witnessName: z.string() }).nullable(),
});
export type IpdNarcoticDrug = z.infer<typeof IpdNarcoticDrugSchema>;

/** One register line on the ward (newest first). Sealed patient: "Sealed patient", no bed. */
export const IpdNarcoticLineSchema = z.object({
  entryId: IpdIdSchema,
  at: IpdInstantSchema,
  kind: z.enum(IPD_NARCOTIC_ENTRY_KINDS),
  medicineName: z.string(),
  qty: z.number(),
  unit: z.string(),
  patient: z.string(),
  bedCode: z.string().nullable(),
  byName: z.string(),
  witnessName: z.string().nullable(),
});
export type IpdNarcoticLine = z.infer<typeof IpdNarcoticLineSchema>;

/** A count that differed from the register: open until a supervisor or pharmacist resolves it. */
export const IpdNarcoticExceptionSchema = z.object({
  countId: IpdIdSchema,
  at: IpdInstantSchema,
  medicineName: z.string(),
  unit: z.string(),
  expected: z.number(),
  counted: z.number(),
  variance: z.number(),
  byName: z.string(),
  witnessName: z.string(),
  resolution: z.object({ at: IpdInstantSchema, byName: z.string(), note: z.string() }).nullable(),
});
export type IpdNarcoticException = z.infer<typeof IpdNarcoticExceptionSchema>;

export const IpdNarcoticWardSchema = z.object({
  asOf: IpdInstantSchema,
  ward: IpdWardRefSchema.nullable(),
  wards: z.array(IpdWardRefSchema),
  shift: z.enum(["morning", "evening", "night"]),
  /** No count on this ward since the current shift began. */
  countDue: z.boolean(),
  /** The reader may close an exception (a nursing supervisor or a pharmacist). */
  canResolve: z.boolean(),
  drugs: z.array(IpdNarcoticDrugSchema),
  exceptions: z.array(IpdNarcoticExceptionSchema),
  lines: z.array(IpdNarcoticLineSchema),
});
export type IpdNarcoticWard = z.infer<typeof IpdNarcoticWardSchema>;

export const IPD_NARCOTIC_ROUTES = {
  ward: "/ipd/emar/narcotics",
  count: "/ipd/emar/narcotics/count",
  resolve: "/ipd/emar/narcotics/resolve",
} as const;
