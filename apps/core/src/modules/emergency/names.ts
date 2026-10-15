/**
 * ER lane 1 (#808) — the emergency module's permission strings, in a file of their own so the manifest and the intents
 * import them without a cycle (the IPD `permissions.ts` precedent). Meanings are in `manifest.ts`.
 */
export const ER_BOARD_VIEW = "er.board.view";
export const ER_ARRIVAL_REGISTER = "er.arrival.register";
/**
 * ER review (2026-10-15, DECIDED) — the wall display's own string: a kiosk or wall screen reads the board in wall mode
 * (initials or the alias, no UHID, no complaint, no police chip) and nothing else.
 */
export const ER_BOARD_WALL = "er.board.wall";
/**
 * `link_identity` files a `patient_merge` request — the same act as the merge screen's "Request merge" — so it asks the
 * same permission the patients module's route asks. DECIDED (lane 1): no new ER string for it.
 */
export const ER_IDENTITY_LINK = "patients.merge";
/**
 * ER lane 2 (#809) — triage, re-triage, vitals, bays and the ER doctor of record: the casualty nurse's and the doctor's
 * clinical acts (spec §4.2: "triage by a nurse or doctor with the er.triage grant"). DECIDED: one string for the five
 * acts; no money behind any of them.
 */
export const ER_TRIAGE = "er.triage";
/**
 * ER lane 3 (#810) — care: notes, the ordering door, the ER issue and the medication record, procedures, consent,
 * specialty calls and "stabilised". Doctor-only acts (orders, emergency consent, stabilised, co-sign, answering a call,
 * signing a verbal order) also check the actor holds the `doctor` role; nothing here names money.
 */
export const ER_CARE = "er.care";
/**
 * ER lane 4 (#811) — the medico-legal case: open it (a doctor), add an addendum (a doctor), record the police intimation,
 * countersign (a senior doctor), list belongings and log the evidence chain (two staff), and read the MLC desk. DECIDED:
 * one string; the doctor-only acts also check the doctor role. Nothing behind it names money.
 */
export const ER_MLC = "er.mlc";
/**
 * ER lane 5 (#812) — disposition and departure: decide, discharge with the summary, hand to a unit, refer out, LAMA,
 * LWBS, abscond, death. DECIDED: one string; the doctor's acts (decide, discharge, hand, refer, death) also check the
 * doctor role, LAMA a doctor or the duty manager. Nothing behind it names money.
 */
export const ER_DISPOSITION = "er.disposition";
/**
 * ER lane 6 (#813) — THE ER BILL DESK: the payer, an advance after "stabilised", pricing, settling at departure or dues
 * against an undertaking, a mass-casualty event account. Money: billing and desk roles only — never a clinician (0058).
 */
export const ER_BILL = "er.bill";
/**
 * ER lane 7 (#814) — codes: call a code (Code Blue and Code Grey from any staff phone), the resuscitation record, the
 * end and the debrief. DECIDED: one string held by every clinical and desk role that can face an arrest or violence; the
 * end of a clinical code also checks the doctor role. No money behind it.
 */
export const ER_CODES = "er.codes";
/**
 * ER lane 8 (#815) — mass casualty (Code Yellow): the MCI board, START / JumpSTART tags, the head count. Declaring and
 * standing down, the packs and the surge bays also check the role (the MS or the duty manager). No money behind it.
 */
export const ER_MCI = "er.mci";
