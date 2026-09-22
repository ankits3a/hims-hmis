import { ApiError } from "../lib/api";

/**
 * APPROVALS-UX — WHAT EACH REQUEST IS ABOUT, IN WORDS THE PERSON DECIDING IT USES.
 *
 * The inbox used to print `typeKey` (`billing_discount`) and `subjectType · subjectId` (a ULID). The
 * owner — who decides discounts, refunds and merges — said the screen confused him, and those two
 * columns are most of why: nothing on the row said what was being asked.
 *
 * Every approval type the server registers is listed here (measured 2026-09-19:
 * `grep -rn 'typeKey' apps/core/src/modules/*\/approval-types.ts`). Each has three strings in the
 * locale files under `inbox.kinds.<typeKey>`:
 *
 *   · `label`   — two or three words, for the tag and the confirmation line;
 *   · `ask`     — the request as a sentence, with the amount and the patient where the type has them;
 *   · `explain` — one line on what saying yes DOES.
 *
 * `needs` names the values `ask` interpolates. A row that lacks one (a discount filed without a
 * patient, say) falls back to the label rather than printing a sentence with a hole in it.
 * A type this map does not know still renders — as "Approval request" with its raw key shown small —
 * because the engine is generic and a new module can register a type before anyone writes its words.
 */
export type Need = "amount" | "patient";

export const APPROVAL_KINDS = {
  billing_discount: ["amount", "patient"],
  billing_clearance_discount: ["amount", "patient"],
  billing_credit_extension: ["patient"],
  billing_refund: ["amount", "patient"],
  billing_variance: [],
  lab_release_unpaid: ["amount", "patient"],
  patient_merge: ["patient"],
  patient_unmerge: ["patient"],
  materials_stock_adjustment: [],
  materials_near_expiry_acceptance: [],
  materials_vendor_bank_change: [],
  imaging_definition_publish: [],
  ot_definition_publish: [],
  ot_deposit_exception: ["amount", "patient"],
  tariff_revision: [],
  membership_grace_honor: ["patient"],
} as const satisfies Record<string, readonly Need[]>;

export type KnownKind = keyof typeof APPROVAL_KINDS;

export function isKnownKind(typeKey: string): typeKey is KnownKind {
  return Object.prototype.hasOwnProperty.call(APPROVAL_KINDS, typeKey);
}

/** The patient as the server named them for THIS reader (kernel/approvals/people.ts). */
export type ApprovalPatient = {
  id: string;
  uhid: string;
  name: string | null;
  alias: string | null;
  restricted: boolean;
};

/**
 * The name to print. The SERVER decided whether this reader may see a sealed patient's legal name —
 * a restricted row arrives with `name: null` and the alias — so this only picks the field it was
 * given. The UHID is the last resort, never a dash: a row nobody can identify cannot be decided.
 */
export function patientName(p: ApprovalPatient): string {
  const shown = p.restricted ? p.alias : p.name;
  return shown === null || shown.trim() === "" || shown === "—" ? p.uhid : shown;
}

/** "12 min ago" / "3 h ago" / "yesterday" / "4 days ago", as an i18n key and its count. */
export function ageOf(iso: string, now: number = Date.now()): { key: string; count: number } {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return { key: "inbox.age.justNow", count: 0 };
  if (minutes < 60) return { key: "inbox.age.minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "inbox.age.hours", count: hours };
  if (hours < 48) return { key: "inbox.age.yesterday", count: 1 };
  return { key: "inbox.age.days", count: Math.floor(hours / 24) };
}

/**
 * A refused decision, in plain words. The server's messages are engineering prose
 * ("segregation-of-duties violation: requester_approver"), so the STATUS decides the sentence and the
 * message is consulted only to tell two 403s and two 409s apart — never shown.
 */
export function decisionErrorKey(e: unknown): string {
  if (!(e instanceof ApiError)) return "inbox.errors.network";
  const body = e.body as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message : "";
  if (e.status === 403) return message.includes("requester_approver") ? "inbox.errors.ownRequest" : "inbox.errors.notAllowed";
  if (e.status === 409) return /already|concurrently/.test(message) ? "inbox.errors.alreadyDecided" : "inbox.errors.wrongRole";
  if (e.status === 404) return "inbox.errors.gone";
  if (e.status === 400) return "inbox.errors.noteRequired";
  return "inbox.errors.network";
}
