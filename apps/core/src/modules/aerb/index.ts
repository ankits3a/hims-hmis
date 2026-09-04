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
export { AERB_LICENSABLE_MODALITIES, appointments, licenceRegister, unlicensedDevices } from "./read";
export type { AppointmentRow, LicenceRegisterRow } from "./read";
export * from "./events";
