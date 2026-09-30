import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { doseRegister } from "../../kernel/db/schema/aerb";
import { patients } from "../../kernel/db/schema/patients";
import {
  imagingDoseSrReceipts, imagingStudies, imagingUnmatchedStudies,
} from "../../kernel/db/schema/radiology";
import { displayName } from "../patients";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { RadiologyError } from "./errors";
import { imagingImagesArrived, imagingImagesReconciled } from "./events";
import { isValidDicomUid, mintStudyInstanceUid } from "./uid";
import type { Db, Tx } from "../../kernel/db/client";
import type { UnmatchedStudyReason } from "../../kernel/db/schema/radiology";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS12 — **THE ARCHIVE TALKS BACK: images arrived, dose reports, and the inbox.**
 *
 * ═══ HMIS NEVER CALLS THE PACS; THE BRIDGE ON THE ARCHIVE HOST FORWARDS TO HMIS ═══
 *
 * 18b's worklist is a PULL the bridge makes (`GET /radiology/mwl`). This is the same bridge
 * posting the other way: it polls Orthanc's `/changes` feed for `StableStudy`, fetches
 * `/studies/{id}` and `/studies/{id}/statistics`, and posts them here as they are; for an SR
 * instance whose SOP class is the X-Ray Radiation Dose SR it posts `/instances/{id}/tags?simplify`.
 * No PACS URL is dialled from this process, no worker job exists, `worker.module.ts` is untouched,
 * and a hospital with no archive runs exactly as before: nothing posts, nothing changes.
 * (`docs/runbooks/radiology-pacs-go-live.md` §6 carries the bridge.)
 *
 * The bridge is the `modality_bridge` USER (18b S1: the kernel has no service-account door) and
 * it holds `radiology.pacs.interface` beside `radiology.mwl.read` — two machine permissions, no
 * clinical one.
 *
 * ═══ THE MATCH IS ACCESSION (THEN UID) **AND** THE UHID — NEVER A NAME ═══
 *
 * The worklist put our accession in (0008,0050) and our UHID in (0010,0020); a modality fed by it
 * sends both back. A notice whose accession names a study of a DIFFERENT patient is the wrong-
 * patient image this whole file exists to stop, so it goes to the inbox (`patient_mismatch`) and a
 * human decides. The DICOM PatientName is stored for that human and read by no rule here.
 */

export const PACS_INTERFACE = "radiology.pacs.interface";
export const PACS_RECONCILE = "radiology.pacs.reconcile";

/* ────────────────────────────── the notice shapes (pure) ────────────────────────────── */

const dicomString = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional().nullable();

/** Orthanc `GET /studies/{id}` — only the fields read here; the rest passes through untouched. */
const orthancStudySchema = z.object({
  ID: z.string().optional(),
  MainDicomTags: z.object({
    StudyInstanceUID: dicomString,
    AccessionNumber: dicomString,
    StudyDate: dicomString,
    ModalitiesInStudy: dicomString,
  }).passthrough(),
  PatientMainDicomTags: z.object({ PatientID: dicomString, PatientName: dicomString }).passthrough().optional(),
  Series: z.array(z.string()).optional(),
}).passthrough();

/** Orthanc `GET /studies/{id}/statistics`. */
const orthancStatisticsSchema = z.object({
  CountSeries: z.coerce.number().int().min(0).optional(),
  CountInstances: z.coerce.number().int().min(0).optional(),
}).passthrough();

export const arrivalNoticeBodySchema = z.object({
  study: orthancStudySchema,
  statistics: orthancStatisticsSchema.optional(),
});

export type ArrivalNotice = {
  studyInstanceUid: string;
  accessionNumber: string | null;
  patientId: string | null;
  patientName: string | null;
  modality: string | null;
  /** ISO `YYYY-MM-DD`, from DICOM DA `YYYYMMDD`; null when absent or malformed. */
  studyDate: string | null;
  seriesCount: number;
  instanceCount: number;
  archiveRef: string | null;
};

const blank = (v: string | null | undefined): string | null => (v === undefined || v === null || v === "" ? null : v);

function dicomDate(da: string | null): string | null {
  if (da === null || !/^\d{8}$/.test(da)) return null;
  const iso = `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/**
 * Pure: Orthanc's study JSON (+ statistics) → the notice this file matches. Refuses a notice with
 * no valid Study Instance UID — the idempotency key and the only thing a viewer can open.
 */
export function parseOrthancStudy(body: unknown): ArrivalNotice {
  const parsed = arrivalNoticeBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new RadiologyError("invalid_pacs_notice", `the arrival notice is not an Orthanc study: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
  }
  const { study, statistics } = parsed.data;
  const tags = study.MainDicomTags;
  const uid = blank(tags.StudyInstanceUID);
  if (uid === null || !isValidDicomUid(uid)) {
    throw new RadiologyError("invalid_pacs_notice", `the arrival notice names no valid Study Instance UID (${uid ?? "none"})`);
  }
  const modalities = blank(tags.ModalitiesInStudy);
  return {
    studyInstanceUid: uid,
    accessionNumber: blank(tags.AccessionNumber),
    patientId: blank(study.PatientMainDicomTags?.PatientID),
    patientName: blank(study.PatientMainDicomTags?.PatientName),
    // `CT\SR` — the first is the imaging modality; the dose SR rides as a second series.
    modality: modalities === null ? null : (modalities.split("\\")[0] ?? null),
    studyDate: dicomDate(blank(tags.StudyDate)),
    seriesCount: statistics?.CountSeries ?? study.Series?.length ?? 0,
    instanceCount: statistics?.CountInstances ?? 0,
    archiveRef: blank(study.ID ?? null),
  };
}

/* ─────────────────────────────── the dose SR (pure) ─────────────────────────────── */

/**
 * ═══ THE CODED CONCEPTS READ FROM A RADIATION DOSE SR (DICOM PS3.16, scheme DCM) ═══
 *
 * CT — TID 10011 "CT Radiation Dose":
 *   · 113813 CT Dose Length Product Total (in 113811 CT Accumulated Dose Data)      → DLP, mGy·cm
 *   · 113830 Mean CTDIvol (in each 113819 CT Acquisition › 113829 CT Dose)            → CTDIvol, mGy
 *   · 113838 DLP (per acquisition) — summed only when the total is absent
 * Projection X-ray / fluoroscopy / mammography — TID 10001 "Projection X-Ray Radiation Dose":
 *   · 113722 Dose Area Product Total (in 113702 Accumulated X-Ray Dose Data)         → DAP
 *   · 113730 Total Fluoro Time                                                        → seconds
 *   · 111637 Accumulated Average Glandular Dose (one per breast, TID 10005)          → AGD, mGy
 *   · 113725 Dose (RP) Total — reference-point air kerma Ka,r (18-S RS12b)           → Ka,r, mGy
 *
 * DECIDED (RS12): the register holds ONE row per examination, so a CT's CTDIvol is the HIGHEST
 * Mean CTDIvol of its acquisitions (the value a DRL is compared with and the conservative one),
 * and a mammogram's AGD is the HIGHER of the two breasts' accumulated values (a per-breast DRL
 * compared with a sum of both breasts would read every normal mammogram as twice the level).
 *
 * Units are READ from each item's MeasurementUnitsCodeSequence (UCUM) and converted to the
 * register's (`aerb/units.ts`): the SR's DAP is usually Gy·m², which is 10,000 Gy·cm² — the
 * factor a typed-number register gets wrong by eye. A unit this table does not know drops that
 * number rather than guessing a factor.
 */
export const SR_CODES = {
  ctDlpTotal: "113813",
  ctMeanCtdivol: "113830",
  ctDlpEvent: "113838",
  dapTotal: "113722",
  fluoroTime: "113730",
  agdAccumulated: "111637",
  /** 18-S RS12b — Dose (RP) Total: the interventional unit's cumulative reference-point air kerma. */
  karTotal: "113725",
  ctAccumulated: "113811",
  projectionAccumulated: "113702",
} as const;

/** UCUM unit → factor to the register's unit, per quantity. */
const UNIT_FACTORS: Record<"ctdivol" | "dlp" | "dap" | "fluoro" | "agd" | "kar", Record<string, number>> = {
  ctdivol: { "mGy": 1, "Gy": 1000, "uGy": 0.001 },
  dlp: { "mGy.cm": 1, "Gy.cm": 1000, "mGy.mm": 0.1 },
  dap: { "Gy.m2": 10_000, "dGy.cm2": 0.1, "cGy.cm2": 0.01, "mGy.cm2": 0.001, "uGy.m2": 0.01, "Gy.cm2": 1, "mGy.m2": 10 },
  fluoro: { "s": 1, "min": 60, "ms": 0.001 },
  agd: { "mGy": 1, "dGy": 100, "uGy": 0.001, "Gy": 1000 },
  kar: { "Gy": 1000, "mGy": 1, "dGy": 100, "cGy": 10, "uGy": 0.001 },
};

type SrItem = {
  ValueType?: unknown;
  ConceptNameCodeSequence?: unknown;
  MeasuredValueSequence?: unknown;
  ContentSequence?: unknown;
};

const first = (v: unknown): Record<string, unknown> | null =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null ? v[0] as Record<string, unknown> : null;

function walk(items: unknown, visit: (code: string, item: SrItem) => void): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as SrItem;
    const code = first(item.ConceptNameCodeSequence)?.CodeValue;
    if (typeof code === "string") visit(code.trim(), item);
    walk(item.ContentSequence, visit);
  }
}

function measured(item: SrItem, quantity: keyof typeof UNIT_FACTORS): number | null {
  const mv = first(item.MeasuredValueSequence);
  if (mv === null) return null;
  const value = Number(String(mv.NumericValue ?? "").trim());
  const unit = first(mv.MeasurementUnitsCodeSequence)?.CodeValue;
  const factor = typeof unit === "string" ? UNIT_FACTORS[quantity][unit.trim()] : undefined;
  if (!Number.isFinite(value) || value < 0 || factor === undefined) return null;
  return value * factor;
}

export type DoseSrNotice = {
  sopInstanceUid: string;
  studyInstanceUid: string;
  accessionNumber: string | null;
  patientId: string | null;
  template: "ct_10011" | "projection_10001" | "unknown";
  ctdivol: number | null;
  dlp: number | null;
  dap: number | null;
  fluoroSeconds: number | null;
  agd: number | null;
  /** 18-S RS12b — Ka,r, mGy. Kept with the others, never enough on its own to make a receipt. */
  kar: number | null;
};

export const doseSrBodySchema = z.object({
  /** Orthanc `GET /instances/{id}/tags?simplify` of the SR instance. */
  tags: z.record(z.string(), z.unknown()),
});

const round3 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1000) / 1000);

/** Pure: an SR instance's simplified tags → the numbers the register takes. */
export function parseDoseSr(body: unknown): DoseSrNotice {
  const parsed = doseSrBodySchema.safeParse(body);
  if (!parsed.success) throw new RadiologyError("invalid_pacs_notice", "the dose report carries no DICOM tags");
  const tags = parsed.data.tags;
  const str = (k: string): string | null => {
    const v = tags[k];
    return typeof v === "string" || typeof v === "number" ? blank(String(v).trim()) : null;
  };
  const sop = str("SOPInstanceUID");
  const uid = str("StudyInstanceUID");
  if (sop === null || !isValidDicomUid(sop) || uid === null || !isValidDicomUid(uid)) {
    throw new RadiologyError("invalid_pacs_notice", "the dose report names no valid SOP Instance UID or Study Instance UID");
  }
  const templateId = String(first(tags.ContentTemplateSequence)?.TemplateIdentifier ?? "").trim();

  let dlpTotal: number | null = null;
  let dlpEvents = 0;
  let sawDlpEvent = false;
  let ctdivol: number | null = null;
  let dap: number | null = null;
  let fluoro: number | null = null;
  let agd: number | null = null;
  let kar: number | null = null;
  let sawCt = false;
  let sawProjection = false;
  const max = (a: number | null, b: number | null): number | null => (b === null ? a : a === null ? b : Math.max(a, b));

  walk(tags.ContentSequence, (code, item) => {
    switch (code) {
      case SR_CODES.ctAccumulated: sawCt = true; break;
      case SR_CODES.projectionAccumulated: sawProjection = true; break;
      case SR_CODES.ctDlpTotal: dlpTotal = measured(item, "dlp") ?? dlpTotal; break;
      case SR_CODES.ctDlpEvent: {
        const v = measured(item, "dlp");
        if (v !== null) { dlpEvents += v; sawDlpEvent = true; }
        break;
      }
      case SR_CODES.ctMeanCtdivol: ctdivol = max(ctdivol, measured(item, "ctdivol")); break;
      case SR_CODES.dapTotal: dap = measured(item, "dap") ?? dap; break;
      case SR_CODES.fluoroTime: fluoro = measured(item, "fluoro") ?? fluoro; break;
      case SR_CODES.agdAccumulated: agd = max(agd, measured(item, "agd")); break;
      case SR_CODES.karTotal: kar = measured(item, "kar") ?? kar; break;
      default: break;
    }
  });

  const template = templateId === "10011" || (templateId === "" && sawCt)
    ? "ct_10011"
    : templateId === "10001" || (templateId === "" && sawProjection) ? "projection_10001" : "unknown";
  const out: DoseSrNotice = {
    sopInstanceUid: sop,
    studyInstanceUid: uid,
    accessionNumber: str("AccessionNumber"),
    patientId: str("PatientID"),
    template,
    ctdivol: round3(ctdivol),
    dlp: round3(dlpTotal ?? (sawDlpEvent ? dlpEvents : null)),
    dap: round3(dap),
    // The register keeps whole seconds (an integer column), as the console does.
    fluoroSeconds: fluoro === null ? null : Math.round(fluoro),
    agd: round3(agd),
    kar: round3(kar),
  };
  if ([out.ctdivol, out.dlp, out.dap, out.fluoroSeconds, out.agd].every((v) => v === null)) {
    throw new RadiologyError("invalid_pacs_notice", "the dose report carries no dose this register records (CTDIvol, DLP, DAP, fluoro time or AGD in a known unit)");
  }
  return out;
}

/* ─────────────────────────────── shared reads ─────────────────────────────── */

async function assertMay(exec: Db | Tx, actor: Actor, permission: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(exec, actor.id, permission, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${permission}`, { permission });
  }
}

const sameId = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim().toUpperCase() === b.trim().toUpperCase();

const studyCols = {
  id: imagingStudies.id, accessionNo: imagingStudies.accessionNo, patientId: imagingStudies.patientId,
  encounterNo: imagingStudies.encounterNo, status: imagingStudies.status, imageSource: imagingStudies.imageSource,
  studyInstanceUid: imagingStudies.studyInstanceUid, imagesArrivedAt: imagingStudies.imagesArrivedAt,
  ionising: imagingStudies.ionising, uhid: patients.uhid,
};
type StudyHit = { id: string; accessionNo: string; patientId: string; encounterNo: string; status: string;
  imageSource: string | null; studyInstanceUid: string | null; imagesArrivedAt: Date | null; ionising: boolean; uhid: string | null };

async function studyWhere(tx: Tx, where: ReturnType<typeof eq>): Promise<StudyHit | null> {
  const [row] = await tx.select(studyCols).from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId)).where(where).limit(1);
  return row ?? null;
}

const BEFORE_ACQUISITION = new Set(["scheduled", "checked_in", "ready", "in_acquisition"]);
const CLOSED = new Set(["cancelled", "no_show", "rescheduled"]);

/**
 * The one matching rule, shared by a fresh notice, a re-sent notice and a dose report: the study
 * the accession names (else the one already carrying this UID), and only if the DICOM PatientID is
 * that study's patient's UHID. Pure over what it is handed.
 */
export function matchVerdict(
  n: { studyInstanceUid: string; accessionNumber: string | null; patientId: string | null },
  candidate: StudyHit | null,
  uidOwner: StudyHit | null,
): { kind: "match"; study: StudyHit } | { kind: "unmatched"; reason: UnmatchedStudyReason; candidate: StudyHit | null } {
  if (candidate === null) {
    return { kind: "unmatched", reason: n.accessionNumber === null && n.patientId === null ? "no_identifiers" : "no_match", candidate: null };
  }
  if (!sameId(n.patientId, candidate.uhid)) return { kind: "unmatched", reason: "patient_mismatch", candidate };
  if (CLOSED.has(candidate.status)) return { kind: "unmatched", reason: "study_closed", candidate };
  if (candidate.imageSource === "outside") return { kind: "unmatched", reason: "outside_study", candidate };
  if (uidOwner !== null && uidOwner.id !== candidate.id) return { kind: "unmatched", reason: "uid_mismatch", candidate };
  if (BEFORE_ACQUISITION.has(candidate.status)) return { kind: "unmatched", reason: "awaiting_acquisition", candidate };
  /**
   * An acquired study already holding a DIFFERENT archive study (a CT whose reconstructions came as
   * a second DICOM study under one accession), or a UID the technologist TYPED from the machine
   * that the archive contradicts: a human says which is which. A UID we MINTED (the worklist's) or
   * none at all is our guess, and the archive's answer replaces it.
   */
  if (candidate.imagesArrivedAt !== null && candidate.studyInstanceUid !== n.studyInstanceUid) {
    return { kind: "unmatched", reason: "uid_mismatch", candidate };
  }
  if (candidate.studyInstanceUid !== null && candidate.studyInstanceUid !== n.studyInstanceUid
    && candidate.studyInstanceUid !== mintStudyInstanceUid(candidate.id)) {
    return { kind: "unmatched", reason: "uid_mismatch", candidate };
  }
  return { kind: "match", study: candidate };
}

async function resolveCandidates(
  tx: Tx, n: { studyInstanceUid: string; accessionNumber: string | null },
): Promise<{ candidate: StudyHit | null; uidOwner: StudyHit | null }> {
  const uidOwner = await studyWhere(tx, eq(imagingStudies.studyInstanceUid, n.studyInstanceUid));
  const byAccession = n.accessionNumber === null ? null : await studyWhere(tx, eq(imagingStudies.accessionNo, n.accessionNumber));
  return { candidate: byAccession ?? uidOwner, uidOwner };
}

/** Writes the arrival onto a study: the archive's UID, its counts, `pacs` as the source. */
async function markArrived(
  tx: Tx, actor: Actor, study: StudyHit, n: { studyInstanceUid: string; seriesCount: number; instanceCount: number },
  via: "notice" | "send" | "reconciled", now: Date,
): Promise<void> {
  await tx.update(imagingStudies).set({
    imageSource: "pacs", studyInstanceUid: n.studyInstanceUid, imagesArrivedAt: now,
    imageSeriesCount: n.seriesCount, imageInstanceCount: n.instanceCount,
  }).where(eq(imagingStudies.id, study.id));
  await appendEvent(tx, imagingImagesArrived.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo, correlationId: study.id, occurredAt: now,
    payload: { studyId: study.id, studyInstanceUid: n.studyInstanceUid, instanceCount: n.instanceCount, via },
  }));
  await retryDoseReceipts(tx, actor, study.id, n.studyInstanceUid, now);
}

/* ─────────────────────────────── T1 — the arrival ─────────────────────────────── */

export type ArrivalOutcome =
  | { outcome: "matched"; studyId: string; accessionNo: string; repeat: boolean }
  | { outcome: "unmatched"; unmatchedId: string; reason: UnmatchedStudyReason };

export async function ingestArrival(tx: Tx, actor: Actor, notice: ArrivalNotice, now = new Date()): Promise<ArrivalOutcome> {
  await assertMay(tx, actor, PACS_INTERFACE);
  /** Orthanc's feed is at-least-once and two bridges may race: one notice per UID at a time. */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`radiology.pacs:${notice.studyInstanceUid}`}))`);

  /** Idempotent on the UID: a study already holding these images only has its counts refreshed. */
  const holder = await studyWhere(tx, eq(imagingStudies.studyInstanceUid, notice.studyInstanceUid));
  if (holder !== null && holder.imagesArrivedAt !== null) {
    await tx.update(imagingStudies).set({
      imageSeriesCount: sql`greatest(coalesce(${imagingStudies.imageSeriesCount}, 0), ${notice.seriesCount})`,
      imageInstanceCount: sql`greatest(coalesce(${imagingStudies.imageInstanceCount}, 0), ${notice.instanceCount})`,
    }).where(eq(imagingStudies.id, holder.id));
    return { outcome: "matched", studyId: holder.id, accessionNo: holder.accessionNo, repeat: true };
  }

  const { candidate, uidOwner } = await resolveCandidates(tx, notice);
  const verdict = matchVerdict(notice, candidate, uidOwner);
  const [open] = await tx.select().from(imagingUnmatchedStudies)
    .where(eq(imagingUnmatchedStudies.studyInstanceUid, notice.studyInstanceUid)).for("update");

  if (verdict.kind === "match") {
    await markArrived(tx, actor, verdict.study, notice, "notice", now);
    if (open !== undefined && open.status === "open") {
      await tx.update(imagingUnmatchedStudies).set({
        status: "attached", resolvedStudyId: verdict.study.id, resolvedAt: now, lastSeenAt: now,
        seriesCount: notice.seriesCount, instanceCount: notice.instanceCount,
      }).where(eq(imagingUnmatchedStudies.id, open.id));
    }
    return { outcome: "matched", studyId: verdict.study.id, accessionNo: verdict.study.accessionNo, repeat: false };
  }

  if (open !== undefined) {
    // A row a human already resolved stays resolved; a re-sent notice only refreshes what it saw.
    await tx.update(imagingUnmatchedStudies).set({
      lastSeenAt: now, seriesCount: notice.seriesCount, instanceCount: notice.instanceCount,
      ...(open.status === "open" ? { reason: verdict.reason, candidateStudyId: verdict.candidate?.id ?? null } : {}),
    }).where(eq(imagingUnmatchedStudies.id, open.id));
    return { outcome: "unmatched", unmatchedId: open.id, reason: open.status === "open" ? verdict.reason : open.reason as UnmatchedStudyReason };
  }
  const unmatchedId = newId();
  await tx.insert(imagingUnmatchedStudies).values({
    id: unmatchedId, studyInstanceUid: notice.studyInstanceUid, accessionNumber: notice.accessionNumber,
    dicomPatientId: notice.patientId, dicomPatientName: notice.patientName, modality: notice.modality,
    studyDate: notice.studyDate, seriesCount: notice.seriesCount, instanceCount: notice.instanceCount,
    archiveRef: notice.archiveRef, reason: verdict.reason, candidateStudyId: verdict.candidate?.id ?? null,
    receivedAt: now, lastSeenAt: now,
  });
  return { outcome: "unmatched", unmatchedId, reason: verdict.reason };
}

/**
 * Called by `recordAcquired` BEFORE it writes, for a `pacs` send: the images that reached the
 * archive ahead of Send, held as `awaiting_acquisition` on this study. The rule that put them
 * there already checked the accession and the UHID; the UID they carry is the one Send records
 * when the technologist typed none.
 */
export async function heldArrivalFor(tx: Tx, studyId: string): Promise<{ id: string; studyInstanceUid: string; seriesCount: number; instanceCount: number } | null> {
  const [row] = await tx.select({
    id: imagingUnmatchedStudies.id, studyInstanceUid: imagingUnmatchedStudies.studyInstanceUid,
    seriesCount: imagingUnmatchedStudies.seriesCount, instanceCount: imagingUnmatchedStudies.instanceCount,
  }).from(imagingUnmatchedStudies)
    .where(and(
      eq(imagingUnmatchedStudies.candidateStudyId, studyId),
      eq(imagingUnmatchedStudies.status, "open"),
      eq(imagingUnmatchedStudies.reason, "awaiting_acquisition"),
    ))
    .orderBy(desc(imagingUnmatchedStudies.lastSeenAt)).limit(1).for("update");
  return row ?? null;
}

/** After Send's CAS: attach the held arrival when Send recorded its UID; else leave it for a human. */
export async function attachHeldAtSend(
  tx: Tx, actor: Actor, studyId: string, held: { id: string; studyInstanceUid: string; seriesCount: number; instanceCount: number },
  recordedUid: string | null, now: Date,
): Promise<boolean> {
  if (recordedUid !== held.studyInstanceUid) {
    await tx.update(imagingUnmatchedStudies).set({ reason: "uid_mismatch", lastSeenAt: now })
      .where(eq(imagingUnmatchedStudies.id, held.id));
    return false;
  }
  const study = await studyWhere(tx, eq(imagingStudies.id, studyId));
  if (study === null) return false;
  await markArrived(tx, actor, study, held, "send", now);
  await tx.update(imagingUnmatchedStudies).set({ status: "attached", resolvedStudyId: studyId, resolvedAt: now })
    .where(eq(imagingUnmatchedStudies.id, held.id));
  return true;
}

/* ─────────────────────────────── T2 — the dose report ─────────────────────────────── */

type DoseNumbers = { ctdivol: number | null; dlp: number | null; dap: number | null; fluoroSeconds: number | null; agd: number | null; kar: number | null };
export const DOSE_KEYS = ["ctdivol", "dlp", "dap", "fluoroSeconds", "agd", "kar"] as const;

/**
 * DECIDED (RS12): a typed number and the SR's AGREE when they differ by no more than 2 % of the
 * larger or 0.05 in the register's unit — the console rounds what it shows (CTDIvol 12.4 for
 * 12.37), and a typed DAP out by the Gy·m² factor is a thousand-fold miss, never a rounding.
 * Only quantities BOTH carry are compared; the SR's extra numbers are kept on its receipt.
 */
export function doseDisagreement(typed: DoseNumbers, sr: DoseNumbers): Record<string, { typed: number; sr: number }> | null {
  const out: Record<string, { typed: number; sr: number }> = {};
  for (const k of DOSE_KEYS) {
    const a = typed[k];
    const b = sr[k];
    if (a === null || b === null) continue;
    if (Math.abs(a - b) > Math.max(0.02 * Math.max(Math.abs(a), Math.abs(b)), 0.05)) out[k] = { typed: a, sr: b };
  }
  return Object.keys(out).length === 0 ? null : out;
}

const numOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

function receiptNumbers(r: { doseCtdivol: string | null; doseDlp: string | null; doseDap: string | null; fluoroSeconds: number | null; doseAgd: string | null; doseKar: string | null }): DoseNumbers {
  return { ctdivol: numOrNull(r.doseCtdivol), dlp: numOrNull(r.doseDlp), dap: numOrNull(r.doseDap), fluoroSeconds: r.fluoroSeconds, agd: numOrNull(r.doseAgd), kar: numOrNull(r.doseKar) };
}

/** Where a receipt for this (now known) study stands: compared with the register, pending, or not applicable. */
async function settleReceipt(tx: Tx, studyId: string, sr: DoseNumbers): Promise<{ outcome: "pending" | "confirmed" | "conflict" | "not_applicable"; conflict: Record<string, unknown> | null }> {
  const [study] = await tx.select({ status: imagingStudies.status, ionising: imagingStudies.ionising, imageSource: imagingStudies.imageSource })
    .from(imagingStudies).where(eq(imagingStudies.id, studyId));
  if (study === undefined) return { outcome: "not_applicable", conflict: null };
  if (BEFORE_ACQUISITION.has(study.status)) return { outcome: "pending", conflict: null };
  const [reg] = await tx.select({
    doseCtdivol: doseRegister.doseCtdivol, doseDlp: doseRegister.doseDlp, doseDap: doseRegister.doseDap,
    fluoroSeconds: doseRegister.fluoroSeconds, doseAgd: doseRegister.doseAgd, doseKar: doseRegister.doseKar,
  }).from(doseRegister).where(and(eq(doseRegister.source, "imaging"), eq(doseRegister.sourceRef, studyId)));
  if (reg === undefined) return { outcome: "not_applicable", conflict: null };
  const conflict = doseDisagreement(receiptNumbers(reg), sr);
  return conflict === null ? { outcome: "confirmed", conflict: null } : { outcome: "conflict", conflict };
}

export type DoseSrOutcomeResult = { receiptId: string; outcome: string; studyId: string | null; repeat: boolean };

export async function ingestDoseSr(tx: Tx, actor: Actor, n: DoseSrNotice, now = new Date()): Promise<DoseSrOutcomeResult> {
  await assertMay(tx, actor, PACS_INTERFACE);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`radiology.dose_sr:${n.sopInstanceUid}`}))`);
  const [seen] = await tx.select({ id: imagingDoseSrReceipts.id, outcome: imagingDoseSrReceipts.outcome, studyId: imagingDoseSrReceipts.studyId })
    .from(imagingDoseSrReceipts).where(eq(imagingDoseSrReceipts.sopInstanceUid, n.sopInstanceUid));
  if (seen !== undefined) return { receiptId: seen.id, outcome: seen.outcome, studyId: seen.studyId, repeat: true };

  const { candidate, uidOwner } = await resolveCandidates(tx, n);
  const verdict = matchVerdict(n, candidate, uidOwner);
  // A dose report may arrive before Send (`awaiting_acquisition`): the study is known and right.
  const study = verdict.kind === "match" ? verdict.study
    : verdict.reason === "awaiting_acquisition" ? verdict.candidate : null;
  const settled = study === null ? { outcome: "unmatched" as const, conflict: null } : await settleReceipt(tx, study.id, n);
  const receiptId = newId();
  await tx.insert(imagingDoseSrReceipts).values({
    id: receiptId, sopInstanceUid: n.sopInstanceUid, studyInstanceUid: n.studyInstanceUid,
    accessionNumber: n.accessionNumber, studyId: study?.id ?? null, template: n.template,
    doseCtdivol: n.ctdivol?.toString() ?? null, doseDlp: n.dlp?.toString() ?? null, doseDap: n.dap?.toString() ?? null,
    fluoroSeconds: n.fluoroSeconds, doseAgd: n.agd?.toString() ?? null, doseKar: n.kar?.toString() ?? null,
    outcome: settled.outcome, conflict: settled.conflict, receivedAt: now,
    resolvedAt: settled.outcome === "pending" || settled.outcome === "unmatched" ? null : now,
  });
  return { receiptId, outcome: settled.outcome, studyId: study?.id ?? null, repeat: false };
}

/**
 * For `recordAcquired`: the most recent dose report waiting for this study's Send, as numbers.
 * Send uses it when the technologist typed none — "dose entry becomes a confirmation".
 */
export async function pendingDoseFor(
  exec: Db | Tx, studyId: string, opts: { lock: boolean } = { lock: true },
): Promise<{ receiptIds: string[]; latest: DoseNumbers } | null> {
  const q = (exec as Tx).select().from(imagingDoseSrReceipts)
    .where(and(eq(imagingDoseSrReceipts.studyId, studyId), eq(imagingDoseSrReceipts.outcome, "pending")))
    .orderBy(desc(imagingDoseSrReceipts.receivedAt));
  const rows = opts.lock ? await q.for("update") : await q;
  if (rows.length === 0) return null;
  return { receiptIds: rows.map((r) => r.id), latest: receiptNumbers(rows[0]!) };
}

/** After Send wrote the register: settle every pending receipt of the study against it. */
export async function settlePendingDose(tx: Tx, studyId: string, usedReceiptId: string | null, now: Date): Promise<void> {
  const rows = await tx.select().from(imagingDoseSrReceipts)
    .where(and(eq(imagingDoseSrReceipts.studyId, studyId), eq(imagingDoseSrReceipts.outcome, "pending")));
  for (const r of rows) {
    const settled = r.id === usedReceiptId
      ? { outcome: "recorded" as const, conflict: null }
      : await settleReceipt(tx, studyId, receiptNumbers(r));
    await tx.update(imagingDoseSrReceipts).set({ outcome: settled.outcome, conflict: settled.conflict, resolvedAt: now })
      .where(eq(imagingDoseSrReceipts.id, r.id));
  }
}

/** A study just gained its archive UID: dose reports that arrived before anyone could place them. */
async function retryDoseReceipts(tx: Tx, _actor: Actor, studyId: string, uid: string, now: Date): Promise<void> {
  const rows = await tx.select().from(imagingDoseSrReceipts)
    .where(and(eq(imagingDoseSrReceipts.studyInstanceUid, uid), eq(imagingDoseSrReceipts.outcome, "unmatched")));
  for (const r of rows) {
    const settled = await settleReceipt(tx, studyId, receiptNumbers(r));
    await tx.update(imagingDoseSrReceipts).set({
      studyId, outcome: settled.outcome, conflict: settled.conflict,
      resolvedAt: settled.outcome === "pending" ? null : now,
    }).where(eq(imagingDoseSrReceipts.id, r.id));
  }
}

/* ─────────────────────────────── T3 — the inbox ─────────────────────────────── */

export type InboxRow = {
  id: string; studyInstanceUid: string; accessionNumber: string | null; dicomPatientId: string | null;
  dicomPatientName: string | null; modality: string | null; studyDate: string | null; seriesCount: number;
  instanceCount: number; reason: string; receivedAt: string; lastSeenAt: string;
  candidate: { studyId: string; accessionNo: string; patientName: string; uhid: string; studyTypeCode: string;
    status: string; imageSource: string | null } | null;
};
export type DoseConflictRow = {
  id: string; studyId: string | null; accessionNo: string | null; template: string;
  conflict: Record<string, { typed: number; sr: number }>; receivedAt: string;
};

/** The PACS inbox: open archive studies, dose disagreements, and whether an archive is configured. */
export async function pacsInbox(db: Db, actor: Actor): Promise<{
  configured: boolean; lastArrivalAt: string | null; unmatched: InboxRow[]; doseConflicts: DoseConflictRow[];
  doseUnmatched: number;
}> {
  await assertMay(db, actor, PACS_RECONCILE);
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const rows = await db.select({
    u: imagingUnmatchedStudies,
    studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo, studyTypeCode: imagingStudies.studyTypeCode,
    status: imagingStudies.status, imageSource: imagingStudies.imageSource, patientId: imagingStudies.patientId,
    encounterNo: imagingStudies.encounterNo,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
  }).from(imagingUnmatchedStudies)
    .leftJoin(imagingStudies, eq(imagingStudies.id, imagingUnmatchedStudies.candidateStudyId))
    .leftJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingUnmatchedStudies.status, "open"))
    .orderBy(desc(imagingUnmatchedStudies.receivedAt)).limit(200);

  const unmatched: InboxRow[] = rows.map((r) => {
    const withheld = r.isConfidential === true && !canSeeConfidential;
    return {
      id: r.u.id, studyInstanceUid: r.u.studyInstanceUid, accessionNumber: r.u.accessionNumber,
      dicomPatientId: r.u.dicomPatientId, dicomPatientName: r.u.dicomPatientName, modality: r.u.modality,
      studyDate: r.u.studyDate, seriesCount: r.u.seriesCount, instanceCount: r.u.instanceCount, reason: r.u.reason,
      receivedAt: r.u.receivedAt.toISOString(), lastSeenAt: r.u.lastSeenAt.toISOString(),
      candidate: r.studyId === null || r.name === null
        ? null
        : {
          studyId: r.studyId, accessionNo: r.accessionNo!, studyTypeCode: r.studyTypeCode!, status: r.status!,
          imageSource: r.imageSource, uhid: withheld ? "" : r.uhid ?? "",
          patientName: displayName({ name: r.name, alias: r.alias ?? null, isConfidential: r.isConfidential ?? false }, canSeeConfidential),
        },
    };
  });
  /** One PHI line per candidate patient DISCLOSED (F42's shape), after the rows exist. */
  for (const r of rows) {
    if (r.patientId !== null && r.name !== null) {
      await recordPhiAccess(db, {
        actor, patientId: r.patientId, surface: "imaging.study", encounterId: r.encounterNo ?? undefined,
        reason: `PACS inbox: archive study held against ${r.accessionNo ?? "an accession"}`,
      });
    }
  }

  const conflicts = await db.select({
    id: imagingDoseSrReceipts.id, studyId: imagingDoseSrReceipts.studyId, accessionNo: imagingStudies.accessionNo,
    template: imagingDoseSrReceipts.template, conflict: imagingDoseSrReceipts.conflict, receivedAt: imagingDoseSrReceipts.receivedAt,
  }).from(imagingDoseSrReceipts)
    .leftJoin(imagingStudies, eq(imagingStudies.id, imagingDoseSrReceipts.studyId))
    .where(eq(imagingDoseSrReceipts.outcome, "conflict"))
    .orderBy(desc(imagingDoseSrReceipts.receivedAt)).limit(100);
  const [doseUnmatched] = await db.select({ n: sql<number>`count(*)::int` }).from(imagingDoseSrReceipts)
    .where(eq(imagingDoseSrReceipts.outcome, "unmatched"));
  const [last] = await db.select({ at: sql<Date | null>`max(${imagingStudies.imagesArrivedAt})` }).from(imagingStudies);

  return {
    configured: await pacsArchiveConfigured(db),
    lastArrivalAt: last?.at === null || last?.at === undefined ? null : new Date(last.at).toISOString(),
    unmatched,
    doseConflicts: conflicts.map((c) => ({
      id: c.id, studyId: c.studyId, accessionNo: c.accessionNo, template: c.template,
      conflict: (c.conflict ?? {}) as DoseConflictRow["conflict"], receivedAt: c.receivedAt.toISOString(),
    })),
    doseUnmatched: doseUnmatched?.n ?? 0,
  };
}

const REASON_MAX = 500;
function requireReason(reason: string | undefined | null): string {
  const r = (reason ?? "").trim();
  if (r === "") throw new RadiologyError("reason_required", "say why — the reason is kept with the attach or the reject");
  return r.slice(0, REASON_MAX);
}

async function lockOpen(tx: Tx, unmatchedId: string): Promise<typeof imagingUnmatchedStudies.$inferSelect> {
  const [row] = await tx.select().from(imagingUnmatchedStudies).where(eq(imagingUnmatchedStudies.id, unmatchedId)).for("update");
  if (row === undefined) throw new RadiologyError("unknown_unmatched", "that archive study is no longer in the inbox", { unmatchedId });
  if (row.status !== "open") {
    throw new RadiologyError("already_resolved", `that archive study was already ${row.status}`, { unmatchedId, status: row.status });
  }
  return row;
}

/**
 * A human attaches an archive study to the study it belongs to. DECIDED (RS12): ONE person — a
 * technologist or a radiologist holding `radiology.pacs.reconcile` — with a typed reason, recorded
 * on the row, in an event and in the PHI log; no second person (the standard PACS-administrator
 * practice; the audit, not a second signature, is the control). The target is named by accession,
 * never searched by name.
 */
export async function attachUnmatched(
  tx: Tx, actor: Actor, input: { unmatchedId: string; accessionNo: string; reason: string; now?: Date },
): Promise<{ studyId: string; accessionNo: string }> {
  await assertMay(tx, actor, PACS_RECONCILE);
  const reason = requireReason(input.reason);
  const now = input.now ?? new Date();
  const row = await lockOpen(tx, input.unmatchedId);
  const study = await studyWhere(tx, eq(imagingStudies.accessionNo, input.accessionNo.trim()));
  if (study === null) throw new RadiologyError("unknown_study", `no study has accession ${input.accessionNo}`, { accessionNo: input.accessionNo });
  if (study.imageSource === "outside") {
    throw new RadiologyError("outside_study_only", `${study.accessionNo} is an outside study — its images are the film or CD it came with`);
  }
  if (BEFORE_ACQUISITION.has(study.status) || CLOSED.has(study.status)) {
    throw new RadiologyError(
      "not_acquired",
      `${study.accessionNo} is ${study.status.replace("_", " ")} — the room sends it first; these images then attach themselves if the accession and UHID agree`,
      { studyId: study.id, status: study.status },
    );
  }
  if (study.imagesArrivedAt !== null) {
    throw new RadiologyError("images_already_attached", `${study.accessionNo} already holds a study from the archive — one order, one DICOM study`, { studyId: study.id });
  }
  const owner = await studyWhere(tx, eq(imagingStudies.studyInstanceUid, row.studyInstanceUid));
  if (owner !== null && owner.id !== study.id) {
    throw new RadiologyError("duplicate_study_instance_uid", `this archive study's UID is already recorded on ${owner.accessionNo}`, { studyId: owner.id });
  }
  await markArrived(tx, actor, study, row, "reconciled", now);
  await tx.update(imagingUnmatchedStudies).set({
    status: "attached", resolvedStudyId: study.id, resolvedBy: actor.id, resolvedAt: now, resolutionReason: reason,
  }).where(eq(imagingUnmatchedStudies.id, row.id));
  await appendEvent(tx, imagingImagesReconciled.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo, correlationId: study.id, occurredAt: now,
    payload: { unmatchedId: row.id, outcome: "attached", studyId: study.id, unmatchedReason: row.reason },
  }));
  await recordPhiAccess(tx, {
    actor, patientId: study.patientId, surface: "imaging.study", encounterId: study.encounterNo,
    reason: `archive study attached to ${study.accessionNo} from the PACS inbox`,
  });
  return { studyId: study.id, accessionNo: study.accessionNo };
}

/** A phantom, a QA test, a duplicate send: rejected with a reason. Nothing is deleted, here or in the archive. */
export async function rejectUnmatched(
  tx: Tx, actor: Actor, input: { unmatchedId: string; reason: string; now?: Date },
): Promise<{ unmatchedId: string }> {
  await assertMay(tx, actor, PACS_RECONCILE);
  const reason = requireReason(input.reason);
  const now = input.now ?? new Date();
  const row = await lockOpen(tx, input.unmatchedId);
  await tx.update(imagingUnmatchedStudies).set({
    status: "rejected", resolvedBy: actor.id, resolvedAt: now, resolutionReason: reason,
  }).where(eq(imagingUnmatchedStudies.id, row.id));
  await appendEvent(tx, imagingImagesReconciled.make({
    actor, occurredAt: now,
    payload: { unmatchedId: row.id, outcome: "rejected", studyId: null, unmatchedReason: row.reason },
  }));
  return { unmatchedId: row.id };
}

/**
 * The census's question (`standup-check` `radiology_pacs_configured`): is an archive DECLARED — an
 * active, enabled `pacs_settings` naming its Orthanc (AE title + address)? Until it is, the seams
 * are dormant and the row says "PACS not configured"; nothing else in the department changes.
 */
export async function pacsArchiveConfigured(db: Db): Promise<boolean> {
  const row = await activeDefinitionRow(db, "pacs_settings");
  if (row === undefined) return false;
  const settings = parseDefinitionBody("pacs_settings", row.body);
  return settings.enabled && settings.archive !== undefined;
}

/** For the census and the study screen: open inbox rows, not counting ones the machine will clear at Send. */
export async function openUnmatchedCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(imagingUnmatchedStudies)
    .where(and(eq(imagingUnmatchedStudies.status, "open"), ne(imagingUnmatchedStudies.reason, "awaiting_acquisition")));
  return r?.n ?? 0;
}
