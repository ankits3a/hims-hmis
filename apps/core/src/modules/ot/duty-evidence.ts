import { and, asc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import { otCases, resources } from "../../kernel/db/schema";
import { registerTheatreEvidenceSource } from "../roster";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * 20-U U8 — **WHAT THE THEATRE RECORD SHOWS A PERSON DOING**, for the roster's duty-evidence report
 * (RU-3). A read, and only of the five DD8 stamps' outer two: the case was wheeled in, the case was
 * wheeled out, in which theatre, and whether the person was its surgeon or its anaesthetist.
 *
 * **No patient, no procedure, nothing clinical leaves this function.** The report it feeds is a
 * faculty member's paper for a regularisation request; it needs to say "in Theatre 1 as surgeon,
 * 09:12–11:40" and nothing about whom. A case with no wheel-in recorded did not happen in the
 * record's eyes and is not returned — the report states what the record shows, not what was listed.
 */
export type TheatreTime = {
  userId: string;
  role: "surgeon" | "anaesthetist";
  /** The list's IST calendar day. */
  listDate: string;
  theatreName: string;
  wheelIn: Date;
  /** Null when the case is still in theatre, or the wheel-out was never recorded. */
  wheelOut: Date | null;
};

/** Every recorded wheel-in for `userIds`, on list days `[fromIstDate, toIstDate)`. */
export async function theatreTimesOf(
  exec: Db | Tx, userIds: readonly string[], fromIstDate: string, toIstDate: string,
): Promise<TheatreTime[]> {
  const want = [...new Set(userIds)];
  if (want.length === 0) return [];
  const rows = await (exec as Db).select({
    surgeonId: otCases.surgeonId, anaesthetistId: otCases.anaesthetistId, listDate: otCases.listDate,
    theatreName: resources.name, wheelIn: otCases.wheelIn, wheelOut: otCases.wheelOut,
  }).from(otCases)
    .innerJoin(resources, eq(resources.id, otCases.theatreResourceId))
    .where(and(
      gte(otCases.listDate, fromIstDate), lt(otCases.listDate, toIstDate), isNotNull(otCases.wheelIn),
      or(inArray(otCases.surgeonId, want), inArray(otCases.anaesthetistId, want)),
    ))
    .orderBy(asc(otCases.wheelIn));
  const out: TheatreTime[] = [];
  for (const r of rows) {
    const base = { listDate: String(r.listDate), theatreName: r.theatreName, wheelIn: r.wheelIn!, wheelOut: r.wheelOut };
    if (want.includes(r.surgeonId)) out.push({ userId: r.surgeonId, role: "surgeon", ...base });
    if (r.anaesthetistId !== null && want.includes(r.anaesthetistId)) out.push({ userId: r.anaesthetistId, role: "anaesthetist", ...base });
  }
  return out;
}

/**
 * Hands `theatreTimesOf` to the roster's duty-evidence report. Called from `OtModule.onModuleInit`
 * (the roster may not import this module at load time — see `roster/evidence.ts`); exported so a
 * suite can wire it without booting Nest. Returns the unregister.
 */
export function registerOtDutyEvidence(): () => void {
  return registerTheatreEvidenceSource(theatreTimesOf);
}
