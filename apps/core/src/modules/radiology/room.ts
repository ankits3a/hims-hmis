import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { imagingBillDecisions, imagingSafetyScreenings, imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { opdVitals } from "../../kernel/db/schema/opd";
import { events } from "../../kernel/db/schema/events";
import { users } from "../../kernel/db/schema/auth";
import { resources } from "../../kernel/db/schema/resources";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import { displayName, listAllergies } from "../patients";
import { activeDefinitionRow, parseDefinitionBody, protocolFor } from "./definitions";
import { imagingDevices } from "./devices";
import { RadiologyError } from "./errors";
import { imagingExposureRepeated, REPEAT_REASON_CODES } from "./events";
import { clearanceOf } from "./read";
import { activeDoseReferenceLevels, requireStudyType } from "./study-types";
import { mintStudyInstanceUid } from "./uid";
import { pendingDoseFor } from "./pacs";
import type { ImagingDeviceRow } from "./devices";
import type { DoseReferenceLevel, ImagingProtocol } from "./definitions";
import type { RepeatReasonCode } from "./events";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS6 — **THE ROOM CONSOLE'S READ: one study, everything the four steps need.**
 *
 * Identify → Protocol → Acquire → Send. The study screen (`studyView`) answers "what is this study";
 * the console also has to answer "who is on the table and how is it done", and each answer has one
 * owner on the server:
 *
 *   · **the patient in hand** — age and sex from the master, ACTIVE allergies from `listAllergies`
 *     (the same read the contrast gate performs), the last charted weight from OPD vitals, and the
 *     creatinine the `renal_function` gate was satisfied with (the one the prep bay accepted);
 *   · **the protocol** — `protocolFor` over the ACTIVE `imaging_protocols` book; `book: "none"` when
 *     nothing is published, which the console says plainly (the book is guidance, never a gate);
 *   · **the DRL** — the published levels that apply to this examination, so the dose fields can
 *     show the level beside the number. The verdict itself is still `recordAcquired`'s.
 *   · **the repeats so far** on this study, from `imaging.exposure_repeated`.
 *
 * Names go through `displayName`; one `imaging.study` PHI row per read — the surface the study
 * console already logs under, because this is that console.
 */

export type RoomView = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  studyTypeName: string;
  modality: string;
  bodyPart: string;
  contrastOption: "none" | "optional" | "required";
  lateralityApplicable: boolean;
  laterality: string;
  ionising: boolean;
  bedsideLocation: string | null;
  encounterNo: string;
  patientId: string;
  mintedStudyInstanceUid: string;
  patient: {
    name: string;
    uhid: string;
    restricted: boolean;
    ageYears: number | null;
    sex: string;
    allergies: string[];
    weight: { kg: number; recordedAt: Date } | null;
  };
  device: ImagingDeviceRow | null;
  protocol: {
    book: "active" | "none";
    version: number | null;
    matchedOn: "study_type" | "modality" | null;
    protocol: ImagingProtocol | null;
  };
  drl: DoseReferenceLevel[];
  renal: { creatinineUmolL: number | null; egfr: number | null; sampledAt: string | null } | null;
  repeats: { reason: RepeatReasonCode; at: Date }[];
  /**
   * 18-S RS12 — the machine's Radiation Dose SR, when the archive forwarded one before Send. The
   * console then shows it and asks for no typing: Send records these numbers (`dose_sr`).
   */
  doseReport: { ctdivol: number | null; dlp: number | null; dap: number | null; fluoroSeconds: number | null; agd: number | null } | null;
};

/** Whole years between a date of birth and `now`, or null when the master holds no DOB. */
export function ageInYears(dob: Date | null, now: Date): number | null {
  if (dob === null) return null;
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function roomView(db: Db, actor: Actor, studyId: string, now: Date = new Date()): Promise<RoomView> {
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      study: imagingStudies,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
      uhid: patients.uhid, sex: patients.sex, dob: patients.dob,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId));
  const row = rows[0];
  if (!row) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  const study = row.study;
  const studyType = await requireStudyType(db, study.studyTypeCode);

  const allergies = (await listAllergies(db, study.patientId))
    .filter((a) => a.status === "active")
    .map((a) => a.substance);

  const weightRows = await db
    .select({ kg: opdVitals.weightKg, recordedAt: opdVitals.recordedAt })
    .from(opdVitals)
    .where(and(eq(opdVitals.patientId, study.patientId), isNotNull(opdVitals.weightKg)))
    .orderBy(desc(opdVitals.recordedAt))
    .limit(1);
  const w = weightRows[0];

  const devices = study.deviceResourceId === null ? [] : await imagingDevices(db, istDayString(now));
  const device = devices.find((d) => d.id === study.deviceResourceId) ?? null;

  /**
   * The protocol book. A body that no longer parses is REFUSED rather than treated as "no book":
   * `publishDefinition` validated it, so a failure here is data damage, and a console that quietly
   * showed "no protocol" would hide it.
   */
  const bookRow = await activeDefinitionRow(db, "imaging_protocols");
  const match = bookRow === undefined
    ? null
    : protocolFor(parseDefinitionBody("imaging_protocols", bookRow.body), study.studyTypeCode, studyType.modality);

  let drl: DoseReferenceLevel[] = [];
  if (studyType.ionising) {
    try {
      const levels = await activeDoseReferenceLevels(db);
      const own = levels.filter((l) => l.study_type_code === study.studyTypeCode);
      drl = own.length > 0 ? own : levels.filter((l) => l.study_type_code === undefined && l.modality === studyType.modality);
    } catch (e) {
      /** No published DRL book is a fact the dose step states ("no level set"), not an error. */
      if (!(e instanceof RadiologyError && e.code === "definition_not_active")) throw e;
    }
  }

  const renalGate = (await db
    .select({ evidence: imagingSafetyScreenings.evidence })
    .from(imagingSafetyScreenings)
    .where(and(eq(imagingSafetyScreenings.studyId, study.id), eq(imagingSafetyScreenings.kind, "renal_function"))))[0];
  const ev = (renalGate?.evidence ?? null) as Record<string, unknown> | null;
  const renal = renalGate === undefined
    ? null
    : {
      creatinineUmolL: numOrNull(ev?.creatinineUmolL),
      /** RS5 computes eGFR into this evidence; until then the creatinine is what there is. */
      egfr: numOrNull(ev?.egfr) ?? numOrNull(ev?.egfrMlMin173),
      sampledAt: typeof ev?.sampledAt === "string" ? ev.sampledAt : null,
    };

  const repeatRows = await db
    .select({ payload: events.payload, at: events.occurredAt })
    .from(events)
    .where(and(eq(events.name, imagingExposureRepeated.name), eq(events.patientId, study.patientId)))
    .orderBy(events.occurredAt);
  const repeats = repeatRows
    .map((r) => ({ p: imagingExposureRepeated.payloadSchema.parse(r.payload), at: r.at }))
    .filter((r) => r.p.studyId === study.id)
    .map((r) => ({ reason: r.p.reason, at: r.at }));

  await recordPhiAccess(db, {
    actor, patientId: study.patientId, surface: "imaging.study",
    encounterId: study.encounterNo, reason: `room console ${study.accessionNo}`,
  });

  return {
    studyId: study.id,
    accessionNo: study.accessionNo,
    status: study.status,
    priority: study.priority,
    studyTypeCode: study.studyTypeCode,
    studyTypeName: studyType.name,
    modality: studyType.modality,
    bodyPart: studyType.body_part,
    contrastOption: studyType.contrast_option,
    lateralityApplicable: studyType.laterality_applicable,
    laterality: study.laterality,
    ionising: studyType.ionising,
    bedsideLocation: study.bedsideLocation,
    encounterNo: study.encounterNo,
    patientId: study.patientId,
    mintedStudyInstanceUid: mintStudyInstanceUid(study.id),
    patient: {
      name: displayName({ name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential),
      uhid: row.isConfidential && !clearance.canSeeConfidential ? "" : row.uhid,
      restricted: row.isConfidential && !clearance.canSeeConfidential,
      ageYears: ageInYears(row.dob, now),
      sex: row.sex,
      allergies,
      weight: w === undefined || w.kg === null ? null : { kg: w.kg, recordedAt: w.recordedAt },
    },
    device,
    protocol: {
      book: bookRow === undefined ? "none" : "active",
      version: bookRow?.version ?? null,
      matchedOn: match?.matchedOn ?? null,
      protocol: match?.protocol ?? null,
    },
    drl,
    renal,
    repeats,
    doseReport: (await pendingDoseFor(db, study.id, { lock: false }))?.latest ?? null,
  };
}

/**
 * PLAN 18-S RS6 — **REJECTS & REPEATS: the reject analysis, from the facts already recorded.**
 *
 * Per machine and technologist over a window: studies ACQUIRED there (the denominator —
 * `imaging_studies.acquired_by` on the machine) and exposures REPEATED (`imaging.exposure_repeated`,
 * the technologist being the event's actor). The rate is repeats ÷ studies acquired; an exposure
 * count per image needs MPPS from the machine (RS12), so a study is the unit today (DECIDED, RS6).
 *
 * The log names the accession and the study type, never the patient: this is a QA register, and a
 * repeat reason with a name beside it is a disclosure nobody reading the rate needs. The bill
 * decisions the console raised are listed by kind and state only; RESOLVING one stays with
 * `radiology.bill_decisions.manage` (the desk / billing manager) — the performer does not decide
 * who pays.
 */
export type RejectsView = {
  from: string;
  to: string;
  rows: { deviceResourceId: string; deviceCode: string; technologistId: string; technologistName: string; acquired: number; repeats: number }[];
  reasons: { reason: RepeatReasonCode; count: number }[];
  log: { at: Date; studyId: string; accessionNo: string; studyTypeCode: string; deviceCode: string; technologistName: string; reason: RepeatReasonCode }[];
  openDecisions: { id: string; kind: string; studyId: string; accessionNo: string; reason: string | null; raisedAt: Date }[];
};

/** IST calendar days `[from, to]` inclusive, as instants — the dose register's own convention. */
function istRange(from: string, to: string): { lo: Date; hi: Date } {
  const lo = new Date(`${from}T00:00:00+05:30`);
  const hi = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000);
  if (Number.isNaN(lo.getTime()) || Number.isNaN(hi.getTime()) || hi <= lo) {
    throw new RadiologyError("invalid_date", `"${from}" to "${to}" is not a range of days`);
  }
  return { lo, hi };
}

export async function roomRejects(db: Db, opts: { from: string; to: string }): Promise<RejectsView> {
  const { lo, hi } = istRange(opts.from, opts.to);

  const acquired = await db
    .select({ id: imagingStudies.id, device: imagingStudies.deviceResourceId, by: imagingStudies.acquiredBy })
    .from(imagingStudies)
    .where(and(gte(imagingStudies.acquiredAt, lo), lt(imagingStudies.acquiredAt, hi), isNotNull(imagingStudies.deviceResourceId)));

  const evRows = await db
    .select({ payload: events.payload, at: events.occurredAt, actorId: events.actorId })
    .from(events)
    .where(and(eq(events.name, imagingExposureRepeated.name), gte(events.occurredAt, lo), lt(events.occurredAt, hi)))
    .orderBy(desc(events.occurredAt));
  const repeats = evRows.map((r) => ({ ...imagingExposureRepeated.payloadSchema.parse(r.payload), at: r.at, actorId: r.actorId }));

  const deviceIds = [...new Set([...acquired.map((a) => a.device!), ...repeats.map((r) => r.deviceResourceId)])];
  const userIds = [...new Set([...acquired.map((a) => a.by).filter((b): b is string => b !== null), ...repeats.map((r) => r.actorId)])];
  const studyIds = [...new Set(repeats.map((r) => r.studyId))];
  const codeOf = new Map((deviceIds.length === 0 ? [] : await db.select({ id: resources.id, code: resources.code })
    .from(resources).where(inArray(resources.id, deviceIds))).map((d) => [d.id, d.code]));
  const nameOf = new Map((userIds.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName })
    .from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.name]));

  const key = (d: string, u: string) => `${d}|${u}`;
  const cells = new Map<string, { acquired: number; repeats: number }>();
  for (const a of acquired) {
    if (a.by === null) continue;
    const c = cells.get(key(a.device!, a.by)) ?? { acquired: 0, repeats: 0 };
    c.acquired += 1;
    cells.set(key(a.device!, a.by), c);
  }
  for (const r of repeats) {
    const c = cells.get(key(r.deviceResourceId, r.actorId)) ?? { acquired: 0, repeats: 0 };
    c.repeats += 1;
    cells.set(key(r.deviceResourceId, r.actorId), c);
  }
  const rows = [...cells.entries()].map(([k, v]) => {
    const [deviceResourceId, technologistId] = k.split("|") as [string, string];
    return {
      deviceResourceId, deviceCode: codeOf.get(deviceResourceId) ?? "—",
      technologistId, technologistName: nameOf.get(technologistId) ?? "—", ...v,
    };
  }).sort((a, b) => a.deviceCode.localeCompare(b.deviceCode) || a.technologistName.localeCompare(b.technologistName));

  const reasons = REPEAT_REASON_CODES
    .map((reason) => ({ reason, count: repeats.filter((r) => r.reason === reason).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  const openRows = await db
    .select({
      id: imagingBillDecisions.id, kind: imagingBillDecisions.kind, studyId: imagingBillDecisions.studyId,
      detail: imagingBillDecisions.detail, raisedAt: imagingBillDecisions.raisedAt,
    })
    .from(imagingBillDecisions)
    .where(and(
      inArray(imagingBillDecisions.kind, ["repeat_no_charge", "contrast_not_given"]),
      isNull(imagingBillDecisions.resolvedAt),
    ));
  const accStudies = [...new Set([...studyIds, ...openRows.map((o) => o.studyId)])];
  const accOf = new Map((accStudies.length === 0 ? [] : await db.select({ id: imagingStudies.id, acc: imagingStudies.accessionNo })
    .from(imagingStudies).where(inArray(imagingStudies.id, accStudies))).map((s) => [s.id, s.acc]));

  return {
    from: opts.from,
    to: opts.to,
    rows,
    reasons,
    log: repeats.map((r) => ({
      at: r.at, studyId: r.studyId, accessionNo: accOf.get(r.studyId) ?? "—", studyTypeCode: r.studyTypeCode,
      deviceCode: codeOf.get(r.deviceResourceId) ?? "—", technologistName: nameOf.get(r.actorId) ?? "—", reason: r.reason,
    })),
    openDecisions: openRows.map((o) => {
      const reason = (o.detail as { reason?: unknown } | null)?.reason;
      return {
        id: o.id, kind: o.kind, studyId: o.studyId, accessionNo: accOf.get(o.studyId) ?? "—",
        reason: typeof reason === "string" ? reason : null, raisedAt: o.raisedAt,
      };
    }),
  };
}
