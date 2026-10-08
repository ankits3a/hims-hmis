export type OpdErrorCode =
  | "user_actor_required" | "opd_not_configured" | "opd_config_invalid" | "invalid_config"
  | "unknown_department" | "department_inactive" | "duplicate_department_code"
  | "unknown_room" | "duplicate_room_code"
  | "unknown_doctor" | "doctor_inactive" | "unknown_user" | "user_already_doctor" | "doctor_department_mismatch"
  // FD-29 — the doctor id the prescription prints. Both fall through `opdStatus` to 400, which
  // is right for each: a blank or over-long id is a malformed request, and the exhausted case
  // is reached only at ten thousand doctors, where the caller's answer is to supply one.
  | "invalid_doctor_code" | "doctor_code_exhausted"
  | "not_a_doctor" | "not_your_patient"
  | "invalid_schedule" | "unknown_schedule" | "unknown_leave" | "leave_not_scheduled" | "invalid_leave_range"
  | "patient_not_found" | "duplicate_suspected" | "registration_not_permitted"
  | "invalid_slot" | "slot_taken" | "slot_in_past" | "doctor_on_leave" | "unknown_appointment"
  | "appointment_state_conflict" | "appointment_not_today"
  | "unknown_encounter" | "encounter_state_conflict" | "edit_lease_state_conflict" | "consult_gate_refused" | "unknown_session" | "session_closed" | "doctor_out"
  // The co-pilot's syndrome key. A key the knowledge file does not hold is a CLIENT error with a
  // domain name, not a 500 — the screen sends what a previous build's suggest route gave it.
  | "unknown_syndrome"
  // The advice library. `unknown_advice_template` maps to 404 by the `unknown_` rule and is
  // deliberately also what a doctor gets for another doctor's row: not-found and not-yours must
  // answer identically, or the code becomes a way to probe whose template an id belongs to.
  | "unknown_advice_template" | "advice_template_incomplete" | "advice_keyword_invalid"
  // Decision 0051 — the owner's list of learned medicine nicknames; 404 by the `unknown_` rule.
  | "unknown_nickname"
  | "unknown_complaint_concept" | "complaint_term_invalid" | "complaint_term_already_mapped"
  | "call_conflict" | "unknown_queue_entry" | "queue_entry_state_conflict" | "invalid_transfer"
  | "invalid_vitals" | "vitals_incomplete"
  // VD-1 T2 — the sanity gates. `vitals_gate` carries `detail.gates[]` (key, kind, value, and a
  // suggestion where one exists) and is CLEARED BY A PER-KEY OVERRIDE, the grammar 16a T5's
  // hard warnings established: a refusal a named human can pass through, never a lockout.
  // `carried_value_locked` is its sibling for D7's carried values, which unlock with a REASON
  // from a preset list rather than a bare override — the difference is that a gate asks "is this
  // number real" and a lock asks "why is it changing".
  | "vitals_gate" | "carried_value_locked"
  // VD-1 T3 — the danger protocol. `escalation_not_warranted` is the one that matters: the BAY
  // asks for a bump and the SERVER decides, by re-evaluating the reading against the band. A
  // route that bumped on the caller's say-so would let anybody move anybody to class 0.
  | "escalation_not_warranted" | "escalation_state_conflict" | "escalation_window_closed"
  // VD-1 T4 — a rest with no recall time is a forgotten patient, so it is refused rather than
  // defaulted. The bench's other refusals reuse `unknown_queue_entry`.
  | "invalid_bench_state"
  // VD-1 T5 / D2 — an amendment names the row it replaces. `unknown_vitals` doubles as the
  // read-gate's refusal (an encounter id is not a capability), so a chart the actor may not see
  // answers exactly as one that does not exist.
  | "unknown_vitals" | "vitals_state_conflict"
  | "invalid_follow_up_days" | "extension_cap_reached" | "reason_required"
  | "allergy_conflict" | "override_reason_required" | "empty_prescription" | "unknown_prescription"
  // FD-30 — the transcription draft (owner ruling 2026-09-12, draft-then-confirm). `unknown_draft`
  // rides the `unknown_*` rule to 404 deliberately: a doctor tapping issue on a slip a colleague
  // just discarded is asking for something that is no longer there, not sending a bad request.
  | "unknown_draft"
  // FD-31 — 403 through `opdStatus`'s own rule, like `registration_not_permitted` beside it: the
  // request is well formed and the account simply may not do this.
  | "transcription_not_permitted"
  // PLAN 16a T5 — the hard-warning grammar EXTENDS rather than forks (DD3): these two carry their
  // hits in `detail` and are cleared by an override with a reason, exactly as `allergy_conflict` is.
  // A severe interaction, and the same moiety twice on one slip under two brand names.
  | "interaction_conflict" | "duplicate_salt_conflict" | "drug_disease_conflict"
  // 17d T4 — a SECOND open laboratory walk-in for one patient on one day. Scoped to the lab door,
  // never to `openVisitInTx`: OPD legitimately opens a second visit the same day, and the lab is
  // the case where it is always a mistake — a walk-in is one draw, and tests remembered on the way
  // out are an add-on to the order that exists.
  | "lab_walkin_already_open"
  // Consult engine (sections.ts): a section this visit's department does not show, or a body its schema refuses.
  | "section_not_in_profile" | "invalid_section_body"
  // Board "Ophthal" — the glasses print refuses a prescription with no power in it: a sheet of blank
  // lens cells handed to an optician is not a prescription. 400 through `opdStatus`'s default.
  | "glasses_rx_empty"
  // The consult layout (layout.ts): a body the one validator refuses, and a save that lost a race
  // for its version number (409 by the `_state_conflict` rule — re-read, then save again).
  | "invalid_layout" | "layout_state_conflict"
  // Owner 2026-10-05 — "Wrong department — move patient". A move to the department the visit is
  // already in is the same-department "change the doctor" (400); a visit with a bill that still
  // stands is a credit note first (409 by the `_state_conflict` rule).
  | "move_same_department" | "visit_billed_state_conflict"
  // 2026-10-06 — a completion that would drop prescription lines written and never issued
  // (production 2026-09-23). 409 by the `_state_conflict` rule: issue or clear them, then complete.
  | "rx_unissued_state_conflict"
  // Owner ruling 2026-10-06 — consulted on paper. `paper_consult_not_permitted` is an authorisation
  // answer (403, beside `transcription_not_permitted`); the `_state_conflict` pair is 409 by rule:
  // a visit the paper road cannot close or reopen as it stands, and a visit whose prescription the
  // doctor has already issued on the screen (the desk must not type over it).
  | "paper_consult_not_permitted" | "paper_consult_state_conflict" | "doctor_rx_exists_state_conflict"
  // The doctor's own screen acting on a visit a desk has since closed from paper (409): a sentence, not a fault.
  | "closed_on_paper_state_conflict"
  // Owner 2026-10-07 — the guardian came with the reports and the patient did not. Only a RETURNING
  // patient (revisit or renewal) may skip the bay this way (409, listed in `OPD_CONFLICT_CODES`: the request is well formed, the visit
  // is the wrong kind); an account holding neither the bay's nor the desk's grant is refused 403; a
  // relation outside the fixed list or an over-long name is a malformed request (400).
  | "patient_absent_returning_only" | "patient_absent_not_permitted" | "invalid_patient_absent"
  // PHONE CONSULT (decision 0048) — a doctor's sets and the hospital's starter sets (`rx-sets.ts`).
  // Not-found and not-yours answer identically (404). A controlled medicine in a set is a malformed
  // request (400); signing or editing a department's starter set without being its unit head is 403.
  | "unknown_rx_set" | "invalid_rx_set" | "rx_set_controlled" | "rx_set_not_permitted"
  // The spoken note (`consult-voice.ts`). Voice being off, unconfigured or over the day's cap is a
  // STATE (409, `detail.why`), a clip too long or empty is a malformed request (400).
  | "voice_unavailable_state_conflict" | "invalid_voice_clip" | "unknown_voice_note" | "voice_provider_failed";

export class OpdError extends Error {
  constructor(
    readonly code: OpdErrorCode,
    message?: string,
    readonly detail?: unknown, // e.g. allergy matches, missing vitals — carried to the HTTP body
  ) {
    super(message ?? code);
    this.name = "OpdError";
  }
}
