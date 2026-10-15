import { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_CARE, ER_TRIAGE } from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

export { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_CARE, ER_TRIAGE };

/**
 * ER lane 1 (#808, decision 0076) — the emergency department's declared surface: four permissions, four menu entries,
 * no subscription (spec SPEC-emergency §4.1, §5 A and C).
 *
 *   er.board.view        read the tracking board (wall and desktop) and the ER desk's lists, and subscribe to `er:board`
 *                        — front office, its supervisor, the casualty nurse, doctors, the duty manager, the MS
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
  ],
  permissions: [ER_BOARD_VIEW, ER_ARRIVAL_REGISTER, ER_TRIAGE, ER_CARE],
  subscriptions: [],
};
