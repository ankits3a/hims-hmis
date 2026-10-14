import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import { events, otCases } from "../../kernel/db/schema";
import { procedureConverted } from "./events";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * IPD E5.4 (#741) — **THE PROCEDURES A PATIENT HAD IN THEATRE**, for the inpatient discharge drafter. A read; nothing
 * is written and nothing about money leaves it (no quote, no package, no tariff — decision 0058).
 *
 * A procedure was DONE when its incision is recorded: a case cancelled, postponed or abandoned before the knife is not
 * one. A case is returned when its incision falls inside `[from, until]` (the stay), or when it belongs to `linkedRef`
 * — the day-care encounter (or case) an admission was converted from, whose procedure came before the admission.
 * When the theatre recorded a conversion (`procedure.converted`), the procedure is the one it was converted TO, and
 * the original is named beside it.
 */
export type ProcedureDone = {
  caseId: string;
  encounterId: string;
  procedureCode: string;
  /** The procedure code the case was booked under, when the theatre converted it; else null. */
  convertedFrom: string | null;
  procedureClass: string;
  laterality: string | null;
  anaesthesiaType: string | null;
  surgeonId: string;
  incisionAt: Date;
  closureAt: Date | null;
};

export const PROCEDURES_DONE_LIMIT = 50;

export async function proceduresDone(
  exec: Db | Tx,
  input: { patientId: string; from: Date; until: Date; linkedRef?: string | null },
): Promise<ProcedureDone[]> {
  const inStay = and(eq(otCases.patientId, input.patientId), gte(otCases.incision, input.from), lte(otCases.incision, input.until));
  const ref = input.linkedRef ?? null;
  const rows = await (exec as Db).select().from(otCases)
    .where(and(
      isNotNull(otCases.incision),
      ref === null ? inStay : or(inStay, and(eq(otCases.patientId, input.patientId), or(eq(otCases.encounterId, ref), eq(otCases.id, ref)))),
    ))
    .orderBy(asc(otCases.incision), asc(otCases.id))
    .limit(PROCEDURES_DONE_LIMIT);
  if (rows.length === 0) return [];

  // The latest conversion per case (the event is the theatre's only record of it).
  const converted = new Map<string, string>();
  const moves = await (exec as Db).select({ payload: events.payload }).from(events)
    .where(and(
      eq(events.name, procedureConverted.name), eq(events.module, procedureConverted.module),
      inArray(events.encounterId, [...new Set(rows.map((r) => r.encounterId))]),
    ))
    .orderBy(desc(events.seq));
  for (const m of moves) {
    const p = m.payload as { caseId?: unknown; toProcedureCode?: unknown };
    if (typeof p.caseId === "string" && typeof p.toProcedureCode === "string" && !converted.has(p.caseId)) converted.set(p.caseId, p.toProcedureCode);
  }

  return rows.map((r) => {
    const to = converted.get(r.id);
    return {
      caseId: r.id, encounterId: r.encounterId,
      procedureCode: to ?? r.procedureCode, convertedFrom: to === undefined || to === r.procedureCode ? null : r.procedureCode,
      procedureClass: r.procedureClass, laterality: r.laterality, anaesthesiaType: r.anaesthesiaType, surgeonId: r.surgeonId,
      incisionAt: r.incision!, closureAt: r.closure,
    };
  });
}
