import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { BRIEF_GAP_MINUTES, briefStage, newId } from "@hmis/contracts";
import type { Actor, BriefKind, WireBrief, WireBriefFact } from "@hmis/contracts";
import { doctorDeskBriefs, doctorDeskReads } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { DoctorDeskError } from "./errors";
import { patientOf } from "./scope";
import { recordRun } from "./agent-runs";
import type { DoctorDayLine } from "../opd";
import type { WireAttentionRow } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD-0.7 — THE LOGIN BRIEF ("since you left"), built from facts, never written by a model.
 *
 * ═══ NO MODEL IN THIS FILE (spec 2026-10-16, DECIDED 1) ═══ Every line is a template key over a
 * typed fact that names the record it came from, so the same facts give the same words forever and
 * a line can be argued with (`kernel/desk/brief.ts` DD12; plan §3.0 "no LLM on the critical path of
 * a tap"). Prose drafting is the doctor's opt-in toggle (decision 0006), which is DD-1.6; until then
 * nothing here calls `kernel/inference`, so there is no model to fail open.
 *
 * ═══ WHEN ═══ A Tower read `BRIEF_GAP_MINUTES` or more after the same doctor's previous read is a
 * return ("since you left at 18:10" = that previous read), and builds one brief over the window
 * between them. The first read ever records the instant and builds nothing — there is no "since".
 *
 * ═══ THE LIFECYCLE (R9) ═══ `briefStage` (contracts): highlighted for 5 minutes after it is first
 * shown, or until Got it; on the Tower for an hour; then only on the AI Briefs page. Nothing is
 * deleted — "archived forever" (D12).
 *
 * ═══ A QUIET SPELL IS STILL A BRIEF (E32) ═══ No change facts → the brief carries the state lines
 * only (papers to sign, today's OPD), the screen says "a quiet spell", and the row is kept.
 *
 * The stored `facts` keep a patient's ID only; the name is resolved when the brief is READ, through
 * the patients module, so a confidential patient is shown by alias and a stored brief never holds a
 * name that a later seal should have hidden.
 */
type StoredFact = Omit<WireBriefFact, "patient"> & { patientId: string | null };

const CHANGE_KINDS = new Set(["lab_critical", "imaging_critical", "lab_delta", "imaging_unread"]);

/** Record this read; return the previous read's instant, or null on a first read. */
export async function touchRead(tx: Tx, userId: string, at: Date): Promise<Date | null> {
  const before = (await tx.select().from(doctorDeskReads).where(eq(doctorDeskReads.userId, userId)).for("update"))[0];
  await tx.insert(doctorDeskReads).values({ userId, lastReadAt: at })
    .onConflictDoUpdate({ target: doctorDeskReads.userId, set: { lastReadAt: sql`greatest(${doctorDeskReads.lastReadAt}, ${at.toISOString()}::timestamptz)` } });
  return before?.lastReadAt ?? null;
}

/** The brief's lines over `[from, to]`, from rows the Tower has already read. Pure: the facts in, the lines out. */
export function loginFacts(attention: readonly WireAttentionRow[], line: DoctorDayLine | null, from: Date, to: Date): StoredFact[] {
  const inWindow = (iso: string): boolean => { const t = Date.parse(iso); return t >= from.getTime() && t <= to.getTime(); };
  const changes = attention.filter((r) => CHANGE_KINDS.has(r.kind) && inWindow(r.at)).map((r): StoredFact => ({
    key: `brief.${r.kind}`, params: r.params, patientId: r.patient.id, source: r.source, href: r.href,
  }));
  const papers = attention.filter((r) => r.kind === "visit_open").length;
  const state: StoredFact[] = [];
  if (papers > 0) state.push({ key: "brief.papersToSign", params: { n: papers }, patientId: null, source: null, href: null });
  if (line !== null && line.session !== "none") {
    state.push({ key: "brief.opdToday", params: { booked: line.booked, waiting: line.waiting }, patientId: null, source: null, href: "/opd/consult" });
  }
  return [...changes, ...state];
}

/**
 * Builds the login brief when this read is a return, in the caller's transaction. Returns the new
 * brief's id, or null when this read is not a return.
 */
export async function maybeBuildLoginBrief(
  tx: Tx, userId: string, at: Date, facts: (from: Date) => StoredFact[],
): Promise<string | null> {
  const prev = await touchRead(tx, userId, at);
  if (prev === null || at.getTime() - prev.getTime() < BRIEF_GAP_MINUTES * 60_000) return null;
  const id = newId();
  const lines = facts(prev);
  await tx.insert(doctorDeskBriefs).values({ id, userId, kind: "login", windowFrom: prev, windowTo: at, facts: lines, createdAt: at });
  await recordRun(tx, {
    agent: "login_brief", teamId: null, userId, outcome: "ok", summaryKey: "briefBuilt",
    params: { lines: lines.filter((f) => f.patientId !== null).length }, at,
  });
  return id;
}

type BriefRow = typeof doctorDeskBriefs.$inferSelect;

async function toWire(db: Db, actor: Actor, rows: BriefRow[], at: Date): Promise<WireBrief[]> {
  const facts = rows.flatMap((r) => r.facts as StoredFact[]);
  const ids = facts.map((f) => f.patientId).filter((p): p is string => p !== null);
  const byId = new Map((await getPatientSummaries(db, actor, ids)).map((s) => [s.requestedId, s] as const));
  return rows.map((r) => {
    const shownAt = r.shownAt?.toISOString() ?? null;
    const seenAt = r.seenAt?.toISOString() ?? null;
    return {
      id: r.id, kind: r.kind as BriefKind, windowFrom: r.windowFrom.toISOString(), windowTo: r.windowTo.toISOString(),
      createdAt: r.createdAt.toISOString(), shownAt, seenAt, stage: briefStage({ shownAt, seenAt }, at),
      facts: (r.facts as StoredFact[]).map(({ patientId, ...f }) => ({ ...f, patient: patientId === null ? null : patientOf(byId.get(patientId), patientId) })),
    };
  });
}

/**
 * The login brief for the Tower: the newest, while it is not archived. The first read that returns
 * it stamps `shown_at` — the lifecycle's clock starts when the doctor could first see it.
 */
export async function towerBrief(db: Db, actor: Actor, at: Date): Promise<WireBrief | null> {
  const newest = (await db.select().from(doctorDeskBriefs)
    .where(and(eq(doctorDeskBriefs.userId, actor.id), eq(doctorDeskBriefs.kind, "login")))
    .orderBy(desc(doctorDeskBriefs.createdAt)).limit(1))[0];
  if (newest === undefined) return null;
  let row = newest;
  if (row.shownAt === null) {
    row = (await db.update(doctorDeskBriefs).set({ shownAt: at })
      .where(and(eq(doctorDeskBriefs.id, row.id), isNull(doctorDeskBriefs.shownAt))).returning())[0] ?? row;
  }
  const [wire] = await toWire(db, actor, [row], at);
  return wire === undefined || wire.stage === "archived" ? null : wire;
}

/** Every brief of this person, newest first (AI Briefs page). Bounded: a year of daily logins. */
export const BRIEFS_PAGE_LIMIT = 400;
export async function listBriefs(db: Db, actor: Actor, at: Date): Promise<WireBrief[]> {
  const rows = await db.select().from(doctorDeskBriefs).where(eq(doctorDeskBriefs.userId, actor.id))
    .orderBy(desc(doctorDeskBriefs.createdAt)).limit(BRIEFS_PAGE_LIMIT);
  return toWire(db, actor, rows, at);
}

/** Briefs that moved to the AI Briefs page without a Got it — the menu's count (R9: "a count only"). */
export async function briefsWaiting(db: Db, actor: Actor, at: Date): Promise<number> {
  const rows = await db.select({ shownAt: doctorDeskBriefs.shownAt, seenAt: doctorDeskBriefs.seenAt }).from(doctorDeskBriefs)
    .where(and(eq(doctorDeskBriefs.userId, actor.id), isNull(doctorDeskBriefs.seenAt)))
    .orderBy(desc(doctorDeskBriefs.createdAt)).limit(50);
  return rows.filter((r) => briefStage({ shownAt: r.shownAt?.toISOString() ?? null, seenAt: null }, at) === "archived").length;
}

/** Got it — or opening the brief on the AI Briefs page. Idempotent; only the brief's own doctor. */
export async function markBriefSeen(db: Db, actor: Actor, briefId: string, at: Date): Promise<void> {
  const row = (await db.select({ id: doctorDeskBriefs.id }).from(doctorDeskBriefs)
    .where(and(eq(doctorDeskBriefs.id, briefId), eq(doctorDeskBriefs.userId, actor.id))))[0];
  if (row === undefined) throw new DoctorDeskError("unknown_brief", "No such brief for you.");
  await db.update(doctorDeskBriefs).set({ seenAt: at, shownAt: sql`coalesce(${doctorDeskBriefs.shownAt}, ${at.toISOString()}::timestamptz)` })
    .where(and(eq(doctorDeskBriefs.id, briefId), isNull(doctorDeskBriefs.seenAt)));
}
