/**
 * ER lane 1 (#808) — EVERY REFUSAL AN ER INTENT CAN RETURN, WITH ITS RULE AND ITS FIX (spec §0: no dead ends). `rule`
 * is one plain sentence a desk clerk or a casualty nurse can read; `fix` is the label of the button that offers the way
 * forward. Data (the open episode, the ward the patient is admitted to) rides in the refusal's `detail`; the words here
 * never carry numbers or names.
 *
 * The contract test proves every code here is used by some intent and every intent's code is here. Later lanes add
 * their own codes to this one register.
 */
export const ER_REFUSALS = {
  /* ═══ The patient and the episode ═══ */
  patient_not_found: { rule: "No patient has this id.", fix: "Search patient" },
  patient_deceased: { rule: "The patient is recorded as deceased.", fix: "Open patient record" },
  patient_admitted: { rule: "The patient is admitted on a ward; the ward team looks after them.", fix: "Call the ward team" },
  episode_not_found: { rule: "No emergency episode has this id.", fix: "Open ER desk" },
  episode_wrong_state: { rule: "The emergency episode is not in a state that allows this act.", fix: "Open episode" },
  episode_already_open: { rule: "A patient may have only one open emergency episode.", fix: "Open current episode" },
  state_changed: { rule: "Someone changed this record after you opened it, so nothing was saved.", fix: "Reload" },
  registration_not_ready: { rule: "Patient registration is not set up yet, so no UHID can be issued.", fix: "Ask the administrator" },

  /* ═══ Arrival ═══ */
  time_in_future: { rule: "A time cannot be later than now.", fix: "Fix the time" },
  arrival_too_old: { rule: "An arrival more than a day ago is entered from its paper ER sheet.", fix: "Enter the paper serial" },
  paper_serial_used: { rule: "This paper ER sheet serial is already entered for another episode.", fix: "Open that episode" },
  pre_alert_not_found: { rule: "No pre-alert has this id.", fix: "Open ER desk" },
  pre_alert_closed: { rule: "The pre-alert has already arrived, lapsed or been cancelled.", fix: "Register without it" },
  examined_before_arrival: { rule: "The examination cannot be earlier than the arrival.", fix: "Fix the time" },

  /* ═══ Triage, bays and the doctor (lane 2) ═══ */
  down_triage_needs_reason: { rule: "A level less urgent than the proposal or the last level needs a reason.", fix: "Add reason" },
  department_not_found: { rule: "No department has this code.", fix: "Pick department" },
  already_in_bay: { rule: "The patient is already in a bay.", fix: "Move bay" },
  not_in_bay: { rule: "The patient is not in a bay yet.", fix: "Place in bay" },
  same_bay: { rule: "The patient is already in this bay.", fix: "Pick another bay" },
  bay_not_found: { rule: "No bay has this id.", fix: "Open ER board" },
  bay_not_emergency: { rule: "Only an emergency-class bed is an ER bay.", fix: "Pick an ER bay" },
  bay_not_available: { rule: "The bay was just taken or is not free.", fix: "Pick another bay" },
  not_a_doctor: { rule: "Only a doctor can be the ER doctor of record.", fix: "Pick a doctor" },

  /* ═══ Care (lane 3) ═══ */
  note_not_found: { rule: "No ER note has this id.", fix: "Open episode" },
  note_signed: { rule: "The note is already signed.", fix: "Add an addendum" },
  cosign_own_note: { rule: "A note is co-signed by someone other than its author.", fix: "Ask a senior" },
  cosigner_not_senior: { rule: "A resident's note is co-signed by a senior doctor, not another resident.", fix: "Ask a senior" },
  item_not_stocked: { rule: "This item is not stocked in the ER store.", fix: "Pick another item" },
  stock_short: { rule: "The ER store does not hold enough of this item.", fix: "Ask pharmacy" },
  allergy_override_needed: { rule: "A recorded allergy matches this drug: say why it goes ahead.", fix: "Give override reason" },
  issue_not_found: { rule: "No ER medicine issue has this id.", fix: "Open episode" },
  dose_already_recorded: { rule: "This issue's dose is already recorded.", fix: "Open the medication record" },
  second_check_needed: { rule: "A high-alert drug is given only after a second person checks it.", fix: "Second check" },
  second_check_failed: { rule: "The second person's username or PIN did not match.", fix: "Try again" },
  second_checker_same: { rule: "The second check is made by a different person.", fix: "Ask a colleague" },
  verbal_not_pending: { rule: "There is no unsigned verbal order on this issue.", fix: "Open the medication record" },
  not_ordering_doctor: { rule: "Only the doctor who gave the verbal order signs it.", fix: "Ask that doctor" },
  consent_not_found: { rule: "No consent with this id is recorded for this patient.", fix: "Record consent" },
  consent_witness_needed: { rule: "A paper consent names its witness, and a guardian or representative is named.", fix: "Add witness" },
  emergency_needs_second_doctor: { rule: "Emergency treatment without consent needs a second doctor's concurrence.", fix: "Name second doctor" },
  call_not_found: { rule: "No specialty call has this id.", fix: "Open episode" },
  call_closed: { rule: "The specialty call is already answered and seen.", fix: "Open episode" },
  call_already_open: { rule: "A call to this department is already waiting for this patient.", fix: "Open the call" },
  already_stabilised: { rule: "The patient is already recorded as stabilised.", fix: "Open episode" },

  /* ═══ The medico-legal case (lane 4) ═══ */
  mlc_not_found: { rule: "No medico-legal case has this id.", fix: "Open MLC desk" },
  mlc_already_open: { rule: "This emergency episode already has a medico-legal case; a change is an addendum.", fix: "Add an addendum" },
  intimation_recorded: { rule: "The police intimation for this case is already recorded.", fix: "Add an addendum" },
  mlc_countersigned: { rule: "The case is already countersigned.", fix: "Open MLC desk" },
  countersign_own_mlc: { rule: "A case is countersigned by a doctor other than the one who opened it.", fix: "Ask a senior" },
  intimation_before_arrival: { rule: "A police intimation is never dated before the patient arrived.", fix: "Enter the real time" },
  seal_already_collected: { rule: "A seal is collected once; later links store or hand it over.", fix: "Pick the next step" },
  seal_not_collected: { rule: "Evidence is stored or handed over only after it is collected under this seal.", fix: "Record collection" },
  seal_already_handed_over: { rule: "The evidence under this seal is already handed over.", fix: "Open MLC desk" },

  /* ═══ The band ═══ */
  printer_offline: { rule: "The chosen printer is not answering.", fix: "Pick nearest printer" },
  band_already_printed: { rule: "A band is already printed for this episode.", fix: "Reprint band" },
  no_band_to_reprint: { rule: "There is no band to reprint for this episode.", fix: "Print band" },

  /* ═══ Identity ═══ */
  not_unidentified: { rule: "Only an unidentified patient's record is linked to a true record.", fix: "Open patient record" },
  same_patient: { rule: "The true record must be a different record.", fix: "Pick the true record" },
  true_record_unidentified: { rule: "The true record is itself an unidentified record.", fix: "Pick the true record" },
  merge_already_requested: { rule: "A merge for this record is already waiting for approval.", fix: "Open merge requests" },
} as const satisfies Record<string, { rule: string; fix: string }>;

export type ErRefusalCode = keyof typeof ER_REFUSALS;
export const ER_REFUSAL_CODES = Object.keys(ER_REFUSALS) as ErRefusalCode[];

/** The body of a refused ER request (HTTP 404 for `*_not_found`, 409 otherwise). */
export type ErRefusalBody = {
  statusCode: number;
  code: string;
  message: string;
  rule: string;
  fix: string;
  detail?: Record<string, unknown>;
};
