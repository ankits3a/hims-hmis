import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import {
  IMAGING_CRITICAL_RUNGS, imagingCriticalCallAttempts, imagingCriticalFindings, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { users } from "../../kernel/db/schema/auth";
import { displayName } from "../patients";
import { resolverEnabled, whoIsOn } from "../roster";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { RadiologyError } from "./errors";
import { clearanceOf } from "./read";
import { CRITICAL_TERMS, criticalTermsIn } from "./checks";
import { activeStudyTypes } from "./study-types";
import type { ImagingCriticalRung } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS8b T2 — **THE CRITICAL-CALL LADDER.**
 *
 * The board's rule for a critical result: the radiologist rings the TREATING DOCTOR; no answer
 * moves the call to the UNIT HEAD, then the DUTY RMO, then the HOD; and the call closes ONLY on a
 * read-back that names the finding. Windows per tier come from the governed `critical_categories`
 * book (board: red 15 min, orange 120 min, yellow the next working day).
 *
 * ═══ WHO EACH RUNG IS (the RS8b spike, DECIDED) ═══
 *
 * A rung names a ROLE, and the screen shows who holds it today where the hospital can say:
 *
 *   · **treating doctor** — the order's `ordering_clinician_id`, by name;
 *   · **unit head** — roster position `unit_head`;
 *   · **duty RMO** — roster position `casualty_mo` (there is no RMO position; the duty medical
 *     officer who covers the wards out of hours is the Indian-hospital RMO);
 *   · **HOD** — the `medical_superintendent` role's holders (no HOD position exists; the NABH
 *     escalation policy ends at the administrative head).
 *
 * The two roster rungs name people ONLY when a PUBLISHED roster answers (`source: "published"`).
 * With the resolver off or no roster, `whoIsOn` answers every holder of the position's RBAC role —
 * for `unit_head` that is every doctor in the hospital, which is not a phone number. So the rung
 * shows its role's name and the radiologist types who they rang.
 *
 * ═══ THE READ-BACK NAMES THE FINDING ═══
 *
 * `readBackNamesFinding` is the rule `acknowledgeCritical` enforces (`read_back_mismatch`), so the
 * doctor's own read-back route (RS9) meets it too. It is deliberately lexical and generous: the
 * clinician's words must share a critical term the report states (not negated), or one content
 * word of the impression. "Noted", "OK sir" and "will see" name nothing and are refused.
 */

export const CRITICAL_RUNG_ROLES: Record<ImagingCriticalRung, { position: string | null; role: string | null }> = {
  treating_doctor: { position: null, role: null },
  unit_head: { position: "unit_head", role: null },
  duty_rmo: { position: "casualty_mo", role: null },
  hod: { position: null, role: "medical_superintendent" },
};

/* ═══════════════════════════════ the read-back rule ═══════════════════════════════ */

/** Words that say nothing about WHAT was found — sides, grades, fillers and phone talk. */
const NOT_THE_FINDING = new Set([
  "with", "without", "there", "their", "this", "that", "these", "those", "which", "will", "have", "been",
  "from", "into", "onto", "over", "under", "upon", "also", "then", "than", "very", "more", "less", "some",
  "noted", "seen", "study", "report", "reported", "finding", "findings", "impression", "patient", "evidence",
  "suggestive", "suggests", "suggest", "likely", "possible", "possibly", "probable", "probably", "consistent",
  "right", "left", "bilateral", "both", "side", "sided", "upper", "lower", "middle", "mild", "moderate",
  "severe", "small", "large", "acute", "chronic", "normal", "known", "new", "significant", "approximately",
  "lobe", "zone", "region", "area", "segment", "level", "measuring", "size",
  "taking", "take", "starting", "start", "admit", "admitting", "call", "called", "calling", "understood",
  "okay", "repeat", "repeated", "read", "back", "doctor", "will", "shall", "sending", "send", "shifting",
  "shift", "theatre", "theater", "review", "reviewing", "informed", "inform", "done", "sure", "thanks",
]);

function normaliseSpelling(text: string): string {
  return text.toLowerCase().replace(/ae/g, "e").replace(/oe/g, "e");
}

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normaliseSpelling(text).split(/[^a-z]+/)) {
    if (raw.length < 4 || NOT_THE_FINDING.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * True when the read-back names the finding the report states. An empty report (nothing to name)
 * accepts any non-empty read-back; the RED rule that a read-back EXISTS stays `acknowledgeCritical`'s.
 */
export function readBackNamesFinding(
  readBack: string, report: { impression: string | null; findings: string | null },
): boolean {
  const impression = report.impression?.trim() ?? "";
  const findings = report.findings?.trim() ?? "";
  if (impression === "" && findings === "") return true;

  const reportTerms = criticalTermsIn(`${impression}\n${findings}`).map(normaliseSpelling);
  if (reportTerms.length > 0) {
    const said = criticalTermsIn(readBack).map(normaliseSpelling);
    if (said.some((t) => reportTerms.some((r) => r.includes(t) || t.includes(r)))) return true;
    /**
     * The read-back MENTIONS the report's critical term but negates it ("no pneumothorax") — the
     * clinician heard the opposite of the finding, which is the one read-back that must never close
     * the call, whatever words it shares.
     */
    const heard = normaliseSpelling(readBack);
    const mentioned = CRITICAL_TERMS.map(normaliseSpelling).filter((t) =>
      reportTerms.some((r) => r.includes(t)) && new RegExp(`\\b${t.replace(/ /g, "\\s+")}\\b`).test(heard));
    if (mentioned.length > 0) return false;
  }
  const wanted = contentWords(impression !== "" ? impression : findings);
  if (wanted.size === 0) return true;
  for (const w of contentWords(readBack)) if (wanted.has(w)) return true;
  return false;
}

/** The finding's text a report carries, for the read-back rule. */
export function findingOf(row: { impression: string | null; body: unknown }): { impression: string | null; findings: string | null } {
  const body = (typeof row.body === "object" && row.body !== null ? row.body : {}) as Record<string, unknown>;
  return { impression: row.impression, findings: typeof body.findings === "string" ? body.findings : null };
}

/* ═══════════════════════════════ one call on the ladder ═══════════════════════════════ */

export type CallOutcomeInput = "no_answer" | "answered";

/**
 * One ring, recorded. `no_answer` on the CURRENT rung moves the call one rung up (HOD is the top;
 * a no-answer there is recorded and the rung stays). `answered` leaves the rung where it is — the
 * call is still open until the clinician's read-back is accepted by `acknowledgeCritical`.
 *
 * The rung is compare-and-set: a call recorded on a rung the ladder has already left (a colleague
 * recorded a no-answer, or the chaser escalated) is `stale_state`, and nothing is written.
 */
export async function recordCallAttempt(
  tx: Tx,
  actor: Actor,
  input: {
    criticalId: string;
    rung: number;
    calledUserId?: string | null;
    calledName?: string | null;
    outcome: CallOutcomeInput;
    now?: Date;
  },
): Promise<{ attemptId: string; ladderRung: number }> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not make a telephone call`);
  const now = input.now ?? new Date();
  const [critical] = await (tx as unknown as Db).select().from(imagingCriticalFindings)
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  if (!critical) throw new RadiologyError("unknown_study", `no critical finding ${input.criticalId}`);
  if (critical.acknowledgedAt !== null) {
    throw new RadiologyError(
      "already_signed", "this critical call is already closed — the clinician read the finding back",
      { criticalId: critical.id },
    );
  }
  if (input.rung !== critical.ladderRung) {
    throw new RadiologyError(
      "stale_state",
      `the call has moved to the ${rungWords(critical.ladderRung)} — reload the ladder and record the call on that rung`,
      { criticalId: critical.id, ladderRung: critical.ladderRung, rung: input.rung },
    );
  }
  const calledName = input.calledName?.trim() || null;
  let calledUserId = input.calledUserId ?? null;
  if (calledUserId !== null) {
    const [u] = await (tx as unknown as Db).select({ id: users.id }).from(users).where(eq(users.id, calledUserId));
    if (!u) {
      throw new RadiologyError("evidence_invalid", "the person rung is not a user of this hospital — type their name instead", { calledUserId });
    }
  }
  if (calledUserId === null && calledName === null) {
    throw new RadiologyError("evidence_invalid", "a call is to somebody — pick who was rung or type their name");
  }
  if (calledName !== null && calledName.length > 120) {
    throw new RadiologyError("evidence_invalid", "a name is at most 120 characters");
  }
  calledUserId = calledUserId ?? null;

  const attemptId = newId();
  await tx.insert(imagingCriticalCallAttempts).values({
    id: attemptId, criticalId: critical.id, rung: critical.ladderRung, calledUserId, calledName,
    outcome: input.outcome, recordedBy: actor.id, at: now,
  });

  let ladderRung = critical.ladderRung;
  if (input.outcome === "no_answer" && ladderRung < IMAGING_CRITICAL_RUNGS.length - 1) {
    const moved = await tx.update(imagingCriticalFindings)
      .set({ ladderRung: ladderRung + 1 })
      .where(and(
        eq(imagingCriticalFindings.id, critical.id),
        eq(imagingCriticalFindings.ladderRung, ladderRung),
        isNull(imagingCriticalFindings.acknowledgedAt),
      ))
      .returning({ ladderRung: imagingCriticalFindings.ladderRung });
    if (moved.length === 0) {
      throw new RadiologyError("stale_state", "the call moved while this was being recorded — reload the ladder", { criticalId: critical.id });
    }
    ladderRung = moved[0]!.ladderRung;
  }
  return { attemptId, ladderRung };
}

function rungWords(rung: number): string {
  return ({ 0: "treating doctor", 1: "unit head", 2: "duty RMO", 3: "HOD" } as Record<number, string>)[rung] ?? "next rung";
}

/* ═══════════════════════════════ the board's read ═══════════════════════════════ */

export type LadderRungView = {
  key: ImagingCriticalRung;
  /** Who holds the rung today, when the hospital can say; empty = show the role's name. */
  people: { userId: string; name: string }[];
  source: "order" | "roster" | "role" | "none";
};

export type CriticalCallView = {
  criticalId: string;
  reportId: string;
  studyId: string;
  accessionNo: string;
  studyTypeName: string;
  patientName: string;
  patientUhid: string;
  category: string;
  /** The finding the read-back must name (the report's impression, else its findings). */
  finding: string | null;
  flaggedAt: Date;
  /** The tier's window from the active book; null when the book does not name the tier. */
  windowMin: number | null;
  dueAt: Date | null;
  overdue: boolean;
  ladderRung: number;
  rungs: LadderRungView[];
  attempts: { rung: number; calledName: string | null; calledUserName: string | null; outcome: string; at: Date; recordedByName: string | null }[];
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
  readBack: string | null;
};

/** How far back the acknowledged log reaches (board: the last 48 hours). */
export const ACKNOWLEDGED_LOG_HOURS = 48;

/**
 * The Critical calls view: every open call (oldest first — the one waiting longest is the one to
 * ring), then the calls closed in the last 48 hours, newest first. Logs one `imaging.worklist`
 * row per patient, the reading room's own surface.
 */
export async function criticalCallBoard(
  db: Db, actor: Actor, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env,
): Promise<{ open: CriticalCallView[]; acknowledged: CriticalCallView[] }> {
  if (actor.type !== "user") throw new RadiologyError("forbidden", `a ${actor.type} actor does not read critical calls`);
  const clearance = await clearanceOf(db, actor);
  const since = new Date(now.getTime() - ACKNOWLEDGED_LOG_HOURS * 3_600_000);

  const base = () => db
    .select({
      c: imagingCriticalFindings,
      impression: imagingReports.impression, body: imagingReports.body,
      study: { id: imagingStudies.id, accessionNo: imagingStudies.accessionNo, studyTypeCode: imagingStudies.studyTypeCode, patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo },
      orderingClinicianId: orders.orderingClinicianId,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
    })
    .from(imagingCriticalFindings)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingCriticalFindings.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId));

  const openRows = await base().where(isNull(imagingCriticalFindings.acknowledgedAt))
    .orderBy(imagingCriticalFindings.createdAt).limit(200);
  const doneRows = await base().where(and(isNotNull(imagingCriticalFindings.acknowledgedAt), gte(imagingCriticalFindings.acknowledgedAt, since)))
    .orderBy(desc(imagingCriticalFindings.acknowledgedAt)).limit(200);
  const all = [...openRows, ...doneRows];

  const bookRow = await activeDefinitionRow(db, "critical_categories");
  const windows = new Map<string, number>(
    bookRow === undefined ? [] : parseDefinitionBody("critical_categories", bookRow.body).categories.map((c) => [c.category as string, c.communicate_within_min]),
  );
  const types = new Map((await activeStudyTypes(db)).map((t) => [t.code, t.name]));

  const ids = all.map((r) => r.c.id);
  const attempts = ids.length === 0 ? [] : await db.select().from(imagingCriticalCallAttempts)
    .where(inArray(imagingCriticalCallAttempts.criticalId, ids)).orderBy(imagingCriticalCallAttempts.at);

  const userIds = new Set<string>();
  for (const r of all) {
    if (r.orderingClinicianId !== null) userIds.add(r.orderingClinicianId);
    if (r.c.acknowledgedBy !== null) userIds.add(r.c.acknowledgedBy);
  }
  for (const a of attempts) { userIds.add(a.recordedBy); if (a.calledUserId !== null) userIds.add(a.calledUserId); }

  /** The rungs that do not depend on the call: the roster's two and the HOD role. */
  const rosterRung = async (position: string): Promise<LadderRungView["people"] | null> => {
    if (!resolverEnabled(env)) return null;
    try {
      const answer = await whoIsOn(db, { position }, now, env);
      if (answer.source !== "published") return null;
      answer.userIds.forEach((u) => userIds.add(u));
      return answer.userIds.map((userId) => ({ userId, name: "" }));
    } catch {
      return null;
    }
  };
  const unitHead = await rosterRung(CRITICAL_RUNG_ROLES.unit_head.position!);
  const dutyRmo = await rosterRung(CRITICAL_RUNG_ROLES.duty_rmo.position!);
  const hodIds = await usersHoldingRole(db as unknown as Tx, CRITICAL_RUNG_ROLES.hod.role!);
  hodIds.forEach((u) => userIds.add(u));

  const names = new Map<string, string>();
  if (userIds.size > 0) {
    for (const u of await db.select({ id: users.id, name: users.fullName, active: users.active }).from(users).where(inArray(users.id, [...userIds]))) {
      names.set(u.id, u.name);
    }
  }
  const named = (people: LadderRungView["people"]) => people.map((p) => ({ userId: p.userId, name: names.get(p.userId) ?? p.userId }));

  const toView = (r: (typeof all)[number]): CriticalCallView => {
    const windowMin = windows.get(r.c.category) ?? null;
    const dueAt = windowMin === null ? null : new Date(r.c.createdAt.getTime() + windowMin * 60_000);
    const f = findingOf({ impression: r.impression, body: r.body });
    const treating = r.orderingClinicianId !== null && names.has(r.orderingClinicianId)
      ? [{ userId: r.orderingClinicianId, name: names.get(r.orderingClinicianId)! }] : [];
    return {
      criticalId: r.c.id, reportId: r.c.reportId, studyId: r.study.id, accessionNo: r.study.accessionNo,
      studyTypeName: types.get(r.study.studyTypeCode) ?? r.study.studyTypeCode,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
      patientUhid: r.uhid,
      category: r.c.category,
      finding: f.impression?.trim() || f.findings?.trim() || null,
      flaggedAt: r.c.createdAt, windowMin, dueAt,
      overdue: r.c.acknowledgedAt === null && dueAt !== null && dueAt.getTime() < now.getTime(),
      ladderRung: r.c.ladderRung,
      rungs: [
        { key: "treating_doctor", people: treating, source: treating.length > 0 ? "order" : "none" },
        { key: "unit_head", people: unitHead === null ? [] : named(unitHead), source: unitHead === null ? "role" : "roster" },
        { key: "duty_rmo", people: dutyRmo === null ? [] : named(dutyRmo), source: dutyRmo === null ? "role" : "roster" },
        { key: "hod", people: named(hodIds.map((userId) => ({ userId, name: "" }))), source: "role" },
      ],
      attempts: attempts.filter((a) => a.criticalId === r.c.id).map((a) => ({
        rung: a.rung, calledName: a.calledName, calledUserName: a.calledUserId === null ? null : names.get(a.calledUserId) ?? null,
        outcome: a.outcome, at: a.at, recordedByName: names.get(a.recordedBy) ?? null,
      })),
      acknowledgedAt: r.c.acknowledgedAt,
      acknowledgedByName: r.c.acknowledgedBy === null ? null : names.get(r.c.acknowledgedBy) ?? null,
      readBack: r.c.readBackText,
    };
  };

  const reason = `critical calls, ${String(openRows.length)} open`;
  for (const patientId of new Set(all.map((r) => r.study.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return { open: openRows.map(toView), acknowledged: doneRows.map(toView) };
}
