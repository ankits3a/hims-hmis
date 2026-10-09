import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges, patients,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { labQuickReportSaved } from "./events";
import { flagFor, resolveRange } from "./ranges";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RangeRow } from "./ranges";

/**
 * QUICK ENTRY (owner 2026-10-09, decision 0061) — search a patient, type the values, get a flagged
 * report with an editable summary. No order, no bill, no token, no pathologist signature: the owner
 * runs those in other software for now and will bring them here later.
 *
 * ═══ WHAT IS REUSED AND WHAT IS NOT ═══
 *
 * The catalogue, the range book and `resolveRange`/`flagFor` are the bench's own, so a quick flag
 * and a bench flag for the same value on the same patient are the same flag. The bench's WRITE path
 * (`enterResult`) is not used: it needs an order item, a specimen and a collection time, and it
 * starts the critical ladder and the reflex rules, all of which belong to the ordered workflow.
 * Quick reports live in `lab_quick_reports` and no reader of verified results looks there.
 */

export type QuickAnalyte = {
  analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
  decimals: number; absurdLow: string | null; absurdHigh: string | null;
};
export type QuickTest = { serviceId: string; code: string; nameEn: string; analyteIds: string[] };
export type QuickCatalogue = { tests: QuickTest[]; analytes: QuickAnalyte[] };

export type QuickRange = {
  analyteId: string; low: string | null; high: string | null; text: string | null;
  criticalLow: string | null; criticalHigh: string | null; note: string | null;
};

export type QuickFlag = "L" | "H" | "LL" | "HH" | "N" | null;

/** One line as stored: what was typed, and the range and flag the server resolved at save. */
export type QuickLine = {
  analyteId: string; code: string; nameEn: string; unit: string | null;
  value: string; low: string | null; high: string | null; refText: string | null; flag: QuickFlag;
};

export type QuickReport = {
  id: string; patientId: string; lines: QuickLine[]; summary: string;
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string;
};

export type SaveQuickReportInput = {
  id?: string;
  patientId: string;
  lines: { analyteId: string; value: string }[];
  summary: string;
};

export class QuickEntryError extends Error {
  constructor(readonly code: "patient_not_found" | "analyte_not_found" | "value_not_numeric" | "value_absurd" | "report_not_found",
    message: string, readonly detail?: unknown) {
    super(message);
  }
}

/** Every active test with its parameters in report order, and every analyte those tests name. */
export async function quickCatalogue(exec: Db | Tx): Promise<QuickCatalogue> {
  const tests = await exec.select({ serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn })
    .from(labOrderables).where(eq(labOrderables.active, true)).orderBy(asc(labOrderables.nameEn));
  const links = await exec.select().from(labOrderableAnalytes).orderBy(asc(labOrderableAnalytes.position));
  const analyteRows = await exec.select().from(labAnalytes).orderBy(asc(labAnalytes.nameEn));
  const byService = new Map<string, string[]>();
  for (const l of links) byService.set(l.serviceId, [...(byService.get(l.serviceId) ?? []), l.analyteId]);
  return {
    tests: tests.map((t) => ({ ...t, analyteIds: byService.get(t.serviceId) ?? [] })),
    analytes: analyteRows.map((a) => ({
      analyteId: a.id, code: a.code, nameEn: a.nameEn, unit: a.unit, resultType: a.resultType,
      decimals: a.decimals, absurdLow: a.absurdLow, absurdHigh: a.absurdHigh,
    })),
  };
}

async function subjectOf(exec: Db | Tx, patientId: string): Promise<{ dob: string | null; sex: string | null }> {
  const [p] = await exec.select({ dob: patients.dob, sex: patients.administrativeGender })
    .from(patients).where(eq(patients.id, patientId));
  if (!p) throw new QuickEntryError("patient_not_found", `no patient ${patientId}`);
  return { dob: p.dob ? p.dob.toISOString().slice(0, 10) : null, sex: p.sex };
}

/** The patient's resolved range for each analyte, today — age and sex as the bench resolves them. */
export async function quickRanges(
  exec: Db | Tx, patientId: string, analyteIds: readonly string[], now: Date = new Date(),
): Promise<QuickRange[]> {
  const subject = await subjectOf(exec, patientId);
  if (analyteIds.length === 0) return [];
  const analytes = await exec.select().from(labAnalytes).where(inArray(labAnalytes.id, [...analyteIds]));
  const rows = await exec.select().from(labReferenceRanges).where(inArray(labReferenceRanges.analyteId, [...analyteIds]));
  const byAnalyte = new Map<string, RangeRow[]>();
  for (const r of rows) byAnalyte.set(r.analyteId, [...(byAnalyte.get(r.analyteId) ?? []), r]);
  return analytes.map((a) => {
    const r = resolveRange(a, byAnalyte.get(a.id) ?? [], subject, now);
    return {
      analyteId: a.id, low: r.low, high: r.high, text: r.text,
      criticalLow: r.criticalLow, criticalHigh: r.criticalHigh, note: r.note,
    };
  });
}

/**
 * Create or update a quick report. The server resolves every range and flag itself; the screen's
 * colours are only a preview. A numeric value outside the analyte's absurd envelope is refused —
 * a 92 typed for a haemoglobin of 9.2 is the typo this exists for.
 */
export async function saveQuickReport(
  tx: Tx, actor: Actor, input: SaveQuickReportInput, now: Date = new Date(),
): Promise<QuickReport> {
  const subject = await subjectOf(tx, input.patientId);
  const ids = [...new Set(input.lines.map((l) => l.analyteId))];
  const analytes = ids.length === 0 ? [] : await tx.select().from(labAnalytes).where(inArray(labAnalytes.id, ids));
  const analyteById = new Map(analytes.map((a) => [a.id, a]));
  const rangeRows = ids.length === 0 ? [] : await tx.select().from(labReferenceRanges).where(inArray(labReferenceRanges.analyteId, ids));

  const lines: QuickLine[] = [];
  for (const l of input.lines) {
    const a = analyteById.get(l.analyteId);
    if (!a) throw new QuickEntryError("analyte_not_found", `no analyte ${l.analyteId}`);
    const value = l.value.trim();
    if (value === "") continue;
    const range = resolveRange(a, rangeRows.filter((r) => r.analyteId === a.id), subject, now);
    let flag: QuickFlag = null;
    if (a.resultType === "numeric" || a.resultType === "formula") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new QuickEntryError("value_not_numeric", `${a.code}: "${value}" is not a number`, { analyteId: a.id });
      if ((a.absurdLow !== null && n < Number(a.absurdLow)) || (a.absurdHigh !== null && n > Number(a.absurdHigh))) {
        throw new QuickEntryError("value_absurd", `${a.code}: ${value} is outside the possible range — check the value`, { analyteId: a.id });
      }
      flag = flagFor(n, range);
    }
    lines.push({
      analyteId: a.id, code: a.code, nameEn: a.nameEn, unit: a.unit, value,
      low: range.low, high: range.high, refText: range.text, flag,
    });
  }

  let id = input.id;
  if (id !== undefined) {
    const updated = await tx.update(labQuickReports)
      .set({ lines, summary: input.summary, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(labQuickReports.id, id), eq(labQuickReports.patientId, input.patientId)))
      .returning({ id: labQuickReports.id });
    if (updated.length === 0) throw new QuickEntryError("report_not_found", `no quick report ${id} for this patient`);
  } else {
    id = newId();
    await tx.insert(labQuickReports).values({
      id, patientId: input.patientId, lines, summary: input.summary,
      createdBy: actor.id, createdAt: now, updatedBy: actor.id, updatedAt: now,
    });
  }

  await appendEvent(tx, labQuickReportSaved.make({
    actor, patientId: input.patientId, correlationId: id, occurredAt: now,
    payload: {
      reportId: id, lineCount: lines.length,
      abnormalCount: lines.filter((l) => l.flag !== null && l.flag !== "N").length,
      created: input.id === undefined,
    },
  }));

  return getQuickReport(tx, id);
}

function toReport(r: typeof labQuickReports.$inferSelect): QuickReport {
  return {
    id: r.id, patientId: r.patientId, lines: r.lines as QuickLine[], summary: r.summary,
    createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
    updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getQuickReport(exec: Db | Tx, id: string): Promise<QuickReport> {
  const [r] = await exec.select().from(labQuickReports).where(eq(labQuickReports.id, id));
  if (!r) throw new QuickEntryError("report_not_found", `no quick report ${id}`);
  return toReport(r);
}

/** A patient's quick reports, newest first. */
export async function quickReportsForPatient(exec: Db | Tx, patientId: string): Promise<QuickReport[]> {
  const rows = await exec.select().from(labQuickReports)
    .where(eq(labQuickReports.patientId, patientId)).orderBy(desc(labQuickReports.createdAt)).limit(50);
  return rows.map(toReport);
}
