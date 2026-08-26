export type OpdErrorCode =
  | "user_actor_required" | "opd_not_configured" | "opd_config_invalid" | "invalid_config"
  | "unknown_department" | "department_inactive" | "duplicate_department_code"
  | "unknown_room" | "duplicate_room_code"
  | "unknown_doctor" | "doctor_inactive" | "unknown_user" | "user_already_doctor" | "doctor_department_mismatch"
  | "not_a_doctor" | "not_your_patient"
  | "invalid_schedule" | "unknown_schedule" | "unknown_leave" | "leave_not_scheduled" | "invalid_leave_range"
  | "patient_not_found"
  | "invalid_slot" | "slot_taken" | "slot_in_past" | "doctor_on_leave" | "unknown_appointment"
  | "appointment_state_conflict" | "appointment_not_today"
  | "unknown_encounter" | "encounter_state_conflict" | "consult_gate_refused" | "unknown_session" | "session_closed" | "doctor_out"
  | "call_conflict" | "unknown_queue_entry" | "queue_entry_state_conflict" | "invalid_transfer"
  | "invalid_vitals" | "vitals_incomplete"
  | "invalid_follow_up_days" | "extension_cap_reached" | "reason_required"
  | "allergy_conflict" | "override_reason_required" | "empty_prescription" | "unknown_prescription"
  // PLAN 16a T5 — the hard-warning grammar EXTENDS rather than forks (DD3): these two carry their
  // hits in `detail` and are cleared by an override with a reason, exactly as `allergy_conflict` is.
  // A severe interaction, and the same moiety twice on one slip under two brand names.
  | "interaction_conflict" | "duplicate_salt_conflict";

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
