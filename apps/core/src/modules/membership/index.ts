/**
 * THE cross-module interface of the membership module (spec §4). Later modules import from here
 * or consume events — never internals; the module-isolation lint rule enforces it.
 *
 * Plan 09 fills this in task order: T2 exports the two `AdjustmentSource` factories and the pure
 * benefit resolver contract, T3 `resolveInstruments`, T4 the entitlement and redemption writers,
 * T5 the import lane. `billing` composes the sources at its own layer (DD2) and `partners` reads
 * nothing here at all — the graph is `billing → membership`, `partners → billing`, and it is
 * acyclic by construction (DD1).
 */
export { membershipManifest } from "./manifest";
export { MembershipModule } from "./membership.module";
export { MembershipError } from "./errors";
export type { MembershipErrorCode } from "./errors";
export * from "./events";
