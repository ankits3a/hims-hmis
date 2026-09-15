import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labAnalytes, labInstruments, labOrderableAnalytes, labParkedResults, labSpecimenItems,
  labSpecimens, labTransmissions, orderItems,
} from "../../kernel/db/schema";
import { LabError } from "./errors";
import { instrumentCodeMap } from "./instruments";
import {
  closePlate, evaluatePlateControls, openPlateMapFor, patientWellVerdict, recordWellReading,
} from "./plate-maps";
import { closeRunSheet, openRunSheetFor } from "./run-sheets";
import { enterResult, LAB_RESULTS_INTERFACE } from "./results";
import type { LabEntryMode } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { PlateWellRole } from "./plate-maps";

/**
 * ═══ PLAN 17-E T3 — THE BLOCK ARRIVES, AND EVERY ROW FINDS ITS PATIENT OR PARKS ═══
 *
 * The board's Autolab ESR sends ten positions in one transmission and the header reads *"9 matched ·
 * 1 waiting"*. That sentence is the whole specification: **a transmission is received whole and
 * attached one row at a time.**
 *
 * ═══ D3 — ONE UNREADABLE ROW PARKS THAT ROW, AND THE OTHER NINE GO ON ═══
 *
 * The ten positions are ten different patients. Rejecting the block because one tube did not scan
 * would cost nine people their results for a reason none of them had anything to do with — and the
 * analyser has already consumed those samples, so "send it again" is not available. Each row is
 * therefore resolved and written on its OWN transaction; nothing about row 4 can roll back row 3.
 *
 * ═══ D4 — NEVER ATTACH BY GUESS ═══
 *
 * No fuzzy matching, no nearest-sequence, no "it must be the only unmatched tube on the bench". A
 * row that cannot be named is PARKED with its payload raw, and a human either names the tube or
 * discards it with a reason. This is the rule the phase exists to enforce and no later task may
 * weaken it to make something pass.
 *
 * ═══ THE GUARDS APPLY TO MACHINE VALUES EXACTLY AS TO TYPED ONES ═══
 *
 * The write goes through `enterResult`, the same function the bench keys into, so 17d T1's
 * applicability control and 02 H1's absurd envelope run on every machine value. Both refuse unless a
 * SECOND PAIR OF HANDS vouches — and a machine has none — so a refused row parks as
 * `guard_refused` rather than being entered or dropped. An interface is a faster way to key a
 * number, never a way around the controls on keying one.
 *
 * ═══ D5 — TWO CLOCKS ═══
 *
 * `arrivedAt` is ours. `instrumentAt` is theirs, stored beside it and never read for turnaround.
 * Analyser clocks drift, are set wrong at install, and survive a power cut as 00:00.
 */
export { LAB_RESULTS_INTERFACE };

export type IngestRow = {
  /** The rack slot, strip number or plate well — the instrument's own ordinal within this run. */
  position: number;
  /** How the machine named the sample. Absent for a sequence-only instrument (T4/T5 resolve those). */
  sampleId?: string | null;
  /** The instrument's OWN test code, verbatim and case-sensitive. */
  code: string;
  value: string;
  unit?: string | null;
  /** THEIR clock. Kept, never trusted. */
  instrumentAt?: Date | null;
};

export type ParkReason =
  | "unmapped_code" | "unknown_sample" | "sample_not_received" | "no_open_item" | "guard_refused"
  | "no_run_sheet" | "no_plate_well";

export type IngestOutcome = {
  transmissionId: string;
  arrivedAt: Date;
  /** True when this exact `transmissionRef` had already been received — a bridge retry. */
  duplicate: boolean;
  attached: { position: number; resultId: string }[];
  parked: { position: number; reason: ParkReason; detail?: string }[];
  /**
   * 17-E T5 — present only for a plate reader, and the reason a rejected plate is not a SILENCE.
   * A plate whose controls failed returns nothing attached and nothing parked, which without this
   * block would be indistinguishable from a transmission that did nothing at all.
   */
  plate?: {
    plateMapId: string;
    plateRef: string;
    status: "read" | "controls_failed";
    ncMeanOd: number | null;
    pcMeanOd: number | null;
    cutoffOd: number | null;
    reason: string | null;
  };
};

async function assertMayIngest(db: Db, actor: Actor): Promise<void> {
  /**
   * A `user` actor by TYPE before permission. The bridge is a service USER holding `lab_bridge`
   * (D2, corrected at T2): `guards.ts` refuses any non-user actor before `hasPermission` is reached,
   * so an agent could never pass this anyway — and handing `hasPermission` an agent id returns
   * false, which would report "this user lacks the grant" about something that is not a user.
   */
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", "an instrument transmission is posted by the bridge account");
  }
  if (!(await hasPermission(db, actor.id, LAB_RESULTS_INTERFACE, "hospital"))) {
    throw new LabError("permission_denied", `posting instrument results needs ${LAB_RESULTS_INTERFACE}`);
  }
}

/** Resolves the sample the machine named, for the two modes that name one directly. */
async function resolveSample(
  db: Db, sampleId: string | null | undefined,
): Promise<{ specimenId: string } | { park: ParkReason }> {
  if (sampleId === null || sampleId === undefined || sampleId.trim() === "") return { park: "unknown_sample" };
  const [specimen] = await db
    .select({ id: labSpecimens.id, status: labSpecimens.status })
    .from(labSpecimens).where(eq(labSpecimens.specimenNo, sampleId.trim()));
  if (!specimen) return { park: "unknown_sample" };
  /** A tube the bench has not received is in transit or was rejected — its rack slot is not ours. */
  if (specimen.status !== "received") return { park: "sample_not_received" };
  return { specimenId: specimen.id };
}

/**
 * ═══ ONE DEFINITION OF "ATTACH A MACHINE VALUE, OR SAY WHY IT DID NOT" ═══
 *
 * Every naming mode in this phase — barcode, typed id, run sheet, plate well — differs only in how
 * it turns the transmission into a SPECIMEN. Once it has one, the write is identical and must stay
 * identical: the same open-item lookup, the same `enterResult`, the same refusal handling. Four
 * copies of this would be four places for a later task to loosen one guard on one path.
 *
 * **It is module-level rather than a closure because T6's INBOX is the fifth caller.** When a human
 * names a tube for a parked result, that match must run this exact code — the board says the hand
 * match "re-runs the same attachment path so every guard applies", and a second implementation
 * living behind a screen is precisely how a hand match ends up softer than the machine one.
 */
export async function attachMachineValue(
  db: Db,
  actor: Actor,
  input: {
    instrumentId: string; specimenId: string; analyteId: string; value: string;
    unit: string | null; remarks?: string;
    /**
     * ═══ WHO IS ATTACHING, AND THEREFORE UNDER WHOSE GRANT ═══
     *
     * `interface` (the default) is the BRIDGE posting a block it named itself, authorised by
     * `lab.results.interface`. T6's inbox passes `manual_from_printout` instead, and that is not a
     * workaround for a permission — it is the truthful record. The interface did NOT attach this
     * value; it failed to name the tube, and a person read the number off a screen and decided whose
     * it was. `entry_mode` is where that decision has to be visible: labelling it `interface` would
     * hide the one human judgement in the whole chain, and it is the judgement most likely to be
     * wrong. `analyzer_id` still records which machine produced the number, so nothing about the
     * machine's authorship is lost.
     *
     * It also means the grant follows the act rather than being widened to fit it: a technologist
     * writes under `lab.results.enter`, which they legitimately hold, and `lab.results.interface`
     * stays the bridge's alone exactly as D6 requires.
     */
    entryMode?: LabEntryMode;
  },
  now: Date = new Date(),
): Promise<{ resultId: string } | { park: ParkReason; detail?: string }> {
  /**
   * ═══ THE OPEN ITEMS ON THIS TUBE THAT ACTUALLY REPORT THIS ANALYTE ═══
   *
   * **The analyte filter is the fix, and its absence was the defect.** `specimens.ts` draws ONE tube
   * per `(specimen_type, container)` across the whole order group, so an outpatient billed for LFT
   * and RFT together gives one serum SST tube carrying two order items — the ordinary Indian OPD
   * morning, not a corner case. This query used to ask only *"what is open on this tube"*, which for
   * a transaminase includes the renal panel that does not report one.
   *
   * `lab_orderable_analytes` already answers *"which of these tests reports a transaminase"*. It is
   * the catalogue's own statement, it is the same table `analytesFor` reads inside `enterResult` to
   * refuse a foreign analyte, and asking it HERE turns a refusal-by-guard into a candidate list.
   *
   * The `ORDER BY` is not decoration. Without it this set is unordered, and everything below depends
   * on which row comes first.
   */
  const items = await db
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .innerJoin(orderItems, eq(orderItems.id, labSpecimenItems.orderItemId))
    .innerJoin(labOrderableAnalytes, and(
      eq(labOrderableAnalytes.serviceId, orderItems.serviceId),
      eq(labOrderableAnalytes.analyteId, input.analyteId),
    ))
    .where(and(
      eq(labSpecimenItems.specimenId, input.specimenId),
      eq(labSpecimenItems.active, true),
      inArray(orderItems.status, ["in_progress"]),
    ))
    .orderBy(orderItems.id);

  /**
   * ═══ TWO WAYS TO HAVE NO CANDIDATE, AND THE SEAT NEEDS THEM APART ═══
   *
   * The ingest itself does not care: both park, and both mean a human must look. **The INBOX does.**
   * `matchParkedResult` surfaces the underlying code to the person standing at the screen precisely
   * because *"the analyte is not on this tube's order"* and *"nothing on this tube is open"* send
   * them to different next actions — and before the analyte filter existed, the first arrived as
   * `unknown_analyte` from `enterResult` by accident of trying the wrong item.
   *
   * So the filter keeps the distinction it would otherwise have collapsed, at the cost of one cheap
   * count. The park REASON stays `no_open_item` for both — it is true of both, and widening the
   * `lab_parked_results` CHECK would be a migration to say something the detail already says.
   */
  if (items.length === 0) {
    const [open] = await db
      .select({ orderItemId: labSpecimenItems.orderItemId })
      .from(labSpecimenItems)
      .innerJoin(orderItems, eq(orderItems.id, labSpecimenItems.orderItemId))
      .where(and(
        eq(labSpecimenItems.specimenId, input.specimenId),
        eq(labSpecimenItems.active, true),
        inArray(orderItems.status, ["in_progress"]),
      ))
      .limit(1);
    return open === undefined
      ? { park: "no_open_item" }
      : { park: "no_open_item", detail: "unknown_analyte" };
  }

  /**
   * ═══ AND THE LOOP NOW ITERATES, WHICH IT DID NOT ═══
   *
   * Every path through the old body left the function — success returned, a `LabError` returned a
   * park, anything else threw — so **iteration two was unreachable and the `return` after the loop
   * was dead code.** Only `items[0]` was ever tried. A reader saw a loop and assumed a fallback
   * existed; there was none, and the code said otherwise in the most convincing way available.
   */
  let refusal: LabError | null = null;
  for (const item of items) {
    try {
      const out = await enterResult(db, actor, {
        orderItemId: item.orderItemId,
        analyteId: input.analyteId,
        value: input.value,
        unit: input.unit,
        entryMode: input.entryMode ?? "interface",
        analyzerId: input.instrumentId,
        ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
      }, now);
      return { resultId: out.resultId };
    } catch (e) {
      /**
       * A guard refused. 17d T1's applicability control and the absurd envelope both need a SECOND
       * PAIR OF HANDS, and a machine has none — so the row parks for a human rather than being
       * entered or dropped. `enterResult` has already evented the near-miss on its own transaction,
       * which is what makes this safe to swallow HERE and only here.
       *
       * **The LAST refusal is the one reported, not the first**, and with the analyte filter in
       * place every candidate is an item that genuinely reports this analyte — so every refusal is
       * about the value or the patient, never about the test being foreign. The old `unknown_analyte`
       * park, which said "a guard refused" about a question no guard had been asked, cannot arise.
       */
      if (e instanceof LabError) { refusal = e; continue; }
      throw e;
    }
  }
  return { park: "guard_refused", detail: refusal?.code };
}

export async function ingestResults(
  db: Db,
  actor: Actor,
  input: { instrumentId: string; transmissionRef: string; rows: readonly IngestRow[] },
  now: Date = new Date(),
): Promise<IngestOutcome> {
  await assertMayIngest(db, actor);

  const [instrument] = await db.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
  if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
  if (!instrument.active) {
    throw new LabError("unknown_instrument", `laboratory instrument ${input.instrumentId} is not active`);
  }

  /**
   * ═══ A RETRY IS NOT A SECOND SET OF RESULTS ═══
   *
   * A bench PC that times out waiting for our response and re-sends is the ordinary case: the
   * analyser has already aspirated the sample and the bridge has nothing else to do. Writing the
   * block twice would duplicate every value in it, and `lab_results` has no natural key that would
   * catch it. The unique `(instrument, transmission_ref)` is what makes the retry a no-op, and it
   * is checked HERE as well as enforced there so the answer is an outcome rather than a 500.
   */
  const [prior] = await db
    .select({ id: labTransmissions.id, arrivedAt: labTransmissions.arrivedAt })
    .from(labTransmissions)
    .where(and(
      eq(labTransmissions.instrumentId, input.instrumentId),
      eq(labTransmissions.transmissionRef, input.transmissionRef),
    ));
  if (prior) {
    const parked = await db
      .select({ position: labParkedResults.position, reason: labParkedResults.reason })
      .from(labParkedResults).where(eq(labParkedResults.transmissionId, prior.id));
    return {
      transmissionId: prior.id, arrivedAt: prior.arrivedAt, duplicate: true,
      attached: [], parked: parked.map((p) => ({ position: p.position, reason: p.reason as ParkReason })),
    };
  }

  const transmissionId = newId();
  await db.insert(labTransmissions).values({
    id: transmissionId,
    instrumentId: input.instrumentId,
    transmissionRef: input.transmissionRef,
    arrivedAt: now,
    rowCount: input.rows.length,
    receivedByType: actor.type,
    receivedById: actor.id,
  });

  /**
   * ═══ T4 — A MACHINE THAT CAN ONLY COUNT RESOLVES BY THE SHEET, NOT BY A NAME ═══
   *
   * The EL-120 and the U120 send a POSITION. It names a result only inside the run that produced
   * it, so the sheet the bench scanned before loading is the only thing that can turn it into a
   * patient. No open sheet means no run was loaded, and every row parks — the alternative is
   * reading positions against YESTERDAY's map, which is a swapped tube by construction.
   */
  const sheet = instrument.sampleIdMode === "run_sheet"
    ? await openRunSheetFor(db, input.instrumentId)
    : null;

  const codeMap = await instrumentCodeMap(db, input.instrumentId);
  const attached: IngestOutcome["attached"] = [];
  const parked: IngestOutcome["parked"] = [];

  const park = async (row: IngestRow, reason: ParkReason, detail?: string): Promise<void> => {
    await db.insert(labParkedResults).values({
      id: newId(), transmissionId, instrumentId: input.instrumentId,
      position: row.position, sampleId: row.sampleId ?? null, instrumentCode: row.code,
      rawValue: row.value, rawUnit: row.unit ?? null, instrumentAt: row.instrumentAt ?? null,
      reason,
    });
    parked.push(detail === undefined ? { position: row.position, reason } : { position: row.position, reason, detail });
  };

  const attachOrPark = (
    specimenId: string, analyteId: string, value: string, unit: string | null, remarks?: string,
  ): Promise<{ resultId: string } | { park: ParkReason; detail?: string }> => attachMachineValue(
    db, actor,
    { instrumentId: input.instrumentId, specimenId, analyteId, value, unit, ...(remarks === undefined ? {} : { remarks }) },
    now,
  );

  /**
   * ═══ 17-E T5 — 96 NUMBERS AND NO IDENTITY, AND THE CONTROLS THAT CAN VOID THEM ALL ═══
   *
   * This is the ONE arm of the phase that is not row-independent, and the departure from D3 is
   * deliberate rather than accidental. The ESR's ten positions are ten independent measurements: one
   * unreadable strip has nothing to do with the other nine. A plate's ninety-two patient wells are
   * all computed against a SINGLE cut-off derived from the controls sitting on that same plate — so
   * if the controls failed, the cut-off is meaningless and so is every well measured against it.
   *
   * ═══ PARKING IS DEFERRED UNTIL THE CONTROLS HAVE SPOKEN ═══
   *
   * On a void plate NOTHING from the block reaches a human — not a result, and not an inbox row
   * either. T6's inbox exists so somebody can NAME an unidentified number and attach it, and that is
   * exactly the action that must be impossible here: the number is not unidentified, it is void.
   * A parked row from a failed plate would invite a technologist to hand-match a value the plate has
   * already rejected, and every guard on the attachment path would let it through, because none of
   * them knows about the plate. So the rows are collected first and written only once the plate is
   * known to be good.
   */
  if (instrument.sampleIdMode === "plate_map") {
    const plate = await openPlateMapFor(db, input.instrumentId);
    /**
     * No plate laid out means no map exists for these wells, and there is deliberately nothing to
     * fall back to — reading well `C4` against YESTERDAY's map is a swapped tube by construction.
     */
    if (plate === null) {
      for (const row of input.rows) await park(row, "no_plate_well");
      return { transmissionId, arrivedAt: now, duplicate: false, attached, parked };
    }

    type Landed = { row: IngestRow; well: string; role: PlateWellRole; specimenId: string | null; od: number };
    const landed: Landed[] = [];
    const deferred: { row: IngestRow; reason: ParkReason; detail?: string }[] = [];
    for (const row of input.rows) {
      /**
       * The WELL is how a plate reader names a sample, so it arrives in `sampleId` — the field whose
       * whole meaning is "how the machine named this". `position` stays the transmission's own
       * ordinal and is never consulted for identity: two answers to "which well is this" is one
       * answer too many, and the wrong one would report a control as a patient.
       */
      const well = (row.sampleId ?? "").trim().toUpperCase();
      const onPlate = well === "" ? undefined : plate.wells.get(well);
      if (onPlate === undefined) { deferred.push({ row, reason: "no_plate_well" }); continue; }
      const od = Number(row.value);
      if (!Number.isFinite(od)) {
        deferred.push({ row, reason: "no_plate_well", detail: "non_numeric_optical_density" });
        continue;
      }
      landed.push({ row, well, role: onPlate.role, specimenId: onPlate.specimenId, od });
    }

    /**
     * ═══ A WELL NAMED TWICE IN ONE BLOCK IS AMBIGUOUS, AND NEITHER READING IS USED ═══
     *
     * The plate is read once, so two readings for `C4` mean the bridge is confused about its own
     * transmission and there is no way to know which number came out of that well. Taking the first,
     * or the last, would be attaching by guess — the one thing this phase refuses everywhere else.
     * It matters most for a CONTROL: a doubled negative control silently drags the mean, and the
     * cut-off every patient well is measured against moves with it, in a direction nothing reports.
     */
    const seen = new Map<string, number>();
    for (const l of landed) seen.set(l.well, (seen.get(l.well) ?? 0) + 1);
    for (const l of landed.filter((x) => (seen.get(x.well) ?? 0) > 1)) {
      deferred.push({ row: l.row, reason: "no_plate_well", detail: "well_named_twice" });
    }
    const readings = landed.filter((l) => seen.get(l.well) === 1);

    /** THE CUT-OFF COMES FROM THIS PLATE'S OWN CONTROLS — no other plate can reach this call. */
    const controls = evaluatePlateControls(plate.kit, readings.map((l) => ({ role: l.role, od: l.od })));

    /** The controls' readings are written first, because they are the evidence for the verdict. */
    for (const l of readings) {
      if (l.role === "patient") continue;
      await recordWellReading(db, plate.id, l.well, {
        od: l.od,
        verdict: l.role === "blank" ? null : controls.ok ? "control_ok" : "control_failed",
      });
    }

    if (!controls.ok) {
      /**
       * ═══ D10 — REJECTED WHOLE ═══
       *
       * Every patient OD is KEPT and every patient verdict stays null. The readings are why the
       * plate failed and NABL asks for them; a verdict against a meaningless cut-off would be this
       * software asserting something it cannot know. The plate row is the record of the rejection —
       * status, both control means, the cut-off that was computed, and the sentence naming the fault.
       */
      for (const l of readings) {
        if (l.role === "patient") await recordWellReading(db, plate.id, l.well, { od: l.od, verdict: null });
      }
      await closePlate(db, plate.id, { status: "controls_failed", verdict: controls, transmissionId }, now);
      return {
        transmissionId, arrivedAt: now, duplicate: false, attached, parked,
        plate: {
          plateMapId: plate.id, plateRef: plate.plateRef, status: "controls_failed",
          ncMeanOd: controls.ncMeanOd, pcMeanOd: controls.pcMeanOd, cutoffOd: controls.cutoffOd,
          reason: controls.reason,
        },
      };
    }

    const cutoffOd = controls.cutoffOd as number;
    /** The plate is good, so the rows that never found a well are genuinely for a human to name. */
    for (const d of deferred) await park(d.row, d.reason, d.detail);

    /**
     * WHAT A WELL REPORTS FOLLOWS THE CATALOGUE, NOT THIS FILE. A qualitative screen is a `coded`
     * analyte and carries the interpretation; a lab that catalogued the index as a number gets the
     * S/CO ratio. Either way the OTHER figure travels in the remarks, so the number that produced
     * the interpretation is on the record and a report can never show a bare optical density —
     * which would be meaningless off its own plate and, worse, comparable across plates.
     */
    const patientWells = readings.filter((l) => l.role === "patient" && l.specimenId !== null);
    const analyteIds = [...new Set(
      patientWells.map((l) => codeMap.get(l.row.code)?.analyteId).filter((a): a is string => a !== undefined),
    )];
    const resultTypes = new Map<string, string>();
    if (analyteIds.length > 0) {
      const rows = await db
        .select({ id: labAnalytes.id, resultType: labAnalytes.resultType })
        .from(labAnalytes).where(inArray(labAnalytes.id, analyteIds));
      for (const r of rows) resultTypes.set(r.id, r.resultType);
    }

    for (const l of patientWells) {
      const mapped = codeMap.get(l.row.code);
      if (mapped === undefined) { await park(l.row, "unmapped_code"); continue; }
      const { verdict, signalToCutoff, repeatRequired } = patientWellVerdict(l.od, cutoffOd);
      await recordWellReading(db, plate.id, l.well, { od: l.od, verdict, repeatRequired });

      const numeric = resultTypes.get(mapped.analyteId) === "numeric";
      const value = numeric
        ? signalToCutoff.toFixed(2)
        : verdict === "reactive" ? "Reactive" : "Non-Reactive";
      const remarks =
        `${plate.assay} · plate ${plate.plateRef} · kit lot ${plate.kitLot} · well ${l.well} · ` +
        `OD ${l.od.toFixed(4)} · cut-off ${cutoffOd.toFixed(4)} · S/CO ${signalToCutoff.toFixed(2)}` +
        /** The board: a reactive screen is REPEATED IN DUPLICATE before anyone is told. */
        (repeatRequired ? " · REACTIVE ON FIRST RUN — REPEAT IN DUPLICATE BEFORE REPORTING" : "");

      const outcome = await attachOrPark(
        l.specimenId as string, mapped.analyteId, value,
        numeric ? mapped.unit ?? "S/CO" : null, remarks,
      );
      if ("park" in outcome) { await park(l.row, outcome.park, outcome.detail); continue; }
      attached.push({ position: l.row.position, resultId: outcome.resultId });
    }

    /**
     * The block consumes the plate, exactly as it consumes a run sheet: those wells now hold used
     * reagent, so a SECOND block is a new plate whose map nobody built, and it must find none.
     */
    await closePlate(db, plate.id, { status: "read", verdict: controls, transmissionId }, now);
    return {
      transmissionId, arrivedAt: now, duplicate: false, attached, parked,
      plate: {
        plateMapId: plate.id, plateRef: plate.plateRef, status: "read",
        ncMeanOd: controls.ncMeanOd, pcMeanOd: controls.pcMeanOd, cutoffOd: controls.cutoffOd,
        reason: null,
      },
    };
  }

  for (const row of input.rows) {
    /** Each row on its own, so one unreadable position cannot cost the other nine theirs (D3). */
    const mapped = codeMap.get(row.code);
    if (mapped === undefined) { await park(row, "unmapped_code"); continue; }

    let sample: { specimenId: string } | { park: ParkReason };
    if (instrument.sampleIdMode === "run_sheet") {
      /**
       * **A GAP PARKS THAT POSITION AND ONLY THAT POSITION.** There is deliberately nothing to fall
       * back to: no nearest-filled, no next-in-sequence, no "the only unscanned cup". A sheet with a
       * hole at strip 43 means nobody scanned strip 43, and the tube physically in that slot is
       * unknown — reading it as strip 44's patient is exactly the swap the sheet exists to prevent.
       */
      const specimenId = sheet?.positions.get(row.position);
      sample = specimenId === undefined ? { park: "no_run_sheet" } : { specimenId };
    } else {
      sample = await resolveSample(db, row.sampleId);
    }
    if ("park" in sample) { await park(row, sample.park); continue; }

    /**
     * The instrument's unit becomes ours by a stored factor, applied ONCE, here. A non-numeric
     * value (a urine strip's `++`) is passed through — a factor cannot multiply a symbol.
     */
    const asNumber = Number(row.value);
    const converted = Number.isFinite(asNumber) && mapped.factor !== "1"
      ? String(asNumber * Number(mapped.factor))
      : row.value;

    const outcome = await attachOrPark(sample.specimenId, mapped.analyteId, converted, mapped.unit);
    if ("park" in outcome) { await park(row, outcome.park, outcome.detail); continue; }
    attached.push({ position: row.position, resultId: outcome.resultId });
  }

  /**
   * ═══ THE BLOCK CONSUMES THE SHEET ═══
   *
   * Once this run has landed, the sheet's positions describe cups that are no longer on the machine.
   * A SECOND block is therefore not a retry — it is a new run whose sheet nobody built — and with
   * the sheet closed it finds none and parks whole, rather than resolving against a stale map.
   *
   * Closed even when every row parked: the sheet was still the one this run was loaded against, and
   * leaving it open would offer it to the next block.
   */
  if (sheet !== null) await closeRunSheet(db, sheet.id, transmissionId, now);

  return { transmissionId, arrivedAt: now, duplicate: false, attached, parked };
}

/** The inbox's read: what is waiting for a human to name (T6 renders this). */
export async function parkedResults(db: Db, opts: { instrumentId?: string } = {}): Promise<unknown[]> {
  const rows = await db
    .select().from(labParkedResults)
    .where(opts.instrumentId === undefined
      ? eq(labParkedResults.status, "parked")
      : and(eq(labParkedResults.status, "parked"), eq(labParkedResults.instrumentId, opts.instrumentId)));
  return rows;
}
