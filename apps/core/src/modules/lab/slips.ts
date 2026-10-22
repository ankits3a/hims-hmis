import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { readCopilotGate } from "../../kernel/copilot/halt";
import { withTx } from "../../kernel/db/client";
import {
  labAnalytes, labInstrumentCodes, labInstruments, labOrderableAnalytes, labQuickReports, labReferenceRanges, labSlipIgnoredCodes,
  labSlipScans, patients, resources,
} from "../../kernel/db/schema";
import { DocumentStoreError } from "../../kernel/documents/store";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayNameFor, listMergedLoserIds } from "../patients";
import { labSlipAttached, labSlipDetached, labSlipDiscarded, labSlipReadFailed, labSlipRowResolved, labSlipScanned } from "./events";
import { LAB_INSTRUMENTS_MANAGE, mapInstrumentCode } from "./instruments";
import { getQuickReport, saveQuickResults } from "./quick";
import { flagFor, resolveRange } from "./ranges";
import { LAB_RESULTS_ENTER } from "./results";
import { mapSlipRows, openChecks, slipCounts } from "./slip-map";
import { chipsFor, chipStrength, differencesOf, preselectIndex, slipIdOf } from "./slip-match";
import { parseSlipReply, SLIP_PROMPT_VERSION, slipCostMicroInr, SlipReadError } from "./slip-reader";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { QuickLine, QuickChosenTest } from "./quick";
import type { QuickLineSlip } from "./slip-lines";
import type { SlipAnalyte, SlipCounts, SlipFlag, SlipMapContext, SlipReportContext, SlipRowView } from "./slip-map";
import type { SlipChips, SlipDifference, SlipIdKind } from "./slip-match";
import type { SlipHeader, SlipReader, SlipReply } from "./slip-reader";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * SPEC #934 — THE BENCH PHOTOGRAPHS THE ANALYSER'S SLIP; THE SERVER READS IT INTO A DRAFT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Quick lab mode only. The bench photographs the slip a machine printed; this file stores the image,
 * has the configured provider transcribe it (`slip-reader.ts`), maps the rows to the report's fields
 * (`slip-map.ts`), finds the report (`slip-match.ts`) and writes the values AS A DRAFT through the same
 * `saveQuickResults` the bench uses, with `complete: false`.
 *
 * ═══ WHAT THE SCAN NEVER DOES (rule 1) ═══
 *
 * It never sets a report to `reported`, never writes `lab_results`, never opens a critical call and
 * never starts the ladder: quick-mode criticals stay outside the ladder (decision 0061), and a
 * person's Save & Complete is the only way out of draft. It never overwrites a value a person typed
 * (rule 3) and never attaches by guess (rule 5): an exact sample number or UHID whose printed name,
 * age and gender agree, or a person's tap.
 */
export const SLIP_MAX_BYTES = 1_500_000; // `patients/documents.ts` DOCUMENT_MAX_BYTES: the phone's budget, the server's refusal
const SLIP_DEDUPE_DAYS = 7;
const SLIP_STALE_READ_MS = 2 * 60_000;
export const SLIP_RETAIN_DAYS = 90;
const SLIP_DAILY_CAP_INR = 5000;
const CANDIDATE_LIMIT = 8;
const DAY_MS = 86_400_000;

export const LAB_SLIP_ACTOR: Actor = { type: "system", id: "lab-slip-sweep" };

export type SlipErrorCode =
  | "slip_reading_off" | "not_permitted" | "scan_not_found" | "report_not_found" | "report_closed" | "slip_confirm_needed"
  | "slip_reason_required" | "slip_not_attached" | "slip_already_attached" | "slip_discarded" | "slip_not_read" | "slip_image_invalid"
  | "slip_image_too_large" | "instrument_not_found" | "analyte_not_in_report" | "slip_value_refused" | "slip_spend_cap"
  | "row_not_found" | "row_not_open" | "slip_image_purged";

export class SlipError extends Error {
  constructor(readonly code: SlipErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "SlipError";
  }
}

export function slipHttpStatus(code: SlipErrorCode): number {
  switch (code) {
    case "scan_not_found": case "report_not_found": case "instrument_not_found": case "row_not_found": return 404;
    case "not_permitted": return 403;
    case "slip_reading_off": return 503;
    case "slip_spend_cap": return 429;
    case "slip_reason_required": case "slip_image_invalid": case "slip_image_too_large": case "analyte_not_in_report": case "slip_value_refused": return 422;
    default: return 409;
  }
}

export type SlipDeps = { store: DocumentStore; reader: SlipReader | null; timeoutMs?: number; dailyCapInr?: number };
export type ScanSlipInput = {
  image: Buffer; mimeType: string; source: "camera" | "gallery"; instrumentId: string;
  photoTakenAt?: string | null; quickReportId?: string | null;
};

export type SlipCandidate = {
  quickReportId: string;
  patient: { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null };
  sampleNo: string | null; collectedAt: string; status: string; tests: string[];
  chips: SlipChips; preselected: boolean;
};

export type SlipScanView = {
  id: string; status: string; source: string; instrumentId: string; instrumentName: string;
  capturedAt: string; photoTakenAt: string | null; provider: string | null; model: string | null; promptVersion: string | null;
  error: string | null; imagePurged: boolean;
  header: SlipHeader | null;
  rows: SlipRowView[]; counts: SlipCounts; rowsMissing: string[];
  /** How the slip named its patient, and the reminder when it did not. */
  match: { idKind: SlipIdKind; hint: "type_sample_no" | null; noOpenReport: boolean };
  /** Fill from slip: the report the bench had open. */
  requestedReportId: string | null;
  /** What the slip says that disagrees with the ID's patient or the requested report: staff must say Yes. */
  differences: SlipDifference[];
  candidates: SlipCandidate[];
  attached: null | {
    quickReportId: string; matchKind: string; matchedBy: string; matchedAt: string; confirmNote: string | null;
    patient: SlipCandidate["patient"]; sampleNo: string | null; tests: QuickChosenTest[];
  };
  discard: null | { reason: string; by: string; at: string };
};

export type SlipIdentity = SlipHeader & { analyserText: string | null; rowsMissing: string[] };

type ScanRow = typeof labSlipScans.$inferSelect;
type ReportRow = typeof labQuickReports.$inferSelect;

/* ═══════════════════════════════ guards ═══════════════════════════════ */

async function assertBench(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(exec as Db, actor.id, LAB_RESULTS_ENTER, "hospital"))) {
    throw new SlipError("not_permitted", `a slip is scanned, attached and resolved by the bench (${LAB_RESULTS_ENTER})`);
  }
}
async function assertManage(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(exec as Db, actor.id, LAB_INSTRUMENTS_MANAGE, "hospital"))) {
    throw new SlipError("not_permitted", `an analyser's code map and ignore list are set by ${LAB_INSTRUMENTS_MANAGE}`);
  }
}

function startsLike(mimeType: string, b: Buffer): boolean {
  if (mimeType === "image/jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mimeType === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

const isOpen = (r: Pick<ReportRow, "status" | "handedOverAt">): boolean => (r.status === "waiting" || r.status === "draft") && r.handedOverAt === null;

/** 00:00 IST yesterday: the window an open report must have been collected in to be a candidate. */
function windowStart(now: Date): Date {
  return new Date(istDayWindow(now).start.getTime() - DAY_MS);
}

/* ═══════════════════════════════ the analyser's map, the catalogue ═══════════════════════════════ */

async function instrumentOf(exec: Db | Tx, instrumentId: string): Promise<{ id: string; name: string; active: boolean } | null> {
  const [row] = await (exec as Db).select({ id: labInstruments.id, name: resources.name, active: labInstruments.active })
    .from(labInstruments).innerJoin(resources, eq(resources.id, labInstruments.resourceId)).where(eq(labInstruments.id, instrumentId));
  return row ?? null;
}

async function mapContext(exec: Db | Tx, scan: ScanRow, report: SlipReportContext | null): Promise<SlipMapContext> {
  const db = exec as Db;
  const codes = await db.select().from(labInstrumentCodes).where(eq(labInstrumentCodes.instrumentId, scan.instrumentId));
  const ignored = await db.select().from(labSlipIgnoredCodes).where(eq(labSlipIgnoredCodes.instrumentId, scan.instrumentId));
  const prior = new Map((scan.rows as SlipRowView[]).map((r) => [r.position, { checked: r.checked, resolution: r.resolution }]));
  const placeIds = [...prior.values()].flatMap((p) => (p.resolution?.action === "place" ? [p.resolution.analyteId] : []));
  const ids = [...new Set([...codes.map((c) => c.analyteId), ...placeIds])];
  const analytes = ids.length === 0 ? [] : await db.select().from(labAnalytes).where(inArray(labAnalytes.id, ids));
  return {
    codes: new Map(codes.map((c) => [c.instrumentCode, { analyteId: c.analyteId, unit: c.unit, factor: c.factor }])),
    ignored: new Map(ignored.map((i) => [i.code, i.reason])),
    analytes: new Map(analytes.map((a): [string, SlipAnalyte] => [a.id, {
      id: a.id, code: a.code, nameEn: a.nameEn, unit: a.unit, resultType: a.resultType, absurdLow: a.absurdLow, absurdHigh: a.absurdHigh, formula: a.formula,
    }])),
    report,
    prior,
  };
}

/** The analytes a report's tests carry, in report order. */
async function reportAnalyteIds(exec: Db | Tx, tests: readonly QuickChosenTest[]): Promise<string[]> {
  if (tests.length === 0) return [];
  return (await (exec as Db).select({ analyteId: labOrderableAnalytes.analyteId }).from(labOrderableAnalytes)
    .where(inArray(labOrderableAnalytes.serviceId, tests.map((t) => t.serviceId))).orderBy(asc(labOrderableAnalytes.position))).map((r) => r.analyteId);
}

/** What a report adds to the mapping: its analytes, who typed what, an earlier slip's values, its computed lines, our flags. */
async function reportContext(exec: Db | Tx, report: ReportRow, scanId: string, now: Date): Promise<SlipReportContext> {
  const db = exec as Db;
  const ids = await reportAnalyteIds(exec, report.tests as QuickChosenTest[]);
  const lines = report.lines as QuickLine[];
  const formulaIds = new Set(ids.length === 0 ? [] : (await db.select({ id: labAnalytes.id }).from(labAnalytes)
    .where(and(inArray(labAnalytes.id, ids), eq(labAnalytes.resultType, "formula")))).map((a) => a.id));
  const typed = new Map<string, string>(), priorSlip = new Map<string, string>(), computed = new Map<string, string>();
  for (const l of lines) {
    if (formulaIds.has(l.analyteId)) { computed.set(l.analyteId, l.value); continue; }
    const m = l.slip;
    if (m === undefined || m.edited === true || m.kept === true) typed.set(l.analyteId, l.value);
    else if (m.scanId !== scanId) priorSlip.set(l.analyteId, l.value);
  }
  const [p] = await db.select({ dob: patients.dob, sex: patients.administrativeGender }).from(patients).where(eq(patients.id, report.patientId));
  const subject = { dob: p?.dob ? p.dob.toISOString().slice(0, 10) : null, sex: p?.sex ?? null };
  const analytes = ids.length === 0 ? [] : await db.select().from(labAnalytes).where(inArray(labAnalytes.id, ids));
  const ranges = ids.length === 0 ? [] : await db.select().from(labReferenceRanges).where(inArray(labReferenceRanges.analyteId, ids));
  const byId = new Map(analytes.map((a) => [a.id, a]));
  return {
    analyteIds: new Set(ids), typed, priorSlip, computed,
    flagOf: (analyteId, value): SlipFlag => {
      const a = byId.get(analyteId);
      if (a === undefined) return null;
      return flagFor(value, resolveRange(a, ranges.filter((r) => r.analyteId === analyteId), subject, now));
    },
  };
}

async function remap(exec: Db | Tx, scan: ScanRow, report: SlipReportContext | null): Promise<{ rows: SlipRowView[]; rowsMissing: string[] }> {
  const reply = parseSlipReply(JSON.stringify(scan.rawReply === null ? null : (scan.rawReply as { reply?: unknown }).reply ?? null));
  if (reply === null) return { rows: [], rowsMissing: [] };
  return mapSlipRows(reply, await mapContext(exec, scan, report));
}

/* ═══════════════════════════════ writing the draft ═══════════════════════════════ */

/**
 * Bring an ATTACHED scan and its report into line: re-map against the report, write every placeable
 * value that is not a person's (through `saveQuickResults`, `complete: false`, so ranges, flags,
 * guards and formulas are the bench's own), then re-map once more so cross-checks see the computed
 * lines. One transaction, holding the report's row lock.
 */
async function syncAttached(tx: Tx, actor: Actor, scanId: string, now: Date): Promise<void> {
  const [scan] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, scanId)).for("update");
  if (!scan || scan.quickReportId === null) return;
  const [report] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, scan.quickReportId)).for("update");
  if (!report) throw new SlipError("report_not_found", `no quick report ${scan.quickReportId}`);
  if (!isOpen(report)) throw new SlipError("report_closed", "this report is complete or handed over; a slip cannot change it");

  const first = await remap(tx, scan, await reportContext(tx, report, scan.id, now));
  // The report's own lines, as a save would send them: computed lines are the server's and are left out.
  const input = new Map<string, { analyteId: string; value: string; slip?: QuickLineSlip }>();
  for (const l of report.lines as QuickLine[]) {
    if (await isFormula(tx, l.analyteId)) continue;
    input.set(l.analyteId, { analyteId: l.analyteId, value: l.value, ...(l.slip ? { slip: l.slip } : {}) });
  }

  let changed = report.status === "waiting";
  for (const r of first.rows) {
    if (r.placement !== "placed" || r.analyteId === null || r.placedValue === null) continue;
    const had = input.get(r.analyteId);
    if (r.written) {
      const marker: QuickLineSlip = { scanId: scan.id, row: r.position, checks: openChecks(r) };
      if (had?.value !== r.placedValue || had.slip?.scanId !== scan.id || had.slip.row !== r.position) changed = true;
      input.set(r.analyteId, { analyteId: r.analyteId, value: r.placedValue, slip: marker });
    } else if (had !== undefined && had.slip?.scanId !== scan.id && r.checks.includes("typed_differs")) {
      input.set(r.analyteId, { ...had, slip: { scanId: scan.id, row: r.position, checks: ["typed_differs"], slipValue: r.placedValue, kept: true } });
      changed = true;
    }
  }
  if (changed) {
    await saveQuickResults(tx, actor, { id: report.id, lines: [...input.values()], summary: report.summary, complete: false, origin: "slip" }, now);
  }
  const [after] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, report.id));
  const final = await remap(tx, scan, await reportContext(tx, after!, scan.id, now));
  await tx.update(labSlipScans).set({ rows: final.rows, identity: { ...(scan.identity as SlipIdentity), rowsMissing: final.rowsMissing } })
    .where(eq(labSlipScans.id, scan.id));
}

const formulaCache = new WeakMap<object, Map<string, boolean>>();
async function isFormula(tx: Tx, analyteId: string): Promise<boolean> {
  const cache = formulaCache.get(tx) ?? new Map<string, boolean>();
  formulaCache.set(tx, cache);
  const hit = cache.get(analyteId);
  if (hit !== undefined) return hit;
  const [a] = await tx.select({ t: labAnalytes.resultType }).from(labAnalytes).where(eq(labAnalytes.id, analyteId));
  const yes = a?.t === "formula";
  cache.set(analyteId, yes);
  return yes;
}

/** Re-map a scan that has no report yet (after a read, a mapping change, a detach). */
async function syncUnattached(tx: Tx, scanId: string): Promise<void> {
  const [scan] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, scanId)).for("update");
  if (!scan) return;
  const out = await remap(tx, scan, null);
  await tx.update(labSlipScans).set({ rows: out.rows, identity: { ...(scan.identity as SlipIdentity), rowsMissing: out.rowsMissing } })
    .where(eq(labSlipScans.id, scanId));
}

async function attachInTx(
  tx: Tx, actor: Actor, scanId: string, reportId: string, matchKind: "sample_no" | "uhid" | "staff_pick" | "from_report",
  confirmNote: string | null, now: Date,
): Promise<void> {
  const [report] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, reportId)).for("update");
  if (!report) throw new SlipError("report_not_found", `no quick report ${reportId}`);
  if (!isOpen(report)) throw new SlipError("report_closed", "this report is complete or handed over; a slip cannot attach to it");
  await tx.update(labSlipScans).set({
    status: "attached", quickReportId: reportId, matchKind, matchedBy: actor.id, matchedAt: now, confirmNote,
  }).where(eq(labSlipScans.id, scanId));
  await syncAttached(tx, actor, scanId, now);
  await appendEvent(tx, labSlipAttached.make({
    actor, patientId: report.patientId, correlationId: scanId, occurredAt: now, payload: { scanId, quickId: reportId, matchKind },
  }));
}

/* ═══════════════════════════════ finding the report ═══════════════════════════════ */

type Person = { id: string; name: string; uhid: string; administrativeGender: string; dob: string | null; status: string; mergedInto: string | null };
async function people(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, Person>> {
  if (ids.length === 0) return new Map();
  const rows = await (exec as Db).select().from(patients).where(inArray(patients.id, [...new Set(ids)]));
  return new Map(rows.map((p) => [p.id, {
    id: p.id, name: p.name, uhid: p.uhid, administrativeGender: p.administrativeGender, dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
    status: p.status, mergedInto: p.mergedIntoPatientId,
  }]));
}

/** The open quick reports of the window, for these patients (or anyone), whose tests carry an analyte this slip maps. */
async function openReportsFor(exec: Db | Tx, mappedAnalyteIds: readonly string[], now: Date, patientIds: readonly string[] | null): Promise<ReportRow[]> {
  if (mappedAnalyteIds.length === 0) return [];
  const db = exec as Db;
  const services = new Set((await db.select({ s: labOrderableAnalytes.serviceId }).from(labOrderableAnalytes)
    .where(inArray(labOrderableAnalytes.analyteId, [...mappedAnalyteIds]))).map((r) => r.s));
  const rows = await db.select().from(labQuickReports).where(and(
    inArray(labQuickReports.status, ["waiting", "draft"]), isNull(labQuickReports.handedOverAt), gte(labQuickReports.collectedAt, windowStart(now)),
    patientIds === null ? undefined : inArray(labQuickReports.patientId, [...patientIds]),
  )).orderBy(desc(labQuickReports.collectedAt)).limit(300);
  return rows.filter((r) => (r.tests as QuickChosenTest[]).some((t) => services.has(t.serviceId)));
}

const mappedIds = (rows: readonly SlipRowView[]): string[] =>
  [...new Set(rows.filter((r) => r.analyteId !== null && (r.placement === "placed" || r.placement === "cross_check" || r.placement === "not_placed")).map((r) => r.analyteId!))];

type Resolved =
  | { kind: "sample_no"; report: ReportRow }
  | { kind: "uhid"; patientId: string; reports: ReportRow[] }
  | { kind: "counter" | "none" | "unknown_id" };

/** The exact ID on the slip, resolved: our sample number (one open report), a UHID (a patient, merges followed), or nothing. */
async function resolveId(exec: Db | Tx, header: SlipHeader, rows: readonly SlipRowView[], now: Date): Promise<Resolved> {
  const id = slipIdOf(header);
  if (id === null) return { kind: "none" };
  if (id.counter) return { kind: "counter" };
  const db = exec as Db;
  const [bySample] = await db.select().from(labQuickReports).where(and(
    sql`upper(regexp_replace(${labQuickReports.sampleNo}, '[\\s/-]', '', 'g')) = ${id.id}`,
    inArray(labQuickReports.status, ["waiting", "draft"]), isNull(labQuickReports.handedOverAt),
  )).limit(1);
  if (bySample) return { kind: "sample_no", report: bySample };
  const [byUhid] = await db.select({ id: patients.id }).from(patients)
    .where(sql`upper(regexp_replace(${patients.uhid}, '[\\s/-]', '', 'g')) = ${id.id}`).limit(1);
  if (!byUhid) return { kind: "unknown_id" };
  let survivor = byUhid.id;
  for (let hop = 0; hop < 8; hop += 1) {
    const p = (await people(db, [survivor])).get(survivor);
    if (p?.mergedInto == null) break;
    survivor = p.mergedInto;
  }
  const chain = [survivor, ...(await listMergedLoserIds(db, survivor))];
  return { kind: "uhid", patientId: survivor, reports: await openReportsFor(db, mappedIds(rows), now, chain) };
}

async function candidatesOf(exec: Db | Tx, actor: Actor, header: SlipHeader, reports: readonly ReportRow[]): Promise<SlipCandidate[]> {
  const who = await people(exec, reports.map((r) => r.patientId));
  const raw = reports.map((r) => {
    const p = who.get(r.patientId)!;
    return { r, p, chips: chipsFor(header, p, r.collectedAt) };
  });
  raw.sort((a, b) => chipStrength(b.chips) - chipStrength(a.chips) || b.r.collectedAt.getTime() - a.r.collectedAt.getTime());
  const top = raw.slice(0, CANDIDATE_LIMIT);
  const pick = preselectIndex(top.map((x) => x.chips));
  const rows = await (exec as Db).select().from(patients).where(inArray(patients.id, [...new Set(top.map((x) => x.p.id))]));
  const display = new Map<string, string>();
  for (const p of rows) display.set(p.id, await displayNameFor(exec, actor, p));
  return top.map((x, i) => ({
    quickReportId: x.r.id,
    patient: { id: x.p.id, uhid: x.p.uhid, display: display.get(x.p.id) ?? x.p.uhid, administrativeGender: x.p.administrativeGender, dob: x.p.dob },
    sampleNo: x.r.sampleNo, collectedAt: x.r.collectedAt.toISOString(), status: x.r.status,
    tests: (x.r.tests as QuickChosenTest[]).map((t) => t.code), chips: x.chips, preselected: i === pick,
  }));
}

type Routing = { idKind: SlipIdKind; differences: SlipDifference[]; candidates: ReportRow[]; noOpenReport: boolean; attach: null | { reportId: string; kind: "sample_no" | "uhid" | "from_report" } };

/** Decide, from the slip and the database alone, where a scan goes. Never a guess: an exact ID that agrees, or a person. */
async function route(exec: Db | Tx, scan: ScanRow, header: SlipHeader, rows: readonly SlipRowView[], now: Date): Promise<Routing> {
  const resolved = await resolveId(exec, header, rows, now);
  const idKind: SlipIdKind = resolved.kind === "sample_no" || resolved.kind === "uhid" ? resolved.kind : resolved.kind;
  const agree = async (r: ReportRow): Promise<SlipDifference[]> => {
    const p = (await people(exec, [r.patientId])).get(r.patientId)!;
    return differencesOf(chipsFor(header, p, r.collectedAt));
  };

  if (scan.requestedReportId !== null) {
    const [requested] = await (exec as Db).select().from(labQuickReports).where(eq(labQuickReports.id, scan.requestedReportId));
    if (!requested || !isOpen(requested)) {
      return { idKind, differences: [], candidates: await openReportsFor(exec, mappedIds(rows), now, null), noOpenReport: false, attach: null };
    }
    const diff = await agree(requested);
    const elsewhere = (resolved.kind === "sample_no" && resolved.report.id !== requested.id)
      || (resolved.kind === "uhid" && resolved.patientId !== requested.patientId && !(await listMergedLoserIds(exec as Db, resolved.patientId)).includes(requested.patientId));
    const differences: SlipDifference[] = [...(elsewhere ? ["id" as const] : []), ...diff];
    return differences.length === 0
      ? { idKind, differences, candidates: [], noOpenReport: false, attach: { reportId: requested.id, kind: "from_report" } }
      : { idKind, differences, candidates: [requested], noOpenReport: false, attach: null };
  }

  if (resolved.kind === "sample_no") {
    const diff = await agree(resolved.report);
    return diff.length === 0
      ? { idKind, differences: [], candidates: [], noOpenReport: false, attach: { reportId: resolved.report.id, kind: "sample_no" } }
      : { idKind, differences: diff, candidates: [resolved.report], noOpenReport: false, attach: null };
  }
  if (resolved.kind === "uhid") {
    if (resolved.reports.length === 0) return { idKind, differences: [], candidates: [], noOpenReport: true, attach: null };
    const diffs = await Promise.all(resolved.reports.map(agree));
    const differences = [...new Set(diffs.flat())];
    if (resolved.reports.length === 1 && differences.length === 0) {
      return { idKind, differences: [], candidates: [], noOpenReport: false, attach: { reportId: resolved.reports[0]!.id, kind: "uhid" } };
    }
    return { idKind, differences, candidates: resolved.reports, noOpenReport: false, attach: null };
  }
  return { idKind, differences: [], candidates: await openReportsFor(exec, mappedIds(rows), now, null), noOpenReport: false, attach: null };
}

/* ═══════════════════════════════ reading ═══════════════════════════════ */

async function failRead(db: Db, scanId: string, reason: string, actor: Actor, now: Date): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.update(labSlipScans).set({ status: "failed", error: reason }).where(eq(labSlipScans.id, scanId));
    await appendEvent(tx, labSlipReadFailed.make({ actor, correlationId: scanId, occurredAt: now, payload: { scanId, reason } }));
  });
}

/**
 * Ask the reader, check the reply, map the rows and route the scan. A reply that fails the schema is
 * asked for once more; after that the scan is `failed` (`unreadable_reply`). Never throws: every
 * failure lands on the scan, where the bench sees it and can Read again.
 */
async function performRead(db: Db, deps: SlipDeps, actor: Actor, scanId: string, now: Date): Promise<void> {
  const reader = deps.reader!;
  try {
    const [scan] = await db.select().from(labSlipScans).where(eq(labSlipScans.id, scanId));
    if (!scan) return;
    const instrument = await instrumentOf(db, scan.instrumentId);
    const image = await deps.store.get(scan.storageKey);
    const started = Date.now();
    let reply: SlipReply | null = null;
    let last: { raw: unknown; tokensIn: number | null; tokensOut: number | null } = { raw: null, tokensIn: null, tokensOut: null };
    let tokensIn = 0, tokensOut = 0;
    for (let attempt = 0; attempt < 2 && reply === null; attempt += 1) {
      const got = await reader.read({ image, mimeType: scan.mimeType, analyserName: instrument?.name ?? "analyser" });
      last = got;
      tokensIn += got.tokensIn ?? 0; tokensOut += got.tokensOut ?? 0;
      reply = parseSlipReply(got.text);
    }
    const ms = Date.now() - started;
    const meta = {
      provider: reader.provider, model: reader.model, promptVersion: SLIP_PROMPT_VERSION, latencyMs: ms, tokensIn, tokensOut,
      rawReply: { provider: last.raw, reply },
    };
    if (reply === null) {
      await db.update(labSlipScans).set(meta).where(eq(labSlipScans.id, scanId));
      await failRead(db, scanId, "unreadable_reply", actor, now);
      return;
    }
    const identity: SlipIdentity = { ...reply.header, analyserText: reply.analyserText, rowsMissing: [] };
    await db.update(labSlipScans).set({ ...meta, identity }).where(eq(labSlipScans.id, scanId));
    if (reply.slipKind === "not_a_result_slip") { await failRead(db, scanId, "not_a_result_slip", actor, now); return; }
    const unreadable = reply.rows.filter((r) => r.legible === "unreadable").length;
    if (reply.rows.length === 0 || unreadable * 2 > reply.rows.length) { await failRead(db, scanId, "too_blurred", actor, now); return; }

    await withTx(db, async (tx) => {
      await tx.update(labSlipScans).set({ status: "read", error: null }).where(eq(labSlipScans.id, scanId));
      await syncUnattached(tx, scanId);
      const [read] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, scanId));
      const rows = read!.rows as SlipRowView[];
      await appendEvent(tx, labSlipScanned.make({
        actor, correlationId: scanId, occurredAt: now,
        payload: {
          scanId, source: read!.source as "camera" | "gallery", instrumentId: read!.instrumentId, provider: reader.provider, model: reader.model,
          promptVersion: SLIP_PROMPT_VERSION, rowCount: rows.length, mappedCount: rows.filter((r) => r.analyteId !== null).length,
          checkCount: rows.filter((r) => r.checks.length > 0).length, ms,
        },
      }));
      const r = await route(tx, read!, reply.header, rows, now);
      if (r.attach !== null) await attachInTx(tx, actor, scanId, r.attach.reportId, r.attach.kind, null, now);
      else await tx.update(labSlipScans).set({ status: "waiting" }).where(eq(labSlipScans.id, scanId));
    });
  } catch (e) {
    const reason = e instanceof SlipReadError ? e.reason : e instanceof DocumentStoreError ? "image_missing" : "read_failed";
    try { await failRead(db, scanId, reason, actor, now); } catch { /* the sweep fails a scan left reading */ }
  }
}

async function spentToday(db: Db, now: Date): Promise<number> {
  const { start, end } = istDayWindow(now);
  const rows = await db.select({ model: labSlipScans.model, i: labSlipScans.tokensIn, o: labSlipScans.tokensOut }).from(labSlipScans)
    .where(and(gte(labSlipScans.readStartedAt, start), lt(labSlipScans.readStartedAt, end)));
  return rows.reduce((n, r) => n + slipCostMicroInr(r.model, r.i, r.o), 0);
}

/** Decision 0064's ₹ cap: slip reads count toward it, and at the cap reading pauses until midnight IST. */
async function assertUnderCap(db: Db, deps: SlipDeps, now: Date): Promise<void> {
  const cap = (deps.dailyCapInr ?? SLIP_DAILY_CAP_INR) * 1_000_000;
  const copilot = (await readCopilotGate(db, now)).spentMicroInr;
  if (copilot + (await spentToday(db, now)) >= cap) {
    throw new SlipError("slip_spend_cap", "today's AI spend has reached the cap; type the values — reading resumes at midnight IST");
  }
}

/** The read runs inside the request up to the budget; past it the scan answers `reading` and the phone polls. */
async function readWithin(db: Db, deps: SlipDeps, actor: Actor, scanId: string, now: Date): Promise<void> {
  const reading = performRead(db, deps, actor, scanId, now);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([reading, new Promise<void>((done) => { timer = setTimeout(done, deps.timeoutMs ?? 30_000); })]);
  if (timer !== undefined) clearTimeout(timer);
}

/* ═══════════════════════════════ the routes' work ═══════════════════════════════ */

/** `POST /lab/slips` — store the image, read it, map it, find the report. The same bytes within 7 days return the same scan. */
export async function scanSlip(db: Db, deps: SlipDeps, actor: Actor, input: ScanSlipInput, now: Date = new Date()): Promise<SlipScanView> {
  if (deps.reader === null) throw new SlipError("slip_reading_off", "slip reading is not set up on this server; type the values");
  await assertBench(db, actor);
  if (input.mimeType !== "image/jpeg" && input.mimeType !== "image/png") throw new SlipError("slip_image_invalid", "a slip is a JPEG or PNG photograph");
  if (input.image.length === 0 || !startsLike(input.mimeType, input.image)) throw new SlipError("slip_image_invalid", "the file is not the image it says it is; take the photo again");
  if (input.image.length > SLIP_MAX_BYTES) throw new SlipError("slip_image_too_large", `the slip photo exceeds ${String(SLIP_MAX_BYTES)} bytes; the phone must downscale`);
  const instrument = await instrumentOf(db, input.instrumentId);
  if (instrument === null || !instrument.active) throw new SlipError("instrument_not_found", `no active analyser ${input.instrumentId}`);
  if (input.quickReportId != null) {
    const [r] = await db.select().from(labQuickReports).where(eq(labQuickReports.id, input.quickReportId));
    if (!r) throw new SlipError("report_not_found", `no quick report ${input.quickReportId}`);
    if (!isOpen(r)) throw new SlipError("report_closed", "this report is complete or handed over; a slip cannot fill it");
  }
  const sha256 = createHash("sha256").update(input.image).digest("hex");
  const [same] = await db.select({ id: labSlipScans.id }).from(labSlipScans)
    .where(and(eq(labSlipScans.sha256, sha256), gte(labSlipScans.capturedAt, new Date(now.getTime() - SLIP_DEDUPE_DAYS * DAY_MS))))
    .orderBy(desc(labSlipScans.capturedAt)).limit(1);
  if (same) return getSlipScan(db, actor, same.id, now);
  await assertUnderCap(db, deps, now);

  const id = newId();
  const ext = input.mimeType === "image/png" ? "png" : "jpg";
  const storageKey = `${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
  const taken = input.photoTakenAt == null ? null : new Date(input.photoTakenAt);
  await withTx(db, async (tx) => {
    await tx.insert(labSlipScans).values({
      id, status: "reading", storageKey, mimeType: input.mimeType, byteSize: input.image.length, sha256, source: input.source,
      photoTakenAt: taken !== null && Number.isFinite(taken.getTime()) ? taken : null, capturedBy: actor.id, capturedAt: now, readStartedAt: now,
      instrumentId: input.instrumentId, requestedReportId: input.quickReportId ?? null,
    });
    // Row first, bytes second: a failed put rolls the row back and leaves no file (`patients/documents.ts`).
    await deps.store.put(storageKey, input.image);
  });
  await readWithin(db, deps, actor, id, now);
  return getSlipScan(db, actor, id, now);
}

/** `POST /lab/slips/:id/reread` — the reader again, on the stored image (after a failure, or for a second opinion while waiting). */
export async function rereadSlip(db: Db, deps: SlipDeps, actor: Actor, id: string, now: Date = new Date()): Promise<SlipScanView> {
  if (deps.reader === null) throw new SlipError("slip_reading_off", "slip reading is not set up on this server; type the values");
  await assertBench(db, actor);
  const scan = await scanRow(db, id);
  if (scan.imagePurgedAt !== null) throw new SlipError("slip_image_purged", "this slip's image has been purged");
  if (scan.status !== "failed" && scan.status !== "waiting") throw new SlipError("slip_not_read", `a ${scan.status} slip cannot be read again`);
  await assertUnderCap(db, deps, now);
  await db.update(labSlipScans).set({ status: "reading", error: null, readStartedAt: now }).where(eq(labSlipScans.id, id));
  await readWithin(db, deps, actor, id, now);
  return getSlipScan(db, actor, id, now);
}

async function scanRow(exec: Db | Tx, id: string): Promise<ScanRow> {
  const [scan] = await (exec as Db).select().from(labSlipScans).where(eq(labSlipScans.id, id));
  if (!scan) throw new SlipError("scan_not_found", `no slip scan ${id}`);
  return scan;
}

/** `POST /lab/slips/:id/attach` — a person names the report. A slip that disagrees with it needs an explicit Yes. */
export async function attachSlip(
  db: Db, actor: Actor, id: string, input: { quickReportId: string; confirmed?: boolean }, now: Date = new Date(),
): Promise<SlipScanView> {
  await assertBench(db, actor);
  await withTx(db, async (tx) => {
    const [scan] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, id)).for("update");
    if (!scan) throw new SlipError("scan_not_found", `no slip scan ${id}`);
    if (scan.status === "attached") throw new SlipError("slip_already_attached", "this slip is already attached; detach it first");
    if (scan.status === "discarded") throw new SlipError("slip_discarded", "this slip was discarded");
    if (scan.status !== "waiting" && scan.status !== "read") throw new SlipError("slip_not_read", `a ${scan.status} slip cannot be attached`);
    const [report] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, input.quickReportId));
    if (!report) throw new SlipError("report_not_found", `no quick report ${input.quickReportId}`);
    if (!isOpen(report)) throw new SlipError("report_closed", "this report is complete or handed over; a slip cannot attach to it");
    const header = scan.identity as SlipIdentity;
    const p = (await people(tx, [report.patientId])).get(report.patientId)!;
    const resolved = await resolveId(tx, header, scan.rows as SlipRowView[], now);
    const elsewhere = (resolved.kind === "sample_no" && resolved.report.id !== report.id)
      || (resolved.kind === "uhid" && resolved.patientId !== report.patientId && !(await listMergedLoserIds(tx as unknown as Db, resolved.patientId)).includes(report.patientId));
    const differences: SlipDifference[] = [...(elsewhere ? ["id" as const] : []), ...differencesOf(chipsFor(header, p, report.collectedAt))];
    if (differences.length > 0 && input.confirmed !== true) {
      throw new SlipError("slip_confirm_needed", "this slip disagrees with the patient; confirm it is this patient's slip", { differences });
    }
    const kind = scan.requestedReportId === report.id ? "from_report" : "staff_pick";
    await attachInTx(tx, actor, id, report.id, kind, differences.length > 0 ? `confirmed despite: ${differences.join(", ")}` : null, now);
  });
  return getSlipScan(db, actor, id, now);
}

/** `POST /lab/slips/:id/detach` — only while the report is a draft. The slip's values nobody edited leave; the scan waits again. */
export async function detachSlip(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<SlipScanView> {
  await assertBench(db, actor);
  await withTx(db, async (tx) => {
    const [scan] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, id)).for("update");
    if (!scan) throw new SlipError("scan_not_found", `no slip scan ${id}`);
    if (scan.status !== "attached" || scan.quickReportId === null) throw new SlipError("slip_not_attached", "this slip is not attached");
    const [report] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, scan.quickReportId)).for("update");
    if (!report || !isOpen(report)) throw new SlipError("report_closed", "the report is complete or handed over; its slip stays");
    const kept: { analyteId: string; value: string; slip?: QuickLineSlip }[] = [];
    for (const l of report.lines as QuickLine[]) {
      if (await isFormula(tx, l.analyteId)) continue;
      const mine = l.slip?.scanId === id;
      if (mine && l.slip!.edited !== true && l.slip!.kept !== true) continue;
      kept.push({ analyteId: l.analyteId, value: l.value, ...(l.slip !== undefined && !mine ? { slip: l.slip } : {}) });
    }
    await saveQuickResults(tx, actor, { id: report.id, lines: kept, summary: report.summary, complete: false, origin: "slip" }, now);
    if (kept.length === 0 && report.summary.trim() === "") {
      await tx.update(labQuickReports).set({ status: "waiting", updatedBy: actor.id, updatedAt: now }).where(eq(labQuickReports.id, report.id));
    }
    // A place-into resolution named a field of THIS report; it does not survive the report.
    const rows = (scan.rows as SlipRowView[]).map((r) => (r.resolution?.action === "place" ? { ...r, resolution: null } : r));
    await tx.update(labSlipScans).set({
      status: "waiting", quickReportId: null, matchKind: null, matchedBy: null, matchedAt: null, confirmNote: null, rows,
    }).where(eq(labSlipScans.id, id));
    await syncUnattached(tx, id);
    await appendEvent(tx, labSlipDetached.make({ actor, patientId: report.patientId, correlationId: id, occurredAt: now, payload: { scanId: id, quickId: report.id } }));
  });
  return getSlipScan(db, actor, id, now);
}

export type SlipRowAction =
  | { action: "checked" }
  | { action: "place"; analyteId: string }
  | { action: "ignore"; reason: string }
  | { action: "map"; analyteId: string; unit?: string | null; factor?: string }
  | { action: "ignore_always"; reason: string };

/** `POST /lab/slips/:id/rows/:n` — Checked, Place in…, Ignore (reason), Map for this analyser, Always ignore (both lab head). */
export async function resolveSlipRow(db: Db, actor: Actor, id: string, position: number, act: SlipRowAction, now: Date = new Date()): Promise<SlipScanView> {
  await assertBench(db, actor);
  const scan = await scanRow(db, id);
  if (scan.status === "discarded") throw new SlipError("slip_discarded", "this slip was discarded");
  const row = (scan.rows as SlipRowView[]).find((r) => r.position === position);
  if (row === undefined) throw new SlipError("row_not_found", `slip row ${String(position)} does not exist`);
  const reason = "reason" in act ? act.reason.trim() : null;
  if ((act.action === "ignore" || act.action === "ignore_always") && (reason === null || reason === "")) {
    throw new SlipError("slip_reason_required", "say why this row is ignored");
  }

  if (act.action === "map") {
    await assertManage(db, actor);
    await mapInstrumentCode(db, actor, { instrumentId: scan.instrumentId, instrumentCode: row.code, analyteId: act.analyteId, unit: act.unit ?? row.unit, factor: act.factor ?? "1" });
  } else if (act.action === "ignore_always") {
    await setSlipIgnoredCode(db, actor, { instrumentId: scan.instrumentId, code: row.code, reason: reason! }, now);
  }

  await withTx(db, async (tx) => {
    const [locked] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, id)).for("update");
    const rows = (locked!.rows as SlipRowView[]).map((r) => ({ ...r }));
    const r = rows.find((x) => x.position === position)!;
    if (act.action === "checked") {
      if (r.placement !== "placed" && r.placement !== "cross_check") throw new SlipError("row_not_open", "only a placed or cross-check row is checked");
      r.checked = r.checked ?? { by: actor.id, at: now.toISOString(), via: "tap" };
    } else if (act.action === "ignore") {
      if (r.placement !== "not_placed") throw new SlipError("row_not_open", "only a row that is not placed is ignored");
      r.resolution = { action: "ignore", reason: reason!, by: actor.id, at: now.toISOString() };
      r.placement = "ignored";
    } else if (act.action === "place") {
      if (locked!.status !== "attached" || locked!.quickReportId === null) throw new SlipError("slip_not_attached", "attach the slip to a report before placing a row");
      if (r.placement !== "not_placed") throw new SlipError("row_not_open", "only a row that is not placed is placed by hand");
      const [report] = await tx.select().from(labQuickReports).where(eq(labQuickReports.id, locked!.quickReportId));
      if (!(await reportAnalyteIds(tx, report!.tests as QuickChosenTest[])).includes(act.analyteId)) {
        throw new SlipError("analyte_not_in_report", "place a row only into a parameter of this report");
      }
      r.resolution = { action: "place", analyteId: act.analyteId, by: actor.id, at: now.toISOString() };
    }
    await tx.update(labSlipScans).set({ rows }).where(eq(labSlipScans.id, id));
    if (locked!.status === "attached") await syncAttached(tx, actor, id, now);
    else await syncUnattached(tx, id);
    if (act.action === "place") {
      const [after] = await tx.select({ rows: labSlipScans.rows }).from(labSlipScans).where(eq(labSlipScans.id, id));
      const placed = (after!.rows as SlipRowView[]).find((x) => x.position === position)!;
      if (placed.placement !== "placed" && placed.placement !== "cross_check") {
        throw new SlipError("slip_value_refused", `the value cannot go there: ${placed.reason ?? "refused"}`, { reason: placed.reason });
      }
    }
    await appendEvent(tx, labSlipRowResolved.make({
      actor, correlationId: id, occurredAt: now, payload: { scanId: id, row: position, action: act.action, reason },
    }));
  });
  return getSlipScan(db, actor, id, now);
}

/** `POST /lab/slips/:id/discard` — a reason, always. A record, not a delete: the row and its events stay. */
export async function discardSlip(db: Db, actor: Actor, id: string, reason: string, now: Date = new Date()): Promise<SlipScanView> {
  await assertBench(db, actor);
  const why = reason.trim();
  if (why === "") throw new SlipError("slip_reason_required", "say why this slip is discarded");
  await withTx(db, async (tx) => {
    const [scan] = await tx.select().from(labSlipScans).where(eq(labSlipScans.id, id)).for("update");
    if (!scan) throw new SlipError("scan_not_found", `no slip scan ${id}`);
    if (scan.status === "attached") throw new SlipError("slip_already_attached", "detach the slip from its report before discarding it");
    if (scan.status === "discarded") return;
    await tx.update(labSlipScans).set({ status: "discarded", discardReason: why, discardedBy: actor.id, discardedAt: now }).where(eq(labSlipScans.id, id));
    await appendEvent(tx, labSlipDiscarded.make({ actor, correlationId: id, occurredAt: now, payload: { scanId: id, reason: why } }));
  });
  return getSlipScan(db, actor, id, now);
}

/** Lab head: an analyser prints this code and the report does not carry it. Every scan of that analyser re-maps on its next touch. */
export async function setSlipIgnoredCode(
  db: Db, actor: Actor, input: { instrumentId: string; code: string; reason: string }, now: Date = new Date(),
): Promise<void> {
  await assertManage(db, actor);
  const reason = input.reason.trim();
  if (reason === "") throw new SlipError("slip_reason_required", "say why this analyser's code is ignored");
  if ((await instrumentOf(db, input.instrumentId)) === null) throw new SlipError("instrument_not_found", `no analyser ${input.instrumentId}`);
  await db.insert(labSlipIgnoredCodes).values({ instrumentId: input.instrumentId, code: input.code, reason, setBy: actor.id, setAt: now })
    .onConflictDoUpdate({ target: [labSlipIgnoredCodes.instrumentId, labSlipIgnoredCodes.code], set: { reason, setBy: actor.id, setAt: now } });
}

/** `GET /lab/slips/:id/image` — the stored image, and one PHI access row per read. */
export async function readSlipImage(
  db: Db, store: DocumentStore, actor: Actor, id: string, now: Date = new Date(),
): Promise<{ bytes: Buffer; mimeType: string }> {
  await assertBench(db, actor);
  const scan = await scanRow(db, id);
  if (scan.imagePurgedAt !== null) throw new SlipError("slip_image_purged", "this slip's image was purged after 90 days unattached");
  const bytes = await store.get(scan.storageKey);
  let patientId = `slip:${id}`;
  let sealed = false;
  if (scan.quickReportId !== null) {
    const [r] = await db.select({ patientId: labQuickReports.patientId, sealed: patients.isConfidential }).from(labQuickReports)
      .innerJoin(patients, eq(patients.id, labQuickReports.patientId)).where(eq(labQuickReports.id, scan.quickReportId));
    if (r) { patientId = r.patientId; sealed = r.sealed; }
  }
  // An unattached slip names nobody we know yet; the row is still written, under the scan's own id.
  await recordPhiAccess(db, { actor, patientId, surface: "lab.quick_reports", sealed, reason: null, now });
  return { bytes, mimeType: scan.mimeType };
}

/** `GET /lab/slips?status=waiting` — slips waiting for a patient, newest first. */
export async function listWaitingSlips(db: Db, actor: Actor): Promise<{
  id: string; status: string; capturedAt: string; instrumentName: string; name: string | null; idKind: SlipIdKind; rowCount: number;
}[]> {
  await assertBench(db, actor);
  const rows = await db.select({ s: labSlipScans, name: resources.name }).from(labSlipScans)
    .innerJoin(labInstruments, eq(labInstruments.id, labSlipScans.instrumentId)).innerJoin(resources, eq(resources.id, labInstruments.resourceId))
    .where(eq(labSlipScans.status, "waiting")).orderBy(desc(labSlipScans.capturedAt)).limit(100);
  return rows.map(({ s, name }) => {
    const header = s.identity as SlipIdentity | null;
    const id = header === null ? null : slipIdOf(header);
    return {
      id: s.id, status: s.status, capturedAt: s.capturedAt.toISOString(), instrumentName: name, name: header?.name ?? null,
      idKind: id === null ? "none" : id.counter ? "counter" : "unknown_id", rowCount: (s.rows as SlipRowView[]).length,
    };
  });
}

/** `GET /lab/slips/setup` — is reading on, and which analysers have a code map (the phone's chip row). */
export async function slipSetup(db: Db, reader: SlipReader | null): Promise<{ reading: boolean; analysers: { id: string; name: string }[] }> {
  const rows = await db.selectDistinct({ id: labInstruments.id, name: resources.name }).from(labInstruments)
    .innerJoin(resources, eq(resources.id, labInstruments.resourceId))
    .innerJoin(labInstrumentCodes, eq(labInstrumentCodes.instrumentId, labInstruments.id))
    .where(eq(labInstruments.active, true)).orderBy(asc(resources.name));
  return { reading: reader !== null, analysers: rows };
}

/** `GET /lab/slips/:id` — the scan view: header, rows with their mapping and checks, the match, live candidates. */
export async function getSlipScan(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<SlipScanView> {
  const scan = await scanRow(db, id);
  const instrument = await instrumentOf(db, scan.instrumentId);
  const identity = scan.identity as SlipIdentity | null;
  const header: SlipHeader | null = identity === null ? null
    : { name: identity.name, patientId: identity.patientId, sampleId: identity.sampleId, gender: identity.gender, age: identity.age, printedAt: identity.printedAt };
  const rows = scan.rows as SlipRowView[];
  let routing: Routing | null = null;
  if (header !== null && (scan.status === "waiting" || scan.status === "read")) routing = await route(db, scan, header, rows, now);
  const id0 = header === null ? null : slipIdOf(header);
  const idKind: SlipIdKind = routing?.idKind ?? (id0 === null ? "none" : id0.counter ? "counter" : scan.matchKind === "sample_no" || scan.matchKind === "uhid" ? scan.matchKind : "unknown_id");

  let attached: SlipScanView["attached"] = null;
  if (scan.status === "attached" && scan.quickReportId !== null) {
    const rep = await getQuickReport(db, actor, scan.quickReportId);
    attached = {
      quickReportId: rep.id, matchKind: scan.matchKind!, matchedBy: scan.matchedBy!, matchedAt: scan.matchedAt!.toISOString(),
      confirmNote: scan.confirmNote, patient: rep.patient, sampleNo: rep.sampleNo, tests: rep.tests,
    };
  }
  return {
    id: scan.id, status: scan.status, source: scan.source, instrumentId: scan.instrumentId, instrumentName: instrument?.name ?? "",
    capturedAt: scan.capturedAt.toISOString(), photoTakenAt: scan.photoTakenAt?.toISOString() ?? null,
    provider: scan.provider, model: scan.model, promptVersion: scan.promptVersion, error: scan.error, imagePurged: scan.imagePurgedAt !== null,
    header, rows, counts: slipCounts(rows), rowsMissing: identity?.rowsMissing ?? [],
    match: { idKind, hint: idKind === "none" || idKind === "counter" ? "type_sample_no" : null, noOpenReport: routing?.noOpenReport ?? false },
    requestedReportId: scan.requestedReportId,
    differences: routing?.differences ?? [],
    candidates: routing === null || header === null ? [] : await candidatesOf(db, actor, header, routing.candidates),
    attached,
    discard: scan.status === "discarded" ? { reason: scan.discardReason!, by: scan.discardedBy!, at: scan.discardedAt!.toISOString() } : null,
  };
}

/* ═══════════════════════════════ the lab sweep ═══════════════════════════════ */

/**
 * Run with the lab's SLA sweep (`kernel/worker/jobs.ts`). A read left `reading` for more than two
 * minutes — a restart mid-request — is failed and offers Read again. The image of a scan that was
 * discarded or never attached is removed from the DocumentStore after 90 days; the row, the model's
 * reply and the events stay. An attached scan's image is kept as long as its report.
 */
export async function sweepLabSlips(db: Db, store: DocumentStore, now: Date): Promise<{ failed: number; purged: number }> {
  const stale = await db.select({ id: labSlipScans.id }).from(labSlipScans)
    .where(and(eq(labSlipScans.status, "reading"), lt(labSlipScans.readStartedAt, new Date(now.getTime() - SLIP_STALE_READ_MS)))).limit(200);
  for (const s of stale) await failRead(db, s.id, "timeout", LAB_SLIP_ACTOR, now);

  const old = await db.select({ id: labSlipScans.id, key: labSlipScans.storageKey }).from(labSlipScans).where(and(
    inArray(labSlipScans.status, ["discarded", "waiting", "failed", "read"]), isNull(labSlipScans.imagePurgedAt),
    lt(labSlipScans.capturedAt, new Date(now.getTime() - SLIP_RETAIN_DAYS * DAY_MS)),
  )).limit(200);
  let purged = 0;
  for (const s of old) {
    try { await store.remove(s.key); } catch (e) { if (!(e instanceof DocumentStoreError && e.reason === "not_found")) continue; }
    await db.update(labSlipScans).set({ imagePurgedAt: now }).where(eq(labSlipScans.id, s.id));
    purged += 1;
  }
  return { failed: stale.length, purged };
}
