import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  IMAGING_PEER_SCORES, imagingPeerReviews, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { users } from "../../kernel/db/schema/auth";
import { RadiologyError } from "./errors";
import { requireStudyType } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS8c T2 — PEER REVIEW (RADPEER), BLIND ═══
 *
 * The board: *"A random 3% of each reader's signed reports, plus every discrepancy and every
 * amendment, scored blind by another radiologist."* NABH's imaging quality indicator ("radiologist
 * discrepancy, peer review 3–4, target < 1 %") reads the scores.
 *
 *   · **the random sample** (`drawPeerSample`) — per reader per IST month, ⌈3 % × first signatures⌉,
 *     at least one; drawn with a cryptographic shuffle (a reader cannot predict which of theirs is
 *     drawn), idempotent (a second draw for a month adds nothing), run daily by the worker for the
 *     month just closed. A first signature = a `signed` or `superseded` version that supersedes
 *     nothing; night-partner prelims and residents' `awaiting_cosign` rows are not in the pool;
 *   · **every amendment** (`openAmendmentReview`) — the version the amendment superseded, read by
 *     whoever signed it (`amendReport` calls it in its transaction);
 *   · **every night prelim the morning consultant found discrepant** (`tele.ts`).
 *
 * **Blind.** The reviewer's case read never carries the reader's name or signer block; the pool
 * excludes the reviewer's own reports; scoring one's own is refused (and the CHECK repeats it). The
 * per-reader agreement is shown by name (the board's bars) — the individual cases are not.
 *
 * RADPEER: 1 concur; 2 a discrepancy in interpretation not ordinarily expected to be made; 3 should
 * be made most of the time; 4 should be made almost every time; a = unlikely, b = likely clinically
 * significant. A score of 2 or worse says what it was (a line). DECIDED: 2a/2b count as "minor",
 * 3–4 as "significant"; agreement = score 1.
 */

export const PEER_SAMPLE_RATE = 0.03;
export type PeerScore = (typeof IMAGING_PEER_SCORES)[number];

/** `YYYY-MM` → the IST month's [start, end) instants. */
export function istMonthWindow(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const IST = 330 * 60_000;
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - IST),
    end: new Date(Date.UTC(y, m, 1) - IST),
  };
}

/** The IST month before the one `now` falls in. */
export function previousIstMonth(now: Date): string {
  const [y, m] = istDayString(now).slice(0, 7).split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/** How many of `n` first signatures one reader's month samples: ⌈3 %⌉, at least one. */
export function sampleSize(n: number): number {
  return n <= 0 ? 0 : Math.max(1, Math.ceil(n * PEER_SAMPLE_RATE));
}

/**
 * Draw one IST month's random sample. Idempotent: a reader who already has their month's cases gets
 * none more. Returns the cases opened.
 */
export async function drawPeerSample(db: Db, month: string): Promise<{ opened: number }> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new RadiologyError("evidence_invalid", `"${month}" is not a month (YYYY-MM)`);
  const { start, end } = istMonthWindow(month);
  const pool = await db.select({ id: imagingReports.id, studyId: imagingReports.studyId, signerId: imagingReports.signerId })
    .from(imagingReports)
    .where(and(
      inArray(imagingReports.status, ["signed", "superseded"]),
      isNull(imagingReports.supersedesId),
      isNull(imagingReports.externalReporterId),
      isNotNull(imagingReports.signerId),
      gte(imagingReports.signedAt, start),
      lt(imagingReports.signedAt, end),
    ));
  const byReader = new Map<string, { id: string; studyId: string }[]>();
  for (const r of pool) {
    const list = byReader.get(r.signerId!) ?? [];
    list.push({ id: r.id, studyId: r.studyId });
    byReader.set(r.signerId!, list);
  }
  let opened = 0;
  for (const [readerId, reports] of byReader) {
    const already = await db.select({ reportId: imagingPeerReviews.reportId }).from(imagingPeerReviews)
      .where(and(eq(imagingPeerReviews.trigger, "random"), eq(imagingPeerReviews.sampleMonth, month), eq(imagingPeerReviews.readerId, readerId)));
    const want = sampleSize(reports.length) - already.length;
    if (want <= 0) continue;
    const taken = new Set(already.map((a) => a.reportId));
    const candidates = reports.filter((r) => !taken.has(r.id));
    /** Fisher–Yates with a cryptographic source: nobody can tell in advance which report is drawn. */
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    for (const c of candidates.slice(0, want)) {
      const ins = await db.insert(imagingPeerReviews).values({
        id: newId(), reportId: c.id, studyId: c.studyId, readerId, trigger: "random", sampleMonth: month,
      }).onConflictDoNothing({ target: [imagingPeerReviews.reportId, imagingPeerReviews.trigger] }).returning({ id: imagingPeerReviews.id });
      opened += ins.length;
    }
  }
  return { opened };
}

/** The worker's daily call: the month just closed (idempotent, so every day after the 1st is a no-op). */
export async function sweepPeerSample(db: Db, now: Date = new Date()): Promise<{ opened: number }> {
  return await drawPeerSample(db, previousIstMonth(now));
}

/** `amendReport` — the version an amendment superseded goes to review, read by whoever signed it. */
export async function openAmendmentReview(
  tx: Tx, superseded: { id: string; studyId: string; signerId: string | null; externalReporterId?: string | null },
): Promise<void> {
  if (superseded.signerId === null) return;
  await tx.insert(imagingPeerReviews).values({
    id: newId(), reportId: superseded.id, studyId: superseded.studyId, readerId: superseded.signerId, trigger: "amendment",
  }).onConflictDoNothing({ target: [imagingPeerReviews.reportId, imagingPeerReviews.trigger] });
}

/** `tele.ts` — a night prelim the morning consultant found discrepant. */
export async function openOverreadReview(
  tx: Tx, prelim: { reportId: string; studyId: string; readerId: string },
): Promise<void> {
  await tx.insert(imagingPeerReviews).values({
    id: newId(), reportId: prelim.reportId, studyId: prelim.studyId, readerId: prelim.readerId, trigger: "overread_discrepancy",
  }).onConflictDoNothing({ target: [imagingPeerReviews.reportId, imagingPeerReviews.trigger] });
}

/* ═══════════════════════════════ the reads ═══════════════════════════════ */

export type PeerQueueRow = {
  reviewId: string;
  trigger: string;
  studyTypeName: string;
  modality: string;
  signedAt: string | null;
  openedAt: string;
  /** Days since the case was opened — due within 14 (the board's "overdue"). */
  ageDays: number;
};

export type PeerScoredRow = {
  reviewId: string; trigger: string; studyTypeName: string; modality: string;
  score: string; learningCase: boolean; note: string | null; scoredAt: string;
};

export type ReaderAgreement = {
  readerId: string; readerName: string; scored: number; concur: number; minor: number; significant: number;
  /** Score 1 as a whole-number percentage; null with nothing scored. */
  agreementPct: number | null;
};

export type PeerBoard = {
  queue: PeerQueueRow[];
  recent: PeerScoredRow[];
  readers: ReaderAgreement[];
  tiles: { sampledThisMonth: number; triggeredThisMonth: number; agreementPct: number | null; significantThisMonth: number; overdue: number };
};

export const PEER_DUE_DAYS = 14;
export const PEER_AGREEMENT_DAYS = 90;

const bucket = (score: string): "concur" | "minor" | "significant" => (score === "1" ? "concur" : score.startsWith("2") ? "minor" : "significant");

async function typeNames(exec: Db, codes: string[]): Promise<Map<string, { name: string; modality: string }>> {
  const out = new Map<string, { name: string; modality: string }>();
  for (const code of new Set(codes)) {
    try {
      const t = await requireStudyType(exec, code);
      out.set(code, { name: t.name, modality: t.modality });
    } catch { out.set(code, { name: code, modality: "—" }); }
  }
  return out;
}

export async function peerBoard(db: Db, actor: Actor, now: Date = new Date()): Promise<PeerBoard> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "peer review is a person's act");
  const queueRows = await db.select({
    id: imagingPeerReviews.id, trigger: imagingPeerReviews.trigger, createdAt: imagingPeerReviews.createdAt,
    studyTypeCode: imagingStudies.studyTypeCode, signedAt: imagingReports.signedAt, readerId: imagingPeerReviews.readerId,
  })
    .from(imagingPeerReviews)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingPeerReviews.studyId))
    .innerJoin(imagingReports, eq(imagingReports.id, imagingPeerReviews.reportId))
    .where(and(eq(imagingPeerReviews.state, "open"), ne(imagingPeerReviews.readerId, actor.id)))
    .orderBy(asc(imagingPeerReviews.createdAt))
    .limit(200);
  const since = new Date(now.getTime() - PEER_AGREEMENT_DAYS * 86_400_000);
  const scored = await db.select({
    id: imagingPeerReviews.id, trigger: imagingPeerReviews.trigger, score: imagingPeerReviews.score,
    learningCase: imagingPeerReviews.learningCase, note: imagingPeerReviews.note, scoredAt: imagingPeerReviews.scoredAt,
    readerId: imagingPeerReviews.readerId, readerName: users.fullName, studyTypeCode: imagingStudies.studyTypeCode,
  })
    .from(imagingPeerReviews)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingPeerReviews.studyId))
    .leftJoin(users, eq(users.id, imagingPeerReviews.readerId))
    .where(and(eq(imagingPeerReviews.state, "scored"), gte(imagingPeerReviews.scoredAt, since)))
    .orderBy(desc(imagingPeerReviews.scoredAt));
  const month = istDayString(now).slice(0, 7);
  const { start: monthStart } = istMonthWindow(month);
  const opened = await db.select({ trigger: imagingPeerReviews.trigger }).from(imagingPeerReviews)
    .where(gte(imagingPeerReviews.createdAt, monthStart));
  const allOpen = await db.select({ createdAt: imagingPeerReviews.createdAt }).from(imagingPeerReviews)
    .where(eq(imagingPeerReviews.state, "open"));

  const types = await typeNames(db, [...queueRows.map((q) => q.studyTypeCode), ...scored.map((s) => s.studyTypeCode)]);
  const readers = new Map<string, ReaderAgreement>();
  for (const s of scored) {
    const r = readers.get(s.readerId) ?? {
      readerId: s.readerId, readerName: s.readerName ?? "—", scored: 0, concur: 0, minor: 0, significant: 0, agreementPct: null,
    };
    r.scored += 1;
    r[bucket(s.score!)] += 1;
    readers.set(s.readerId, r);
  }
  for (const r of readers.values()) r.agreementPct = Math.round((r.concur / r.scored) * 1000) / 10;
  const concurAll = scored.filter((s) => s.score === "1").length;
  const monthScored = scored.filter((s) => s.scoredAt !== null && s.scoredAt >= monthStart);

  return {
    queue: queueRows.map((q) => ({
      reviewId: q.id, trigger: q.trigger,
      studyTypeName: types.get(q.studyTypeCode)?.name ?? q.studyTypeCode, modality: types.get(q.studyTypeCode)?.modality ?? "—",
      signedAt: q.signedAt?.toISOString() ?? null, openedAt: q.createdAt.toISOString(),
      ageDays: Math.floor((now.getTime() - q.createdAt.getTime()) / 86_400_000),
    })),
    /** Blind: no reader, no reviewer. Names are the aggregate's, never a case's. */
    recent: scored.slice(0, 30).map((s) => ({
      reviewId: s.id, trigger: s.trigger,
      studyTypeName: types.get(s.studyTypeCode)?.name ?? s.studyTypeCode, modality: types.get(s.studyTypeCode)?.modality ?? "—",
      score: s.score!, learningCase: s.learningCase, note: s.note, scoredAt: s.scoredAt!.toISOString(),
    })),
    readers: [...readers.values()].sort((a, b) => a.readerName.localeCompare(b.readerName)),
    tiles: {
      sampledThisMonth: opened.filter((o) => o.trigger === "random").length,
      triggeredThisMonth: opened.filter((o) => o.trigger !== "random").length,
      agreementPct: scored.length === 0 ? null : Math.round((concurAll / scored.length) * 1000) / 10,
      significantThisMonth: monthScored.filter((s) => bucket(s.score!) === "significant").length,
      overdue: allOpen.filter((o) => now.getTime() - o.createdAt.getTime() > PEER_DUE_DAYS * 86_400_000).length,
    },
  };
}

export type PeerCase = {
  reviewId: string;
  trigger: string;
  studyId: string;
  studyTypeName: string;
  modality: string;
  patientAgeSex: string;
  indication: string | null;
  sections: Record<string, string>;
  impression: string | null;
  coded: Record<string, unknown>;
  signedAt: string | null;
  prelim: boolean;
};

async function loadCase(exec: Db | Tx, reviewId: string) {
  const rows = await (exec as Db).select({
    review: imagingPeerReviews, report: imagingReports, study: imagingStudies,
    sex: patients.sex, dob: patients.dob, indication: orders.indication, serviceName: services.name,
  })
    .from(imagingPeerReviews)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingPeerReviews.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingPeerReviews.studyId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .where(eq(imagingPeerReviews.id, reviewId));
  const row = rows[0];
  if (!row) throw new RadiologyError("unknown_peer_review", "That review case is not in the pool — reload the list.", { reviewId });
  return row;
}

function refuseOwn(): never {
  throw new RadiologyError(
    "peer_review_own_report",
    "This case is your own report — a colleague scores it. Take the next case.",
  );
}

/**
 * The blind case: the study, the question and the report's words — never who wrote them. The
 * reviewer opens the images through the existing logged route (by study).
 */
export async function peerCase(db: Db, actor: Actor, reviewId: string, now: Date = new Date()): Promise<PeerCase> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "peer review is a person's act");
  const row = await loadCase(db, reviewId);
  if (row.review.readerId === actor.id) refuseOwn();
  const type = (await typeNames(db, [row.study.studyTypeCode])).get(row.study.studyTypeCode)!;
  const body = (typeof row.report.body === "object" && row.report.body !== null ? row.report.body : {}) as Record<string, unknown>;
  const sections: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && v.trim() !== "") sections[k] = v;
  const age = row.dob === null ? null : Math.floor((now.getTime() - new Date(`${row.dob}T00:00:00Z`).getTime()) / (365.25 * 86_400_000));
  await recordPhiAccess(db, { actor, patientId: row.study.patientId, surface: "imaging.report", reason: "blind peer review of a report", now });
  return {
    reviewId, trigger: row.review.trigger, studyId: row.study.id,
    studyTypeName: row.serviceName || type.name, modality: type.modality,
    patientAgeSex: `${age === null ? "—" : String(age)}${row.sex === "female" ? "F" : row.sex === "male" ? "M" : ""}`,
    indication: row.indication ?? null, sections,
    impression: row.report.impression ?? null,
    coded: typeof body.coded === "object" && body.coded !== null ? body.coded as Record<string, unknown> : {},
    signedAt: row.report.signedAt?.toISOString() ?? null,
    prelim: row.report.status === "prelim",
  };
}

export const PEER_NOTE_MIN = 4;

export async function scorePeerReview(
  tx: Tx, actor: Actor, input: { reviewId: string; score: string; learningCase?: boolean; note?: string | null; now?: Date },
): Promise<{ reviewId: string; score: PeerScore }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "peer review is a person's act");
  if (!(IMAGING_PEER_SCORES as readonly string[]).includes(input.score)) {
    throw new RadiologyError("evidence_invalid", "Score it on RADPEER: 1, 2a, 2b, 3a, 3b, 4a or 4b.", { score: input.score });
  }
  const note = input.note?.trim() ?? "";
  if (input.score !== "1" && note.length < PEER_NOTE_MIN) {
    throw new RadiologyError("reason_required", "A discrepancy says what it was — one line on what was missed or misread.", { min: PEER_NOTE_MIN });
  }
  const row = await loadCase(tx, input.reviewId);
  if (row.review.readerId === actor.id) refuseOwn();
  const now = input.now ?? new Date();
  const done = await tx.update(imagingPeerReviews).set({
    state: "scored", reviewerId: actor.id, score: input.score, learningCase: input.learningCase === true,
    note: note === "" ? null : note, scoredAt: now,
  }).where(and(eq(imagingPeerReviews.id, input.reviewId), eq(imagingPeerReviews.state, "open")))
    .returning({ id: imagingPeerReviews.id });
  if (done.length === 0) {
    throw new RadiologyError("already_resolved", "A colleague scored this case a moment ago — take the next one.", { reviewId: input.reviewId });
  }
  return { reviewId: input.reviewId, score: input.score as PeerScore };
}
