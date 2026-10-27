import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdPaiseSchema } from "./common";
import { IPD_DISCHARGE_STEPS } from "./discharge";

/**
 * E3.3 (#731) — THE FAMILY LINK (spec SPEC-ipd-core §4.3, §4.7 family view, §4.9 G, §4.10 edges 14–17).
 *
 * The desk issues a link for one admission to the REGISTERED ATTENDANT (the daily-totals recipient: the active guardian
 * with a phone and bill authority, else the latest deposit payer recorded as a relative with a phone). Opening the link
 * asks for an OTP that goes ONLY to that phone; a verified session (12 h, an http-only cookie on that browser) shows the
 * patient's first name (the alias for a confidential patient), ward, day of stay, the condition word the treating team
 * set, today's totals (no line items), the discharge tracker in plain words and a "Request a callback" form. Line items
 * need a second explicit step inside the session, and that step is logged. Off for sealed and medico-legal admissions
 * and when the treating team turns it off; revoked at death and absconding; "Discharged" for 24 hours after the exit.
 * Nothing here is written by a model: a clinical question becomes a callback request to the ward desk.
 */

/** The condition words the treating team sets (never a model). The family page shows "Ask the ward" until one is set. */
export const IPD_CONDITION_WORDS = ["stable", "improving", "serious", "critical"] as const;
export const IpdConditionWordSchema = z.enum(IPD_CONDITION_WORDS);
export type IpdConditionWord = z.infer<typeof IpdConditionWordSchema>;

/** Why the treating team turned the family link off for an admission (spec §4.9 G: psychiatric, HIV, MTP, POCSO …). */
export const IPD_FAMILY_OFF_REASONS = ["psychiatric", "hiv", "mtp", "pocso", "patient_request", "other"] as const;
export const IpdFamilyOffReasonSchema = z.enum(IPD_FAMILY_OFF_REASONS);

/** How the attendant is related to the patient (consent at issue, DPDP Act 2023 §6). */
export const IPD_FAMILY_RELATIONS = ["self", "spouse", "parent", "child", "sibling", "relative", "guardian", "other"] as const;

/** The purpose stated on the page and recorded with the consent (DPDP Act 2023 §5 notice). */
export const IPD_FAMILY_PURPOSE = "inpatient_updates" as const;

/** No idempotency key on purpose: a replayed answer would have to store the token; a second issue revokes the first. */
export const IpdIssueFamilyLinkSchema = z.strictObject({
  /** Who agreed to the link (the patient, or the attendant for a patient who cannot) and how they are related. */
  consent: z.strictObject({
    consentedBy: z.string().trim().min(2).max(120),
    relation: z.enum(IPD_FAMILY_RELATIONS),
    method: z.enum(["verbal", "paper"]),
  }),
});
export type IpdIssueFamilyLink = z.infer<typeof IpdIssueFamilyLinkSchema>;

/** A set, not an append: repeating it is harmless, so it carries no idempotency key. */
export const IpdSetConditionSchema = z.strictObject({
  word: IpdConditionWordSchema.nullable(),
  /** Turn the family link off (null turns it back on). A live link is revoked when it goes off. */
  familyOff: IpdFamilyOffReasonSchema.nullable().optional(),
});
export type IpdSetCondition = z.infer<typeof IpdSetConditionSchema>;

export const IpdCloseCallbackSchema = z.strictObject({ note: z.string().trim().min(1).max(500) });

/** The staff panel on the discharge desk: condition, the live link, the open callbacks for this admission. */
export const IpdFamilyPanelSchema = z.object({
  admissionId: IpdIdSchema,
  condition: z.object({ word: IpdConditionWordSchema.nullable(), setAt: IpdInstantSchema.nullable(), setBy: z.string().nullable() }),
  familyOff: IpdFamilyOffReasonSchema.nullable(),
  /** Why a link cannot be issued now, or null (sealed, medico-legal, turned off, no attendant phone, stay ended). */
  blocked: z.enum(["sealed", "mlc", "family_off", "no_attendant_phone", "stay_ended"]).nullable(),
  link: z.object({
    id: IpdIdSchema,
    status: z.enum(["active", "revoked", "expired"]),
    phoneMasked: z.string(),
    issuedAt: IpdInstantSchema,
    revokedReason: z.string().nullable(),
  }).nullable(),
  /** Masked attendant phone a new link would go to, or null. */
  attendantPhoneMasked: z.string().nullable(),
  callbacks: z.array(z.lazy(() => IpdFamilyCallbackSchema)),
  can: z.object({ issue: z.boolean(), revoke: z.boolean(), setCondition: z.boolean(), closeCallback: z.boolean() }),
});
export type IpdFamilyPanel = z.infer<typeof IpdFamilyPanelSchema>;

/** What issue answers: the address to hand over (QR / copy), `/family#<token>`. Shown once; stored only as a hash. */
export const IpdFamilyLinkIssuedSchema = z.object({ linkId: IpdIdSchema, path: z.string(), phoneMasked: z.string() });
export type IpdFamilyLinkIssued = z.infer<typeof IpdFamilyLinkIssuedSchema>;

export const IpdFamilyCallbackSchema = z.object({
  id: IpdIdSchema,
  admissionId: IpdIdSchema,
  /** The alias for a restricted patient; null for a SEALED patient (the desk shows "Sealed patient"). */
  patientName: z.string().nullable(),
  /** Null for a sealed or a confidential patient: the desk list is read over a shoulder. */
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
  /** `sealed` (D-31) and `confidential` (staff / VIP) rows carry no bed and no ward. */
  privacy: z.enum(["sealed", "confidential"]).nullable(),
  text: z.string(),
  phoneMasked: z.string(),
  status: z.enum(["open", "done"]),
  createdAt: IpdInstantSchema,
  closedAt: IpdInstantSchema.nullable(),
  closedBy: z.string().nullable(),
  note: z.string().nullable(),
});
export type IpdFamilyCallback = z.infer<typeof IpdFamilyCallbackSchema>;

export const IpdFamilyCallbackListSchema = z.object({ rows: z.array(IpdFamilyCallbackSchema) });
export type IpdFamilyCallbackList = z.infer<typeof IpdFamilyCallbackListSchema>;

// ═══════════════════════════════════════ the public page ═══════════════════════════════════════

/** Before the OTP: only the masked phone and whether the link is still open. No name, no ward. */
export const IpdFamilyGateSchema = z.object({
  status: z.enum(["needs_otp", "verified", "closed"]),
  phoneMasked: z.string().nullable(),
  purpose: z.literal(IPD_FAMILY_PURPOSE),
});
export type IpdFamilyGate = z.infer<typeof IpdFamilyGateSchema>;

/**
 * The link token travels in the BODY of every public call, never in a path: the edge's access log keeps paths (review
 * #764). The page itself is `/family#<token>` — a fragment never leaves the browser.
 */
export const IpdFamilyTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);
export const IpdFamilyTokenBodySchema = z.strictObject({ token: IpdFamilyTokenSchema });
export const IpdFamilyOtpSchema = z.strictObject({ token: IpdFamilyTokenSchema, code: z.string().regex(/^\d{6}$/) });

export const IpdFamilyStepSchema = z.object({
  key: z.enum(IPD_DISCHARGE_STEPS),
  state: z.enum(["done", "now", "waiting", "skipped"]),
  at: IpdInstantSchema.nullable(),
});

/** The verified page (board G). Words are keys the page translates; numbers and dates come from records. */
export const IpdFamilyViewSchema = z.object({
  status: z.enum(["in_hospital", "discharged"]),
  name: z.string(),
  /** Null for a confidential patient (alias only, no place). */
  ward: z.string().nullable(),
  dayOfStay: z.number().int().positive(),
  condition: z.object({ word: IpdConditionWordSchema.nullable(), setAt: IpdInstantSchema.nullable() }),
  totals: z.object({
    billPaise: IpdPaiseSchema,
    depositPaise: IpdPaiseSchema,
    /** deposit − bill: positive is money left, negative is amount due. */
    balancePaise: z.number().int(),
    asOf: IpdInstantSchema,
  }),
  tracker: z.object({
    steps: z.array(IpdFamilyStepSchema),
    expectedAt: IpdInstantSchema.nullable(),
    todo: z.enum(["nothing", "pay_bill", "collect_gate_pass", "wait_summary", "go_home"]),
  }).nullable(),
  sessionExpiresAt: IpdInstantSchema,
  purpose: z.literal(IPD_FAMILY_PURPOSE),
  /**
   * ICU IC-1 (#984, D9) — the doctor's word to the family for TODAY (IST), latest first: words only, never a live number.
   * Absent or null when no update was logged today (or the patient is not in an ICU).
   */
  todayUpdate: z.object({ summary: z.string(), at: IpdInstantSchema, mode: z.string() }).nullable().optional(),
});
export type IpdFamilyView = z.infer<typeof IpdFamilyViewSchema>;

export const IpdFamilyBillDetailsSchema = z.object({
  lines: z.array(z.object({ serviceDate: z.string(), serviceName: z.string(), qty: z.number().int(), amountPaise: z.number().int() })),
  totalPaise: z.number().int(),
});
export type IpdFamilyBillDetails = z.infer<typeof IpdFamilyBillDetailsSchema>;

export const IpdFamilyCallbackRequestSchema = z.strictObject({ token: IpdFamilyTokenSchema, text: z.string().trim().min(2).max(500) });

export const IPD_FAMILY_ROUTES = {
  panel: "/ipd/admissions/:admissionId/family",
  issue: "/ipd/admissions/:admissionId/family-link",
  revoke: "/ipd/family-links/:linkId/revoke",
  condition: "/ipd/admissions/:admissionId/condition",
  callbacks: "/ipd/family-callbacks",
  closeCallback: "/ipd/family-callbacks/:callbackId/close",
  /** Public (no staff session): POST, the token in the body, the session in an http-only cookie. */
  gate: "/ipd/family/gate",
  sendOtp: "/ipd/family/otp",
  verify: "/ipd/family/verify",
  view: "/ipd/family/view",
  billDetails: "/ipd/family/bill-details",
  callback: "/ipd/family/callback",
} as const;

/** OTP and session limits (spec decided): 3 sends an hour, 5 wrong codes an hour, 10-minute codes, 12-hour sessions. */
export const IPD_FAMILY_LIMITS = {
  otpSendsPerHour: 3,
  otpAttemptsPerHour: 5,
  otpTtlMinutes: 10,
  sessionHours: 12,
  dischargedHours: 24,
  callbacksPerDay: 5,
} as const;
