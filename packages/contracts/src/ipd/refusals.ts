/**
 * E0.2 (#714) — EVERY REFUSAL AN IPD INTENT CAN RETURN, WITH ITS RULE AND ITS FIX (spec §0A principle 5: no
 * dead ends). `rule` is one plain sentence a clerk or nurse can read; `fix` is the label of the button that
 * offers the way forward. A refusal carries data beside the code (the open admission, the next three beds)
 * in its detail; the words here never carry numbers.
 *
 * The contract test proves every code here is used by some intent and every intent's code is here.
 */
export const IPD_REFUSALS = {
  /* ═══ The patient and the admission ═══ */
  patient_not_found: { rule: "No patient has this id.", fix: "Search patient" },
  patient_deceased: { rule: "The patient is recorded as deceased.", fix: "Open patient record" },
  admission_not_found: { rule: "No admission has this id.", fix: "Search admissions" },
  admission_wrong_state: { rule: "The admission is not in a state that allows this act.", fix: "Open admission" },
  admission_already_open: { rule: "A patient may have only one open admission.", fix: "Open current admission" },
  incumbent_stay_open: { rule: "The patient is still admitted in the old system.", fix: "Finish old stay first" },
  advice_expired: { rule: "Admission advice is valid for 24 hours from its planned date.", fix: "Request again" },
  planned_date_past: { rule: "A planned admission cannot be booked for a past date.", fix: "Pick a date" },
  icu_needs_intensivist: { rule: "An ICU admission or move needs an intensivist's approval in the system.", fix: "Ask intensivist" },
  state_changed: { rule: "Someone changed this record after you opened it, so nothing was saved.", fix: "Reload" },
  not_treating_team: { rule: "Only the patient's treating or consulted team may do this.", fix: "Ask treating team" },
  not_treating_consultant: { rule: "Only the treating consultant may do this.", fix: "Ask consultant" },

  /* ═══ Beds (§4.1) ═══ */
  bed_not_found: { rule: "No bed has this id.", fix: "Open bed board" },
  bed_not_available: { rule: "The bed was just taken or is not free.", fix: "Pick another bed" },
  bed_gender_mismatch: { rule: "The bed's gender rule does not admit this patient.", fix: "Pick another bed" },
  bed_isolation_mismatch: { rule: "The bed does not support the isolation this patient needs.", fix: "Pick isolation bed" },
  bed_age_mismatch: { rule: "Paediatric beds are for children and adult beds for adults.", fix: "Pick another bed" },
  bed_class_mismatch: { rule: "The bed's class differs from the class asked for, and no upgrade or downgrade was flagged.", fix: "Flag upgrade or downgrade" },
  room_gender_unknown: { rule: "The shared room's first occupant has no recorded gender, so nobody is placed beside them.", fix: "Set room gender" },
  bed_not_incumbent: { rule: "Only a bed still held by the old system is released this way.", fix: "Open bed board" },
  bed_retired: { rule: "A retired bed cannot take a patient.", fix: "Pick another bed" },
  bed_reserved: { rule: "A reserved bed cannot be blocked or retired until its reservation ends.", fix: "Release reservation" },
  overflow_needs_duty_manager: { rule: "An overflow bed needs the duty manager's approval.", fix: "Ask duty manager" },
  bed_not_blocked: { rule: "The bed is not blocked.", fix: "Open bed board" },
  repair_ticket_open: { rule: "A bed with an open repair ticket opens only when the ticket is closed and a nurse confirms the fix.", fix: "Close the repair ticket" },
  bed_not_cleaning: { rule: "Only a bed waiting for cleaning can be marked clean.", fix: "Open bed board" },
  reservation_not_found: { rule: "No reservation has this id.", fix: "Open bed board" },
  reservation_ended: { rule: "The reservation has already lapsed or been released.", fix: "Reserve again" },

  /* ═══ Admission paperwork, bands and payer (§4.2) ═══ */
  consent_missing: { rule: "General consent must be signed before admission.", fix: "Take consent" },
  representative_reason_missing: { rule: "A representative signing for the patient must give the reason.", fix: "Add reason" },
  deposit_required: { rule: "This admission needs a deposit receipt or a recorded exemption.", fix: "Take deposit" },
  printer_offline: { rule: "The chosen printer is not answering.", fix: "Pick nearest printer" },
  band_already_printed: { rule: "A band is already printed for this admission.", fix: "Reprint band" },
  no_band_to_reprint: { rule: "There is no band to reprint for this admission.", fix: "Print band" },
  payer_change_needs_counselling: { rule: "A payer change after admission needs signed counselling.", fix: "Record counselling" },
  auth_out_of_order: { rule: "An authorisation entry must follow the one before it.", fix: "Open authorisation" },
  plan_missing: { rule: "The admission's payer, class and plan must be recorded first.", fix: "Record payer and plan" },
  downtime_serial_used: { rule: "This paper serial is already entered for another admission.", fix: "Open that admission" },

  /* ═══ Money (§2.3, §4.2, §4.3) ═══ */
  rate_missing: { rule: "A rate this estimate needs is not set on the active tariff.", fix: "Ask billing to set the rate" },
  deposit_not_refunded: { rule: "A cancelled admission's deposit must be refunded first.", fix: "Refund the deposit first" },
  scheme_patient_no_deposit: { rule: "Scheme patients pay nothing unless an approver marks a line non-covered.", fix: "Ask approver" },
  cash_limit_reached: { rule: "Cash from one payer is capped by law at under two lakh rupees a day.", fix: "Use another tender" },
  deposit_before_stabilisation: { rule: "No deposit is asked before an emergency patient is stabilised.", fix: "Defer deposit" },
  dues_need_approval: { rule: "Leaving with unpaid dues needs an approver and a signed undertaking.", fix: "Ask approver" },
  bill_changed: { rule: "The bill changed after you opened it.", fix: "Reload bill" },
  insurer_final_pending: { rule: "The insurer's final approval has not arrived.", fix: "Take undertaking" },

  /* ═══ Transfers and class (§4.4) ═══ */
  transfer_already_open: { rule: "The patient already has a transfer waiting for acceptance.", fix: "Open transfer" },
  transfer_not_found: { rule: "No transfer has this id.", fix: "Open ward board" },
  transfer_not_open: { rule: "The transfer is already accepted or cancelled.", fix: "Open ward board" },
  not_receiving_ward: { rule: "Only a nurse on the receiving ward can accept the handover.", fix: "Ask receiving nurse" },
  sender_cannot_accept: { rule: "The nurse who sent the patient cannot also accept them.", fix: "Ask receiving nurse" },
  swap_same_admission: { rule: "A swap needs two different patients.", fix: "Pick second patient" },
  class_unchanged: { rule: "The patient is already in this class.", fix: "Pick another class" },
  room_rent_cap_not_acknowledged: { rule: "The room-rent cap warning must be shown before an upgrade consent.", fix: "Show cap warning" },

  /* ═══ Nursing and tasks (§4.5) ═══ */
  assessment_already_recorded: { rule: "The nursing admission assessment is already recorded.", fix: "Add reassessment" },
  value_needs_confirm: { rule: "A value outside physiological limits must be confirmed before it is saved.", fix: "Confirm value" },
  time_in_future: { rule: "A time cannot be later than now.", fix: "Fix the time" },
  device_not_registered: { rule: "Only a registered device may send readings.", fix: "Register device" },
  task_not_found: { rule: "No task has this id.", fix: "Open tasks" },
  task_closed: { rule: "The task is already closed.", fix: "Open tasks" },
  not_task_assignee: { rule: "Only the task's assignee or a supervisor can close it.", fix: "Ask assignee" },
  assignee_unknown: { rule: "The task's assignee is not a known person, role or machine.", fix: "Pick assignee" },
  agent_open_limit: { rule: "An agent may hold at most three open proposals per patient.", fix: "Review open proposals" },

  /* ═══ Orders and doses (§4.5A, §4.6) ═══ */
  antibiotic_stop_date_required: { rule: "An antibiotic order needs a stop date.", fix: "Add stop date" },
  weight_required: { rule: "A weight-based dose needs the patient's weight first.", fix: "Record weight" },
  verbal_order_not_allowed: { rule: "Verbal orders are never taken for chemotherapy or high-alert drugs.", fix: "Ask doctor to order" },
  verbal_order_only: { rule: "A nurse may record an order only as a read-back verbal order in an emergency.", fix: "Ask doctor to order" },
  allergy_conflict: { rule: "The drug conflicts with a recorded allergy.", fix: "Review allergy" },
  duplicate_order: { rule: "An active order for the same drug and route already exists.", fix: "Open active order" },
  order_not_found: { rule: "No order has this id.", fix: "Open orders" },
  order_not_pending: { rule: "Only an order waiting for verification can be verified.", fix: "Open orders" },
  order_not_verified: { rule: "A drug is issued only after a pharmacist verifies the order.", fix: "Verify order" },
  order_not_active: { rule: "The order is stopped, cancelled or not yet issued.", fix: "Open orders" },
  stock_short: { rule: "There is not enough stock to issue this quantity.", fix: "Issue what is in stock" },
  wristband_scan_required: { rule: "A dose is recorded only after a wristband scan or a reasoned override.", fix: "Scan wristband" },
  wrong_patient_scanned: { rule: "The scanned wristband belongs to a different patient.", fix: "Scan again" },
  wrong_drug_scanned: { rule: "The scanned label does not match this order.", fix: "Scan again" },
  outside_due_window: { rule: "The dose is outside its due window.", fix: "Hold with reason" },
  second_nurse_required: { rule: "A high-alert drug needs a second nurse's PIN.", fix: "Ask second nurse" },
  second_nurse_same_person: { rule: "The second check must be a different nurse.", fix: "Ask second nurse" },
  prn_interval_not_met: { rule: "The minimum interval since the last PRN dose has not passed.", fix: "Wait or ask doctor" },
  prn_daily_max_reached: { rule: "The 24-hour maximum for this PRN drug is reached.", fix: "Ask doctor" },
  dose_already_recorded: { rule: "This dose already has a recorded outcome.", fix: "Open MAR" },
  give_expired: { rule: "An unfinished give expires after five minutes.", fix: "Scan again" },
  infusion_out_of_order: { rule: "An infusion event must follow the one before it.", fix: "Open infusion" },

  /* ═══ Discharge (§4.7) ═══ */
  department_not_yours: { rule: "A department confirms only its own charges.", fix: "Ask the department" },
  medicines_not_returned: { rule: "Pharmacy confirms only after unused medicines are returned.", fix: "Return medicines" },
  charges_unconfirmed: { rule: "Every department must confirm no pending charges first.", fix: "Chase departments" },
  draft_changed: { rule: "The summary draft changed after you opened it.", fix: "Reload draft" },
  medicine_not_on_active_order: { rule: "Every medicine in the summary must match an active order.", fix: "Fix medicines" },
  consultant_cosign_required: { rule: "A resident's entry needs the consultant's co-sign.", fix: "Send for co-sign" },
  summary_unsigned: { rule: "The discharge summary must be signed before the patient leaves.", fix: "Sign summary" },
  bill_unsettled: { rule: "The final bill must be settled or its dues approved.", fix: "Open final bill" },
  receiving_hospital_missing: { rule: "A transfer out needs a confirmed receiving hospital.", fix: "Add hospital" },
  gate_pass_not_found: { rule: "No gate pass has this code.", fix: "Call the desk" },
  gate_pass_void: { rule: "The gate pass was voided.", fix: "Call the desk" },
  gate_pass_used: { rule: "The gate pass was already scanned.", fix: "Call the desk" },
  police_intimation_required: { rule: "A medico-legal case needs a police intimation record.", fix: "Record intimation" },
} as const satisfies Record<string, { rule: string; fix: string }>;

export type IpdRefusalCode = keyof typeof IPD_REFUSALS;
