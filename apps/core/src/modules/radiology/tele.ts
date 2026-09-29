import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import {
  imagingOutsideStudies, imagingReports, imagingStudies, imagingTeleReads,
} from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { users } from "../../kernel/db/schema/auth";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { imagingOverreadRecorded } from "./events";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { openOverreadReview } from "./peer-review";
import type { TeleradiologyBody } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS8c T3 — NIGHT AND OUTSIDE READS (ruling 7) ═══
 *
 * Ruling 7: *"A contracted Indian provider with NMC-registered radiologists; data stays in India. A
 * DPA under the DPDP Act. Preliminary read within 30 minutes for STAT and 60 for urgent. A consultant
 * over-reads next morning, with discrepancies logged."*
 *
 *   · **Identity.** The active `teleradiology` book lists each provider (DPA date, data in India) and
 *     each of its radiologists as a named HMIS user with an NMC number (`teleReaderOf`). A listed
 *     reader's reports are PRELIM only: `signReport`, `cosignReport` and `amendReport` refuse them
 *     `tele_reader_prelim_only` whatever roles they hold (the identity decides, not the grant).
 *   · **The prelim.** `savePrelim` by a listed reader stamps `external_reporter_id` (the provider's
 *     key — the column 18a reserved for "O-3's outsourced night read") and opens ONE over-read row per
 *     study with a snapshot of the provider, the reader's name and NMC number, and the ruling's clock
 *     (images-in → prelim, 30 min STAT / 60 urgent). A revised prelim moves the row to the newer
 *     version and keeps the first prelim's instant (the clock measured the first answer).
 *   · **The over-read** (`overRead`) — a consultant radiologist, never the reader: CONCUR signs the
 *     prelim's words as the hospital's report; MINOR / MAJOR sign the consultant's corrected words
 *     (or AMEND the report if it was already signed), with a line on what differed. The signed
 *     version is released in the same act. A discrepancy opens a blind peer-review case
 *     (`overread_discrepancy`) and every grade emits `imaging.overread_recorded`. A MAJOR discrepancy
 *     re-opens the treating doctor's loop: the new released version is UNREAD in their results inbox
 *     (RS9 — acts and reads are per version) with the over-read shown beside it; RS8b's critical
 *     ladder is raised by the signature when the consultant marks a critical category.
 *   · **Outside studies** (a film from another centre) are listed for reading here too; they are
 *     reported like our own (18a-iii T4).
 *
 * No money: the provider's per-read fee is a payable under the contract, not a patient charge.
 */

export type TeleReader = {
  provider: { key: string; name: string; dpaSignedOn: string };
  reader: { userId: string; name: string; nmcRegNo: string };
};

/** The listing, or null — read from the ACTIVE book only (a draft names nobody). */
export async function teleReaderOf(exec: Db | Tx, userId: string): Promise<TeleReader | null> {
  const book = await activeTeleBook(exec);
  if (book === null) return null;
  for (const p of book.providers) {
    const r = p.readers.find((x) => x.user_id === userId);
    if (r) return { provider: { key: p.key, name: p.name, dpaSignedOn: p.dpa_signed_on }, reader: { userId: r.user_id, name: r.name, nmcRegNo: r.nmc_reg_no } };
  }
  return null;
}

async function activeTeleBook(exec: Db | Tx): Promise<TeleradiologyBody | null> {
  const row = await activeDefinitionRow(exec as Db, "teleradiology");
  return row === undefined ? null : parseDefinitionBody("teleradiology", row.body);
}

/** `signReport` / `cosignReport` / `amendReport` / `overRead`: a night-read partner's radiologist never signs. */
export async function assertNotTeleReader(exec: Db | Tx, actor: Actor, act: "sign" | "co-sign" | "amend" | "over-read"): Promise<void> {
  if (actor.type !== "user") return;
  const t = await teleReaderOf(exec, actor.id);
  if (t === null) return;
  throw new RadiologyError(
    "tele_reader_prelim_only",
    `${t.reader.name} reads for ${t.provider.name}, the night-read partner — their report is a PRELIM. `
    + `A consultant of this hospital ${act === "over-read" ? "over-reads" : "signs"} it in the morning (Reading room → Night & outside).`,
    { act, providerKey: t.provider.key },
  );
}

/**
 * `savePrelim`, after its insert, when the actor is a listed reader. One awaiting row per study: a
 * revised prelim points the row at the newer version.
 */
export async function openTeleRead(
  tx: Tx, tele: TeleReader, study: typeof imagingStudies.$inferSelect, prelimReportId: string, now: Date,
): Promise<void> {
  const book = await activeTeleBook(tx);
  const target = study.priority === "stat" ? book?.prelim_minutes.stat ?? 30 : study.priority === "urgent" ? book?.prelim_minutes.urgent ?? 60 : null;
  const moved = await tx.update(imagingTeleReads).set({ prelimReportId })
    .where(and(eq(imagingTeleReads.studyId, study.id), eq(imagingTeleReads.state, "awaiting")))
    .returning({ id: imagingTeleReads.id });
  if (moved.length > 0) return;
  await tx.insert(imagingTeleReads).values({
    id: newId(), studyId: study.id, prelimReportId,
    providerKey: tele.provider.key, providerName: tele.provider.name,
    readerId: tele.reader.userId, readerName: tele.reader.name, readerNmcNo: tele.reader.nmcRegNo,
    priority: study.priority, targetMinutes: target, imagesAt: study.acquiredAt ?? null, prelimAt: now,
  });
}

/* ═══════════════════════════════ the over-read ═══════════════════════════════ */

export type OverreadGrade = "concur" | "minor" | "major";
export const OVERREAD_NOTE_MIN = 4;

/**
 * The signing half is injected (`reports.ts` owns signing, drafting, amending and publishing; it
 * imports this file, so this file does not import it back).
 */
export type OverreadSigning = {
  latestSigned: (tx: Tx, studyId: string) => Promise<{ id: string; templateKey: string; body: unknown; laterality: string | null; publishedAt: Date | null } | undefined>;
  draft: (content: { templateKey: string; body: Record<string, unknown>; impression: string | null; laterality: string | null }) => Promise<{ reportId: string }>;
  sign: (reportId: string) => Promise<{ reportId: string }>;
  amend: (content: { templateKey: string; body: Record<string, unknown>; impression: string | null; laterality: string | null; reason: string }) => Promise<{ reportId: string }>;
  publish: () => Promise<unknown>;
};

export async function overRead(
  tx: Tx,
  actor: Actor,
  input: {
    teleReadId: string; grade: string; note?: string | null;
    /** MINOR / MAJOR: the consultant's words. Findings default to the prelim's; the impression is required. */
    findings?: string | null; impression?: string | null;
    now?: Date;
  },
  signing: OverreadSigning,
): Promise<{ teleReadId: string; grade: OverreadGrade; finalReportId: string }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "an over-read is a consultant's act");
  if (!["concur", "minor", "major"].includes(input.grade)) {
    throw new RadiologyError("evidence_invalid", "Grade the night read: concur, minor discrepancy or major discrepancy.", { grade: input.grade });
  }
  const grade = input.grade as OverreadGrade;
  await assertNotTeleReader(tx, actor, "over-read");
  if (!(await actorHoldsAnyRole(tx, actor.id, ["radiologist"]))) {
    throw new RadiologyError(
      "overread_not_consultant",
      "The morning over-read is a consultant radiologist's — ask the consultant on the list to over-read it.",
    );
  }
  const note = input.note?.trim() ?? "";
  const impression = input.impression?.trim() ?? "";
  if (grade !== "concur" && note.length < OVERREAD_NOTE_MIN) {
    throw new RadiologyError("reason_required", "Say in one line what the night read got wrong — it goes to the discrepancy log.", { min: OVERREAD_NOTE_MIN });
  }
  if (grade !== "concur" && impression.length === 0) {
    throw new RadiologyError("impression_required", "A discrepancy is corrected in the report: write your impression.");
  }

  const rows = await (tx as unknown as Db).select().from(imagingTeleReads)
    .where(eq(imagingTeleReads.id, input.teleReadId)).for("update");
  const tele = rows[0];
  if (!tele) throw new RadiologyError("unknown_tele_read", "That night read is not on the list — reload it.", { teleReadId: input.teleReadId });
  if (tele.state !== "awaiting") {
    throw new RadiologyError("already_resolved", "A consultant has already over-read this night read.", { teleReadId: tele.id, state: tele.state });
  }
  const [prelim] = await (tx as unknown as Db).select().from(imagingReports).where(eq(imagingReports.id, tele.prelimReportId));
  const prelimBody = (prelim!.body ?? {}) as Record<string, unknown>;

  const signed = await signing.latestSigned(tx, tele.studyId);
  let finalReportId: string;
  if (signed === undefined) {
    if (grade === "concur") {
      finalReportId = (await signing.sign(prelim!.id)).reportId;
    } else {
      const findings = input.findings?.trim() ? input.findings.trim() : prelimBody.findings;
      const d = await signing.draft({
        templateKey: prelim!.templateKey,
        body: { ...prelimBody, ...(findings !== undefined ? { findings } : {}) },
        impression, laterality: prelim!.laterality,
      });
      finalReportId = (await signing.sign(d.reportId)).reportId;
    }
    await signing.publish();
  } else if (grade === "concur") {
    finalReportId = signed.id;
  } else {
    const base = (signed.body ?? {}) as Record<string, unknown>;
    const findings = input.findings?.trim() ? input.findings.trim() : base.findings;
    finalReportId = (await signing.amend({
      templateKey: signed.templateKey,
      body: { ...base, ...(findings !== undefined ? { findings } : {}) },
      impression, laterality: signed.laterality,
      reason: `Over-read of the night prelim (${tele.providerName}): ${grade} discrepancy — ${note}`,
    })).reportId;
    if (signed.publishedAt === null) await signing.publish();
  }

  const now = input.now ?? new Date();
  const done = await tx.update(imagingTeleReads).set({
    state: grade, overreadBy: actor.id, overreadAt: now, overreadNote: note === "" ? null : note, finalReportId,
  }).where(and(eq(imagingTeleReads.id, tele.id), eq(imagingTeleReads.state, "awaiting")))
    .returning({ id: imagingTeleReads.id });
  if (done.length === 0) throw new RadiologyError("stale_state", "Another consultant over-read this a moment ago — reload.", { teleReadId: tele.id });
  if (grade !== "concur") {
    await openOverreadReview(tx, { reportId: tele.prelimReportId, studyId: tele.studyId, readerId: tele.readerId });
  }
  const [study] = await (tx as unknown as Db).select({ patientId: imagingStudies.patientId }).from(imagingStudies).where(eq(imagingStudies.id, tele.studyId));
  await appendEvent(tx, imagingOverreadRecorded.make({
    actor, patientId: study?.patientId,
    payload: { teleReadId: tele.id, studyId: tele.studyId, grade, finalReportId, providerKey: tele.providerKey },
  }));
  return { teleReadId: tele.id, grade, finalReportId };
}

/* ═══════════════════════════════ the read ═══════════════════════════════ */

export type TeleQueueRow = {
  teleReadId: string;
  studyId: string;
  accessionNo: string;
  patientName: string;
  uhid: string;
  studyName: string;
  priority: string;
  providerName: string;
  readerName: string;
  readerNmcNo: string;
  prelimAt: string;
  imagesAt: string | null;
  /** images-in → first prelim, whole minutes; null without an images instant. */
  tatMinutes: number | null;
  targetMinutes: number | null;
  late: boolean;
  prelim: { findings: string | null; impression: string | null };
  state: string;
  overread: { at: string; by: string | null; note: string | null } | null;
};

export type TeleBoard = {
  configured: boolean;
  coverage: { nightFrom: string; nightTo: string; overreadBy: string; prelimMinutes: { stat: number; urgent: number } } | null;
  providers: { key: string; name: string; dpaSignedOn: string; readers: number }[];
  queue: TeleQueueRow[];
  log: TeleQueueRow[];
  outside: { studyId: string; accessionNo: string; patientName: string; studyName: string; centreName: string; studyDate: string; state: string }[];
  summary: { prelims30: number; medianTat30: number | null; late30: number; minor30: number; major30: number; awaiting: number };
};

export const TELE_LOG_DAYS = 30;

export async function teleBoard(db: Db, actor: Actor, now: Date = new Date()): Promise<TeleBoard> {
  const book = await activeTeleBook(db);
  const canSeeConfidential = actor.type === "user" && await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const since = new Date(now.getTime() - TELE_LOG_DAYS * 86_400_000);
  const rows = await db.select({
    t: imagingTeleReads, accessionNo: imagingStudies.accessionNo, patientId: imagingStudies.patientId, studyName: services.name,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
    impression: imagingReports.impression, body: imagingReports.body, overreaderName: users.fullName,
  })
    .from(imagingTeleReads)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingTeleReads.studyId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(imagingReports, eq(imagingReports.id, imagingTeleReads.prelimReportId))
    .leftJoin(users, eq(users.id, imagingTeleReads.overreadBy))
    .where(gte(imagingTeleReads.prelimAt, since))
    .orderBy(asc(imagingTeleReads.prelimAt))
    .limit(500);
  const awaitingOlder = await db.select({ id: imagingTeleReads.id }).from(imagingTeleReads)
    .where(and(eq(imagingTeleReads.state, "awaiting")));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.patientId)) continue;
    seen.add(r.patientId);
    await recordPhiAccess(db, { actor, patientId: r.patientId, surface: "imaging.report", reason: "the night-read over-read queue", now });
  }
  const view = rows.map((r): TeleQueueRow => {
    const t = r.t;
    const tat = t.imagesAt === null ? null : Math.max(0, Math.round((t.prelimAt.getTime() - t.imagesAt.getTime()) / 60_000));
    const body = (r.body ?? {}) as Record<string, unknown>;
    return {
      teleReadId: t.id, studyId: t.studyId, accessionNo: r.accessionNo,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential),
      uhid: r.uhid, studyName: r.studyName, priority: t.priority, providerName: t.providerName,
      readerName: t.readerName, readerNmcNo: t.readerNmcNo, prelimAt: t.prelimAt.toISOString(),
      imagesAt: t.imagesAt?.toISOString() ?? null, tatMinutes: tat, targetMinutes: t.targetMinutes,
      late: tat !== null && t.targetMinutes !== null && tat > t.targetMinutes,
      prelim: { findings: typeof body.findings === "string" ? body.findings : null, impression: r.impression ?? null },
      state: t.state,
      overread: t.overreadAt !== null ? { at: t.overreadAt.toISOString(), by: r.overreaderName ?? null, note: t.overreadNote } : null,
    };
  });
  /** Awaiting rows older than the log window still belong in the queue. */
  const extraIds = awaitingOlder.map((a) => a.id).filter((id) => !view.some((v) => v.teleReadId === id));
  const extra = extraIds.length === 0 ? [] : (await teleRowsById(db, actor, extraIds, canSeeConfidential, now));
  const queue = [...extra, ...view.filter((v) => v.state === "awaiting")];
  const log = view.filter((v) => v.state !== "awaiting").reverse();
  const tats = view.map((v) => v.tatMinutes).filter((x): x is number => x !== null).sort((a, b) => a - b);

  const outsideRows = await db.select({
    studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo, status: imagingStudies.status,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, studyName: services.name,
    centreName: imagingOutsideStudies.centreName, studyDate: imagingOutsideStudies.studyDate,
  })
    .from(imagingOutsideStudies)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingOutsideStudies.studyId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .where(inArray(imagingStudies.status, ["acquired", "reported"]))
    .orderBy(desc(imagingOutsideStudies.recordedAt))
    .limit(50);

  return {
    configured: book !== null,
    coverage: book === null ? null : {
      nightFrom: book.night_from, nightTo: book.night_to, overreadBy: book.overread_by,
      prelimMinutes: { stat: book.prelim_minutes.stat, urgent: book.prelim_minutes.urgent },
    },
    providers: book === null ? [] : book.providers.map((p) => ({ key: p.key, name: p.name, dpaSignedOn: p.dpa_signed_on, readers: p.readers.length })),
    queue,
    log,
    outside: outsideRows.map((o) => ({
      studyId: o.studyId, accessionNo: o.accessionNo,
      patientName: displayName({ name: o.name, alias: o.alias, isConfidential: o.isConfidential }, canSeeConfidential),
      studyName: o.studyName, centreName: o.centreName, studyDate: String(o.studyDate), state: o.status,
    })),
    summary: {
      prelims30: view.length,
      medianTat30: tats.length === 0 ? null : tats[Math.floor((tats.length - 1) / 2)]!,
      late30: view.filter((v) => v.late).length,
      minor30: view.filter((v) => v.state === "minor").length,
      major30: view.filter((v) => v.state === "major").length,
      awaiting: queue.length,
    },
  };
}

async function teleRowsById(db: Db, actor: Actor, ids: string[], canSeeConfidential: boolean, now: Date): Promise<TeleQueueRow[]> {
  const rows = await db.select({
    t: imagingTeleReads, accessionNo: imagingStudies.accessionNo, patientId: imagingStudies.patientId, studyName: services.name,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
    impression: imagingReports.impression, body: imagingReports.body,
  })
    .from(imagingTeleReads)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingTeleReads.studyId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(imagingReports, eq(imagingReports.id, imagingTeleReads.prelimReportId))
    .where(inArray(imagingTeleReads.id, ids))
    .orderBy(asc(imagingTeleReads.prelimAt));
  for (const r of rows) {
    await recordPhiAccess(db, { actor, patientId: r.patientId, surface: "imaging.report", reason: "the night-read over-read queue", now });
  }
  return rows.map((r) => {
    const t = r.t;
    const tat = t.imagesAt === null ? null : Math.max(0, Math.round((t.prelimAt.getTime() - t.imagesAt.getTime()) / 60_000));
    const body = (r.body ?? {}) as Record<string, unknown>;
    return {
      teleReadId: t.id, studyId: t.studyId, accessionNo: r.accessionNo,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential),
      uhid: r.uhid, studyName: r.studyName, priority: t.priority, providerName: t.providerName,
      readerName: t.readerName, readerNmcNo: t.readerNmcNo, prelimAt: t.prelimAt.toISOString(),
      imagesAt: t.imagesAt?.toISOString() ?? null, tatMinutes: tat, targetMinutes: t.targetMinutes,
      late: tat !== null && t.targetMinutes !== null && tat > t.targetMinutes,
      prelim: { findings: typeof body.findings === "string" ? body.findings : null, impression: r.impression ?? null },
      state: t.state, overread: null,
    };
  });
}

/** RS9's inbox: the latest over-read grade per study, for the treating doctor's row. */
export async function overreadsForStudies(exec: Db, studyIds: string[]): Promise<Map<string, { grade: string; note: string | null; providerName: string }>> {
  if (studyIds.length === 0) return new Map();
  const rows = await exec.select({
    studyId: imagingTeleReads.studyId, state: imagingTeleReads.state, note: imagingTeleReads.overreadNote,
    providerName: imagingTeleReads.providerName, at: imagingTeleReads.overreadAt,
  }).from(imagingTeleReads)
    .where(and(inArray(imagingTeleReads.studyId, studyIds), ne(imagingTeleReads.state, "awaiting")))
    .orderBy(asc(imagingTeleReads.overreadAt));
  return new Map(rows.map((r) => [r.studyId, { grade: r.state, note: r.note, providerName: r.providerName }]));
}
