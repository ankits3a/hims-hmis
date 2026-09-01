/**
 * PLAN 18a T2 — the PCPNDT module's public surface.
 *
 * **15b and 62 import from HERE and from nowhere deeper.** That is what makes DD1's "adopted
 * unchanged" a property rather than an intention: a consumer that reached into `form-f.ts` directly
 * would couple itself to this module's internals, and the register's whole value is that there is
 * one of it.
 */
export { pcpndtManifest } from "./manifest";
export { PcpndtError, PCPNDT_ERROR_CODES, pcpndtHttpStatus } from "./errors";
export type { PcpndtErrorCode } from "./errors";
export { PcpndtModule } from "./pcpndt.module";
export {
  activeRegistrationFor, addMachine, addPerson, createRegistration, deactivateMachine,
  deactivatePerson, deactivateRegistration, registeredPersons,
} from "./registrations";
export type { RegisteredMachineRow, RegisteredPersonRow, RegistrationRow } from "./registrations";
export {
  assertFormFRecorded, assertMachineRegistered, assertPersonRegistered, openFormF, recordFormF,
  verifyFormF,
} from "./form-f";
export type { FormFRow, OpenFormFInput, RecordFormFInput } from "./form-f";
export { LOCKOUT_LEXICON, findLockoutHits, isLockedOut } from "./lockout";
export type { LockoutHit } from "./lockout";
export { formFForStudy, formFForStudyTx } from "./read";
export type { FormFView } from "./read";
export * from "./events";
