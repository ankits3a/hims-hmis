import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { cleanAstRows, astProblemText, isCultureCode, isNoGrowth, newId } from "@hmis/contracts";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges, orderItems, orders, patients, users,
} from "../../kernel/db/schema";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { LIVE_ITEM_STATUSES } from "../../kernel/orders/transitions";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { HOSPITAL } from "../../kernel/printing/document-kit";
import { qrSvg } from "../../kernel/printing/qr";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayNameFor, getPatient, listMergedLoserIds } from "../patients";
import { labQuickHandedOver, labQuickReported, labQuickSentBack, labQuickStarted, labReportShared } from "./events";
import { flagFor, resolveRange } from "./ranges";
import { evaluateFormula, formulaInputCodes } from "./formula";
import type { FormulaOutcome } from "./formula";
import type { Actor, AstBlock, AstDraftRow } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RangeRow, ResolvedRange } from "./ranges";

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
  /** Owner 2026-10-11 — a calculated parameter's expression, so the bench previews it. */
  formula: string | null; formulaGuard: string | null;
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
  id: string; status: "waiting" | "draft" | "reported"; patient: QuickPatient; encounterNo: string | null;
  tests: QuickChosenTest[]; collectedAt: string; collectedBy: string;
  reportedAt: string | null; reportedBy: string | null;
  /** Owner 2026-10-11 — the quick chain's order, sample number and hand-over (null on a 0061 Start). */
  orderId: string | null; orderNo: string | null; sampleNo: string | null;
  handedOverAt: string | null; handedOverBy: string | null;
};

export type QuickReport = QuickRow & {
  /** Every parameter of the chosen tests in report order, then any the bench added by hand. */
  analyteIds: string[];
  /** The same ids under their test's name (`null` title = added by hand), so any screen can print it. */
  groups: { title: string | null; analyteIds: string[] }[];
  /** Full names for the printed "Collected by" / "Performed by" lines — never a login name. */
  collectedByName: string | null;
  reportedByName: string | null;
  /**
   * The footer of the printed page, from the SAME constants the OPD prescription's A4 footer prints
   * (`kernel/printing/document-kit.ts` `HOSPITAL`, owner 2026-10-09: "the footer needs to be inspired
   * from OPD prescription slip A4 page"). Plain text — the kit's copies are HTML-escaped for its own
   * templates, and the screen escapes again.
   */
  hospital: { name: string; address: string; hotline: string; emergency: string; email: string; website: string };
  /** The visit number as the prescription's footer QR (an SVG string, 62 px), or null with no visit. */
  visitQrSvg: string | null;
  lines: QuickLine[];
  summary: string;
  /** Owner 2026-10-12 — each culture test's antibiotic sensitivity table (`[]` when none). */
  ast: AstBlock[];
};

export type StartQuickInput = {
  patientId: string; encounterNo: string | null; serviceIds: string[]; bloodCollected: boolean;
};

export type SaveQuickResultsInput = {
  id: string;
  lines: { analyteId: string; value: string }[];
  summary: string;
  /** Owner 2026-10-11 — `false` is /lab/qbench's Save draft; absent or `true` completes the report. */
  complete?: boolean;
  /**
   * Owner 2026-10-12 — the antibiotic tables of the report's culture tests. ABSENT keeps what is stored
   * (an older screen that knows no table cannot wipe one); present replaces every table.
   */
  ast?: { serviceId: string; rows: AstDraftRow[] }[];
};

export type QuickEntryErrorCode =
  | "patient_not_found" | "test_not_found" | "no_tests" | "blood_not_collected"
  | "analyte_not_found" | "value_not_numeric" | "value_absurd" | "report_not_found"
  | "order_not_found" | "already_collected" | "not_completed" | "already_handed_over" | "not_permitted"
  | "ast_invalid";

export class QuickEntryError extends Error {
  constructor(readonly code: QuickEntryErrorCode, message: string, readonly detail?: unknown) {
    super(message);
  }
}

/** The kit's strings are written for its HTML templates (`&amp;`); the wire carries plain text. */
function unescapeKit(s: string): string {
  return s.replace(/&amp;/g, "&");
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
      formula: a.formula, formulaGuard: a.formulaGuard,
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
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => x !== null))];
  const orderNos = new Map(orderIds.length === 0 ? [] : (await exec.select({ id: orders.id, orderNo: orders.orderNo })
    .from(orders).where(inArray(orders.id, orderIds))).map((o) => [o.id, o.orderNo]));
  return rows.map((r) => ({
    id: r.id, status: r.status as QuickRow["status"], patient: byId.get(r.patientId)!, encounterNo: r.encounterNo,
    tests: r.tests as QuickChosenTest[], collectedAt: r.collectedAt.toISOString(), collectedBy: r.collectedBy,
    reportedAt: r.reportedAt?.toISOString() ?? null, reportedBy: r.reportedBy,
    orderId: r.orderId, orderNo: r.orderId === null ? null : orderNos.get(r.orderId) ?? null, sampleNo: r.sampleNo,
    handedOverAt: r.handedOverAt?.toISOString() ?? null, handedOverBy: r.handedOverBy,
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
    .where(inArray(labQuickReports.status, ["waiting", "draft"])).orderBy(asc(labQuickReports.collectedAt)).limit(300);
  const reported = await db.select().from(labQuickReports)
    .where(and(eq(labQuickReports.status, "reported"), gte(labQuickReports.reportedAt, istDayWindow(now).start)))
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
  const groups: { title: string | null; analyteIds: string[] }[] = [];
  for (const t of tests) {
    const mine: string[] = [];
    for (const l of links) {
      if (l.serviceId === t.serviceId && !ordered.includes(l.analyteId)) { ordered.push(l.analyteId); mine.push(l.analyteId); }
    }
    if (mine.length > 0) groups.push({ title: t.nameEn, analyteIds: mine });
  }
  const lines = r.lines as QuickLine[];
  const extra = lines.map((l) => l.analyteId).filter((id) => !ordered.includes(id));
  ordered.push(...extra);
  if (extra.length > 0) groups.push({ title: null, analyteIds: extra });
  const people = [r.collectedBy, r.reportedBy].filter((x): x is string => x !== null);
  const names = new Map((await exec.select({ id: users.id, fullName: users.fullName }).from(users)
    .where(inArray(users.id, people))).map((u) => [u.id, u.fullName]));
  return {
    ...row!, analyteIds: ordered, groups, lines, summary: r.summary, ast: r.ast as AstBlock[],
    collectedByName: names.get(r.collectedBy) ?? null,
    reportedByName: r.reportedBy === null ? null : names.get(r.reportedBy) ?? null,
    hospital: {
      name: unescapeKit(HOSPITAL.nameTitleCase), address: unescapeKit(HOSPITAL.address), hotline: HOSPITAL.hotline,
      emergency: HOSPITAL.emergency, email: HOSPITAL.email, website: HOSPITAL.website,
    },
    visitQrSvg: r.encounterNo === null ? null : qrSvg(r.encounterNo, 62),
  };
}

/**
 * The calculated lines of a quick report, from its typed lines — the full bench's rule (DD3,
 * `results.ts`): a parameter waits until every input it names is typed; then it is a number rounded
 * to its decimals and flagged against its range, or, when its guard fails (TG ≥ 400 for a Friedewald
 * LDL) or it would divide by zero, the reason as text and no flag. Repeated until nothing new is
 * computed, so a formula over a formula lands in the same save.
 */
export function calculatedLines(
  analytes: (typeof labAnalytes.$inferSelect)[],
  typed: QuickLine[],
  rangeOf: (a: typeof labAnalytes.$inferSelect) => ResolvedRange,
): QuickLine[] {
  const formulas = analytes.filter((a) => a.resultType === "formula");
  const codeOf = new Map(analytes.map((a) => [a.id, a.code]));
  const siblings: Record<string, number | undefined> = {};
  for (const l of typed) {
    const n = Number(l.value);
    const code = codeOf.get(l.analyteId);
    if (code !== undefined && l.value.trim() !== "" && Number.isFinite(n)) siblings[code] = n;
  }
  const out: QuickLine[] = [];
  for (let pass = 0; pass < formulas.length; pass += 1) {
    let progressed = false;
    for (const a of formulas) {
      if (out.some((l) => l.analyteId === a.id)) continue;
      if (!formulaInputCodes(a.formula, a.formulaGuard).every((c) => siblings[c] !== undefined)) continue;
      let outcome: FormulaOutcome;
      try { outcome = evaluateFormula(a, siblings); } catch { outcome = { computed: false, reason: "not calculable" }; }
      const range = rangeOf(a);
      const value = outcome.computed ? outcome.value.toFixed(Math.max(0, Math.min(6, a.decimals))) : outcome.reason;
      if (outcome.computed) siblings[a.code] = Number(value);
      out.push({
        analyteId: a.id, code: a.code, nameEn: a.nameEn, unit: outcome.computed ? a.unit : null, value,
        low: range.low, high: range.high, refText: range.text,
        flag: outcome.computed ? flagFor(Number(value), range) : null,
      });
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
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
  /**
   * OWNER 2026-10-11 — calculated parameters (LDL, globulin, A:G, indirect bilirubin …) are the
   * SERVER's, as on the full bench (DD3): whatever the screen sent for one is dropped and the value is
   * computed below from the typed inputs. So the report's formula analytes are read too, typed or not.
   */
  const chosen = existing.tests as QuickChosenTest[];
  const reportAnalyteIds = chosen.length === 0 ? [] : (await tx.select({ analyteId: labOrderableAnalytes.analyteId })
    .from(labOrderableAnalytes).where(inArray(labOrderableAnalytes.serviceId, chosen.map((t) => t.serviceId)))
    .orderBy(asc(labOrderableAnalytes.position))).map((r) => r.analyteId);
  const ids = [...new Set([...input.lines.map((l) => l.analyteId), ...reportAnalyteIds])];
  const analytes = ids.length === 0 ? [] : await tx.select().from(labAnalytes).where(inArray(labAnalytes.id, ids));
  const analyteById = new Map(analytes.map((a) => [a.id, a]));
  const rangeRows = ids.length === 0 ? [] : await tx.select().from(labReferenceRanges).where(inArray(labReferenceRanges.analyteId, ids));

  const lines: QuickLine[] = [];
  for (const l of input.lines) {
    const a = analyteById.get(l.analyteId);
    if (!a) throw new QuickEntryError("analyte_not_found", `no analyte ${l.analyteId}`);
    if (a.resultType === "formula") continue;
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

  const inReportOrder = [...analytes].sort((a, b) => reportAnalyteIds.indexOf(a.id) - reportAnalyteIds.indexOf(b.id));
  lines.push(...calculatedLines(inReportOrder, lines, (a) => resolveRange(a, rangeRows.filter((r) => r.analyteId === a.id), subject, now)));

  if (existing.handedOverAt !== null) {
    throw new QuickEntryError("already_handed_over", "this report has been handed over; it can no longer be changed");
  }
  /** An older screen sends no `ast`: what is stored stays, unless the organism now says "No growth". */
  const ast = astTables(chosen, lines, analytes, input.ast ?? (existing.ast as AstBlock[]));
  const first = existing.status !== "reported" && existing.reportedAt === null;
  const complete = input.complete !== false;
  await tx.update(labQuickReports).set({
    lines, summary: input.summary, ast,
    ...(complete
      ? { status: "reported", reportedAt: existing.reportedAt ?? now, reportedBy: existing.reportedBy ?? actor.id }
      : { status: "draft", reportedAt: null, reportedBy: null }),
    updatedBy: actor.id, updatedAt: now,
  }).where(eq(labQuickReports.id, input.id));
  if (!complete) return getQuickReport(tx, actor, input.id);

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

/**
 * OWNER 2026-10-12 — the antibiotic tables as stored. Each names a culture test of THIS report
 * (`CS_*`; fungal culture has none), at most once; the rows pass `cleanAstRows` (blank rows drop, S/I/R
 * only, MIC a plain number, a refusal names the row); a table left with no rows is not stored. When
 * the organism line reads "No growth" / "Sterile" nothing is stored, whatever the screen sent.
 */
function astTables(
  chosen: readonly QuickChosenTest[], lines: readonly QuickLine[], analytes: readonly (typeof labAnalytes.$inferSelect)[],
  input: readonly { serviceId: string; rows: AstDraftRow[] }[],
): AstBlock[] {
  const organismIds = new Set(analytes.filter((a) => a.code === "MIC_ORG").map((a) => a.id));
  const sterile = lines.some((l) => organismIds.has(l.analyteId) && isNoGrowth(l.value));
  const out: AstBlock[] = [];
  for (const block of input) {
    const test = chosen.find((t) => t.serviceId === block.serviceId);
    if (test === undefined || !isCultureCode(test.code)) {
      throw new QuickEntryError("ast_invalid", "an antibiotic table belongs only to a culture test of this report", { serviceId: block.serviceId });
    }
    if (out.some((b) => b.serviceId === block.serviceId)) {
      throw new QuickEntryError("ast_invalid", `${test.nameEn}: one antibiotic table per test`, { serviceId: block.serviceId });
    }
    const clean = cleanAstRows(block.rows);
    if (!clean.ok) {
      throw new QuickEntryError("ast_invalid", `${test.nameEn} — ${astProblemText(clean.problem)}`, { serviceId: block.serviceId, row: clean.problem.index });
    }
    if (!sterile && clean.rows.length > 0) out.push({ serviceId: block.serviceId, rows: clean.rows });
  }
  return out;
}

/**
 * A patient's REPORTED quick reports, newest first — for the patient profile and the doctor's
 * consult, on `lab.results.read`. Kept apart from `patientResultsForDoctor` on purpose: that reader
 * returns SIGNED values only, and a quick report is not signed (decision 0061), so every screen
 * that shows these labels them as quick reports rather than mixing them into signed results.
 *
 * Visibility follows the same rules as that reader: the patient's visibility (sealed charts,
 * break-glass) through `getPatient`, the whole merge chain, one access-log row per read, and a
 * report that carries a SENSITIVE test (HIV, HBsAg …) is omitted, not counted, unless the reader
 * holds `orders.read.restricted` — for those tests the existence of the test is the sensitive fact.
 */
export async function quickReportsForPatient(
  db: Db, actor: Actor, patientId: string, now: Date = new Date(),
): Promise<QuickReport[]> {
  if (actor.type !== "user") throw new QuickEntryError("patient_not_found", "a patient's reports are read by a person");
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new QuickEntryError("patient_not_found", `no patient ${patientId}`);
  const canonical = visible.patient.id;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const rows = await db.select().from(labQuickReports)
    .where(and(inArray(labQuickReports.patientId, chainIds), eq(labQuickReports.status, "reported")))
    .orderBy(desc(labQuickReports.reportedAt)).limit(20);

  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "lab.quick_reports",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null, now,
  });

  const serviceIds = [...new Set(rows.flatMap((r) => (r.tests as QuickChosenTest[]).map((t) => t.serviceId)))];
  const sensitive = serviceIds.length === 0 ? new Set<string>() : new Set((await db.select({ id: labOrderables.serviceId })
    .from(labOrderables).where(and(inArray(labOrderables.serviceId, serviceIds), eq(labOrderables.sensitive, true)))).map((x) => x.id));
  const canSeeRestricted = sensitive.size > 0 && await hasPermission(db, actor.id, "orders.read.restricted", "hospital");
  const shown = rows.filter((r) => canSeeRestricted || !(r.tests as QuickChosenTest[]).some((t) => sensitive.has(t.serviceId)));
  const out: QuickReport[] = [];
  for (const r of shown) out.push(await getQuickReport(db, actor, r.id));
  return out;
}

/* ═══════════════ OWNER 2026-10-11 — THE QUICK CHAIN: counter → qcollect → qbench → qreports ═══════════════ */

async function holdsAny(exec: Db | Tx, actor: Actor, permissions: readonly string[]): Promise<boolean> {
  if (actor.type !== "user") return false;
  for (const p of permissions) if (await hasPermission(exec, actor.id, p, "hospital")) return true;
  return false;
}

export type QuickCollectRow = {
  orderId: string; orderNo: string; encounterNo: string; placedAt: string; priority: string;
  patient: QuickPatient; tests: QuickChosenTest[];
};

/**
 * /lab/qcollect — every lab order of the last seven days still waiting for blood: its items are live,
 * no quick report holds it, and no tube of the full workflow carries any of its items. Oldest first.
 */
export async function quickCollectQueue(db: Db, actor: Actor, now: Date = new Date()): Promise<QuickCollectRow[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const items = await db
    .select({
      orderId: orders.id, orderNo: orders.orderNo, encounterNo: orders.encounterNo, placedAt: orders.placedAt,
      priority: orders.priority, patientId: orders.patientId, serviceId: orderItems.serviceId,
      code: labOrderables.code, nameEn: labOrderables.nameEn,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(and(
      eq(orders.kind, "lab"),
      gte(orders.placedAt, since),
      inArray(orderItems.status, [...LIVE_ITEM_STATUSES]),
      sql`not exists (select 1 from lab_quick_reports q where q.order_id = ${orders.id})`,
      sql`not exists (select 1 from lab_specimen_items si where si.order_item_id = ${orderItems.id} and si.active)`,
    ))
    /** #889 — orders oldest first, and an order's tests in the catalogue picker's order (by name). */
    .orderBy(asc(orders.placedAt), asc(orders.id), asc(labOrderables.nameEn), asc(orderItems.serviceId));
  const byOrder = new Map<string, { row: (typeof items)[number]; tests: QuickChosenTest[] }>();
  for (const it of items) {
    const g = byOrder.get(it.orderId) ?? { row: it, tests: [] };
    if (!g.tests.some((t) => t.serviceId === it.serviceId)) g.tests.push({ serviceId: it.serviceId, code: it.code, nameEn: it.nameEn });
    byOrder.set(it.orderId, g);
  }
  const people = byOrder.size === 0 ? [] : await db.select().from(patients)
    .where(inArray(patients.id, [...new Set([...byOrder.values()].map((g) => g.row.patientId))]));
  const pById = new Map<string, QuickPatient>();
  for (const p of people) {
    pById.set(p.id, {
      id: p.id, uhid: p.uhid, display: await displayNameFor(db, actor, p),
      administrativeGender: p.administrativeGender, dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
    });
  }
  return [...byOrder.values()].map(({ row, tests }) => ({
    orderId: row.orderId, orderNo: row.orderNo, encounterNo: row.encounterNo, placedAt: row.placedAt.toISOString(),
    priority: row.priority, patient: pById.get(row.patientId)!, tests,
  }));
}

/**
 * BLOOD COLLECTED — the staff confirm it themselves (no label printing, no tube scan, owner
 * 2026-10-11). The order becomes a quick report `waiting` for results, with a sample number from the
 * specimen series, and moves to /lab/qbench. Once per order, enforced by a unique index.
 */
export async function quickCollect(tx: Tx, actor: Actor, orderId: string, now: Date = new Date()): Promise<QuickRow> {
  if (!(await holdsAny(tx, actor, ["lab.desk.operate", "lab.collection.operate"]))) {
    throw new QuickEntryError("not_permitted", "confirming blood collection is the lab counter's or the phlebotomist's act");
  }
  const [order] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.kind, "lab"))).for("update");
  if (!order) throw new QuickEntryError("order_not_found", `no lab order ${orderId}`);
  const [done] = await tx.select({ id: labQuickReports.id }).from(labQuickReports).where(eq(labQuickReports.orderId, orderId));
  if (done) throw new QuickEntryError("already_collected", `blood for ${order.orderNo} is already confirmed`, { quickId: done.id });
  const live = await tx.select({ serviceId: orderItems.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn })
    .from(orderItems).innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(and(eq(orderItems.orderId, orderId), inArray(orderItems.status, [...LIVE_ITEM_STATUSES])))
    /** #889 — stored order is the bench form's and the printed report's group order: fix it by name. */
    .orderBy(asc(labOrderables.nameEn), asc(orderItems.serviceId));
  if (live.length === 0) throw new QuickEntryError("no_tests", `${order.orderNo} has no test left to collect`);
  const tests: QuickChosenTest[] = [];
  for (const t of live) if (!tests.some((x) => x.serviceId === t.serviceId)) tests.push(t);
  const sampleNo = await nextEpisodeNo(tx, "lab_specimen", istDayString(now));
  const id = newId();
  await tx.insert(labQuickReports).values({
    id, patientId: order.patientId, encounterNo: order.encounterNo, orderId, sampleNo, tests, status: "waiting",
    collectedAt: now, collectedBy: actor.id, createdAt: now, updatedBy: actor.id, updatedAt: now,
  });
  await appendEvent(tx, labQuickStarted.make({
    actor, patientId: order.patientId, correlationId: id, occurredAt: now,
    payload: { quickId: id, testCount: tests.length },
  }));
  const [row] = await rowsWithPatients(tx, actor, await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)));
  return row!;
}

/** /lab/qreports — every completed report not yet handed over (any day), then today's hand-overs. */
export async function quickReportsDesk(
  db: Db, actor: Actor, now: Date = new Date(),
): Promise<{ ready: QuickRow[]; handedOverToday: QuickRow[] }> {
  const ready = await db.select().from(labQuickReports)
    .where(and(eq(labQuickReports.status, "reported"), isNull(labQuickReports.handedOverAt)))
    .orderBy(asc(labQuickReports.reportedAt)).limit(300);
  const handed = await db.select().from(labQuickReports)
    .where(and(eq(labQuickReports.status, "reported"), gte(labQuickReports.handedOverAt, istDayWindow(now).start)))
    .orderBy(desc(labQuickReports.handedOverAt)).limit(300);
  return { ready: await rowsWithPatients(db, actor, ready), handedOverToday: await rowsWithPatients(db, actor, handed) };
}

/** PRINT & HAND OVER — the report left the lab with the patient; it is then closed to edits. */
export async function handOverQuick(tx: Tx, actor: Actor, id: string, now: Date = new Date()): Promise<QuickRow> {
  const [r] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)).for("update");
  if (!r) throw new QuickEntryError("report_not_found", `no quick report ${id}`);
  if (r.status !== "reported") throw new QuickEntryError("not_completed", "only a completed report is handed over");
  if (r.handedOverAt !== null) throw new QuickEntryError("already_handed_over", "this report has already been handed over");
  await tx.update(labQuickReports).set({ handedOverAt: now, handedOverBy: actor.id, updatedBy: actor.id, updatedAt: now })
    .where(eq(labQuickReports.id, id));
  await appendEvent(tx, labQuickHandedOver.make({ actor, patientId: r.patientId, correlationId: id, occurredAt: now, payload: { quickId: id } }));
  const [row] = await rowsWithPatients(tx, actor, await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)));
  return row!;
}

/**
 * SHARE PDF (owner 2026-10-12) — the phone shared a completed report's PDF. One audit event naming who
 * and which report; nothing else is written (the report is neither changed nor handed over).
 */
export async function recordQuickShare(
  tx: Tx, actor: Actor, id: string, now: Date = new Date(),
): Promise<{ reportId: string; sharedAt: string }> {
  const [r] = await tx.select({ patientId: labQuickReports.patientId, status: labQuickReports.status })
    .from(labQuickReports).where(eq(labQuickReports.id, id));
  if (!r) throw new QuickEntryError("report_not_found", `no quick report ${id}`);
  if (r.status !== "reported") throw new QuickEntryError("not_completed", "only a completed report is shared");
  await appendEvent(tx, labReportShared.make({
    actor, patientId: r.patientId, correlationId: id, occurredAt: now,
    payload: { reportId: id, patientId: r.patientId, channel: "phone_share" },
  }));
  return { reportId: id, sharedAt: now.toISOString() };
}

/** SEND BACK TO QUICK BENCH — a completed report becomes a draft again; refused once handed over. */
export async function sendBackQuick(tx: Tx, actor: Actor, id: string, now: Date = new Date()): Promise<QuickRow> {
  const [r] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)).for("update");
  if (!r) throw new QuickEntryError("report_not_found", `no quick report ${id}`);
  if (r.handedOverAt !== null) throw new QuickEntryError("already_handed_over", "this report has been handed over; it can no longer be sent back");
  if (r.status !== "reported") throw new QuickEntryError("not_completed", "only a completed report is sent back");
  await tx.update(labQuickReports).set({ status: "draft", reportedAt: null, reportedBy: null, updatedBy: actor.id, updatedAt: now })
    .where(eq(labQuickReports.id, id));
  await appendEvent(tx, labQuickSentBack.make({ actor, patientId: r.patientId, correlationId: id, occurredAt: now, payload: { quickId: id } }));
  const [row] = await rowsWithPatients(tx, actor, await tx.select().from(labQuickReports).where(eq(labQuickReports.id, id)));
  return row!;
}
