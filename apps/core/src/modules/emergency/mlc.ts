import { and, asc, desc, eq, gte, inArray, isNull, lte, max, sql } from "drizzle-orm";
import {
  ER_INTENTS, ER_MLC_COUNTERSIGN_MIN, ER_MLC_FREE_BY_LAW, ER_MLC_INTIMATION_MIN, ER_MLC_LATE_MIN, erIsInFuture, newId,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  ER_OPEN_STATE_VALUES, erEpisodes, erMlcAddenda, erMlcCustody, erMlcIntimations, erMlcObligations, erMlcs, ipdMortuaryRegister, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { getPatientSummaries } from "../patients";
import { escalationRecipients } from "../roster";
import { isConsultant } from "../ipd";
import { cancelTask, getTask, raiseTask } from "../tasks";
import { verifySecondPerson } from "./care";
import { lockEpisode, onceEr, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import {
  erBelongingsRecorded, erEvidenceCustody, erMlcAddendum, erMlcCountersigned, erMlcOpened, erPoliceIntimated,
} from "./events";
import { ER_MLC } from "./names";
import { ER_MLC_INTIMATION_TASK } from "./task-kinds";
import { isActiveDoctor } from "./triage";
import type { Actor, ErBroughtBy, ErIntentName, ErMlcCategory, ErMlcClock, ErMlcDesk, ErMlcDetail, ErMlcRow } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 4 (#811) — THE MEDICO-LEGAL CASE (spec SPEC-emergency §3.7, §3.8, §4.4; contracts `emergency/mlc.ts`).
 *
 * - The register: one MLC per ER episode, serial `MLC26-000123` per IST year. The row is IMMUTABLE (a trigger refuses
 *   UPDATE and DELETE); corrections are addenda, the latest category winning on every read.
 * - Opened by a doctor (`open_mlc`), or BY RULE at arrival (DECIDED, spec §4.4): an unidentified patient
 *   (`unknown_unconscious`), a body brought dead (`brought_dead`) and a patient the police bring (`police_brought` — the
 *   intimation IS their arrival: recorded at once from the officer the desk wrote down, when the desk named the station).
 * - Two obligations per case: the police intimation, due 1 h after opening (a stat task for the ER desk and the casualty
 *   nurse at the due instant, one climb 30 min later on the `mlc_intimation` ladder); the faculty countersign, due in 24 h
 *   (breached → one notice on the `mlc_countersign` ladder; the obligation stays owed, even after the patient's death).
 * - Belongings and evidence: a numbered custody log, each link signed by the recorder and a second person's PIN.
 * - The MLC's events correlate on the MLC id (its own record), the episode id in the payload: the episode's own event
 *   stream stays the clinical one.
 * - THE MLC NEVER DELAYS TREATMENT: no care intent reads this file's tables (lane 3's acceptance (c-2) proves it).
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type MlcRow = typeof erMlcs.$inferSelect;
type ObligationRow = typeof erMlcObligations.$inferSelect;

const MIN = 60_000;
/** DECIDED (lane 4): an intimation still missing this long past its target climbs to the duty manager's ladder. */
export const ER_MLC_INTIMATION_CLIMB_MIN = 30;
export const ER_MLC_ACTOR: Actor = { type: "system", id: "er-mlc-clock" };
const RESIDENT_ROLES = ["resident", "radiology_resident"];
const OPEN: readonly string[] = ER_OPEN_STATE_VALUES;

const lockKey = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

/** IST calendar year of an instant (the MLC serial restarts every IST year). */
function istYear(at: Date): number {
  return Number(istDayString(at).slice(0, 4));
}

async function mintMlcNo(tx: Tx, at: Date): Promise<{ year: number; serial: number; mlcNo: string }> {
  const year = istYear(at);
  await lockKey(tx, `er_mlc_no:${String(year)}`);
  const rows = (await tx.execute(sql`select coalesce(max(mlc_serial), 0) + 1 as next from er_mlcs where mlc_year = ${year}`)).rows as { next: number | string }[];
  const serial = Number(rows[0]!.next);
  return { year, serial, mlcNo: `MLC${String(year % 100).padStart(2, "0")}-${String(serial).padStart(6, "0")}` };
}

/** The case under its advisory lock (every MLC act serialises on it; the row itself is never updated). */
async function lockMlc(tx: Tx, mlcId: string): Promise<MlcRow> {
  await lockKey(tx, `er_mlc:${mlcId}`);
  const row = (await tx.select().from(erMlcs).where(eq(erMlcs.id, mlcId)))[0];
  if (row === undefined) throw new ErRefusal("mlc_not_found");
  return row;
}

async function obligationOf(tx: Db | Tx, mlcId: string, kind: "police_intimation" | "faculty_countersign"): Promise<ObligationRow> {
  return (await tx.select().from(erMlcObligations).where(and(eq(erMlcObligations.mlcId, mlcId), eq(erMlcObligations.kind, kind))))[0]!;
}

async function requireDoctor(tx: Tx, actor: Actor): Promise<void> {
  if (actor.type === "system") return;
  if (!(await isActiveDoctor(tx, actor.id))) throw new ErRefusal("not_a_doctor", { userId: actor.id });
}

/** The episode's MLC, if one is open (one per episode). */
export async function mlcOfEpisode(db: Db | Tx, episodeId: string): Promise<MlcRow | undefined> {
  return (await db.select().from(erMlcs).where(eq(erMlcs.episodeId, episodeId)))[0];
}

type OpenArgs = {
  category: ErMlcCategory;
  byRule: boolean;
  informant?: { name: string; relation: string; phone?: string; words: string } | undefined;
  injuries?: { site: string; kind: string; sizeCm?: string; description?: string }[] | undefined;
  pocso?: boolean | undefined;
};

/**
 * Opens the case in the caller's transaction (the episode already locked or just written): the row, its two obligations,
 * the police-present intimation when the police brought the patient, and `er.mlc_opened`. Refuses a second case.
 */
export async function openMlcIn(tx: Tx, actor: Actor, e: EpisodeRow, args: OpenArgs, at: Date): Promise<MlcRow> {
  const existing = await mlcOfEpisode(tx, e.id);
  if (existing !== undefined) throw new ErRefusal("mlc_already_open", { mlcId: existing.id, mlcNo: existing.mlcNo });
  const no = await mintMlcNo(tx, at);
  const id = newId();
  // Late (spec §4.4: allowed, flagged): a doctor opening it more than 6 h after the gate, or after the patient left.
  const late = !args.byRule && (at.getTime() - e.arrivedAt.getTime() > ER_MLC_LATE_MIN * MIN || !OPEN.includes(e.state));
  await tx.insert(erMlcs).values({
    id, mlcNo: no.mlcNo, mlcYear: no.year, mlcSerial: no.serial, episodeId: e.id, patientId: e.patientId, category: args.category,
    informant: args.informant ?? null, injuries: args.injuries ?? [], pocso: args.pocso ?? false,
    freeByLaw: ER_MLC_FREE_BY_LAW.includes(args.category), openedBy: actor.id, openedByRule: args.byRule, openedAt: at, late,
    provenance: provenanceOf(actor),
  });
  await tx.insert(erMlcObligations).values([
    { id: newId(), mlcId: id, kind: "police_intimation", dueAt: new Date(at.getTime() + ER_MLC_INTIMATION_MIN * MIN) },
    { id: newId(), mlcId: id, kind: "faculty_countersign", dueAt: new Date(at.getTime() + ER_MLC_COUNTERSIGN_MIN * MIN) },
  ]);
  await appendEvent(tx, erMlcOpened.make({
    payload: { episodeId: e.id, mlcId: id, mlcNo: no.mlcNo, category: args.category, byRule: args.byRule, late, provenance: provenanceOf(actor) },
    actor, correlationId: id, patientId: e.patientId, occurredAt: at,
  }));
  // The police brought the patient: the intimation is their arrival — the officer the desk recorded (spec §4.4).
  const b = (e.broughtBy ?? null) as ErBroughtBy | null;
  if ((e.arrivalMode === "police" || b?.kind === "police") && b?.policeStation !== undefined) {
    await writeIntimation(tx, actor, (await lockMlc(tx, id)), {
      mode: "police_present", station: b.policeStation, receiverName: b.name ?? (b.badgeNo === undefined ? "Officer on arrival" : `Badge ${b.badgeNo}`),
      receiverRank: null, gdEntryNo: null, intimatedAt: e.arrivedAt,
    }, at);
  }
  return (await tx.select().from(erMlcs).where(eq(erMlcs.id, id)))[0]!;
}

// ═══════════════════════════════════════════ open_mlc, add_mlc_addendum ═══════════════════════════════════════════

export async function openMlc(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"open_mlc">> {
  const input: Input<"open_mlc"> = ER_INTENTS.open_mlc.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "open_mlc", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    const e = await lockEpisode(tx, input.episodeId);
    const m = await openMlcIn(tx, actor, e, {
      category: input.category, byRule: false, informant: input.informant, injuries: input.injuries, pocso: input.pocso,
    }, at);
    const [i, c] = await Promise.all([obligationOf(tx, m.id, "police_intimation"), obligationOf(tx, m.id, "faculty_countersign")]);
    return {
      mlcId: m.id, mlcNo: m.mlcNo, late: m.late, intimationDueAt: i.dueAt.toISOString(), countersignDueAt: c.dueAt.toISOString(),
    };
  }), at);
}

export async function addMlcAddendum(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"add_mlc_addendum">> {
  const input: Input<"add_mlc_addendum"> = ER_INTENTS.add_mlc_addendum.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "add_mlc_addendum", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMlc(tx, input.mlcId);
    await requireDoctor(tx, actor);
    const id = newId();
    await tx.insert(erMlcAddenda).values({
      id, mlcId: m.id, text: input.text, category: input.category ?? null, examinationRefused: input.examinationRefused ?? false,
      injuries: input.injuries ?? [], authorId: actor.id, at,
    });
    await appendEvent(tx, erMlcAddendum.make({
      payload: { episodeId: m.episodeId, mlcId: m.id, addendumId: id, provenance: provenanceOf(actor) },
      actor, correlationId: m.id, patientId: m.patientId, occurredAt: at,
    }));
    return { addendumId: id, at: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ the police intimation ═══════════════════════════════════════════

type IntimationArgs = {
  mode: "written" | "phone_then_written" | "police_present"; station: string; receiverName: string; receiverRank: string | null;
  gdEntryNo: string | null; intimatedAt: Date;
};

/** The intimation row, the obligation met, its task cancelled, the event. In the caller's transaction, the case locked. */
async function writeIntimation(tx: Tx, actor: Actor, m: MlcRow, a: IntimationArgs, at: Date): Promise<{ id: string; withinTarget: boolean }> {
  const already = (await tx.select({ id: erMlcIntimations.id }).from(erMlcIntimations).where(eq(erMlcIntimations.mlcId, m.id)))[0];
  if (already !== undefined) throw new ErRefusal("intimation_recorded", { intimationId: already.id });
  const ob = await obligationOf(tx, m.id, "police_intimation");
  const id = newId();
  await tx.insert(erMlcIntimations).values({
    id, mlcId: m.id, mode: a.mode, station: a.station, receiverName: a.receiverName, receiverRank: a.receiverRank,
    gdEntryNo: a.gdEntryNo, intimatedAt: a.intimatedAt, recordedBy: actor.id, recordedAt: at,
  });
  await tx.update(erMlcObligations).set({ metAt: a.intimatedAt, metBy: actor.id }).where(eq(erMlcObligations.id, ob.id));
  await closeObligationTask(tx, ob, "police intimation recorded", at);
  const withinTarget = a.intimatedAt.getTime() <= ob.dueAt.getTime();
  await appendEvent(tx, erPoliceIntimated.make({
    payload: { episodeId: m.episodeId, mlcId: m.id, mode: a.mode, withinTarget, provenance: provenanceOf(actor) },
    actor, correlationId: m.id, patientId: m.patientId, occurredAt: at,
  }));
  return { id, withinTarget };
}

async function closeObligationTask(tx: Tx, ob: ObligationRow, why: string, at: Date): Promise<void> {
  if (ob.taskId === null) return;
  const t = await getTask(tx, ob.taskId);
  if (t === null || !["created", "assigned", "accepted", "in_progress"].includes(t.state)) return;
  await cancelTask(tx, ER_MLC_ACTOR, { taskId: t.id, version: t.version, reason: why }, at);
}

export async function recordPoliceIntimation(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_police_intimation">> {
  const input: Input<"record_police_intimation"> = ER_INTENTS.record_police_intimation.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  if (input.intimatedAt !== undefined && erIsInFuture(input.intimatedAt, at)) throw new ErRefusal("time_in_future");
  const when = input.intimatedAt === undefined ? at : new Date(Math.min(new Date(input.intimatedAt).getTime(), at.getTime()));
  return onceEr(db, actor, "record_police_intimation", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMlc(tx, input.mlcId);
    // ER review (2026-10-15): an intimation is never dated before the patient arrived (the target would always be met).
    const ep = await readEpisode(tx, m.episodeId);
    if (when.getTime() < ep.arrivedAt.getTime()) throw new ErRefusal("intimation_before_arrival", { arrivedAt: ep.arrivedAt.toISOString() });
    const r = await writeIntimation(tx, actor, m, {
      mode: input.mode, station: input.station, receiverName: input.receiverName, receiverRank: input.receiverRank ?? null,
      gdEntryNo: input.gdEntryNo ?? null, intimatedAt: when,
    }, at);
    return { intimationId: r.id, intimatedAt: when.toISOString(), withinTarget: r.withinTarget };
  }), at);
}

// ═══════════════════════════════════════════ the faculty countersign ═══════════════════════════════════════════

export async function countersignMlc(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"countersign_mlc">> {
  const input: Input<"countersign_mlc"> = ER_INTENTS.countersign_mlc.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "countersign_mlc", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMlc(tx, input.mlcId);
    const ob = await obligationOf(tx, m.id, "faculty_countersign");
    if (ob.metAt !== null) throw new ErRefusal("mlc_countersigned", { countersignedAt: ob.metAt.toISOString() });
    if (m.openedBy === actor.id) throw new ErRefusal("countersign_own_mlc");
    // ER review (2026-10-15): the examiner who wrote the findings (an addendum) does not countersign their own case.
    const authored = (await tx.select({ id: erMlcAddenda.id }).from(erMlcAddenda)
      .where(and(eq(erMlcAddenda.mlcId, m.id), eq(erMlcAddenda.authorId, actor.id))).limit(1))[0];
    if (authored !== undefined) throw new ErRefusal("countersign_own_mlc", { addendum: authored.id });
    // FACULTY = a consultant by the IPD rule (active doctor master + consultant grade on the roster, else not a resident
    // role): a doctor off the master (a medical officer, an intern) is not senior enough.
    if (!(await isActiveDoctor(tx, actor.id)) || await actorHoldsAnyRole(tx, actor.id, RESIDENT_ROLES) || !(await isConsultant(tx, actor.id, at))) {
      throw new ErRefusal("cosigner_not_senior");
    }
    await tx.update(erMlcObligations).set({ metAt: at, metBy: actor.id }).where(eq(erMlcObligations.id, ob.id));
    const withinTarget = at.getTime() <= ob.dueAt.getTime();
    await appendEvent(tx, erMlcCountersigned.make({
      payload: { episodeId: m.episodeId, mlcId: m.id, withinTarget, provenance: provenanceOf(actor) },
      actor, correlationId: m.id, patientId: m.patientId, occurredAt: at,
    }));
    return { mlcId: m.id, countersignedAt: at.toISOString(), withinTarget };
  }), at);
}

// ═══════════════════════════════════════════ belongings and evidence ═══════════════════════════════════════════

/** A custody witness: any active user who holds `er.mlc` (the ER desk, a nurse, a doctor, the duty manager). */
const holdsMlc = (tx: Tx, userId: string) => hasPermission(tx as unknown as Db, userId, ER_MLC, "hospital");

async function nextLink(tx: Tx, mlcId: string): Promise<number> {
  const r = (await tx.select({ m: max(erMlcCustody.link) }).from(erMlcCustody).where(eq(erMlcCustody.mlcId, mlcId)))[0];
  return (r?.m ?? 0) + 1;
}

export async function recordBelongings(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_belongings">> {
  const input: Input<"record_belongings"> = ER_INTENTS.record_belongings.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_belongings", input.idempotencyKey, input, async () => {
    const witness = await verifySecondPerson(db, actor, input.secondPerson.username, input.secondPerson.pin, at, holdsMlc);
    return withTx(db, async (tx) => {
      const m = await lockMlc(tx, input.mlcId);
      const id = newId();
      await tx.insert(erMlcCustody).values({
        id, mlcId: m.id, link: await nextLink(tx, m.id), kind: "belongings", action: "listed", items: input.items, keptIn: input.keptIn,
        recordedBy: actor.id, witnessedBy: witness, at,
      });
      await appendEvent(tx, erBelongingsRecorded.make({
        payload: { episodeId: m.episodeId, mlcId: m.id, custodyId: id, items: input.items.length, provenance: provenanceOf(actor) },
        actor, correlationId: m.id, patientId: m.patientId, occurredAt: at,
      }));
      return { custodyId: id, witnessedBy: witness };
    });
  }, at);
}

export async function handOverEvidence(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"hand_over_evidence">> {
  const input: Input<"hand_over_evidence"> = ER_INTENTS.hand_over_evidence.input.parse(raw);
  await requireErPermission(db, actor, ER_MLC);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "hand_over_evidence", input.idempotencyKey, input, async () => {
    const witness = await verifySecondPerson(db, actor, input.secondPerson.username, input.secondPerson.pin, at, holdsMlc);
    return withTx(db, async (tx) => {
      const m = await lockMlc(tx, input.mlcId);
      const seal = input.sealNo.trim().toUpperCase();
      const chain = await tx.select({ action: erMlcCustody.action }).from(erMlcCustody)
        .where(and(eq(erMlcCustody.mlcId, m.id), eq(erMlcCustody.sealNo, seal)));
      if (chain.some((l) => l.action === "handed_over")) throw new ErRefusal("seal_already_handed_over", { sealNo: seal });
      if (input.action === "collected" && chain.some((l) => l.action === "collected")) throw new ErRefusal("seal_already_collected", { sealNo: seal });
      if (input.action !== "collected" && !chain.some((l) => l.action === "collected")) throw new ErRefusal("seal_not_collected", { sealNo: seal });
      const id = newId();
      const link = await nextLink(tx, m.id);
      await tx.insert(erMlcCustody).values({
        id, mlcId: m.id, link, kind: "evidence", evidenceKind: input.kind, description: input.description, sealNo: seal, action: input.action,
        receiver: input.receiver ?? null, recordedBy: actor.id, witnessedBy: witness, at,
      });
      await appendEvent(tx, erEvidenceCustody.make({
        payload: { episodeId: m.episodeId, mlcId: m.id, custodyId: id, link, action: input.action, provenance: provenanceOf(actor) },
        actor, correlationId: m.id, patientId: m.patientId, occurredAt: at,
      }));
      return { custodyId: id, link };
    });
  }, at);
}

// ═══════════════════════════════════════════ the clocks ═══════════════════════════════════════════

/**
 * Every minute (inside the bed-reservation lapse job, beside the ER's other clocks). Owed obligations only (a partial
 * index on `due_at where met_at is null`); each stamp is written once, so a tick with nothing new writes nothing.
 * - police intimation past its 1-hour target → ONE stat task (`er_mlc_intimation`) for the ER desk and the casualty
 *   nurse; still owed 30 min later → ONE climb on the `mlc_intimation` ladder (fallback the duty manager).
 * - faculty countersign past 24 h → the obligation is BREACHED (stamped) and told ONCE on the `mlc_countersign` ladder
 *   (fallback the medical superintendent). It stays owed — the patient's death or departure does not close it.
 * Notices and tasks carry the MLC and ER numbers, never a name.
 */
export async function sweepErMlcClocks(db: Db, now: Date): Promise<{ tasks: number; climbs: number; breaches: number }> {
  const out = { tasks: 0, climbs: 0, breaches: 0 };
  // ER review (2026-10-15): an obligation with nothing left to raise (the intimation's task and climb done, the
  // countersign's breach told) is left out — it costs no transaction and no case lock every minute.
  const owed = await db.select({ id: erMlcObligations.id }).from(erMlcObligations)
    .where(and(isNull(erMlcObligations.metAt), lte(erMlcObligations.dueAt, now), sql`not (
      (${erMlcObligations.kind} = 'police_intimation' and ${erMlcObligations.taskId} is not null and ${erMlcObligations.climbedAt} is not null)
      or (${erMlcObligations.kind} = 'faculty_countersign' and ${erMlcObligations.breachedAt} is not null))`));
  for (const { id } of owed) {
    await withTx(db, async (tx) => {
      const ob0 = (await tx.select().from(erMlcObligations).where(eq(erMlcObligations.id, id)))[0];
      if (ob0 === undefined) return;
      const m = await lockMlc(tx, ob0.mlcId);
      const ob = (await tx.select().from(erMlcObligations).where(eq(erMlcObligations.id, id)))[0]!;
      if (ob.metAt !== null) return;
      const e = await readEpisode(tx, m.episodeId);
      if (ob.kind === "police_intimation") {
        if (ob.taskId === null) {
          const raised = await raiseTask(tx, ER_MLC_ACTOR, {
            kind: ER_MLC_INTIMATION_TASK, patientId: m.patientId, placeResourceId: OPEN.includes(e.state) ? e.bayId : null, priority: "stat",
            dueAt: ob.dueAt.toISOString(), sourceRef: `er_mlc_intimation:${m.id}`, note: `Police intimation ${m.mlcNo} · ${e.episodeNo}`,
            raisedAt: ob.dueAt.toISOString(),
          }, now);
          await tx.update(erMlcObligations).set({ taskId: raised.task.id }).where(eq(erMlcObligations.id, ob.id));
          out.tasks += 1;
        }
        if (ob.climbedAt === null && now.getTime() >= ob.dueAt.getTime() + ER_MLC_INTIMATION_CLIMB_MIN * MIN) {
          const to = (await escalationRecipients(tx, "mlc_intimation", { fallbackRoleKey: "duty_manager" }, now)).userIds;
          for (const userId of to) {
            await raiseNoticeIn(tx, {
              userId, kind: "er.mlc_intimation_overdue", title: `Police intimation overdue · ${m.mlcNo}`,
              body: `${e.episodeNo} · due ${String(Math.round((now.getTime() - ob.dueAt.getTime()) / MIN))} min ago`,
              refType: "er_mlc", refId: m.id, sourceKey: `er_mlc_intimation:${m.id}:climb`, at: now,
            });
          }
          await tx.update(erMlcObligations).set({ climbedAt: now }).where(eq(erMlcObligations.id, ob.id));
          out.climbs += 1;
        }
      } else if (ob.breachedAt === null) {
        const to = (await escalationRecipients(tx, "mlc_countersign", { fallbackRoleKey: "medical_superintendent" }, now)).userIds;
        for (const userId of to) {
          await raiseNoticeIn(tx, {
            userId, kind: "er.mlc_countersign_overdue", title: `MLC countersign overdue · ${m.mlcNo}`, body: e.episodeNo,
            refType: "er_mlc", refId: m.id, sourceKey: `er_mlc_countersign:${m.id}:breach`, at: now,
          });
        }
        await tx.update(erMlcObligations).set({ breachedAt: now }).where(eq(erMlcObligations.id, ob.id));
        out.breaches += 1;
      }
    });
  }
  return out;
}

// ═══════════════════════════════════════════ reads: the MLC desk ═══════════════════════════════════════════

function clockOf(ob: ObligationRow | undefined, now: Date): ErMlcClock {
  if (ob === undefined) return { dueAt: now.toISOString(), metAt: null, breached: false };
  const breached = ob.metAt === null ? now.getTime() > ob.dueAt.getTime() : ob.metAt.getTime() > ob.dueAt.getTime();
  return { dueAt: ob.dueAt.toISOString(), metAt: ob.metAt?.toISOString() ?? null, breached };
}

async function toRows(db: Db, actor: Actor, mlcs: MlcRow[], now: Date): Promise<ErMlcRow[]> {
  if (mlcs.length === 0) return [];
  const ids = mlcs.map((m) => m.id);
  const [obs, adds, eps, people] = await Promise.all([
    db.select().from(erMlcObligations).where(inArray(erMlcObligations.mlcId, ids)),
    db.select({ mlcId: erMlcAddenda.mlcId, category: erMlcAddenda.category }).from(erMlcAddenda)
      .where(and(inArray(erMlcAddenda.mlcId, ids), sql`${erMlcAddenda.category} is not null`)).orderBy(asc(erMlcAddenda.at)),
    db.select({ id: erEpisodes.id, no: erEpisodes.episodeNo, state: erEpisodes.state }).from(erEpisodes)
      .where(inArray(erEpisodes.id, [...new Set(mlcs.map((m) => m.episodeId))])),
    getPatientSummaries(db, actor, [...new Set(mlcs.map((m) => m.patientId))]),
  ]);
  const cat = new Map<string, string>();
  for (const a of adds) cat.set(a.mlcId, a.category!);
  const ep = new Map(eps.map((e) => [e.id, e] as const));
  const who = new Map(people.map((p) => [p.requestedId, p] as const));
  return mlcs.map((m) => {
    const p = who.get(m.patientId);
    const e = ep.get(m.episodeId);
    return {
      mlcId: m.id, mlcNo: m.mlcNo, episodeId: m.episodeId, episodeNo: e?.no ?? "", patientId: m.patientId,
      patientLabel: p === undefined ? "" : (p.restricted ? p.alias : p.name) ?? p.uhid, uhid: p?.uhid ?? "",
      category: (cat.get(m.id) ?? m.category) as ErMlcCategory, openedAt: m.openedAt.toISOString(), openedByRule: m.openedByRule,
      late: m.late, freeByLaw: m.freeByLaw, pocso: m.pocso, episodeState: e?.state ?? "",
      intimation: clockOf(obs.find((o) => o.mlcId === m.id && o.kind === "police_intimation"), now),
      countersign: clockOf(obs.find((o) => o.mlcId === m.id && o.kind === "faculty_countersign"), now),
    };
  });
}

/** The MLC desk (spec §5 E): every case with an obligation owed (the oldest due first), then the last 7 days' others. */
export async function readMlcDesk(db: Db, actor: Actor, opts: Opts = {}): Promise<ErMlcDesk> {
  await requireErPermission(db, actor, ER_MLC);
  const now = opts.now ?? new Date();
  const owedIds = (await db.select({ mlcId: erMlcObligations.mlcId }).from(erMlcObligations)
    .where(isNull(erMlcObligations.metAt)).orderBy(asc(erMlcObligations.dueAt)).limit(400)).map((r) => r.mlcId);
  const owedSet = [...new Set(owedIds)];
  const owedRows = owedSet.length === 0 ? [] : await db.select().from(erMlcs).where(inArray(erMlcs.id, owedSet));
  const recentRows = await db.select().from(erMlcs).where(gte(erMlcs.openedAt, new Date(now.getTime() - 7 * 24 * 60 * MIN)))
    .orderBy(desc(erMlcs.openedAt)).limit(200);
  const owed = await toRows(db, actor, owedSet.map((id) => owedRows.find((r) => r.id === id)!).filter(Boolean), now);
  const recent = await toRows(db, actor, recentRows.filter((r) => !owedSet.includes(r.id)), now);
  return { owed, recent, serverNow: now.toISOString() };
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const u = [...new Set(ids)];
  if (u.length === 0) return new Map();
  return new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, u))).map((r) => [r.id, r.n] as const));
}

/** One case in full: the original, every addendum, the intimation, the countersign, the custody log, the mortuary entry. */
export async function readMlc(db: Db, actor: Actor, mlcId: string, opts: Opts = {}): Promise<ErMlcDetail> {
  await requireErPermission(db, actor, ER_MLC);
  const now = opts.now ?? new Date();
  const m = (await db.select().from(erMlcs).where(eq(erMlcs.id, mlcId)))[0];
  if (m === undefined) throw new ErRefusal("mlc_not_found");
  const [row] = await toRows(db, actor, [m], now);
  const [adds, intim, custody, obs, mortuary] = await Promise.all([
    db.select().from(erMlcAddenda).where(eq(erMlcAddenda.mlcId, m.id)).orderBy(asc(erMlcAddenda.at)),
    db.select().from(erMlcIntimations).where(eq(erMlcIntimations.mlcId, m.id)),
    db.select().from(erMlcCustody).where(eq(erMlcCustody.mlcId, m.id)).orderBy(asc(erMlcCustody.link)),
    db.select().from(erMlcObligations).where(eq(erMlcObligations.mlcId, m.id)),
    db.select({ id: ipdMortuaryRegister.id }).from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.erEpisodeId, m.episodeId)),
  ]);
  const cs = obs.find((o) => o.kind === "faculty_countersign");
  const i = intim[0];
  const names = await namesOf(db, [
    m.openedBy, ...adds.map((a) => a.authorId), ...(i === undefined ? [] : [i.recordedBy]), ...(cs?.metBy === null || cs === undefined ? [] : [cs.metBy]),
    ...custody.flatMap((c) => [c.recordedBy, c.witnessedBy]),
  ]);
  const ref = (userId: string) => ({ userId, name: names.get(userId) ?? userId });
  return {
    ...row!,
    openedBy: ref(m.openedBy), informant: m.informant ?? null, injuries: m.injuries as ErMlcDetail["injuries"],
    originalCategory: m.category as ErMlcCategory,
    addenda: adds.map((a) => ({
      addendumId: a.id, text: a.text, category: (a.category as ErMlcCategory | null) ?? null, examinationRefused: a.examinationRefused,
      injuries: a.injuries as ErMlcDetail["injuries"], by: ref(a.authorId), at: a.at.toISOString(),
    })),
    intimationRecord: i === undefined ? null : {
      mode: i.mode as "written", station: i.station, receiverName: i.receiverName, receiverRank: i.receiverRank, gdEntryNo: i.gdEntryNo,
      intimatedAt: i.intimatedAt.toISOString(), recordedBy: ref(i.recordedBy),
    },
    countersignedBy: cs?.metBy === null || cs === undefined ? null : ref(cs.metBy),
    custody: custody.map((c) => ({
      custodyId: c.id, link: c.link, kind: c.kind as "belongings", evidenceKind: c.evidenceKind, description: c.description, sealNo: c.sealNo,
      action: c.action, items: c.items ?? null, keptIn: c.keptIn ?? null, receiver: c.receiver ?? null, recordedBy: ref(c.recordedBy),
      witnessedBy: ref(c.witnessedBy), at: c.at.toISOString(),
    })),
    mortuaryEntryId: mortuary[0]?.id ?? null,
  };
}
