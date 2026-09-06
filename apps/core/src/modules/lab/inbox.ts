import { and, desc, eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labInstruments, labParkedResults, labPlateMaps, labSpecimens, labTransmissions, resources,
} from "../../kernel/db/schema";
import { LabError, LAB_ERROR_CODES } from "./errors";
import type { LabErrorCode } from "./errors";
import { attachMachineValue } from "./ingest";
import { instrumentCodeMap } from "./instruments";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T6 — THE INBOX: RESULTS WAITING FOR A PATIENT ═══
 *
 * Abha Rani's seat. The board draws it as a header reading *"9 matched · 1 waiting"* and a list of
 * the ones that are waiting — each with its raw payload, the machine that sent it, and when it
 * arrived. Two things can happen to a row and there is deliberately no third: a human NAMES the tube,
 * or DISCARDS it with a reason.
 *
 * ═══ THE HAND MATCH RE-RUNS THE MACHINE'S OWN PATH, IT DOES NOT SHORTCUT IT ═══
 *
 * `attachMachineValue` is the same function the ingest calls, imported rather than reimplemented.
 * That is the whole design: the applicability control, the absurd envelope and the open-item rule
 * apply to a value a human rescued exactly as they applied when the machine sent it. A screen with
 * its own quieter attachment path is how the inbox becomes the softest door in the building — and
 * it would be the door somebody reaches for precisely when a result is already confusing.
 *
 * ═══ A DISCARD IS A RECORD, NOT A DELETE ═══
 *
 * The row is never removed. `status` becomes `discarded` and `discard_reason` must say why —
 * a biconditional the database enforces. A number that came off an analyser and then vanished with
 * nothing to show is the shape of a result quietly dropped because it was inconvenient.
 */
export const LAB_INSTRUMENTS_OPERATE = "lab.instruments.operate";

export type InboxRow = {
  id: string;
  instrumentId: string;
  instrumentCode: string;
  instrumentName: string;
  /** OUR clock — when the block reached us. The instrument's own is stored and never trusted (D5). */
  arrivedAt: Date;
  position: number;
  sampleId: string | null;
  code: string;
  rawValue: string;
  rawUnit: string | null;
  reason: string;
};

async function assertMayOperate(db: Db, actor: Actor): Promise<void> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", "the interface inbox is worked by a person");
  }
  if (!(await hasPermission(db, actor.id, LAB_INSTRUMENTS_OPERATE, "hospital"))) {
    throw new LabError("permission_denied", `working the interface inbox needs ${LAB_INSTRUMENTS_OPERATE}`);
  }
}

/** What is waiting, newest arrival first. Only `parked` — matched and discarded rows are history. */
export async function inbox(db: Db, opts: { instrumentId?: string } = {}): Promise<InboxRow[]> {
  const where = opts.instrumentId === undefined
    ? eq(labParkedResults.status, "parked")
    : and(eq(labParkedResults.status, "parked"), eq(labParkedResults.instrumentId, opts.instrumentId));
  return await db
    .select({
      id: labParkedResults.id,
      instrumentId: labParkedResults.instrumentId,
      instrumentCode: resources.code,
      instrumentName: resources.name,
      arrivedAt: labTransmissions.arrivedAt,
      position: labParkedResults.position,
      sampleId: labParkedResults.sampleId,
      code: labParkedResults.instrumentCode,
      rawValue: labParkedResults.rawValue,
      rawUnit: labParkedResults.rawUnit,
      reason: labParkedResults.reason,
    })
    .from(labParkedResults)
    .innerJoin(labTransmissions, eq(labTransmissions.id, labParkedResults.transmissionId))
    .innerJoin(labInstruments, eq(labInstruments.id, labParkedResults.instrumentId))
    .innerJoin(resources, eq(resources.id, labInstruments.resourceId))
    .where(where)
    .orderBy(desc(labTransmissions.arrivedAt));
}

/**
 * ═══ D13 — THE INBOX WILL NEVER SHOW A REJECTED PLATE, SO THE SEAT NEEDS THIS BESIDE IT ═══
 *
 * A plate whose controls failed parks NOTHING: its patient wells are not unidentified, they are
 * VOID, and offering them here would invite a technologist to hand-match a value the plate has
 * already rejected — with every guard on the attachment path letting it through, because none of
 * them knows about the plate. The rejection is therefore a record on `lab_plate_maps` rather than a
 * queue of rows, and this is the read that puts it in front of the same human.
 */
export async function rejectedPlates(
  db: Db, opts: { instrumentId?: string } = {},
): Promise<{
  plateMapId: string; plateRef: string; assay: string; kitLot: string; readAt: Date | null;
  ncMeanOd: string | null; pcMeanOd: string | null; cutoffOd: string | null; reason: string | null;
}[]> {
  const where = opts.instrumentId === undefined
    ? eq(labPlateMaps.status, "controls_failed")
    : and(eq(labPlateMaps.status, "controls_failed"), eq(labPlateMaps.instrumentId, opts.instrumentId));
  return await db
    .select({
      plateMapId: labPlateMaps.id, plateRef: labPlateMaps.plateRef, assay: labPlateMaps.assay,
      kitLot: labPlateMaps.kitLot, readAt: labPlateMaps.readAt, ncMeanOd: labPlateMaps.ncMeanOd,
      pcMeanOd: labPlateMaps.pcMeanOd, cutoffOd: labPlateMaps.cutoffOd,
      reason: labPlateMaps.controlsFailReason,
    })
    .from(labPlateMaps).where(where).orderBy(desc(labPlateMaps.readAt));
}

/** The IST calendar day a moment falls on — the lab's day is an Indian one, never UTC's. */
function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/**
 * A human names the tube. The value then goes through `attachMachineValue` — the machine's own path,
 * every guard intact — and the row is closed as `matched` only if that attachment actually wrote.
 */
export async function matchParkedResult(
  db: Db,
  actor: Actor,
  input: { parkedResultId: string; specimenNo: string },
  now: Date = new Date(),
): Promise<{ resultId: string }> {
  await assertMayOperate(db, actor);
  const [row] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, input.parkedResultId));
  if (!row) throw new LabError("unknown_result", `no parked result ${input.parkedResultId}`);
  if (row.status !== "parked") {
    throw new LabError("already_verified", `parked result ${row.id} is already ${row.status}`);
  }

  const [specimen] = await db
    .select({ id: labSpecimens.id, status: labSpecimens.status, receivedAt: labSpecimens.receivedAt })
    .from(labSpecimens).where(eq(labSpecimens.specimenNo, input.specimenNo.trim()));
  if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenNo}`);
  if (specimen.status !== "received") {
    throw new LabError(
      "specimen_not_receivable",
      `specimen ${input.specimenNo} is ${specimen.status} — only a received tube can carry a result`,
    );
  }

  /**
   * ═══ NOT A TUBE FROM ANOTHER DAY ═══
   *
   * The inbox lists a number with no identity, and the whole risk of the seat is that a human under
   * pressure attaches it to a plausible-looking tube. A run that arrived this morning cannot contain
   * a reading from a specimen received last Tuesday — that tube was analysed, reported and disposed
   * of on its own day. Refusing the cross-day match removes the largest class of plausible-but-wrong
   * pairings a person can make from this screen, and it costs a legitimate match nothing.
   */
  const [transmission] = await db
    .select({ arrivedAt: labTransmissions.arrivedAt })
    .from(labTransmissions).where(eq(labTransmissions.id, row.transmissionId));
  if (specimen.receivedAt !== null && transmission !== undefined
      && istDay(specimen.receivedAt) !== istDay(transmission.arrivedAt)) {
    throw new LabError(
      "specimen_not_receivable",
      `specimen ${input.specimenNo} was received on ${istDay(specimen.receivedAt)} and this block ` +
        `arrived on ${istDay(transmission.arrivedAt)} — a run does not carry another day's tube`,
    );
  }

  const mapped = (await instrumentCodeMap(db, row.instrumentId)).get(row.instrumentCode);
  if (mapped === undefined) {
    throw new LabError(
      "unknown_analyte",
      `${row.instrumentCode} is not mapped on this instrument — map the code before matching, so the ` +
        "result carries the analyte the catalogue names rather than one chosen at a screen",
    );
  }

  const outcome = await attachMachineValue(db, actor, {
    instrumentId: row.instrumentId,
    specimenId: specimen.id,
    analyteId: mapped.analyteId,
    value: row.rawValue,
    unit: mapped.unit,
    /**
     * NOT `interface`. The interface failed to name this tube — that is why the row is here — and a
     * person decided whose it was. `manual_from_printout` is the vocabulary's own word for a machine
     * number entered by a human, it already ships, and it keeps the one human judgement in the chain
     * visible in `entry_mode`. `analyzer_id` still names the machine that produced the value.
     */
    entryMode: "manual_from_printout",
    remarks: `matched by hand from the interface inbox · ${row.instrumentCode} ${row.rawValue}`,
  }, now);

  /**
   * ═══ THE GUARDS STILL BITE, AND THE SEAT IS TOLD WHICH ONE ═══
   *
   * A refusal leaves the row PARKED rather than closing it: the human has learned something and the
   * row must stay in front of them.
   *
   * The UNDERLYING code is surfaced rather than collapsed into one. `attachMachineValue` reports
   * every refusal as `guard_refused` because the INGEST only needs to know that a human must look;
   * a person standing at this screen needs to know whether the analyte is not on this tube's order,
   * the value is outside the absurd envelope, or it is impossible for this patient — those are three
   * different next actions. A single code would tell them "it did not work" and send them guessing.
   */
  if ("park" in outcome) {
    const underlying = outcome.detail;
    const code: LabErrorCode =
      underlying !== undefined && (LAB_ERROR_CODES as readonly string[]).includes(underlying)
        ? (underlying as LabErrorCode)
        : "item_not_resultable";
    throw new LabError(
      code,
      `this tube will not take that value (${underlying ?? outcome.park}) — the same control that ` +
        "refused the machine refuses the hand match, and the row stays in the inbox",
    );
  }

  await db
    .update(labParkedResults)
    .set({ status: "matched", resolvedBy: actor.id, resolvedAt: now })
    .where(and(eq(labParkedResults.id, row.id), eq(labParkedResults.status, "parked")));
  return { resultId: outcome.resultId };
}

/** Discarded WITH A REASON, never deleted. The database enforces the biconditional; this refuses blanks. */
export async function discardParkedResult(
  db: Db,
  actor: Actor,
  input: { parkedResultId: string; reason: string },
  now: Date = new Date(),
): Promise<void> {
  await assertMayOperate(db, actor);
  const reason = input.reason.trim();
  if (reason === "") {
    throw new LabError(
      "catalogue_invalid",
      "a discarded result names why — a number that came off an analyser and vanished with nothing " +
        "to show is not a record",
    );
  }
  const [row] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, input.parkedResultId));
  if (!row) throw new LabError("unknown_result", `no parked result ${input.parkedResultId}`);
  if (row.status !== "parked") {
    throw new LabError("already_verified", `parked result ${row.id} is already ${row.status}`);
  }
  await db
    .update(labParkedResults)
    .set({ status: "discarded", discardReason: reason, resolvedBy: actor.id, resolvedAt: now })
    .where(and(eq(labParkedResults.id, row.id), eq(labParkedResults.status, "parked")));
}

/** The header's count, as the board draws it: how many are still waiting, per machine. */
export async function inboxCounts(exec: Db | Tx): Promise<{ instrumentId: string; waiting: number }[]> {
  const rows = await exec
    .select({ instrumentId: labParkedResults.instrumentId })
    .from(labParkedResults).where(eq(labParkedResults.status, "parked"));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.instrumentId, (counts.get(r.instrumentId) ?? 0) + 1);
  return [...counts].map(([instrumentId, waiting]) => ({ instrumentId, waiting }));
}
