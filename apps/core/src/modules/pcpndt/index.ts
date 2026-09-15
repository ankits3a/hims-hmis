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
  activeRegistrationFor, activeRegistrations, addMachine, addPerson, createRegistration,
  deactivateMachine, deactivatePerson, deactivateRegistration, readRegister,
  registeredMachines, registeredPersons,
} from "./registrations";
export type {
  RegisterBookEntry, RegisteredMachineRow, RegisteredPersonRow, RegistrationRow,
} from "./registrations";
export {
  assertFormFRecorded, assertMachineRegistered, assertPersonRegistered, openFormF, recordFormF,
  registerFormFSubjectResolver, verifyFormF,
} from "./form-f";
export type {
  FormFRow, FormFSubject, FormFSubjectResolver, OpenFormFInput, RecordFormFInput,
} from "./form-f";
export {
  LOCKOUT_LEXICON, LOCKOUT_LEXICON_CODED, LOCKOUT_LEXICON_DEMOGRAPHIC,
  findLockoutHits, isLockedOut,
} from "./lockout";
export type { LockoutHit, LockoutTier } from "./lockout";
export { formFForStudy, formFForStudyTx } from "./read";
export type { FormFView } from "./read";
export * from "./events";
