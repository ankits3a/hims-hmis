import { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_BOARD_WALL, ER_BILL, ER_CARE, ER_CODES, ER_DISPOSITION, ER_MCI, ER_MLC, ER_TRIAGE } from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

export { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_BOARD_WALL, ER_BILL, ER_CARE, ER_CODES, ER_DISPOSITION, ER_MCI, ER_MLC, ER_TRIAGE };

/**
 * ER lane 1 (#808, decision 0076) — the emergency department's declared surface: five permissions, five menu entries,
 * no subscription (spec SPEC-emergency §4.1, §5 A and C).
 *
 *   er.board.view        read the tracking board (wall and desktop) and the ER desk's lists, and subscribe to `er:board`
 *                        — front office, its supervisor, the casualty nurse, doctors, the duty manager, the MS
 *   er.board.wall        the wall display only (initials or the alias, no UHID, no complaint, no police chip) — the
 *                        ER roles above and the kiosk `display` role (ER review 2026-10-15)
 *   er.arrival.register  record an arrival (a known patient, a new named patient, an unidentified patient), a pre-alert,
 *                        a brought-dead marker, and print or reprint the ER band — front office, its supervisor, the
 *                        casualty nurse, the duty manager
 *
 *   er.triage            (lane 2, #809) triage and re-triage by ESI, vital sets, place and move in a bay, name the ER
 *                        doctor of record — the casualty nurse and doctors
 *
 *   er.care              (lane 3, #810) notes, STAT orders through the ordering door, the ER issue and the medication
 *                        record, procedures, consent, specialty calls, "stabilised" — doctors and the casualty nurse
 *                        (doctor-only acts also check the doctor role)
 *
 *   er.disposition       (lane 5, #812) decide the disposition, discharge with the summary, hand to a unit, refer out,
 *                        LAMA, LWBS, abscond, death — doctors, the casualty nurse, the duty manager, the front office
 *                        (the doctor's acts also check the doctor role; LAMA a doctor or the duty manager)
 *
 *   er.codes             (lane 7, #814) call a code (Code Blue / Code Grey anywhere), the resuscitation record, end, debrief
 *                        — doctors, nurses, the ER desk, its supervisor, the duty manager, security, the MS
 *
 *   er.mci               (lane 8, #815) mass casualty: the MCI board, START / JumpSTART tags, the head count; declaring,
 *                        standing down, the packs and surge bays also need the MS or duty manager role — doctors, the
 *                        casualty nurse, the ER desk, its supervisor, the duty manager, the MS
 *
 *   er.bill              (lane 6, #813) the ER bill desk: payer, advance (after "stabilised"), pricing, settle or dues,
 *                        a mass-casualty event account — front office, its supervisor, cashier, billing manager, duty manager
 *
 *   er.mlc               (lane 4, #811) the medico-legal case: open, addendum, police intimation, countersign,
 *                        belongings, evidence chain of custody, and the MLC desk — doctors, the casualty nurse, the
 *                        front office and its supervisor, the duty manager, the MS (opening, addenda and countersign
 *                        also check the doctor role; the countersign a senior one)
 *
 * Linking an unidentified patient to the true record files a `patient_merge` request and asks `patients.merge`, the
 * permission the merge screen already asks (DECIDED: no third string). No ER string names money (decision 0058).
 * API ONLY: the worker runs the pre-alert lapse inside the bed-reservation minute job and installs nothing.
 */
export const emergencyManifest: ModuleManifest = {
  key: "emergency",
  title: "Emergency",
  // The authoritative pairing `apps/web/src/router.tsx`'s NAV copies (test/nav-parity.test.ts).
  menu: [
    { label: "ER desk", path: "/er/desk", permission: ER_ARRIVAL_REGISTER },
    { label: "ER board", path: "/er/board", permission: ER_BOARD_VIEW },
    // Lane 2 (#809) — the triage screen (tablet or phone).
    { label: "ER triage", path: "/er/triage", permission: ER_TRIAGE },
    // Lane 3 (#810) — the ER patient: care in one place (phone or tablet).
    { label: "ER patient", path: "/er/patient", permission: ER_CARE },
    // Lane 4 (#811) — the MLC desk: owed intimations and countersigns with their clocks.
    { label: "MLC desk", path: "/er/mlc", permission: ER_MLC },
    // Lane 6 (#813) — the ER bill desk (money: desk and billing roles only).
    { label: "ER bill desk", path: "/er/bill", permission: ER_BILL },
    // Lane 7 (#814) — the resus scribe (tablet landscape): codes running, the timeline by tap.
    { label: "ER codes", path: "/er/codes", permission: ER_CODES },
    // Lane 8 (#815) — Code Yellow: the MCI board (counts, tags, packs, surge bays, the head count).
    { label: "MCI board", path: "/er/mci", permission: ER_MCI },
  ],
  permissions: [ER_BOARD_VIEW, ER_ARRIVAL_REGISTER, ER_TRIAGE, ER_BOARD_WALL, ER_CARE, ER_MLC, ER_DISPOSITION, ER_BILL, ER_CODES, ER_MCI],
  subscriptions: [],
};
