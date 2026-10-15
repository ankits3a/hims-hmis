import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import { cdsAliases, cdsRxLines, opdSuggestionEvents } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { medicinesByIds } from "../formulary";
import { trustByUse } from "./alias-pipeline";
import { controlledToday } from "./alias-store";
import { OpdError } from "./errors";
import { aliasRestored, aliasUndone } from "./events";

/**
 * ═══ A NICKNAME IN USE: TAPS, CROSSES, TRUST, AND THE OWNER'S UNDO (decisions 0050, 0051) ═══
 *
 * There is ONE log — `opd_suggestion_events`, kind 'alias', `item_key` the nickname's id:
 *
 *   accepted  — a doctor picked the nickname's row. One per (nickname, visit): picking it twice for
 *               one prescription is one use (`recordSignals` drops the second).
 *   dismissed — a doctor crossed the row off.
 *   manual    — the row was on screen and the doctor picked a DIFFERENT medicine (`context_key`
 *               `med:<id>`): the nickname's second target, if it has one.
 *
 * `applyAliasUse` re-reads that log for one nickname and writes what it means:
 *
 *   TRUSTED (`trustByUse`) at ≥ 3 different doctors and ≥ 10 taps, when no tapped visit's issued
 *   prescription lacks the medicine's composition, no second target holds more than a fifth of the
 *   picks, and the medicine is not controlled today.
 *
 *   DEMOTED — DECIDED 2026-10-08, not ruled: the last three things doctors did with the row were
 *   crosses, by at least two different doctors, with no tap in between. A demoted nickname is never
 *   shown and never proposed again; only the owner's list can restore it. A trusted nickname whose
 *   medicine has since become controlled is demoted too.
 *
 * "Doctor" is the visit's doctor when the event names a visit (a scribe typing a doctor's paper is
 * that doctor's use), else the person who tapped.
 */
export const DEMOTE_AFTER_CROSSES = 3;
export const DEMOTE_MIN_DOCTORS = 2;

export async function applyAliasUse(db: Db, aliasKey: string, now: Date = new Date()): Promise<"unchanged" | "trusted" | "demoted" | "absent"> {
  return db.transaction(async (tx) => {
    /* The log keeps keys lower-cased (`recordSignals`), so a nickname is found by its id in either case. */
    const [alias] = await tx.select().from(cdsAliases).where(sql`lower(${cdsAliases.id}) = ${aliasKey.toLowerCase()}`).for("update");
    if (alias === undefined || alias.medicineId === null || (alias.state !== "suggestion" && alias.state !== "trusted")) return "absent";
    const aliasId = alias.id;

    const events = await tx.select({
      outcome: opdSuggestionEvents.outcome, userId: opdSuggestionEvents.userId, doctorId: opdSuggestionEvents.doctorId,
      encounterId: opdSuggestionEvents.encounterId, contextKey: opdSuggestionEvents.contextKey,
    }).from(opdSuggestionEvents)
      .where(and(eq(opdSuggestionEvents.kind, "alias"), eq(opdSuggestionEvents.itemKey, aliasId.toLowerCase())))
      .orderBy(asc(opdSuggestionEvents.createdAt), asc(opdSuggestionEvents.id));
    const who = (e: { userId: string; doctorId: string | null }): string => e.doctorId ?? e.userId;
    const taps = events.filter((e) => e.outcome === "accepted");
    const distinctDoctors = new Set(taps.map(who)).size;

    const tapsByTarget: Record<string, number> = { [alias.medicineId]: taps.length };
    for (const e of events) if (e.outcome === "manual" && e.contextKey !== null) tapsByTarget[e.contextKey] = (tapsByTarget[e.contextKey] ?? 0) + 1;

    const today = await controlledToday(tx as unknown as Db, alias.medicineId);
    /* A tapped visit whose ISSUED prescription holds neither the medicine nor its composition: the doctor changed it. */
    const visits = [...new Set(taps.map((e) => e.encounterId).filter((x): x is string => x !== null))];
    let editedToAnotherMoiety = 0;
    if (visits.length > 0 && today !== null) {
      const lines = await tx.select({ encounterId: cdsRxLines.encounterId, medicineId: cdsRxLines.medicineId, moietySet: cdsRxLines.moietySet })
        .from(cdsRxLines).where(inArray(cdsRxLines.encounterId, visits));
      for (const v of visits) {
        const mine = lines.filter((l) => l.encounterId === v);
        if (mine.length > 0 && !mine.some((l) => l.medicineId === alias.medicineId || (l.moietySet !== null && l.moietySet === today.moietySet))) editedToAnotherMoiety += 1;
      }
    }

    const acts = events.filter((e) => e.outcome === "accepted" || e.outcome === "dismissed").slice(-DEMOTE_AFTER_CROSSES);
    const crossedOut = acts.length === DEMOTE_AFTER_CROSSES && acts.every((e) => e.outcome === "dismissed") && new Set(acts.map(who)).size >= DEMOTE_MIN_DOCTORS;
    const controlled = today === null || today.controlled;

    let state = alias.state;
    if (crossedOut || (alias.state === "trusted" && controlled)) state = "demoted";
    else if (alias.state === "suggestion" && trustByUse({ distinctDoctors, tapsByTarget, editedToAnotherMoiety, controlled }).trusted) state = "trusted";

    await tx.update(cdsAliases).set({ distinctDoctors, taps: taps.length, state, updatedAt: state === alias.state ? alias.updatedAt : now }).where(eq(cdsAliases.id, aliasId));
    return state === alias.state ? "unchanged" : state === "trusted" ? "trusted" : "demoted";
  });
}

// ─────────────────────────────────────────── the owner's weekly list ───────────────────────────────────────────

export type NicknameRow = {
  id: string;
  nickname: string;
  /** The catalogue's full product name, and its strength and form — never a model's words. */
  medicine: string | null;
  detail: string | null;
  state: "suggested" | "trusted" | "removed";
  /** How a removed one was removed: by the owner here, or by doctors crossing it off. */
  removedBy: "owner" | "doctors" | null;
  doctors: number;
  taps: number;
  changedAt: string;
};
export type NicknameList = { on: boolean; counts: { suggested: number; trusted: number; removed: number }; items: NicknameRow[] };

const SHOWN_STATES = ["suggestion", "trusted", "demoted", "undone"] as const;

/**
 * What was learned: every nickname that is or was live, changed in the last seven days (or all of
 * them). A 'proposed' row was never shown to anybody and is not listed. `counts` are of the whole
 * table, not of the page. Works with the pipeline off — the list is then simply what there was.
 */
export async function listNicknames(db: Db, opts: { all: boolean; on: boolean }, now: Date = new Date()): Promise<NicknameList> {
  const tally = await db.select({ state: cdsAliases.state, n: count() }).from(cdsAliases)
    .where(and(eq(cdsAliases.kind, "medicine"), inArray(cdsAliases.state, [...SHOWN_STATES]))).groupBy(cdsAliases.state);
  const n = (s: string): number => Number(tally.find((r) => r.state === s)?.n ?? 0);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.select().from(cdsAliases)
    .where(and(eq(cdsAliases.kind, "medicine"), inArray(cdsAliases.state, [...SHOWN_STATES]), opts.all ? sql`true` : gte(cdsAliases.updatedAt, since)))
    .orderBy(desc(cdsAliases.updatedAt), asc(cdsAliases.term)).limit(500);
  const ids = [...new Set(rows.map((r) => r.medicineId).filter((x): x is string => x !== null))];
  const meds = new Map<string, { brandName: string; strengthLabel: string | null; form: string }>();
  for (let i = 0; i < ids.length; i += 200) for (const [id, m] of await medicinesByIds(db, ids.slice(i, i + 200))) meds.set(id, m);
  return {
    on: opts.on,
    counts: { suggested: n("suggestion"), trusted: n("trusted"), removed: n("demoted") + n("undone") },
    items: rows.map((r) => {
      const m = r.medicineId === null ? undefined : meds.get(r.medicineId);
      /* A combination's stored strength is its FIRST component's alone (measured 2026-10-08): its name carries all of them, so only the form is added. */
      const strength = m?.strengthLabel == null || m.brandName.includes(" + ") ? null : m.strengthLabel.replace(/\/\s*$/, "").trim() || null;
      return {
        id: r.id, nickname: r.term, medicine: m?.brandName ?? null, detail: m === undefined ? null : [strength, m.form].filter((x) => x !== null && x !== "").join(" · "),
        state: r.state === "suggestion" ? "suggested" : r.state === "trusted" ? "trusted" : "removed",
        removedBy: r.state === "undone" ? "owner" : r.state === "demoted" ? "doctors" : null,
        doctors: r.distinctDoctors, taps: r.taps, changedAt: (r.undoneAt ?? r.updatedAt).toISOString(),
      };
    }),
  };
}

/**
 * THE ONE-TAP UNDO. A live nickname becomes 'undone': the search never returns it and the runner
 * never proposes its term again. Who and when are on the row (`undone_by`, `undone_at`) and in the
 * event stream (`alias.undone`), in the same transaction. Undoing twice is a no-op, not an error.
 */
export async function undoNickname(db: Db, actor: Actor, aliasId: string, now: Date = new Date()): Promise<void> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a nickname is removed by a person");
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(cdsAliases).where(eq(cdsAliases.id, aliasId)).for("update");
    if (row === undefined || row.state === "proposed") throw new OpdError("unknown_nickname", "no such nickname");
    if (row.state === "undone") return;
    await tx.update(cdsAliases).set({ state: "undone", undoneBy: actor.id, undoneAt: now, updatedAt: now }).where(eq(cdsAliases.id, aliasId));
    await appendEvent(tx, aliasUndone.make({ actor, payload: { aliasId, term: row.term, medicineId: row.medicineId, previousState: row.state } }));
  });
}

/**
 * Put a removed nickname back — as a SUGGESTION, whatever it was: trust is earned by use and is
 * worked out again from the log on the next tap. Refused when its medicine is controlled today or
 * gone from the catalogue. Audited like the undo (`alias.restored`).
 */
export async function restoreNickname(db: Db, actor: Actor, aliasId: string, now: Date = new Date()): Promise<void> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a nickname is restored by a person");
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(cdsAliases).where(eq(cdsAliases.id, aliasId)).for("update");
    if (row === undefined || row.state === "proposed" || row.medicineId === null) throw new OpdError("unknown_nickname", "no such nickname");
    if (row.state !== "undone" && row.state !== "demoted") return;
    const today = await controlledToday(tx as unknown as Db, row.medicineId);
    if (today === null || today.controlled) throw new OpdError("invalid_config", "this medicine can no longer have a nickname");
    await tx.update(cdsAliases).set({ state: "suggestion", undoneBy: null, undoneAt: null, updatedAt: now }).where(eq(cdsAliases.id, aliasId));
    await appendEvent(tx, aliasRestored.make({ actor, payload: { aliasId, term: row.term, medicineId: row.medicineId, previousState: row.state } }));
  });
}
