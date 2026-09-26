/**
 * PLAN 16c — the pharmacy module's refusal vocabulary. Closed list, `LAB_ERROR_CODES`' shape:
 * a controller maps a code to a status, a screen renders it as a sentence, and a test names it.
 * Later tasks APPEND under their own heading; nothing is renamed.
 */
export const PHARMACY_ERROR_CODES = [
  "permission_denied",
  // ── sale items and the price rule (T2) ──
  "unknown_item",
  "not_a_drug",
  "sale_item_exists",
  "unknown_sale_item",
  "sale_item_inactive",
  "price_unknown",
  "gst_slab_unknown",
  // ── queue, claim, verify (T3) ──
  "unknown_dispense",
  "unknown_line",
  "unknown_prescription",
  "prescription_superseded",
  "dispense_not_in_state",
  "line_not_open",
  "schedule_x_not_dispensed_here",
  "unresolved_medicine",
  "substitution_not_allowed",
  "consent_required",
  "allergy_block",
  "interaction_block",
  "qty_required",
  "store_missing",
  "not_found",
  // ── pick, bill, hand over (T4) ──
  "scheduled_needs_pharmacist",
  "identity_confirmation_required",
  "nothing_to_dispense",
  "batch_not_saleable",
  "short_stock",
  "fefo_override_unavailable",
  "identity_mismatch",
  // ── the close review (16c §8.5 pass 1): money before the drug, D8 ──
  "invoice_not_settled",
  // ── the close review, second contract sweep: expired stock ──
  "batch_expired",
  /**
   * ── FD-31, owner ruling 2026-09-12 ──
   *
   * *"The pharmacist will cross confirm the prescription slip (either the photo capture of
   * prescription or physical prescription slip) before generating the medicine bill."*
   *
   * 409 and not 403: the account is allowed to bill, the DISPENSE is not ready to be billed. It is
   * the same animal as `invoice_not_settled` two lines up — a state conflict the pharmacist clears
   * by doing the thing, not an authority they lack.
   */
  "slip_not_confirmed",
  /**
   * THE SAME FACT AS `batch_expired`, A DIFFERENT REMEDY — which is why it is a different code.
   *
   * `batch_expired` is raised at the PICK, where the pharmacist NAMED a carton and can name
   * another; its string says "Choose another batch" and there that is true. This one is raised at
   * HAND OVER, on a line already picked, priced, billed and PAID. There is no batch to choose, the
   * money has moved, and the screen offers no such control. Reusing the code would hand the
   * pharmacist an impossible instruction at the one moment they are facing a patient.
   */
  "batch_expired_before_collection",
  // ── P2: the register of pharmacists (Pharmacy Act 1948 §42) ──
  /** The acting login has no current state council registration on file. */
  "pharmacist_not_registered",
  /** A registration is filed, and ended, by someone other than its holder. */
  "self_registration",
  "invalid_registration",
  "registration_expired",
  "registration_in_use",
  "registration_ended",
  "not_a_pharmacist_role",
  // ── P5: a paid dispense that cannot be collected ──
  /** An act whose record a reviewer will read, attempted without saying why. */
  "reason_required",
  // ── P6: sales returns (doc 16 O-7) ──
  "return_window_closed",
  "return_not_sealed",
  /** A cold-chain, frozen or narcotic item: its storage after it left the counter cannot be vouched for. */
  "return_not_accepted",
  "return_cut_strip",
  "return_short_expiry",
  "return_exceeds_dispensed",
  // ── P7 ──
  "invalid_day",
  // ── P9 ──
  "invalid_range",
  // ── P13 ──
  "scan_unknown",
  "scan_wrong_item",
  "scan_batch_unknown",
  "scan_batch_mismatch",
  // ── P19: walk-in retail sales ──
  /** No Form 20/21 licence is recorded for the retail store (Drugs and Cosmetics Act §18(c)). */
  "retail_licence_missing",
  /** The recorded licence does not cover today. */
  "retail_licence_lapsed",
  "invalid_retail_licence",
  "retail_store_missing",
  /** A Schedule H or H1 line with no outside prescription captured (r.65(9)). */
  "prescription_required",
  "invalid_prescription",
  "registration_not_permitted",
  "duplicate_suspected",
  "unknown_retail_sale",
  /**
   * The prescription photo could not be written (the kernel document store is not writable). The
   * sale is refused whole: a Schedule H sale without its prescription on file is not a sale.
   */
  "document_store_unavailable",
  // ── P20: paper dispenses entered after an outage ──
  /** Not a downtime kit's receipt sheet, or a serial the kit never reserved. */
  "sheet_invalid",
  "sheet_already_entered",
  /** The time on the sheet is in the future, or before the kit was printed. */
  "invalid_dispense_time",
  /** The time on the sheet fell while the hospital was not in downtime or degraded mode. */
  "not_in_downtime",
  "backfill_window_closed",
  /** A paper line must name the batch written on the sheet. */
  "batch_required",
  /** The person named as handing the medicine over is not pharmacy staff. */
  "unknown_pharmacist",
  // ── PD-5b: a line the pharmacist read, and the two books only a new moiety can trip ──
  /** The medicine chosen for a line nobody could place repeats a moiety already on the prescription. */
  "duplicate_block",
  /** A diagnosis the patient carries rules the medicine out and no prescriber ruled on it (a reading, or a code added after issue). */
  "drug_disease_block",
  // ── PD-D18: where the drug is ──
  /** A shelf label longer than the line can print (24 characters). */
  "invalid_shelf_location",
  // ── PD-9: the prescriber authorises what the check would refuse ──
  /** The check raises no such refusal on that line — there is nothing for the doctor to authorise. */
  "authorisation_not_needed",
  /** The request was already authorised or declined. */
  "authorisation_not_pending",
  "unknown_authorisation",
  // ── P1 (parity plan 2026-09-24): the short book ──
  /** A drug name under two characters, or a quantity that is not a positive whole number. */
  "invalid_short_book_entry",
  "unknown_short_book_entry",
  /** The entry was already resolved (ordered, received or dismissed). */
  "short_book_resolved",
  // ── P1: the desk prints ──
  /** The paper asked for does not exist yet: no bill before the money, no label before the pick. */
  "nothing_to_print",
  // ── P5 (parity plan): the office's reports ──
  /** The GSTR-2B file is not the portal's JSON, nor a CSV with a GSTIN, invoice number, date and taxable value. */
  "gst_statement_unreadable",
  /** The Tally export before the accountant has confirmed the ledger names once. */
  "tally_ledgers_unconfirmed",
  /** A Tally ledger name left empty or longer than 100 characters. */
  "invalid_tally_ledgers",
  /** A voucher would not balance: a defect, and the whole file is refused. */
  "tally_unbalanced",
  // ── PHARMACY P6 — narcotic, psychotropic and Schedule X drugs under the law (`controlled.ts`) ──
  /** A narcotic drug (NDPS) line without a current RMI recognition (Form 3G) — the refusal names the licence. */
  "ndps_not_dispensed_here",
  /** A controlled-drug licence out of shape: a number, form, authority, holder or date missing, or recognition beyond three years. */
  "invalid_controlled_licence",
  /** The controlled-drug cabinet `PHARM-NDPS` does not exist (seed:pharmacy creates it). */
  "controlled_store_missing",
  /** A controlled medicine whose stock item is not kept in the narcotic cabinet (its storage class is not `narcotic`). */
  "controlled_item_not_in_cabinet",
  /** The person holding the cabinet lacks `pharmacy.ndps.custody`. */
  "custody_not_permitted",
  /** The witness's username and PIN did not match an active member of staff. */
  "witness_not_confirmed",
  /** Too many wrong PINs for that witness: wait, as at the shared-terminal switch. */
  "witness_throttled",
  /** The witness lacks `pharmacy.ndps.witness`. */
  "witness_not_permitted",
  /** The holder named as the witness: one person cannot be two keys. */
  "custody_same_person",
  /** A controlled line's prescription lacks what the law asks: the prescriber's registration number, the patient's address, a stated quantity. */
  "controlled_prescription_incomplete",
  /** More than the prescription states (dose × frequency × days). */
  "controlled_qty_exceeds_prescribed",
  /** The pharmacy's retained copy of the prescription is not on file (Schedule X's duplicate, D&C r.65(9)(a)). */
  "retained_prescription_required",
  /** Who took the controlled drug, and the identity they showed, is not recorded. */
  "collected_by_required",
  /** Schedule X: the pharmacist has not endorsed the prescription with the seller's name, address and date (r.65(11)(c)). */
  "endorsement_required",
  /** A narcotic line whose prescriber is not on the list of doctors trained under NDPS Rules r.2(ib). */
  "end_prescriber_not_trained",
  /** A trained-prescriber entry out of shape, a doctor already on the list, or not a doctor here. */
  "invalid_end_prescriber",
  /** No such current trained-prescriber entry. */
  "unknown_end_prescriber",
  /** A witnessed act at the cabinet out of shape: not the cabinet's, the Controller's nominee or approval missing. */
  "controlled_act_invalid",
  // ── PHARMACY P6 (hygiene) — item merge (`item-merge.ts`) ──
  /** A new use of an item merged into another (register it for sale, re-enable it, give it a shelf): the survivor is used instead. */
  "item_merged",
] as const;

export type PharmacyErrorCode = (typeof PHARMACY_ERROR_CODES)[number];

export class PharmacyError extends Error {
  constructor(
    readonly code: PharmacyErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `pharmacy refused: ${code}`);
    this.name = "PharmacyError";
  }
}

const STATUS: Record<PharmacyErrorCode, number> = {
  permission_denied: 403,
  unknown_item: 404,
  not_a_drug: 409,
  sale_item_exists: 409,
  unknown_sale_item: 404,
  sale_item_inactive: 409,
  price_unknown: 409,
  gst_slab_unknown: 409,
  unknown_dispense: 404,
  unknown_line: 404,
  unknown_prescription: 404,
  prescription_superseded: 409,
  dispense_not_in_state: 409,
  line_not_open: 409,
  schedule_x_not_dispensed_here: 409,
  unresolved_medicine: 409,
  substitution_not_allowed: 409,
  consent_required: 409,
  allergy_block: 409,
  interaction_block: 409,
  qty_required: 400,
  store_missing: 409,
  not_found: 404,
  scheduled_needs_pharmacist: 403,
  identity_confirmation_required: 409,
  nothing_to_dispense: 409,
  batch_not_saleable: 409,
  short_stock: 409,
  fefo_override_unavailable: 409,
  identity_mismatch: 409,
  invoice_not_settled: 409,
  batch_expired: 409,
  slip_not_confirmed: 409,
  batch_expired_before_collection: 409,
  pharmacist_not_registered: 403,
  self_registration: 403,
  invalid_registration: 400,
  registration_expired: 409,
  registration_in_use: 409,
  registration_ended: 409,
  not_a_pharmacist_role: 409,
  reason_required: 400,
  return_window_closed: 409,
  return_not_sealed: 409,
  return_not_accepted: 409,
  return_cut_strip: 409,
  return_short_expiry: 409,
  return_exceeds_dispensed: 409,
  invalid_day: 400,
  invalid_range: 400,
  scan_unknown: 409,
  scan_wrong_item: 409,
  scan_batch_unknown: 409,
  scan_batch_mismatch: 409,
  retail_licence_missing: 409,
  retail_licence_lapsed: 409,
  invalid_retail_licence: 400,
  retail_store_missing: 409,
  prescription_required: 409,
  invalid_prescription: 400,
  registration_not_permitted: 403,
  duplicate_suspected: 409,
  unknown_retail_sale: 404,
  document_store_unavailable: 503,
  sheet_invalid: 409,
  sheet_already_entered: 409,
  invalid_dispense_time: 400,
  not_in_downtime: 409,
  backfill_window_closed: 409,
  batch_required: 400,
  unknown_pharmacist: 409,
  duplicate_block: 409,
  drug_disease_block: 409,
  invalid_shelf_location: 400,
  authorisation_not_needed: 409,
  authorisation_not_pending: 409,
  unknown_authorisation: 404,
  invalid_short_book_entry: 400,
  unknown_short_book_entry: 404,
  short_book_resolved: 409,
  nothing_to_print: 409,
  gst_statement_unreadable: 400,
  tally_ledgers_unconfirmed: 409,
  invalid_tally_ledgers: 400,
  tally_unbalanced: 500,
  ndps_not_dispensed_here: 409,
  invalid_controlled_licence: 400,
  controlled_store_missing: 409,
  controlled_item_not_in_cabinet: 409,
  custody_not_permitted: 403,
  witness_not_confirmed: 403,
  witness_throttled: 429,
  witness_not_permitted: 403,
  custody_same_person: 409,
  controlled_prescription_incomplete: 409,
  controlled_qty_exceeds_prescribed: 409,
  retained_prescription_required: 409,
  collected_by_required: 409,
  endorsement_required: 409,
  end_prescriber_not_trained: 409,
  invalid_end_prescriber: 400,
  unknown_end_prescriber: 404,
  controlled_act_invalid: 409,
  item_merged: 409,
};

export function pharmacyHttpStatus(code: PharmacyErrorCode): number {
  return STATUS[code];
}
