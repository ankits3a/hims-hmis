import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { labInstruments, labRunSheetPositions, labRunSheets, labSpecimens } from "../../kernel/db/schema";
import { LabError } from "./errors";
import { LAB_RESULTS_ENTER } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T4 — THE RUN SHEET ═══
 *
 * *"An instrument that knows only a sequence number gets a run sheet: before loading, Abha scans
 * each cup in order and the sheet remembers strip 41 → S2609010215. When the block arrives, every
 * strip finds its patient. A sheet with a gap parks that one result."*
 *
 * The EL-120 and the U120 report a POSITION and nothing else. Their sequence counter names a result
 * only within the run that produced it, so the mapping must exist before the block does — and it is
 * built by SCANNING, never typing. A sheet keyed from memory is the tube swap this phase exists to
 * prevent, wearing a clipboard.
 *
 * The sheet is built by the BENCH (`lab.results.enter`), not by the bridge. The machine account
 * consumes a sheet and can never author one: a bridge that could write the mapping could name any
 * tube it liked, which is precisely the authority the whole design withholds from it.
 */
export type RunSheetRow = { position: number; specimenNo: string; specimenId: string };

async function assertMayScan(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user") throw new LabError("user_actor_required", "a run sheet is built at the bench");
  if (!(await hasPermission(exec as Db, actor.id, LAB_RESULTS_ENTER, "hospital"))) {
    throw new LabError("permission_denied", `building a run sheet needs ${LAB_RESULTS_ENTER}`);
  }
}

/** Opens the sheet for a run. Refuses a second open sheet — the DB index is the real guard. */
export async function openRunSheet(
  db: Db, actor: Actor, input: { instrumentId: string; runRef: string }, now: Date = new Date(),
): Promise<{ runSheetId: string }> {
  await assertMayScan(db, actor);
  const [instrument] = await db.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
  if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
  if (instrument.sampleIdMode !== "run_sheet") {
    throw new LabError(
      "unknown_instrument",
      `instrument ${input.instrumentId} names its samples by ${instrument.sampleIdMode} — a run sheet ` +
        "belongs to a machine that reports only a position",
    );
  }
  const runSheetId = newId();
  try {
    await db.insert(labRunSheets).values({
      id: runSheetId, instrumentId: input.instrumentId, runRef: input.runRef,
      openedAt: now, openedBy: actor.id,
    });
  } catch (e) {
    /**
     * The partial unique index refused: this machine already has an open sheet. Translated rather
     * than surfaced raw, because "there is already a run loaded" is something the bench can act on
     * and a constraint name is not.
     */
    if (e instanceof Error && /lab_run_sheets_open_ux/.test(e.message)) {
      throw new LabError(
        "no_active_order",
        `instrument ${input.instrumentId} already has an open run sheet — close or abandon it before ` +
          "starting another run",
      );
    }
    throw e;
  }
  return { runSheetId };
}

/**
 * Scans one cup into a position. The SPECIMEN NUMBER is what the bench scans, so an unknown one is
 * refused here rather than becoming a null that only fails when the block lands an hour later.
 */
export async function scanIntoRunSheet(
  db: Db,
  actor: Actor,
  input: { runSheetId: string; position: number; specimenNo: string },
  now: Date = new Date(),
): Promise<void> {
  await assertMayScan(db, actor);
  await withTx(db, async (tx) => {
    const [sheet] = await tx.select().from(labRunSheets).where(eq(labRunSheets.id, input.runSheetId));
    if (!sheet) throw new LabError("no_active_order", `no run sheet ${input.runSheetId}`);
    if (sheet.status !== "open") {
      throw new LabError("no_active_order", `run sheet ${sheet.runRef} is ${sheet.status}`);
    }
    const [specimen] = await tx
      .select({ id: labSpecimens.id, status: labSpecimens.status })
      .from(labSpecimens).where(eq(labSpecimens.specimenNo, input.specimenNo));
    if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenNo}`);
    if (specimen.status !== "received") {
      throw new LabError(
        "specimen_not_receivable",
        `specimen ${input.specimenNo} is ${specimen.status} — only a received tube goes on the machine`,
      );
    }
    await tx
      .insert(labRunSheetPositions)
      .values({
        runSheetId: input.runSheetId, position: input.position, specimenId: specimen.id,
        scannedAt: now, scannedBy: actor.id,
      })
      /** Re-scanning a position REPLACES it: the cup was swapped before loading, which is ordinary. */
      .onConflictDoUpdate({
        target: [labRunSheetPositions.runSheetId, labRunSheetPositions.position],
        set: { specimenId: specimen.id, scannedAt: now, scannedBy: actor.id },
      });
  });
}

/** The open sheet for a machine, as the ingest resolves against it. Null when no run is loaded. */
export async function openRunSheetFor(
  exec: Db | Tx, instrumentId: string,
): Promise<{ id: string; runRef: string; positions: Map<number, string> } | null> {
  const [sheet] = await exec
    .select({ id: labRunSheets.id, runRef: labRunSheets.runRef })
    .from(labRunSheets)
    .where(and(eq(labRunSheets.instrumentId, instrumentId), eq(labRunSheets.status, "open")));
  if (!sheet) return null;
  const rows = await exec
    .select({ position: labRunSheetPositions.position, specimenId: labRunSheetPositions.specimenId })
    .from(labRunSheetPositions)
    .where(eq(labRunSheetPositions.runSheetId, sheet.id))
    .orderBy(asc(labRunSheetPositions.position));
  return { id: sheet.id, runRef: sheet.runRef, positions: new Map(rows.map((r) => [r.position, r.specimenId])) };
}

/** Closes the sheet the block consumed. Idempotent: closing a closed sheet changes nothing. */
export async function closeRunSheet(
  db: Db, runSheetId: string, transmissionId: string, now: Date = new Date(),
): Promise<void> {
  await db
    .update(labRunSheets)
    .set({ status: "closed", closedAt: now, closedByTransmissionId: transmissionId })
    .where(and(eq(labRunSheets.id, runSheetId), eq(labRunSheets.status, "open")));
}

/** The sheet as the bench reads it back, gaps included — a gap is a MISSING position, not a null. */
export async function runSheetContents(exec: Db | Tx, runSheetId: string): Promise<RunSheetRow[]> {
  const rows = await exec
    .select({
      position: labRunSheetPositions.position, specimenId: labRunSheetPositions.specimenId,
      specimenNo: labSpecimens.specimenNo,
    })
    .from(labRunSheetPositions)
    .innerJoin(labSpecimens, eq(labSpecimens.id, labRunSheetPositions.specimenId))
    .where(eq(labRunSheetPositions.runSheetId, runSheetId))
    .orderBy(asc(labRunSheetPositions.position));
  return rows;
}
