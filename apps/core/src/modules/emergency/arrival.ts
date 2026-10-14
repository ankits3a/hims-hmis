import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import {
  ER_ARRIVAL_BACKFILL_MS, ER_INTENTS, ER_PRE_ALERT_LAPSE_MINUTES, ER_RETURN_WINDOW_MS, erIsInFuture, newId,
} from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { erEpisodes, erPreAlerts } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { startInstance } from "../../kernel/workflow/instances";
import { placedAdmissionOf } from "../ipd";
import { PatientError, getPatient, registerPatient } from "../patients";
import { bandPerson, checkPrinter, mintBandIn } from "./bands";
import {
  alreadyOpen, erPatientLock, isOpenEpisodeRace, mintAlias, mintEpisodeNo, moveEpisode, onceEr, openEpisodeOf,
  personRecords, provenanceOf, requireErPermission, workflowRefusal,
} from "./core";
import { ErRefusal } from "./errors";
import { erArrived, erBroughtDead, erPreAlertCancelled, erPreAlerted } from "./events";
import { ER_ARRIVAL_REGISTER } from "./names";
import { ER_EPISODE_WORKFLOW_DEF_KEY } from "./workflow";
import type { Actor, ErAgeBand, ErArrivalMode, ErBroughtBy, ErIntentName, ErSex } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 1 (#808) — THE ARRIVAL INTENTS (spec SPEC-emergency §4.1; contracts `packages/contracts/src/emergency/intents.ts`).
 *
 * The IPD shape: parse the contract input → re-check the permission → run once under the idempotency key → lock (the
 * person, then the pre-alert) → re-check state and rules → write the episode, start its workflow instance, print the
 * band and append the events, in ONE transaction.
 *
 * The rules this file owns: arrival is recorded before anything else (sex, an age band and the arrival mode are the
 * only required answers for an unknown); `arrived_at` is the GATE instant and never moves; one open episode per PERSON
 * (refused, showing the first); an admitted inpatient is the ward team's; a second arrival within 24 h is flagged; a
 * pre-alert is claimed by its arrivals and lapses two hours after its expected time. No rule here reads money.
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/** The system actor of the pre-alert lapse (the bed-reservation minute job runs it). */
export const ER_LAPSE_ACTOR: Actor = { type: "system", id: "er-pre-alert-lapse" };

// ═══════════════════════════════════════════ pre-alerts ═══════════════════════════════════════════

export async function preAlert(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"pre_alert">> {
  const input: Input<"pre_alert"> = ER_INTENTS.pre_alert.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "pre_alert", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const id = newId();
    const expectedAt = new Date(at.getTime() + input.etaMinutes * 60_000);
    const expiresAt = new Date(expectedAt.getTime() + ER_PRE_ALERT_LAPSE_MINUTES * 60_000);
    await tx.insert(erPreAlerts).values({
      id, state: "expected", mode: input.mode, expectedAt, expiresAt, count: input.count, sex: input.sex ?? null,
      ageBand: input.ageBand ?? null, complaint: input.complaint ?? null, caller: input.caller ?? null,
      callerPhone: input.callerPhone ?? null, vehicleNo: input.vehicleNo ?? null, createdBy: actor.id, createdAt: at,
    });
    await appendEvent(tx, erPreAlerted.make({
      payload: { preAlertId: id, mode: input.mode, count: input.count, provenance: provenanceOf(actor) },
      actor, correlationId: id, occurredAt: at,
    }));
    return { preAlertId: id, state: "expected" as const, expectedAt: expectedAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }), at);
}

export async function cancelPreAlert(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cancel_pre_alert">> {
  const input: Input<"cancel_pre_alert"> = ER_INTENTS.cancel_pre_alert.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "cancel_pre_alert", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const row = (await tx.select().from(erPreAlerts).where(eq(erPreAlerts.id, input.preAlertId)).for("update"))[0];
    if (row === undefined) throw new ErRefusal("pre_alert_not_found");
    if (row.state !== "expected") throw new ErRefusal("pre_alert_closed", { state: row.state });
    await closePreAlert(tx, actor, row.id, input.reason, at);
    return { preAlertId: row.id, state: "cancelled" as const };
  }), at);
}

async function closePreAlert(tx: Tx, actor: Actor, id: string, reason: string, at: Date): Promise<void> {
  await tx.update(erPreAlerts).set({ state: "cancelled", cancelReason: reason, closedAt: at }).where(eq(erPreAlerts.id, id));
  await appendEvent(tx, erPreAlertCancelled.make({
    payload: { preAlertId: id, reason, provenance: provenanceOf(actor) }, actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * The 2-hour lapse (spec §1), every minute inside the bed-reservation lapse job (no worker job of its own). Idempotent:
 * each row is re-read FOR UPDATE and lapsed only while still expected and due; a tick with nothing due runs one indexed
 * read (`er_pre_alerts_expected_idx`) and writes nothing. Returns how many lapsed.
 */
export async function lapseErPreAlerts(db: Db, now: Date): Promise<number> {
  const due = await db.select({ id: erPreAlerts.id }).from(erPreAlerts)
    .where(and(eq(erPreAlerts.state, "expected"), lte(erPreAlerts.expiresAt, now)));
  let n = 0;
  for (const { id } of due) {
    n += await withTx(db, async (tx) => {
      const row = (await tx.select().from(erPreAlerts).where(eq(erPreAlerts.id, id)).for("update"))[0];
      if (row === undefined || row.state !== "expected" || row.expiresAt.getTime() > now.getTime()) return 0;
      await closePreAlert(tx, ER_LAPSE_ACTOR, id, "lapsed", now);
      return 1;
    });
  }
  return n;
}

/** An arrival answering a pre-alert claims one of its patients; the last claim closes it. Lapsed inline when past due. */
async function claimPreAlert(tx: Tx, preAlertId: string, at: Date): Promise<void> {
  const row = (await tx.select().from(erPreAlerts).where(eq(erPreAlerts.id, preAlertId)).for("update"))[0];
  if (row === undefined) throw new ErRefusal("pre_alert_not_found");
  if (row.state !== "expected" || row.expiresAt.getTime() <= at.getTime()) throw new ErRefusal("pre_alert_closed", { state: row.state });
  const arrived = row.arrivedCount + 1;
  await tx.update(erPreAlerts).set({
    arrivedCount: arrived, ...(arrived >= row.count ? { state: "arrived", closedAt: at } : {}),
  }).where(eq(erPreAlerts.id, preAlertId));
}

// ═══════════════════════════════════════════ the shared arrival ═══════════════════════════════════════════

type ArrivalCommon = {
  arrivalMode: ErArrivalMode; arrivedAt?: string; preAlertId?: string; broughtBy?: ErBroughtBy; complaint?: string;
  paperSerial?: string;
};

/** The gate instant: refuses a future time and, without a paper serial, one more than a day back (spec §4.1 downtime). */
function gateInstant(input: { arrivedAt?: string; paperSerial?: string }, at: Date): Date {
  if (input.arrivedAt === undefined) return at;
  if (erIsInFuture(input.arrivedAt, at)) throw new ErRefusal("time_in_future");
  const gate = new Date(input.arrivedAt);
  if (gate.getTime() > at.getTime()) return at; // inside the skew allowance: the server's clock stands
  if (at.getTime() - gate.getTime() > ER_ARRIVAL_BACKFILL_MS && input.paperSerial === undefined) throw new ErRefusal("arrival_too_old");
  return gate;
}

/** A patient registered at the ER desk; PatientError → the ER's words. */
async function registerHere(tx: Tx, actor: Actor, input: Parameters<typeof registerPatient>[2]): Promise<string> {
  try {
    return (await registerPatient(tx, actor, input)).patient.id;
  } catch (e) {
    if (e instanceof PatientError && e.code === "registration_not_configured") throw new ErRefusal("registration_not_ready");
    throw e;
  }
}

type ArriveArgs = {
  patientId: string;
  /** The person's records (canonical + merged); a just-registered patient has only their own. */
  personIds: readonly string[];
  unidentified: { year: number; serial: number; alias: string } | null;
  ageBand: ErAgeBand | null;
  marks: string | null;
  common: ArrivalCommon;
  gate: Date;
  brought?: { examinedBy: string; examinedAt: Date; ecg: boolean };
};

/** Every arrival's rules and writes, in the caller's transaction. Returns the episode row (state `arrived`). */
async function arriveIn(tx: Tx, actor: Actor, args: ArriveArgs, at: Date): Promise<EpisodeRow> {
  await erPatientLock(tx, args.patientId);
  const placed = await placedAdmissionOf(tx, args.personIds);
  if (placed !== null) {
    throw new ErRefusal("patient_admitted", {
      admissionId: placed.admissionId, admissionNo: placed.admissionNo, wardName: placed.wardName, bedCode: placed.bedCode,
    });
  }
  const first = await openEpisodeOf(tx, args.personIds);
  if (first !== undefined) throw alreadyOpen(first);
  const c = args.common;
  if (c.paperSerial !== undefined) {
    const used = (await tx.select({ id: erEpisodes.id }).from(erEpisodes).where(eq(erEpisodes.paperSerial, c.paperSerial.toUpperCase())))[0];
    if (used !== undefined) throw new ErRefusal("paper_serial_used", { episodeId: used.id });
  }
  const previous = (await tx.select({ id: erEpisodes.id }).from(erEpisodes).where(and(
    inArray(erEpisodes.patientId, [...args.personIds]), ne(erEpisodes.state, "brought_dead"),
    gte(erEpisodes.arrivedAt, new Date(args.gate.getTime() - ER_RETURN_WINDOW_MS)), lte(erEpisodes.arrivedAt, args.gate),
  )).orderBy(desc(erEpisodes.arrivedAt)).limit(1))[0];
  if (c.preAlertId !== undefined) await claimPreAlert(tx, c.preAlertId, at);

  const id = newId();
  const no = await mintEpisodeNo(tx, args.gate);
  let instanceId: string;
  try {
    ({ instanceId } = await startInstance(tx, ER_EPISODE_WORKFLOW_DEF_KEY, { type: "er_episode", id, patientId: args.patientId, encounterId: id }));
  } catch (e) {
    throw workflowRefusal(e);
  }
  const row: typeof erEpisodes.$inferInsert = {
    id, episodeNo: no.episodeNo, episodeYear: no.year, episodeSerial: no.serial, patientId: args.patientId,
    workflowInstanceId: instanceId, state: "arrived", arrivalMode: c.arrivalMode, arrivedAt: args.gate, registeredAt: at,
    registeredBy: actor.id, preAlertId: c.preAlertId ?? null, unidentified: args.unidentified !== null,
    alias: args.unidentified?.alias ?? null, aliasYear: args.unidentified?.year ?? null, aliasSerial: args.unidentified?.serial ?? null,
    ageBand: args.ageBand, marks: args.marks, complaint: c.complaint ?? null, broughtBy: c.broughtBy ?? null,
    returnedWithin24h: previous !== undefined, previousEpisodeId: previous?.id ?? null,
    paperSerial: c.paperSerial?.toUpperCase() ?? null, provenance: provenanceOf(actor), updatedAt: at,
  };
  try {
    // A savepoint: a lost race on the one-open-episode index must not poison the caller's transaction.
    await tx.transaction(async (sp) => { await sp.insert(erEpisodes).values(row); });
  } catch (e) {
    if (isOpenEpisodeRace(e)) {
      const won = await openEpisodeOf(tx, args.personIds);
      if (won !== undefined) throw alreadyOpen(won);
    }
    throw e;
  }
  return (await tx.select().from(erEpisodes).where(eq(erEpisodes.id, id)))[0]!;
}

async function arrivedEvent(tx: Tx, actor: Actor, e: EpisodeRow, at: Date): Promise<void> {
  await appendEvent(tx, erArrived.make({
    payload: {
      episodeId: e.id, episodeNo: e.episodeNo, patientId: e.patientId, arrivalMode: e.arrivalMode,
      arrivedAt: e.arrivedAt.toISOString(), unidentified: e.unidentified, returnedWithin24h: e.returnedWithin24h,
      preAlertId: e.preAlertId, provenance: provenanceOf(actor),
    },
    actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
  }));
}

/** A known record (through the merge chain): refuses unknown and deceased. */
async function knownPerson(db: Db, actor: Actor, patientId: string): Promise<{ patientId: string; ids: string[]; dob: Date | null }> {
  const found = await getPatient(db, actor, patientId);
  if (found === null) throw new ErRefusal("patient_not_found");
  if (found.patient.deceasedAt !== null) throw new ErRefusal("patient_deceased");
  const person = await personRecords(db, found.patient.id);
  if (person === null) throw new ErRefusal("patient_not_found");
  return { patientId: person.canonicalId, ids: person.ids, dob: found.patient.dob };
}

// ═══════════════════════════════════════════ register_arrival ═══════════════════════════════════════════

/** A known patient (scan, UHID, phone) or a named patient new to the hospital. The band prints in the same act. */
export async function registerArrival(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"register_arrival">> {
  const input: Input<"register_arrival"> = ER_INTENTS.register_arrival.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const gate = gateInstant(input, at);
  await checkPrinter(db, input.printerId, at);
  return onceEr(db, actor, "register_arrival", input.idempotencyKey, input, async () => {
    const known = input.patientId === undefined ? null : await knownPerson(db, actor, input.patientId);
    return withTx(db, async (tx) => {
      let patientId: string;
      let personIds: readonly string[];
      let ageBand: ErAgeBand | null = input.ageBand ?? null;
      if (known !== null) {
        ({ patientId } = known);
        personIds = known.ids;
      } else {
        const np = input.newPatient!;
        patientId = await registerHere(tx, actor, { name: np.name, sex: np.sex as ErSex, ...(np.phone === undefined ? {} : { phone: np.phone }) });
        personIds = [patientId];
        ageBand = np.ageBand;
      }
      const e = await arriveIn(tx, actor, { patientId, personIds, unidentified: null, ageBand, marks: null, common: input, gate }, at);
      await arrivedEvent(tx, actor, e, at);
      const band = await mintBandIn(db, tx, actor, e, { site: input.bandSite ?? "wrist", printerId: input.printerId }, at);
      return {
        episodeId: e.id, episodeNo: e.episodeNo, patientId, uhid: band.band.uhid, state: "arrived" as const,
        arrivedAt: e.arrivedAt.toISOString(), registeredAt: e.registeredAt.toISOString(), returnedWithin24h: e.returnedWithin24h, band,
      };
    });
  }, at);
}

// ═══════════════════════════════════════════ register_unidentified ═══════════════════════════════════════════

/**
 * "Unknown male, ~35 y": a REAL UHID, `identity_status = unidentified`, named by the alias (spec §3.4). DECIDED (lane 1):
 * the master record carries the alias as its name, no date of birth (the band is a guess, kept on the episode), the
 * lowest identity assurance (`self_declared`) and no phone — so every screen, label and print downstream names this
 * patient by the alias until the merge, and two unknowns are never confused by name.
 */
export async function registerUnidentified(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"register_unidentified">> {
  const input: Input<"register_unidentified"> = ER_INTENTS.register_unidentified.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const gate = gateInstant(input, at);
  await checkPrinter(db, input.printerId, at);
  return onceEr(db, actor, "register_unidentified", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const alias = await mintAlias(tx, gate);
    const patientId = await registerHere(tx, actor, {
      name: alias.alias, sex: input.sex, identityStatus: "unidentified", identityAssurance: "self_declared",
    });
    const e = await arriveIn(tx, actor, {
      patientId, personIds: [patientId], unidentified: alias, ageBand: input.ageBand, marks: input.marks ?? null, common: input, gate,
    }, at);
    await arrivedEvent(tx, actor, e, at);
    const band = await mintBandIn(db, tx, actor, e, { site: input.bandSite ?? "wrist", printerId: input.printerId }, at);
    return {
      episodeId: e.id, episodeNo: e.episodeNo, patientId, uhid: band.band.uhid, state: "arrived" as const,
      arrivedAt: e.arrivedAt.toISOString(), registeredAt: e.registeredAt.toISOString(), returnedWithin24h: e.returnedWithin24h,
      band, alias: alias.alias, aliasHi: alias.aliasHi,
    };
  }), at);
}

// ═══════════════════════════════════════════ record_brought_dead ═══════════════════════════════════════════

/**
 * The brought-dead MARKER: the episode is minted and moved `arrived → brought_dead` in one act — no band, no treatment
 * episode, no charge (spec §3.8). DECIDED (lane 1): the patient master is NOT marked deceased here — 0018's death needs
 * an MCCD number and a body brought dead gets none (police inquest and post-mortem decide); the `brought_dead` death kind
 * on the patient, the MLC and the mortuary hand-over are lane 4's (er-mlc) seam.
 */
export async function recordBroughtDead(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_brought_dead">> {
  const input: Input<"record_brought_dead"> = ER_INTENTS.record_brought_dead.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  const gate = gateInstant(input, at);
  if (erIsInFuture(input.examinedAt, at)) throw new ErRefusal("time_in_future");
  const examinedAt = new Date(input.examinedAt);
  if (examinedAt.getTime() < gate.getTime()) throw new ErRefusal("examined_before_arrival");
  return onceEr(db, actor, "record_brought_dead", input.idempotencyKey, input, async () => {
    const known = input.patientId === undefined ? null : await knownPerson(db, actor, input.patientId);
    return withTx(db, async (tx) => {
      let patientId: string;
      let personIds: readonly string[];
      let alias: { year: number; serial: number; alias: string } | null = null;
      if (known !== null) {
        ({ patientId } = known);
        personIds = known.ids;
      } else {
        const u = input.unidentified!;
        alias = await mintAlias(tx, gate);
        patientId = await registerHere(tx, actor, { name: alias.alias, sex: u.sex, identityStatus: "unidentified", identityAssurance: "self_declared" });
        personIds = [patientId];
      }
      const e = await arriveIn(tx, actor, {
        patientId, personIds, unidentified: alias, ageBand: input.unidentified?.ageBand ?? null, marks: input.unidentified?.marks ?? null,
        common: input, gate,
      }, at);
      await moveEpisode(tx, actor, e, "brought_dead", at, {
        broughtDeadExaminedBy: input.examinedBy, broughtDeadExaminedAt: examinedAt, ecgStripRecorded: input.ecgStripRecorded,
        outcome: null, departedAt: examinedAt,
      });
      await appendEvent(tx, erBroughtDead.make({
        payload: {
          episodeId: e.id, episodeNo: e.episodeNo, patientId, arrivedAt: e.arrivedAt.toISOString(), examinedAt: examinedAt.toISOString(),
          provenance: provenanceOf(actor),
        },
        actor, correlationId: e.id, patientId, occurredAt: at,
      }));
      const { uhid } = await bandPerson(tx, patientId);
      return { episodeId: e.id, episodeNo: e.episodeNo, patientId, uhid, alias: alias?.alias ?? null, state: "brought_dead" as const };
    });
  }, at);
}
