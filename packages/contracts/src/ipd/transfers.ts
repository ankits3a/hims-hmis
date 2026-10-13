import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema } from "./common";

/**
 * E3.1 (#729) — THE TRANSFER SURFACES' read models (spec SPEC-ipd-core §4.4, §4.9 C/D): the Beds board drawer's
 * Transfer panel (what this patient can be moved to, swapped with, or re-classed as) and the receiving ward's
 * "Waiting for you" handover list (SBAR, then Accept or Cancel). No money: a class is a word, never a price
 * (decision 0058 — a doctor may read the handover list's patient).
 */

const IdentitySchema = z.object({ name: z.string().nullable(), uhid: z.string(), ageSex: z.string(), initials: z.string() });

export const IpdSbarSchema = z.object({
  situation: z.string(),
  background: z.string(),
  assessment: z.string(),
  recommendation: z.string(),
});
export type IpdSbar = z.infer<typeof IpdSbarSchema>;

export const IPD_TRANSFER_REASONS = [
  "clinical_step_up", "clinical_step_down", "post_op", "isolation", "gender_fix", "patient_request", "bed_management",
] as const;

/** One handover waiting for the receiving ward's nurse. */
export const IpdHandoverCardSchema = z.object({
  transferId: IpdIdSchema,
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  patient: IdentitySchema,
  fromBed: z.object({ id: IpdIdSchema, code: z.string(), wardName: z.string().nullable() }),
  toBed: z.object({ id: IpdIdSchema, code: z.string(), wardId: IpdIdSchema.nullable(), wardName: z.string().nullable(), class: IpdBedClassSchema }),
  reason: z.enum(IPD_TRANSFER_REASONS),
  sbar: IpdSbarSchema,
  startedAt: IpdInstantSchema,
  startedBy: z.object({ id: z.string(), name: z.string() }),
  /** No acceptance by then escalates to the nursing supervisor / duty manager (§4.4). */
  escalatesAt: IpdInstantSchema.nullable(),
  /** True once `escalatesAt` has passed: the card says so in words, never by colour alone. */
  escalated: z.boolean(),
  /** The viewer started this transfer: they may cancel it but not accept it (`sender_cannot_accept`). */
  sentByViewer: z.boolean(),
});
export type IpdHandoverCard = z.infer<typeof IpdHandoverCardSchema>;

export const IpdHandoverListSchema = z.object({
  asOf: IpdInstantSchema,
  /** Receiving wards with a handover waiting (the filter chips). */
  wards: z.array(z.object({ id: IpdIdSchema, name: z.string(), count: z.number().int().nonnegative() })),
  handovers: z.array(IpdHandoverCardSchema),
});
export type IpdHandoverList = z.infer<typeof IpdHandoverListSchema>;

/** A bed the patient may move to: rule-valid now (the act re-checks under lock). */
export const IpdTransferTargetSchema = z.object({
  bedId: IpdIdSchema,
  code: z.string(),
  wardName: z.string().nullable(),
  class: IpdBedClassSchema,
  icu: z.boolean(),
  reasons: z.array(z.string()),
});
export type IpdTransferTarget = z.infer<typeof IpdTransferTargetSchema>;

export const IpdTransferOptionsSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  patient: IdentitySchema,
  bed: z.object({ id: IpdIdSchema, code: z.string(), class: IpdBedClassSchema, wardName: z.string().nullable() }).nullable(),
  /** The class the stay bills at now (a protected or changed class wins over the bed's). */
  billedClass: IpdBedClassSchema.nullable(),
  /** A class change consented and waiting for its noon. */
  pendingClassChange: z.object({ toClass: IpdBedClassSchema, effectiveFrom: IpdInstantSchema }).nullable(),
  openTransfer: z.object({ transferId: IpdIdSchema, toBedCode: z.string(), startedAt: IpdInstantSchema }).nullable(),
  /** Rule-valid free beds, same ward first, then by code. */
  targets: z.array(IpdTransferTargetSchema),
  /** Other admitted patients on a bed, for a swap; the act checks both patients against both beds. */
  swapWith: z.array(z.object({
    admissionId: IpdIdSchema, bedId: IpdIdSchema, bedCode: z.string(), wardName: z.string().nullable(), initials: z.string(),
    class: IpdBedClassSchema,
  })),
  /** Ward room classes a class change in place may choose (critical care is a transfer). */
  classes: z.array(IpdBedClassSchema),
});
export type IpdTransferOptions = z.infer<typeof IpdTransferOptionsSchema>;

/** Ward room classes a change in place may choose; critical care, day care, emergency and LDR are transfers. */
export const IPD_IN_PLACE_CLASSES = ["general", "semi_private", "private", "deluxe", "suite"] as const;

/** A class change takes effect at the next 12:00 IST after the consent (§4.4). */
export const IPD_CLASS_CHANGE_HOUR_IST = 12;

/** How long a transfer holds its target bed (DECIDED, E3.1): long past the 30-minute escalation. */
export const IPD_TRANSFER_HOLD_MINUTES = 12 * 60;

/** HTTP routes (under the api prefix). The body of each POST is the intent's own input contract. */
export const IPD_TRANSFER_ROUTES = {
  handovers: "/ipd/transfers/handovers",
  options: "/ipd/transfers/options",
  start: "/ipd/transfers/start",
  accept: "/ipd/transfers/accept",
  cancel: "/ipd/transfers/cancel",
  swap: "/ipd/transfers/swap",
  changeClass: "/ipd/transfers/change-class",
} as const;
