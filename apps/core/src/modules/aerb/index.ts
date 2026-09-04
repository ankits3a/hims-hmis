/**
 * PLAN 18c T1 — the AERB module's public surface.
 *
 * **Radiology, the cath lab (63) and radiation oncology (64) import from HERE and from nowhere
 * deeper.** That is what makes D1's "one register" a property rather than an intention: a consumer
 * that reached into `licences.ts` directly would couple itself to this module's internals, and the
 * register's whole value is that there is one of it.
 */
export { aerbManifest } from "./manifest";
export { AerbError, AERB_ERROR_CODES, aerbHttpStatus } from "./errors";
export type { AerbErrorCode } from "./errors";
export { AerbModule } from "./aerb.module";
export {
  activeLicenceFor, appointPerson, appointedPerson, assertDeviceLicensed,
  changeLicenceStatus, endAppointment, fileLicence,
} from "./licences";
export type { AerbLicenceRow, AerbPersonRow, AppointPersonInput, FileLicenceInput } from "./licences";
export { AERB_UNLICENSABLE_MODALITIES, aerbPickers, appointments, licenceRegister, unlicensedDevices } from "./read";
export type { AerbDeviceChoice, AerbUserChoice } from "./read";
// PLAN 18c T6 — one decision about who holds the pen, readable as well as enforceable.
export { AERB_MANAGE, mayManage, requireManage } from "./access";
// PLAN 18c T3 — the patient dose register. `recordDose` is what a SOURCE calls (radiology today,
// the cath lab and radiation oncology later) from inside its own transaction; nothing here reads a
// source's tables, which is what keeps this module installable without a department.
export { doseRegisterRows, patientCumulativeDose, recordDose } from "./dose";
export type { CumulativeDose, DoseRegisterRow, RecordDoseInput } from "./dose";
export { DOSE_QUANTITIES, DOSE_QUANTITY_COLUMNS, DOSE_UNITS } from "./units";
export type { DoseQuantity } from "./units";
// PLAN 18c T5 — the compliance calendar: one read over all four registers.
export { DUE_WINDOW_DAYS, complianceCalendar } from "./calendar";
export type { CalendarRow, CalendarState } from "./calendar";
// PLAN 18c T4 — the TLD badge programme and the record-only investigation ladder.
export {
  STATUTORY_LIMITS, badgeGaps, badgeReads, badgeRegister, closeBadge, investigationLevelPerMonth,
  issueBadge, recordBadgeRead, setInvestigationLevel,
} from "./badges";
export type {
  BadgeGapRow, BadgeReadRow, BadgeRegisterRow, IssueBadgeInput, RecordReadInput, RecordReadOutcome,
} from "./badges";
export {
  ANNUAL_LIMIT_MSV, DAYS_PER_MONTH, DEFAULT_INVESTIGATION_LEVEL_MSV_PER_MONTH,
  FIVE_YEAR_AVERAGE_LIMIT_MSV, FIVE_YEAR_TOTAL_LIMIT_MSV, investigationLevelFor,
} from "./limits";
// PLAN 18c T2 — the QA register and the lockout.
export { qaRegister, recordQa } from "./qa";
export type { QaRecordRow, QaRegisterRow, RecordQaInput, RecordQaOutcome } from "./qa";
export type { AppointmentRow, LicenceRegisterRow } from "./read";
export * from "./events";
