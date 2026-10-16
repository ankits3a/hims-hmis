import type { Db } from "../../kernel/db/client";
import type { KidneyReading } from "./rx-checks";

/**
 * #621 — WHERE THE RENAL DOSE CHECK GETS THE eGFR. The lab holds the creatinine and the equation
 * (`lab.latestEgfr`), but the lab depends on opd, so opd cannot import the lab without a cycle. The
 * lab registers its reader here instead (`LabModule.onModuleInit`, `registerLabKidneyFunctionReader`),
 * the shape `registerDocumentCapturedHook` and `registerEncounterResolver` already use.
 *
 * NO READER IS NOT "NORMAL KIDNEYS". Unregistered, the read answers `null` — "no signed creatinine" —
 * so a drug with a reviewed renal rule still raises "no recent kidney function" and asks for a reason.
 * A missing wire warns; it never silences.
 */
export type KidneyFunctionReader = (db: Db, patientId: string, now: Date) => Promise<KidneyReading>;

let reader: KidneyFunctionReader | null = null;

/** Installs the reader; returns an undo for suites. A second registration replaces the first. */
export function registerKidneyFunctionReader(fn: KidneyFunctionReader): () => void {
  reader = fn;
  return () => { if (reader === fn) reader = null; };
}

export async function readKidneyFunction(db: Db, patientId: string, now: Date): Promise<KidneyReading> {
  return reader === null ? null : reader(db, patientId, now);
}
