import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import {
  imagingImageViews, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { users } from "../../kernel/db/schema/auth";
import { opdDepartments, opdDoctors } from "../../kernel/db/schema/opd";
import { services } from "../../kernel/db/schema/tariff";
import { displayName, listMergedLoserIds, resolvePatientId } from "../patients";
import { loadOpdConfig } from "../opd";
import { codedLine, CODED_SYSTEMS } from "@hmis/contracts";
import { activeDefinitionRow, parseDefinitionBody, templatesFor } from "./definitions";
import { RadiologyError } from "./errors";
import { activeStudyTypes } from "./study-types";
import { REPORT_TEMPLATES, templateKeyFor } from "./templates";
import { clearanceOf } from "./read";
import { IMAGES_READ } from "./views";
import { ageInYearsOn } from "./applicability";
import type { CodedSystem } from "@hmis/contracts";
import type { GovernedReportTemplate } from "./definitions";
import type { SignerBlock } from "./signer";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS8a — **THE READING ROOM'S READS: one urgency-sorted list, and the study in hand.**
 *
 * `radiology.reports.write` gates both — the reader who writes reports is the reader this room is
 * for. Both log, on the surfaces 18a named: the list writes one `imaging.worklist` row per patient
 * (F42), the study in hand one `imaging.study` row, the print one `imaging.report` row.
 *
 * ═══ THE CLOCKS (board: STAT 30 min, ER 60, IPD 6 h, OPD 24 h) — DECIDED, RS8a ═══
 *
 * There is no source column (no ER or IPD module exists), so the class is derived from what the
 * study carries: `priority = stat` → STAT, 30 min; `priority = urgent` → the ER/urgent class, 60 min
 * (urgent is what the emergency and the wards order); a bedside location → IPD, 6 h; otherwise OPD,
 * 24 h. The clock starts when the images are in (`acquired_at`); a study still on the table has no
 * clock yet and is listed dimmed.
 *
 * ═══ THE LOCK IS DERIVED, NOT CLICKED (the owner's "presence is derived") ═══
 *
 * Opening the images IS the claim: the latest image view on an unsigned study, within the last hour,
 * by somebody who writes reports, is shown as "Dr X is reading". No claim button, no table: the view
 * log (`imaging_image_views`, 18b T3) already records exactly this. It is a label, not a lock — a
 * second radiologist may still read, and sees who was there first.
 */

export const READING_WRITE = "radiology.reports.write";
const READING_STATUSES = ["in_acquisition", "acquired", "reported"] as const;
const CLAIM_WINDOW_MS = 60 * 60_000;

export type TatClass = "stat" | "er" | "ipd" | "opd";
export const TAT_MINUTES: Record<TatClass, number> = { stat: 30, er: 60, ipd: 360, opd: 1440 };

export function tatClassOf(priority: string, bedsideLocation: string | null): TatClass {
  if (priority === "stat") return "stat";
  if (priority === "urgent") return "er";
  if (bedsideLocation !== null && bedsideLocation.trim() !== "") return "ipd";
  return "opd";
}

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1 };

export type ReadingRow = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  studyTypeName: string;
  modality: string;
  bodyPart: string;
  patientId: string;
  patientName: string;
  patientSex: string;
  patientAge: number | null;
  restricted: boolean;
  formFRequired: boolean;
  acquiredAt: Date | null;
  tatClass: TatClass;
  targetMinutes: number;
  /** `acquired_at` + the class's target; null while the images are not in. */
  dueAt: Date | null;
  /** The newest version's state: none, draft, prelim or signed (signed and not yet published). */
  reportState: "none" | "draft" | "prelim" | "signed";
  /** Derived from the image-view log (see the header); null when nobody has the study open. */
  readingBy: { userId: string; name: string; since: Date } | null;
};

async function assertReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not read images`);
  if (!(await hasPermission(db, actor.id, READING_WRITE, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${READING_WRITE}`);
  }
}

export async function readingWorklist(db: Db, actor: Actor, now: Date = new Date()): Promise<ReadingRow[]> {
  await assertReader(db, actor);
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      study: imagingStudies, restricted: orderItems.restricted,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
      sex: patients.sex, dob: patients.dob,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(inArray(imagingStudies.status, [...READING_STATUSES]))
    /** STAT first IN SQL, so the cap can only drop routine work (F43). */
    .orderBy(sql`case when ${imagingStudies.priority} = 'stat' then 0 when ${imagingStudies.priority} = 'urgent' then 1 else 2 end`, imagingStudies.acquiredAt)
    .limit(300);

  const studyIds = rows.map((r) => r.study.id);
  const types = new Map((await activeStudyTypes(db)).map((t) => [t.code, t]));

  /** The newest version per study, for the report state. */
  const versions = studyIds.length === 0 ? [] : await db
    .select({ studyId: imagingReports.studyId, status: imagingReports.status, version: imagingReports.version, provenance: imagingReports.provenance })
    .from(imagingReports)
    .where(inArray(imagingReports.studyId, studyIds))
    .orderBy(desc(imagingReports.version));
  const stateOf = new Map<string, ReadingRow["reportState"]>();
  for (const v of versions) {
    if (stateOf.has(v.studyId)) continue;
    if (v.status === "signed" || v.status === "superseded" || v.status === "amended") stateOf.set(v.studyId, "signed");
    else if (v.status === "prelim") stateOf.set(v.studyId, "prelim");
    else if (v.provenance === null) stateOf.set(v.studyId, "draft");
  }
  /** A signed version anywhere in the chain wins over a later unsigned one (an amendment in progress). */
  for (const v of versions) if (v.status === "signed") stateOf.set(v.studyId, "signed");

  const views = studyIds.length === 0 ? [] : await db
    .select({ studyId: imagingImageViews.studyId, viewerId: imagingImageViews.viewerId, viewedAt: imagingImageViews.viewedAt, name: users.fullName })
    .from(imagingImageViews)
    .innerJoin(users, eq(users.id, imagingImageViews.viewerId))
    .where(and(inArray(imagingImageViews.studyId, studyIds), gte(imagingImageViews.viewedAt, new Date(now.getTime() - CLAIM_WINDOW_MS))))
    .orderBy(desc(imagingImageViews.viewedAt));
  const readers = new Map<string, boolean>();
  const readingBy = new Map<string, ReadingRow["readingBy"]>();
  for (const v of views) {
    if (readingBy.has(v.studyId)) continue;
    if (!readers.has(v.viewerId)) readers.set(v.viewerId, await hasPermission(db, v.viewerId, READING_WRITE, "hospital"));
    if (readers.get(v.viewerId) === true) readingBy.set(v.studyId, { userId: v.viewerId, name: v.name, since: v.viewedAt });
  }

  const out: ReadingRow[] = rows.map((r) => {
    const type = types.get(r.study.studyTypeCode);
    const tatClass = tatClassOf(r.study.priority, r.study.bedsideLocation);
    const targetMinutes = TAT_MINUTES[tatClass];
    const reportState = stateOf.get(r.study.id) ?? "none";
    return {
      studyId: r.study.id, accessionNo: r.study.accessionNo, status: r.study.status, priority: r.study.priority,
      studyTypeCode: r.study.studyTypeCode, studyTypeName: type?.name ?? r.study.studyTypeCode,
      modality: type?.modality ?? "", bodyPart: type?.body_part ?? "",
      patientId: r.study.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
      patientSex: r.sex, patientAge: r.dob === null ? null : ageInYearsOn(r.dob, now),
      restricted: r.restricted, formFRequired: r.study.formFRequired,
      acquiredAt: r.study.acquiredAt, tatClass, targetMinutes,
      dueAt: r.study.acquiredAt === null ? null : new Date(r.study.acquiredAt.getTime() + targetMinutes * 60_000),
      reportState,
      readingBy: reportState === "signed" ? null : readingBy.get(r.study.id) ?? null,
    };
  });

  /**
   * THE ONE ORDER (board: "One list, sorted — never filtered"): studies still on the table last,
   * signed-not-published after the unread, then priority, then the clock.
   */
  out.sort((a, b) => sortKey(a) - sortKey(b) || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
    || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));

  const reason = `reading worklist, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return out;
}

function sortKey(r: ReadingRow): number {
  if (r.acquiredAt === null) return 2;
  return r.reportState === "signed" ? 1 : 0;
}

/* ═══════════════════════════════ the study in hand ═══════════════════════════════ */

export type ReadingTemplate = {
  key: string;
  name: string;
  /** false for the built-in section skeletons (`templates.ts`), used when no governed book is published. */
  governed: boolean;
  sections: { key: string; label: string; normal: string | null }[];
  macros: { key: string; label: string; section: string; text: string }[];
  coded: { system: CodedSystem; required: boolean }[];
};

export type ReadingContext = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  studyTypeName: string;
  modality: string;
  laterality: string;
  bedsideLocation: string | null;
  acquiredAt: Date | null;
  tatClass: TatClass;
  targetMinutes: number;
  dueAt: Date | null;
  clinicalQuestion: string | null;
  /** Ruling 4 — the referrer prints as Doctor ID + department, and is shown the same way here. */
  referrer: { doctorCode: string | null; department: string | null };
  patient: { id: string; name: string; uhid: string; sex: string; age: number | null; flags: string[] };
  priors: { studyId: string; studyTypeName: string; signedAt: Date; impression: string | null; criticalCategory: string | null }[];
  /** The patient's CT dose-length product over 12 months from this department's own studies. */
  cumulativeDlp12m: number | null;
  canOpenImages: boolean;
  templates: ReadingTemplate[];
  defaultTemplateKey: string;
  /** The newest human draft or prelim, to seed the editor; null when there is none. */
  working: { reportId: string; version: number; status: string; templateKey: string; body: Record<string, unknown>; impression: string | null; criticalCategory: string | null } | null;
  /** The current signed version, if any, and whether it is published. */
  signed: { reportId: string; version: number; publishedAt: Date | null } | null;
  readingBy: ReadingRow["readingBy"];
};

function governedToReading(t: GovernedReportTemplate): ReadingTemplate {
  return {
    key: t.key, name: t.name, governed: true,
    sections: t.sections.map((s) => ({ key: s.key, label: s.label, normal: s.normal ?? null })),
    macros: t.macros.map((m) => ({ ...m })),
    coded: t.coded.map((c) => ({ system: c.system, required: c.required })),
  };
}

const BUILT_IN_LABEL: Record<string, string> = {
  indication: "Indication", technique: "Technique", comparison: "Comparison", findings: "Findings",
  biometry: "Biometry", sequences: "Sequences", impression: "Impression", recommendation: "Recommendation",
  birads: "BI-RADS",
};

export async function readingContext(db: Db, actor: Actor, studyId: string, now: Date = new Date()): Promise<ReadingContext | null> {
  await assertReader(db, actor);
  const clearance = await clearanceOf(db, actor);
  const [row] = await db
    .select({
      study: imagingStudies, restricted: orderItems.restricted, indication: orders.indication,
      orderingClinicianId: orders.orderingClinicianId,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
      sex: patients.sex, dob: patients.dob, uhid: patients.uhid,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId));
  if (!row) return null;
  const study = row.study;

  await recordPhiAccess(db, {
    actor, patientId: study.patientId, surface: "imaging.study",
    encounterId: study.encounterNo, reason: `reading room, ${study.accessionNo}`,
  });

  const type = (await activeStudyTypes(db)).find((t) => t.code === study.studyTypeCode);
  const modality = type?.modality ?? "";
  const tatClass = tatClassOf(study.priority, study.bedsideLocation);
  const targetMinutes = TAT_MINUTES[tatClass];

  const referrer = await referrerOf(db, row.orderingClinicianId);

  /** Priors: this patient's (and a merged record's) other signed reports, newest first. */
  const canonical = (await resolvePatientId(db, study.patientId)) ?? study.patientId;
  const chain = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const priorRows = await db
    .select({
      studyId: imagingStudies.id, studyTypeCode: imagingStudies.studyTypeCode, serviceName: services.name,
      signedAt: imagingReports.signedAt, impression: imagingReports.impression, criticalCategory: imagingReports.criticalCategory,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .where(and(
      inArray(imagingStudies.patientId, chain), ne(imagingStudies.id, study.id),
      eq(imagingReports.status, "signed"), isNotNull(imagingReports.signedAt),
    ))
    .orderBy(desc(imagingReports.signedAt))
    .limit(10);

  const [dose] = await db.select({ dlp: sql<string | null>`sum(${imagingStudies.doseDlp})` })
    .from(imagingStudies)
    .where(and(inArray(imagingStudies.patientId, chain), gte(imagingStudies.acquiredAt, new Date(now.getTime() - 365 * 86_400_000))));

  /** The templates: the governed book's for this study, else the built-in skeleton. */
  const bookRow = await activeDefinitionRow(db, "report_templates");
  const governed = bookRow === undefined || type === undefined
    ? []
    : templatesFor(parseDefinitionBody("report_templates", bookRow.body), type.code, type.modality).map(governedToReading);
  const builtInKey = type === undefined ? "general" : templateKeyFor(type.modality, type.body_part);
  const builtIn = REPORT_TEMPLATES.find((t) => t.key === builtInKey) ?? REPORT_TEMPLATES[0]!;
  const fallback: ReadingTemplate = {
    key: builtIn.key, name: builtIn.title, governed: false,
    sections: [...builtIn.sections, ...(builtIn.sections.includes("recommendation") ? [] : ["recommendation"])]
      .filter((k) => k !== "birads")
      .map((k) => ({ key: k, label: BUILT_IN_LABEL[k] ?? k, normal: null })),
    macros: [],
    coded: builtIn.key === "mammography" ? [{ system: "birads", required: false }] : [],
  };
  const templates = governed.length > 0 ? governed : [fallback];

  const versions = await db.select().from(imagingReports)
    .where(eq(imagingReports.studyId, study.id)).orderBy(desc(imagingReports.version));
  const workingRow = versions.find((v) => (v.status === "draft" || v.status === "prelim") && v.provenance === null);
  const signedRow = versions.find((v) => v.status === "signed");

  const views = await db
    .select({ viewerId: imagingImageViews.viewerId, viewedAt: imagingImageViews.viewedAt, name: users.fullName })
    .from(imagingImageViews).innerJoin(users, eq(users.id, imagingImageViews.viewerId))
    .where(and(eq(imagingImageViews.studyId, study.id), gte(imagingImageViews.viewedAt, new Date(now.getTime() - CLAIM_WINDOW_MS))))
    .orderBy(desc(imagingImageViews.viewedAt)).limit(5);
  let readingBy: ReadingRow["readingBy"] = null;
  for (const v of views) {
    if (await hasPermission(db, v.viewerId, READING_WRITE, "hospital")) { readingBy = { userId: v.viewerId, name: v.name, since: v.viewedAt }; break; }
  }

  const flags: string[] = [];
  if (row.isConfidential) flags.push("confidential");
  if (row.restricted) flags.push("restricted");
  if (study.formFRequired) flags.push("pcpndt");
  if (study.contrastGiven) flags.push("contrast_given");
  if (study.bedsideLocation !== null) flags.push("bedside");
  if (study.imageSource === "outside") flags.push("outside");

  return {
    studyId: study.id, accessionNo: study.accessionNo, status: study.status, priority: study.priority,
    studyTypeCode: study.studyTypeCode, studyTypeName: type?.name ?? study.studyTypeCode, modality,
    laterality: study.laterality, bedsideLocation: study.bedsideLocation, acquiredAt: study.acquiredAt,
    tatClass, targetMinutes,
    dueAt: study.acquiredAt === null ? null : new Date(study.acquiredAt.getTime() + targetMinutes * 60_000),
    clinicalQuestion: row.indication,
    referrer,
    patient: {
      id: study.patientId,
      name: displayName({ name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential),
      uhid: row.uhid, sex: row.sex, age: row.dob === null ? null : ageInYearsOn(row.dob, now), flags,
    },
    priors: priorRows.map((p) => ({
      studyId: p.studyId, studyTypeName: p.serviceName, signedAt: p.signedAt!, impression: p.impression, criticalCategory: p.criticalCategory,
    })),
    cumulativeDlp12m: dose?.dlp === null || dose?.dlp === undefined ? null : Number(dose.dlp),
    canOpenImages: await hasPermission(db, actor.id, IMAGES_READ, "hospital"),
    templates,
    defaultTemplateKey: workingRow?.templateKey ?? templates[0]!.key,
    working: workingRow === undefined ? null : {
      reportId: workingRow.id, version: workingRow.version, status: workingRow.status, templateKey: workingRow.templateKey,
      body: workingRow.body as Record<string, unknown>, impression: workingRow.impression, criticalCategory: workingRow.criticalCategory,
    },
    signed: signedRow === undefined ? null : { reportId: signedRow.id, version: signedRow.version, publishedAt: signedRow.publishedAt },
    readingBy,
  };
}

async function referrerOf(db: Db, clinicianId: string | null): Promise<ReadingContext["referrer"]> {
  if (clinicianId === null) return { doctorCode: null, department: null };
  const [doc] = await db.select({ code: opdDoctors.code, department: opdDepartments.name })
    .from(opdDoctors).innerJoin(opdDepartments, eq(opdDepartments.id, opdDoctors.departmentId))
    .where(eq(opdDoctors.userId, clinicianId));
  return { doctorCode: doc?.code ?? null, department: doc?.department ?? null };
}

/* ═══════════════════════════════ the print (ruling 4) ═══════════════════════════════ */

export type ReportPrintView = {
  reportId: string;
  version: number;
  status: string;
  accessionNo: string;
  studyTypeName: string;
  acquiredAt: Date | null;
  signedAt: Date;
  amendmentReason: string | null;
  letterhead: { name: string; addressLines: string[] } | null;
  patient: { name: string; uhid: string; sex: string; age: number | null };
  referrer: ReadingContext["referrer"];
  sections: { key: string; label: string; text: string }[];
  impression: string | null;
  /** "BI-RADS 4A — Low suspicion …", one per coded system the report carries. */
  codedLines: string[];
  criticalCategory: string | null;
  /** Ruling 4 — null only on a version signed before RS8a, which prints "signer details not recorded". */
  signer: SignerBlock | null;
  signerId: string;
};

const SECTION_ORDER = ["indication", "technique", "comparison", "sequences", "findings", "biometry", "recommendation"];

/**
 * The signed document as it prints. A draft or a prelim NEVER prints (the board: "a draft never
 * prints"); a superseded version prints marked as such by the screen. `radiology.reports.read`, the
 * report's own permission.
 */
export async function reportPrintView(db: Db, actor: Actor, reportId: string, now: Date = new Date()): Promise<ReportPrintView | null> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, "radiology.reports.read", "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold radiology.reports.read`);
  }
  const clearance = await clearanceOf(db, actor);
  const [row] = await db
    .select({
      report: imagingReports, study: imagingStudies, orderingClinicianId: orders.orderingClinicianId,
      serviceName: services.name,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
      sex: patients.sex, dob: patients.dob, uhid: patients.uhid,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingReports.id, reportId));
  if (!row || row.report.signedAt === null || row.report.signerId === null
    || !["signed", "superseded", "amended"].includes(row.report.status)) return null;

  await recordPhiAccess(db, {
    actor, patientId: row.study.patientId, surface: "imaging.report",
    encounterId: row.study.encounterNo, reason: `print v${String(row.report.version)} of ${row.study.accessionNo}`,
  });

  const body = (row.report.body ?? {}) as Record<string, unknown>;
  const sections = Object.entries(body)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "" && e[0] !== "impression")
    .sort((a, b) => (SECTION_ORDER.indexOf(a[0]) + 100) % 100 - (SECTION_ORDER.indexOf(b[0]) + 100) % 100)
    .map(([key, text]) => ({ key, label: BUILT_IN_LABEL[key] ?? key, text: text.trim() }));
  const coded = typeof body.coded === "object" && body.coded !== null ? body.coded as Record<string, unknown> : {};
  const codedLines = Object.entries(coded)
    .filter(([system]) => (CODED_SYSTEMS as readonly string[]).includes(system))
    .map(([system, entry]) => {
      const value = typeof entry === "object" && entry !== null && "value" in entry ? (entry as { value: string | number }).value : entry as string | number;
      return value === undefined || value === null || value === "" ? null : codedLine(system as CodedSystem, value);
    })
    .filter((l): l is string => l !== null);

  /**
   * The hospital's one letterhead (`opd_config`), read at print time: an unconfigured letterhead
   * prints the department's name instead of refusing the print — the report is the document.
   */
  const letterhead = await loadOpdConfig(db).then((c) => c.letterhead, () => null);
  return {
    reportId: row.report.id, version: row.report.version, status: row.report.status,
    accessionNo: row.study.accessionNo, studyTypeName: row.serviceName, acquiredAt: row.study.acquiredAt,
    signedAt: row.report.signedAt, amendmentReason: row.report.amendmentReason,
    letterhead: letterhead === null ? null : { name: letterhead.name, addressLines: letterhead.addressLines },
    patient: {
      name: displayName({ name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential),
      uhid: row.uhid, sex: row.sex, age: row.dob === null ? null : ageInYearsOn(row.dob, now),
    },
    referrer: await referrerOf(db, row.orderingClinicianId),
    sections, impression: row.report.impression, codedLines,
    criticalCategory: row.report.criticalCategory,
    signer: (row.report.signer ?? null) as SignerBlock | null,
    signerId: row.report.signerId,
  };
}
