import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { labInstruments, labPlateMaps, labPlateWells, labSpecimens } from "../../kernel/db/schema";
import { LabError } from "./errors";
import { LAB_RESULTS_ENTER } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T5 — THE PLATE MAP, AND THE CONTROLS THAT CAN VOID IT ═══
 *
 * The board: *"The reader sends 96 optical densities and nothing else. The plate map — blank,
 * negative and positive controls, cut-off, then 92 patient wells scanned in order — is built here
 * before the plate goes in. The cut-off is computed from the controls; a plate whose controls fail
 * is rejected whole, and no patient gets a result from it. Reactive screens are repeated before
 * anyone is told."*
 *
 * An ELISA reader is the extreme case of this phase's problem. A chemistry analyser at least reads a
 * barcode; the EL-120 at least counts. A plate reader transmits **96 numbers and no identity
 * whatsoever** — no barcode, no sequence, not even a run reference. The well is the only handle and
 * the map is the only thing that turns a well into a person, so the map must exist before the plate
 * goes in and must be built by SCANNING, exactly as a run sheet is.
 *
 * ═══ THE KIT DEFINES THE ARITHMETIC; THIS MODULE ONLY APPLIES IT ═══
 *
 * `cutoffMultiplier`, `cutoffOffset`, `minPcNcRatio` and `maxNcOd` are read off the kit insert and
 * entered when the plate is laid out. They are NOT constants here, and that is deliberate: an
 * assay's cut-off formula and its validity criteria are the manufacturer's, they differ per kit and
 * per lot, and a number hard-coded in this file would be the software quietly overruling a regulated
 * document. NABL asks which kit and which lot; the plate carries both.
 */
export const PLATE_WELL_ROLES = [
  "blank", "negative_control", "positive_control", "cutoff_control", "patient",
] as const;
export type PlateWellRole = (typeof PLATE_WELL_ROLES)[number];

/** The kit's four numbers, as the plate stores them and the arithmetic reads them. */
export type PlateKit = {
  cutoffMultiplier: number;
  cutoffOffset: number;
  minPcNcRatio: number;
  maxNcOd: number;
};

export type PlateWellRow = {
  well: string;
  role: PlateWellRole;
  specimenId: string | null;
  specimenNo: string | null;
  od: string | null;
  verdict: string | null;
  repeatRequired: boolean;
};

export type OpenPlate = {
  id: string;
  plateRef: string;
  assay: string;
  kitLot: string;
  kit: PlateKit;
  /** Well coordinate (upper-case) → what that well IS. The only map from a number to a person. */
  wells: Map<string, { role: PlateWellRole; specimenId: string | null }>;
};

/** What the controls on ONE plate say about that plate. The figures survive a rejection. */
export type PlateControlVerdict = {
  ok: boolean;
  ncMeanOd: number | null;
  pcMeanOd: number | null;
  cutoffOd: number | null;
  /** Named on failure, and the name is the record: a verdict with nothing to show is not one. */
  reason: string | null;
};

/** `numeric(8,4)` — one place that decides how a computed optical density is written down. */
function od4(n: number | null): string | null {
  return n === null ? null : n.toFixed(4);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * ═══ THE CUT-OFF COMES FROM **THIS** PLATE'S OWN CONTROLS ═══
 *
 * Pure, and separated from the ingest for that reason: it can be read, and it can be mutated in a
 * test without a database. Every input is a reading from the plate being evaluated. There is no
 * parameter through which another plate's controls, a stored cut-off, or yesterday's figure could
 * reach it — a plate reader's ODs drift with the room, the reagent and the wash, which is precisely
 * why the kit insert says to recompute the cut-off on every plate.
 *
 * `blank` wells are recorded and deliberately NOT subtracted here. Whether the reader has already
 * blanked its own readings is a property of the reader, and subtracting a second time would silently
 * halve every cut-off on the plate — an error that makes borderline samples read as reactive and
 * would never announce itself.
 */
export function evaluatePlateControls(
  kit: PlateKit, readings: readonly { role: PlateWellRole; od: number }[],
): PlateControlVerdict {
  const odsFor = (role: PlateWellRole): number[] => readings.filter((r) => r.role === role).map((r) => r.od);
  const ncMeanOd = mean(odsFor("negative_control"));
  const pcMeanOd = mean(odsFor("positive_control"));
  const cutoffControls = odsFor("cutoff_control");

  /**
   * Some kits ship a dedicated CUT-OFF CONTROL and say to use its mean directly; others give a
   * formula over the negative controls. The plate says which kit this is by whether it carries the
   * control, so the presence of a reading chooses — rather than this file preferring one house style
   * and applying it to a kit whose insert says otherwise.
   */
  const cutoffOd = cutoffControls.length > 0
    ? mean(cutoffControls)
    : ncMeanOd === null ? null : ncMeanOd * kit.cutoffMultiplier + kit.cutoffOffset;

  const fail = (reason: string): PlateControlVerdict =>
    ({ ok: false, ncMeanOd, pcMeanOd, cutoffOd, reason });

  /**
   * A MISSING control is a failure, never a pass. The tempting alternative — "no negative control
   * was read, so skip that check" — turns a plate loaded wrongly into a plate that reports, which is
   * the one outcome D10 exists to prevent.
   */
  if (ncMeanOd === null) return fail("no negative control well produced a reading");
  if (pcMeanOd === null) return fail("no positive control well produced a reading");
  if (cutoffOd === null) return fail("the cut-off could not be computed from this plate's controls");

  if (ncMeanOd > kit.maxNcOd) {
    return fail(
      `negative control mean OD ${od4(ncMeanOd)} exceeds the kit's maximum ${od4(kit.maxNcOd)} — ` +
        "the plate is contaminated or under-washed",
    );
  }
  /** A zero negative mean would make the ratio infinite; it is caught above only if the kit allows 0. */
  const ratio = ncMeanOd === 0 ? Infinity : pcMeanOd / ncMeanOd;
  if (ratio < kit.minPcNcRatio) {
    return fail(
      `positive/negative ratio ${ratio.toFixed(4)} is below the kit's minimum ` +
        `${od4(kit.minPcNcRatio)} — the conjugate or the substrate did not work`,
    );
  }
  return { ok: true, ncMeanOd, pcMeanOd, cutoffOd, reason: null };
}

/** One patient well against the cut-off THIS plate produced. S/CO is the figure a report carries. */
export function patientWellVerdict(od: number, cutoffOd: number): {
  verdict: "reactive" | "non_reactive"; signalToCutoff: number; repeatRequired: boolean;
} {
  const signalToCutoff = cutoffOd === 0 ? Infinity : od / cutoffOd;
  const reactive = od >= cutoffOd;
  /**
   * The board: a reactive screen is repeated IN DUPLICATE before anyone is told. A first-run
   * reactive on HBsAg, HCV or HIV is an initial reading and not a finding, and the harm of telling
   * someone they are positive on one well is not comparable to the harm of a day's delay.
   */
  return { verdict: reactive ? "reactive" : "non_reactive", signalToCutoff, repeatRequired: reactive };
}

async function assertMayLayOut(exec: Db | Tx, actor: Actor): Promise<void> {
  /**
   * The plate is laid out by the BENCH, never by the bridge — the same division a run sheet draws
   * and for the same reason. A machine account that could write the map could name any well it
   * liked, which is exactly the authority this whole phase withholds from it.
   */
  if (actor.type !== "user") throw new LabError("user_actor_required", "a plate is laid out at the bench");
  if (!(await hasPermission(exec as Db, actor.id, LAB_RESULTS_ENTER, "hospital"))) {
    throw new LabError("permission_denied", `laying out a plate needs ${LAB_RESULTS_ENTER}`);
  }
}

export type OpenPlateMapInput = {
  instrumentId: string;
  plateRef: string;
  assay: string;
  kitLot: string;
} & PlateKit;

/** Opens the map for one plate. Refuses a second open plate — the DB index is the real guard. */
export async function openPlateMap(
  db: Db, actor: Actor, input: OpenPlateMapInput, now: Date = new Date(),
): Promise<{ plateMapId: string }> {
  await assertMayLayOut(db, actor);
  const [instrument] = await db.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
  if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
  if (instrument.sampleIdMode !== "plate_map") {
    throw new LabError(
      "unknown_instrument",
      `instrument ${input.instrumentId} names its samples by ${instrument.sampleIdMode} — a plate map ` +
        "belongs to a reader that reports only a well",
    );
  }
  const plateMapId = newId();
  try {
    await db.insert(labPlateMaps).values({
      id: plateMapId,
      instrumentId: input.instrumentId,
      plateRef: input.plateRef,
      assay: input.assay,
      kitLot: input.kitLot,
      cutoffMultiplier: String(input.cutoffMultiplier),
      cutoffOffset: String(input.cutoffOffset),
      minPcNcRatio: String(input.minPcNcRatio),
      maxNcOd: String(input.maxNcOd),
      openedAt: now,
      openedBy: actor.id,
    });
  } catch (e) {
    /** Translated rather than surfaced raw: "a plate is already loaded" is actionable, a constraint name is not. */
    if (e instanceof Error && /lab_plate_maps_open_ux/.test(e.message)) {
      throw new LabError(
        "no_active_order",
        `instrument ${input.instrumentId} already has an open plate — read or abandon it before ` +
          "laying out another",
      );
    }
    throw e;
  }
  return { plateMapId };
}

export type ScanIntoPlateInput = {
  plateMapId: string;
  well: string;
  role: PlateWellRole;
  /** Present for a `patient` well and forbidden on every other role — the biconditional. */
  specimenNo?: string | null;
};

/**
 * Puts one well on the map. A control can never be reported as a patient, so the specimen is
 * required exactly for `patient` and refused everywhere else — checked here so the bench gets a
 * sentence, and checked again by `lab_plate_wells_specimen_ck` so nothing else can write it wrong.
 */
export async function scanIntoPlateMap(
  db: Db, actor: Actor, input: ScanIntoPlateInput, now: Date = new Date(),
): Promise<void> {
  await assertMayLayOut(db, actor);
  const well = input.well.trim().toUpperCase();
  if (well === "") throw new LabError("catalogue_invalid", "a well needs the reader's own coordinate");
  const specimenNo = input.specimenNo?.trim() ?? "";
  if (input.role === "patient" && specimenNo === "") {
    throw new LabError("unknown_specimen", `well ${well} is a patient well and needs a scanned tube`);
  }
  if (input.role !== "patient" && specimenNo !== "") {
    throw new LabError(
      "catalogue_invalid",
      `well ${well} is a ${input.role} and cannot carry a tube — a control reported as a patient is ` +
        "the mistake a 96-well grid invites",
    );
  }
  await withTx(db, async (tx) => {
    const [plate] = await tx.select().from(labPlateMaps).where(eq(labPlateMaps.id, input.plateMapId));
    if (!plate) throw new LabError("no_active_order", `no plate map ${input.plateMapId}`);
    if (plate.status !== "open") {
      throw new LabError("no_active_order", `plate ${plate.plateRef} is ${plate.status}`);
    }
    let specimenId: string | null = null;
    if (input.role === "patient") {
      const [specimen] = await tx
        .select({ id: labSpecimens.id, status: labSpecimens.status })
        .from(labSpecimens).where(eq(labSpecimens.specimenNo, specimenNo));
      if (!specimen) throw new LabError("unknown_specimen", `no specimen ${specimenNo}`);
      if (specimen.status !== "received") {
        throw new LabError(
          "specimen_not_receivable",
          `specimen ${specimenNo} is ${specimen.status} — only a received tube goes on a plate`,
        );
      }
      specimenId = specimen.id;
    }
    await tx
      .insert(labPlateWells)
      .values({ plateMapId: input.plateMapId, well, role: input.role, specimenId, scannedAt: now, scannedBy: actor.id })
      /** Re-scanning a well REPLACES it: a tube corrected before the plate goes in is ordinary. */
      .onConflictDoUpdate({
        target: [labPlateWells.plateMapId, labPlateWells.well],
        set: { role: input.role, specimenId, scannedAt: now, scannedBy: actor.id },
      });
  });
}

/** The open plate for a reader, as the ingest resolves against it. Null when no plate is loaded. */
export async function openPlateMapFor(exec: Db | Tx, instrumentId: string): Promise<OpenPlate | null> {
  const [plate] = await exec
    .select().from(labPlateMaps)
    .where(and(eq(labPlateMaps.instrumentId, instrumentId), eq(labPlateMaps.status, "open")));
  if (!plate) return null;
  const wells = await exec
    .select({ well: labPlateWells.well, role: labPlateWells.role, specimenId: labPlateWells.specimenId })
    .from(labPlateWells).where(eq(labPlateWells.plateMapId, plate.id));
  return {
    id: plate.id,
    plateRef: plate.plateRef,
    assay: plate.assay,
    kitLot: plate.kitLot,
    kit: {
      cutoffMultiplier: Number(plate.cutoffMultiplier),
      cutoffOffset: Number(plate.cutoffOffset),
      minPcNcRatio: Number(plate.minPcNcRatio),
      maxNcOd: Number(plate.maxNcOd),
    },
    wells: new Map(wells.map((w) => [w.well, { role: w.role as PlateWellRole, specimenId: w.specimenId }])),
  };
}

/** Writes one well's reading. Kept on a failed plate too — the ODs are WHY it failed. */
export async function recordWellReading(
  exec: Db | Tx,
  plateMapId: string,
  well: string,
  reading: { od: number; verdict: string | null; repeatRequired?: boolean },
): Promise<void> {
  await exec
    .update(labPlateWells)
    .set({
      od: od4(reading.od),
      verdict: reading.verdict,
      ...(reading.repeatRequired === undefined ? {} : { repeatRequired: reading.repeatRequired }),
    })
    .where(and(eq(labPlateWells.plateMapId, plateMapId), eq(labPlateWells.well, well)));
}

/**
 * Closes the plate the block was read from, with the figures the controls produced.
 *
 * `controls_failed` and `read` are both terminal and both carry every computed number. A void plate
 * is still a record: NABL asks what the controls read on the day a batch was repeated, and "the
 * plate was rejected" without the ODs that rejected it answers nothing.
 */
export async function closePlate(
  exec: Db | Tx,
  plateMapId: string,
  outcome: { status: "read" | "controls_failed"; verdict: PlateControlVerdict; transmissionId: string },
  now: Date = new Date(),
): Promise<void> {
  await exec
    .update(labPlateMaps)
    .set({
      status: outcome.status,
      ncMeanOd: od4(outcome.verdict.ncMeanOd),
      pcMeanOd: od4(outcome.verdict.pcMeanOd),
      cutoffOd: od4(outcome.verdict.cutoffOd),
      controlsFailReason: outcome.status === "controls_failed" ? outcome.verdict.reason : null,
      readAt: now,
      readByTransmissionId: outcome.transmissionId,
    })
    .where(and(eq(labPlateMaps.id, plateMapId), eq(labPlateMaps.status, "open")));
}

/** The plate as the bench reads it back — every well, its role, its reading and its verdict. */
export async function plateContents(exec: Db | Tx, plateMapId: string): Promise<PlateWellRow[]> {
  const rows = await exec
    .select({
      well: labPlateWells.well, role: labPlateWells.role, specimenId: labPlateWells.specimenId,
      specimenNo: labSpecimens.specimenNo, od: labPlateWells.od, verdict: labPlateWells.verdict,
      repeatRequired: labPlateWells.repeatRequired,
    })
    .from(labPlateWells)
    .leftJoin(labSpecimens, eq(labSpecimens.id, labPlateWells.specimenId))
    .where(eq(labPlateWells.plateMapId, plateMapId))
    .orderBy(asc(labPlateWells.well));
  return rows.map((r) => ({ ...r, role: r.role as PlateWellRole }));
}
