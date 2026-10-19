/**
 * THE cross-module interface of the doctor-desk module (DD-0, #626; plan D-A). A leaf: nothing
 * imports it but the app module and the manifest list. It reads lab, radiology, opd, patients and
 * roster through their own `index.ts`.
 */
export { doctorDeskManifest } from "./manifest";
export { DoctorDeskModule } from "./doctor-desk.module";
export { DoctorDeskError } from "./errors";
export type { DoctorDeskErrorCode } from "./errors";
export { towerView } from "./tower";
export { waitingOn } from "./waiting-on";
export { owedByUnit } from "./owed";
