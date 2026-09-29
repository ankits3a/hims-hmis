import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import {
  IMAGING_COLLECTOR_ID_TYPES, IMAGING_COLLECTOR_KINDS, IMAGING_MEDIA_KINDS,
  imagingMediaRequests, imagingReportDelivery, imagingReportHandovers, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orders } from "../../kernel/db/schema/orders";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema/opd";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { notifications } from "../../kernel/db/schema/notifications";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { imagingMediaRequested, imagingReportHandedOver } from "./events";
import { requireReleased, stampFirstRead, treatingDoctorsOf } from "./closed-loop";
import { CD_SERVICE_CODE, FILM_SERVICE_CODE } from "./counter";
import { activeStudyTypes } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS9 T4 — THE REPORT HAND-OVER: ONE RELEASE REGISTER AT THE IMAGING WINDOW ═══
 *
 * Board "Front desk → Report hand-over": one register, rows that need the desk first, nothing
 * filtered away. A row is a study whose CURRENT version is released; what it needs is derived:
 *
 *   · `abnormal_uncollected` — a report with a critical category not handed over 24 h after release
 *     (the board's "abnormal, not opened in 24 h": there is no patient link on main to have been
 *     opened, so the fact the desk can see is that nobody collected it — call the patient);
 *   · `media_to_print` / `media_to_hand` — a film or CD asked for and not yet printed / handed;
 *   · `amended_after_handover` — the patient holds a version that has since been amended;
 *   · `notice_not_sent` — no "report ready" message was recorded (the bill was not settled at
 *     release: `publishReport` sends it only when settled or RED);
 *   · `not_collected` — released and not yet handed over.
 *
 * The hand-over names its collector (the lab's rule, 02 J2, typed here): the patient; a relative with
 * name, relation and the ID they showed (type + last four); ward staff by name; a courier by name.
 * **There is no patient OTP service on main** — DECIDED: the ID record stands in, the OTP is deferred
 * until a provider exists, and the screen says so. `radiology.schedule` is the desk's grant (no new
 * permission): the person who books the scan hands over the report.
 */

export const RELEASE_WINDOW_DAYS = 30;
export const RELEASE_LIMIT = 300;
export const ABNORMAL_UNCOLLECTED_HOURS = 24;

export type ReleaseNeed =
  | "abnormal_uncollected" | "amended_after_handover" | "media_to_print" | "media_to_hand" | "notice_not_sent" | "not_collected";

export type ReleaseHandover = {
  handoverId: string; reportId: string; version: number; collectorKind: string; collectorName: string | null;
  collectorRelation: string | null; filmSheets: number; cd: boolean; handedAt: string;
};
export type ReleaseMedia = {
  requestId: string; kind: string; quantity: number; included: boolean; requestedAt: string;
  printedAt: string | null; handedOver: boolean;
  /** The tariff service the counter bills for a charged request, when the tariff carries it. */
  serviceCode: string | null;
};

export type ReleaseRow = {
  studyId: string;
  reportId: string;
  version: number;
  accessionNo: string;
  studyName: string;
  modality: string;
  patientId: string;
  patientName: string;
  uhid: string;
  publishedAt: string;
  criticalCategory: string | null;
  bedsideLocation: string | null;
  /** The treating doctor's side of the loop, for the "doctor's copy" column. */
  doctor: "unread" | "read" | "acted" | "none";
  /** The patient notice's recorded state, or null when none was recorded. Never "sent" unless the pump says so. */
  notice: string | null;
  /** X-ray: one film is included (ruling 1). */
  filmIncluded: boolean;
  handovers: ReleaseHandover[];
  media: ReleaseMedia[];
  needs: ReleaseNeed[];
};

const NEED_RANK: Record<ReleaseNeed, number> = {
  abnormal_uncollected: 0, amended_after_handover: 1, media_to_print: 2, media_to_hand: 3, notice_not_sent: 4, not_collected: 5,
};

async function modalityLookup(db: Db | Tx): Promise<(code: string) => string> {
  try {
    const types = await activeStudyTypes(db);
    const by = new Map(types.map((t) => [t.code, t.modality as string]));
    return (code) => by.get(code) ?? "other";
  } catch {
    return () => "other";
  }
}

async function tariffMediaCodes(db: Db | Tx): Promise<Set<string>> {
  const rows = await (db as Db).select({ code: services.code }).from(services)
    .where(and(inArray(services.code, [FILM_SERVICE_CODE, CD_SERVICE_CODE]), eq(services.active, true)));
  return new Set(rows.map((r) => r.code));
}

export async function releaseRegister(db: Db, actor: Actor, now: Date = new Date()): Promise<ReleaseRow[]> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "the release register is read by a person");
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const since = new Date(now.getTime() - RELEASE_WINDOW_DAYS * 86_400_000);

  const rows = await db
    .select({
      report: imagingReports, study: imagingStudies, studyName: services.name,
      authority: orders.authority, orderingClinicianId: orders.orderingClinicianId, visitDoctorUserId: opdDoctors.userId,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
      delivery: imagingReportDelivery,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt), gte(imagingReports.publishedAt, since)))
    .orderBy(desc(imagingReports.publishedAt))
    .limit(RELEASE_LIMIT);
  if (rows.length === 0) return [];

  const studyIds = rows.map((r) => r.study.id);
  const reportIds = rows.map((r) => r.report.id);
  const [handRows, versionRows, mediaRows, noticeRows, tariff, modalityOf] = await Promise.all([
    db.select().from(imagingReportHandovers).where(inArray(imagingReportHandovers.studyId, studyIds)),
    db.select({ id: imagingReports.id, version: imagingReports.version }).from(imagingReports).where(inArray(imagingReports.studyId, studyIds)),
    db.select().from(imagingMediaRequests).where(inArray(imagingMediaRequests.studyId, studyIds)),
    db.select({ dedupeKey: notifications.dedupeKey, status: notifications.status }).from(notifications)
      .where(inArray(notifications.dedupeKey, reportIds.map((id) => `imaging_report_ready:${id}`))),
    tariffMediaCodes(db),
    modalityLookup(db),
  ]);
  const versionOf = new Map(versionRows.map((v) => [v.id, v.version]));
  const noticeOf = new Map(noticeRows.map((n) => [n.dedupeKey, n.status]));

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.study.patientId)) continue;
    seen.add(r.study.patientId);
    await recordPhiAccess(db, {
      actor, patientId: r.study.patientId, surface: "imaging.worklist",
      reason: "report hand-over at the imaging desk", now,
    });
  }

  const out = rows.map((r): ReleaseRow => {
    const modality = modalityOf(r.study.studyTypeCode);
    const hands = handRows.filter((h) => h.studyId === r.study.id).sort((a, b) => a.handedAt.getTime() - b.handedAt.getTime());
    const media = mediaRows.filter((m) => m.studyId === r.study.id).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
    const handedCurrent = hands.some((h) => h.reportId === r.report.id);
    const d = r.delivery;
    /** No in-house treating doctor: nobody's read to wait for (the same rule as `treatingDoctorsOf`). */
    const outside = r.orderingClinicianId === null && r.visitDoctorUserId === null;
    const doctor: ReleaseRow["doctor"] = outside ? "none" : d?.actedAt ? "acted" : d?.firstReadAt ? "read" : "unread";
    const notice = noticeOf.get(`imaging_report_ready:${r.report.id}`) ?? null;
    const publishedAt = r.report.publishedAt!;
    const needs: ReleaseNeed[] = [];
    if (!handedCurrent && r.report.criticalCategory !== null
        && now.getTime() - publishedAt.getTime() > ABNORMAL_UNCOLLECTED_HOURS * 3_600_000) needs.push("abnormal_uncollected");
    if (!handedCurrent && hands.length > 0) needs.push("amended_after_handover");
    if (media.some((m) => m.printedAt === null)) needs.push("media_to_print");
    if (media.some((m) => m.printedAt !== null && m.handoverId === null)) needs.push("media_to_hand");
    if (notice === null && !handedCurrent) needs.push("notice_not_sent");
    if (!handedCurrent && hands.length === 0) needs.push("not_collected");
    return {
      studyId: r.study.id, reportId: r.report.id, version: r.report.version, accessionNo: r.study.accessionNo,
      studyName: r.studyName, modality,
      patientId: r.study.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential),
      uhid: r.uhid, publishedAt: publishedAt.toISOString(), criticalCategory: r.report.criticalCategory,
      bedsideLocation: r.study.bedsideLocation, doctor, notice,
      filmIncluded: modality === "xray",
      handovers: hands.map((h) => ({
        handoverId: h.id, reportId: h.reportId, version: versionOf.get(h.reportId) ?? 0,
        collectorKind: h.collectorKind, collectorName: h.collectorName, collectorRelation: h.collectorRelation,
        filmSheets: h.filmSheets, cd: h.cd, handedAt: h.handedAt.toISOString(),
      })),
      media: media.map((m) => {
        const code = m.kind === "cd" ? CD_SERVICE_CODE : FILM_SERVICE_CODE;
        return {
          requestId: m.id, kind: m.kind, quantity: m.quantity, included: m.included,
          requestedAt: m.requestedAt.toISOString(), printedAt: m.printedAt?.toISOString() ?? null,
          handedOver: m.handoverId !== null,
          serviceCode: m.included ? null : tariff.has(code) ? code : null,
        };
      }),
      needs,
    };
  });

  const top = (row: ReleaseRow): number => Math.min(...row.needs.map((n) => NEED_RANK[n]), 99);
  return out.sort((a, b) => top(a) - top(b) || b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * Ruling 1 — film and CD on request. An X-ray's FIRST film sheet is included (`included`, no charge);
 * every other sheet and every CD names the tariff service the counter bills. No money is composed
 * here and no invoice is linked (DD12): the charge goes through billing's own path.
 */
export async function requestMedia(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; kind: string; quantity?: number; now?: Date },
): Promise<{ requestIds: string[]; included: boolean }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "a film or CD is asked for by a person");
  const now = input.now ?? new Date();
  if (!(IMAGING_MEDIA_KINDS as readonly string[]).includes(input.kind)) {
    throw new RadiologyError("evidence_invalid", "Choose a film or a CD.", { kind: input.kind });
  }
  const kind = input.kind as (typeof IMAGING_MEDIA_KINDS)[number];
  const quantity = kind === "cd" ? 1 : (input.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    throw new RadiologyError("evidence_invalid", "Film is asked for in whole sheets, 1 to 20.", { quantity });
  }
  const studyRows = await (tx as unknown as Db).select().from(imagingStudies).where(eq(imagingStudies.id, input.studyId));
  const study = studyRows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`);
  const released = await (tx as unknown as Db).select({ id: imagingReports.id }).from(imagingReports)
    .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt)));
  if (!released[0]) {
    throw new RadiologyError(
      "report_not_published",
      `The ${study.accessionNo} report is not released yet — film and CD are printed with the released report.`,
      { studyId: study.id },
    );
  }

  const modality = (await modalityLookup(tx))(study.studyTypeCode);
  let includedLeft = 0;
  if (kind === "film" && modality === "xray") {
    const prior = await (tx as unknown as Db).select({ id: imagingMediaRequests.id }).from(imagingMediaRequests)
      .where(and(eq(imagingMediaRequests.studyId, study.id), eq(imagingMediaRequests.included, true)));
    includedLeft = prior.length === 0 ? 1 : 0;
  }
  const parts: { quantity: number; included: boolean }[] = [];
  if (includedLeft > 0) parts.push({ quantity: 1, included: true });
  if (quantity - includedLeft > 0) parts.push({ quantity: quantity - includedLeft, included: false });

  const ids: string[] = [];
  for (const p of parts) {
    const id = newId();
    ids.push(id);
    await tx.insert(imagingMediaRequests).values({
      id, studyId: study.id, kind, quantity: p.quantity, included: p.included, requestedBy: actor.id, requestedAt: now,
    });
    await appendEvent(tx, imagingMediaRequested.make({
      actor, patientId: study.patientId, encounterId: study.encounterNo,
      payload: { requestId: id, studyId: study.id, kind, quantity: p.quantity, included: p.included },
    }));
  }
  return { requestIds: ids, included: includedLeft > 0 };
}

/** The film or CD came off the printer. Once; a second mark is `already_resolved`. */
export async function markMediaPrinted(
  tx: Tx, actor: Actor, input: { requestId: string; now?: Date },
): Promise<{ requestId: string; printedAt: Date }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "printing is marked by a person");
  const now = input.now ?? new Date();
  const done = await tx.update(imagingMediaRequests).set({ printedAt: now, printedBy: actor.id })
    .where(and(eq(imagingMediaRequests.id, input.requestId), isNull(imagingMediaRequests.printedAt)))
    .returning({ id: imagingMediaRequests.id });
  if (done.length === 0) {
    const exists = await (tx as unknown as Db).select({ id: imagingMediaRequests.id }).from(imagingMediaRequests)
      .where(eq(imagingMediaRequests.id, input.requestId));
    if (!exists[0]) throw new RadiologyError("unknown_media_request", "That film or CD request is not on the register any more — reload.");
    throw new RadiologyError("already_resolved", "That film or CD is already marked printed.");
  }
  return { requestId: input.requestId, printedAt: now };
}

export type HandoverInput = {
  reportId: string;
  collectorKind: string;
  collectorName?: string | null;
  collectorRelation?: string | null;
  collectorIdType?: string | null;
  collectorIdLast4?: string | null;
  mediaRequestIds?: string[];
  note?: string | null;
  now?: Date;
};

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * ═══ THE HAND-OVER ═══
 *
 * The CURRENT released version only (`report_superseded` names the version to hand instead). The
 * collector is named as their type needs (`collector_details_required` otherwise, and the database
 * CHECKs say the same). Printed film/CD requests of this study may ride along. For a study with no
 * in-house treating doctor (an outside prescription or the patient themself) the hand-over is the
 * report LANDING, so it stamps the first read and the Unread Watchman does not chase a report nobody
 * in the building is waiting for (DECIDED).
 */
export async function handOverReport(
  tx: Tx, actor: Actor, input: HandoverInput,
): Promise<{ handoverId: string; filmSheets: number; cd: boolean }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "a report is handed over by a person");
  const now = input.now ?? new Date();
  const { report, study } = await requireReleased(tx, input.reportId);

  if (!(IMAGING_COLLECTOR_KINDS as readonly string[]).includes(input.collectorKind)) {
    throw new RadiologyError("collector_details_required", "Say who is collecting: the patient, a relative, ward staff or a courier.");
  }
  const kind = input.collectorKind as (typeof IMAGING_COLLECTOR_KINDS)[number];
  const name = trimOrNull(input.collectorName);
  const relation = trimOrNull(input.collectorRelation);
  const idType = trimOrNull(input.collectorIdType);
  const idLast4 = trimOrNull(input.collectorIdLast4);
  if (kind !== "patient" && (name === null || name.length < 2)) {
    throw new RadiologyError("collector_details_required", `Write the name of the ${kind === "ward_staff" ? "ward staff member" : kind} collecting the report.`);
  }
  if (kind === "relative") {
    if (relation === null || relation.length < 2) {
      throw new RadiologyError("collector_details_required", "A relative collects with a relation (spouse, son, daughter, parent…).");
    }
    if (idType === null || !(IMAGING_COLLECTOR_ID_TYPES as readonly string[]).includes(idType) || idLast4 === null || !/^[A-Za-z0-9]{4}$/.test(idLast4)) {
      throw new RadiologyError(
        "collector_details_required",
        "A relative shows an ID: record its type and its last four characters (no patient OTP service exists yet).",
      );
    }
  }

  const mediaIds = [...new Set(input.mediaRequestIds ?? [])];
  let filmSheets = 0;
  let cd = false;
  if (mediaIds.length > 0) {
    const media = await (tx as unknown as Db).select().from(imagingMediaRequests).where(inArray(imagingMediaRequests.id, mediaIds));
    if (media.length !== mediaIds.length || media.some((m) => m.studyId !== study.id)) {
      throw new RadiologyError("unknown_media_request", "A film or CD in this hand-over is not this study's — reload the register.");
    }
    const unprinted = media.find((m) => m.printedAt === null);
    if (unprinted) throw new RadiologyError("evidence_invalid", "A film or CD is handed over once it is printed — mark it printed first.");
    if (media.some((m) => m.handoverId !== null)) throw new RadiologyError("already_resolved", "That film or CD was already handed over.");
    for (const m of media) {
      if (m.kind === "film") filmSheets += m.quantity; else cd = true;
    }
  }

  const handoverId = newId();
  await tx.insert(imagingReportHandovers).values({
    id: handoverId, reportId: report.id, studyId: study.id, collectorKind: kind,
    collectorName: kind === "patient" ? null : name, collectorRelation: kind === "relative" ? relation : null,
    collectorIdType: kind === "relative" ? idType : null, collectorIdLast4: kind === "relative" ? idLast4 : null,
    filmSheets, cd, note: trimOrNull(input.note), handedBy: actor.id, handedAt: now,
  });
  if (mediaIds.length > 0) {
    const bound = await tx.update(imagingMediaRequests).set({ handoverId })
      .where(and(inArray(imagingMediaRequests.id, mediaIds), isNull(imagingMediaRequests.handoverId)))
      .returning({ id: imagingMediaRequests.id });
    if (bound.length !== mediaIds.length) throw new RadiologyError("already_resolved", "That film or CD was already handed over.");
  }

  const treating = await treatingDoctorsOf(tx, study.id);
  if (treating !== null && treating.userIds.length === 0) {
    await stampFirstRead(tx, report.id, actor.id, now);
  }

  await appendEvent(tx, imagingReportHandedOver.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { handoverId, reportId: report.id, studyId: study.id, collectorKind: kind, filmSheets, cd },
  }));
  return { handoverId, filmSheets, cd };
}

/** Rows that still need the desk, for a count in the header. */
export function openNeeds(rows: readonly ReleaseRow[]): number {
  return rows.filter((r) => r.needs.length > 0).length;
}
