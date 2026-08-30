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
export * from "./events";
