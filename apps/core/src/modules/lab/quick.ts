import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges, patients,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { displayNameFor } from "../patients";
import { labQuickReported, labQuickStarted } from "./events";
import { flagFor, resolveRange } from "./ranges";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RangeRow } from "./ranges";

/**
 * QUICK MODE (owner 2026-10-09, decision 0061) — the lab without bills, tokens or signatures:
 *
 *   1. START, at the counter (`lab.desk.operate`): find the patient (visit no., token, UHID, mobile,
 *      name or card QR — the desk's own finder), choose the tests (the doctor's advised list comes
 *      ticked), confirm blood is collected, press Start. The row is `waiting`, in the queue.
 *   2. REPORT, at the bench (`lab.results.enter`): pick the patient from the queue, the form holds
 *      every parameter of the chosen tests, type the values, edit the drafted summary, save, print.
 *
 * ═══ WHAT IS REUSED AND WHAT IS NOT ═══
 *
 * The catalogue, the range book and `resolveRange`/`flagFor` are the bench's own, so a quick flag
 * and a bench flag for the same value on the same patient are the same flag. The bench's WRITE path
 * (`enterResult`) is not used: it needs an order item and a specimen, and it starts the critical
 * ladder and the reflex rules, all of which belong to the ordered workflow. Quick rows live in
 * `lab_quick_reports` and no reader of verified results looks there.
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

export type QuickChosenTest = { serviceId: string; code: string; nameEn: string };

export type QuickPatient = { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null };

export type QuickRow = {
  id: string; status: "waiting" | "reported"; patient: QuickPatient; encounterNo: string | null;
  tests: QuickChosenTest[]; collectedAt: string; collectedBy: string;
  reportedAt: string | null; reportedBy: string | null;
};

export type QuickReport = QuickRow & {
  /** Every parameter of the chosen tests in report order, then any the bench added by hand. */
  analyteIds: string[];
  lines: QuickLine[];
  summary: string;
};

export type StartQuickInput = {
  patientId: string; encounterNo: string | null; serviceIds: string[]; bloodCollected: boolean;
};

export type SaveQuickResultsInput = {
  id: string;
  lines: { analyteId: string; value: string }[];
  summary: string;
};

export type QuickEntryErrorCode =
  | "patient_not_found" | "test_not_found" | "no_tests" | "blood_not_collected"
  | "analyte_not_found" | "value_not_numeric" | "value_absurd" | "report_not_found";

export class QuickEntryError extends Error {
  constructor(readonly code: QuickEntryErrorCode, message: string, readonly detail?: unknown) {
    super(message);
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** 00:00 IST of `now`'s IST day, as an instant. */
function istMidnight(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
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

/** Step 1 — the counter: tests chosen, blood collected, into the queue. */
export async function startQuick(tx: Tx, actor: Actor, input: StartQuickInput, now: Date = new Date()): Promise<QuickRow> {
  if (!input.bloodCollected) throw new QuickEntryError("blood_not_collected", "tick “Blood collected” before Start");
  const serviceIds = [...new Set(input.serviceIds)];
  if (serviceIds.length === 0) throw new QuickEntryError("no_tests", "add at least one test");
  await subjectOf(tx, input.patientId);
  const found = await tx.select({ serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn })
    .from(labOrderables).where(and(inArray(labOrderables.serviceId, serviceIds), eq(labOrderables.active, true)));
  const byId = new Map(found.map((t) => [t.serviceId, t]));
  const missing = serviceIds.filter((s) => !byId.has(s));
  if (missing.length > 0) throw new QuickEntryError("test_not_found", "a chosen test is not in the lab catalogue", { serviceIds: missing });
  const tests = serviceIds.map((s) => byId.get(s)!);

  const id = newId();
  await tx.insert(labQuickReports).values({
    id, patientId: input.patientId, encounterNo: input.encounterNo, tests, status: "waiting",
    collectedAt: now, collectedBy: actor.id, createdAt: now, updatedBy: actor.id, updatedAt: now,
  });
  await appendEvent(tx, labQuickStarted.make({
    actor, patientId: input.patientId, correlationId: id, occurredAt: now,
    payload: { quickId: id, testCount: tests.length },
  }));
  const [row] = await rowsWithPatients(tx, actor, await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)));
  return row!;
}

async function rowsWithPatients(
  exec: Db | Tx, actor: Actor, rows: (typeof labQuickReports.$inferSelect)[],
): Promise<QuickRow[]> {
  if (rows.length === 0) return [];
  const people = await exec.select().from(patients).where(inArray(patients.id, [...new Set(rows.map((r) => r.patientId))]));
  const byId = new Map<string, QuickPatient>();
  for (const p of people) {
    byId.set(p.id, {
      id: p.id, uhid: p.uhid, display: await displayNameFor(exec, actor, p),
      administrativeGender: p.administrativeGender, dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
    });
  }
  return rows.map((r) => ({
    id: r.id, status: r.status as "waiting" | "reported", patient: byId.get(r.patientId)!, encounterNo: r.encounterNo,
    tests: r.tests as QuickChosenTest[], collectedAt: r.collectedAt.toISOString(), collectedBy: r.collectedBy,
    reportedAt: r.reportedAt?.toISOString() ?? null, reportedBy: r.reportedBy,
  }));
}

/**
 * The bench's queue: every row still waiting, oldest first and whatever day it started (a patient
 * told "come back in two days" is still waiting), then today's reported rows, newest first, for a
 * reprint.
 */
export async function quickQueue(
  db: Db, actor: Actor, now: Date = new Date(),
): Promise<{ waiting: QuickRow[]; reportedToday: QuickRow[] }> {
  const waiting = await db.select().from(labQuickReports)
    .where(eq(labQuickReports.status, "waiting")).orderBy(asc(labQuickReports.collectedAt)).limit(300);
  const reported = await db.select().from(labQuickReports)
    .where(and(eq(labQuickReports.status, "reported"), gte(labQuickReports.reportedAt, istMidnight(now))))
    .orderBy(desc(labQuickReports.reportedAt)).limit(300);
  return { waiting: await rowsWithPatients(db, actor, waiting), reportedToday: await rowsWithPatients(db, actor, reported) };
}

export async function getQuickReport(exec: Db | Tx, actor: Actor, id: string): Promise<QuickReport> {
  const [r] = await exec.select().from(labQuickReports).where(eq(labQuickReports.id, id));
  if (!r) throw new QuickEntryError("report_not_found", `no quick report ${id}`);
  const [row] = await rowsWithPatients(exec, actor, [r]);
  const tests = r.tests as QuickChosenTest[];
  const links = tests.length === 0 ? [] : await exec.select().from(labOrderableAnalytes)
    .where(inArray(labOrderableAnalytes.serviceId, tests.map((t) => t.serviceId)))
    .orderBy(asc(labOrderableAnalytes.position));
  const ordered: string[] = [];
  for (const t of tests) {
    for (const l of links) if (l.serviceId === t.serviceId && !ordered.includes(l.analyteId)) ordered.push(l.analyteId);
  }
  const lines = r.lines as QuickLine[];
  for (const l of lines) if (!ordered.includes(l.analyteId)) ordered.push(l.analyteId);
  return { ...row!, analyteIds: ordered, lines, summary: r.summary };
}

/**
 * Step 2 — the bench: the values and the summary. The server resolves every range and flag itself;
 * the screen's colours are only a preview. A numeric value outside the analyte's absurd envelope is
 * refused — a 92 typed for a haemoglobin of 9.2 is the typo this exists for. Saving again edits it.
 */
export async function saveQuickResults(
  tx: Tx, actor: Actor, input: SaveQuickResultsInput, now: Date = new Date(),
): Promise<QuickReport> {
  const [existing] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, input.id)).for("update");
  if (!existing) throw new QuickEntryError("report_not_found", `no quick report ${input.id}`);
  const subject = await subjectOf(tx, existing.patientId);
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
      if (!Number.isFinite(n)) throw new QuickEntryError("value_not_numeric", `${a.nameEn}: “${value}” is not a number`, { analyteId: a.id });
      if ((a.absurdLow !== null && n < Number(a.absurdLow)) || (a.absurdHigh !== null && n > Number(a.absurdHigh))) {
        throw new QuickEntryError("value_absurd", `${a.nameEn}: ${value} is not possible — check the value`, { analyteId: a.id });
      }
      flag = flagFor(n, range);
    }
    lines.push({
      analyteId: a.id, code: a.code, nameEn: a.nameEn, unit: a.unit, value,
      low: range.low, high: range.high, refText: range.text, flag,
    });
  }

  const first = existing.status === "waiting";
  await tx.update(labQuickReports).set({
    lines, summary: input.summary, status: "reported",
    reportedAt: existing.reportedAt ?? now, reportedBy: existing.reportedBy ?? actor.id,
    updatedBy: actor.id, updatedAt: now,
  }).where(eq(labQuickReports.id, input.id));

  await appendEvent(tx, labQuickReported.make({
    actor, patientId: existing.patientId, correlationId: input.id, occurredAt: now,
    payload: {
      quickId: input.id, lineCount: lines.length,
      abnormalCount: lines.filter((l) => l.flag !== null && l.flag !== "N").length,
      edit: !first,
    },
  }));

  return getQuickReport(tx, actor, input.id);
}
