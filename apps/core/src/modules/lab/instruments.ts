import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { labAnalytes, labInstrumentCodes, labInstruments, resources } from "../../kernel/db/schema";
import { createResource } from "../../kernel/resources/registry";
import { LabError } from "./errors";
import { LAB_RESOURCE_KINDS } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T1 — THE INSTRUMENTS THE LAB ACTUALLY HAS ═══
 *
 * `Instruments.dc.html` describes nine machines on a real bench, and they differ in exactly one way
 * that matters to software: **how each one names the sample it just measured.** That is
 * `sample_id_mode`, and every later task in this phase branches on it and on nothing else about the
 * hardware.
 *
 * ═══ THE MACHINE IS A KERNEL RESOURCE; THIS MODULE OWNS ONLY WHAT THE KERNEL HAS NO OPINION ON ═══
 *
 * `lab/kinds.ts` has declared the `analyzer` kind since Plan 17 T2 — seven statuses, `available` as
 * initial, `in_use` as occupied — and said in its own header that **17-E's drivers would be its
 * first writer**. This is that writer. The STATE of a machine (available, interface_down, retired)
 * lives in `resources` and `resource_status_history` where every other resource's does; what lives
 * here is the sample-id mode and the code map, which are facts about a laboratory instrument and
 * not about a bookable thing.
 *
 * So registering an analyser is ONE transaction that creates both: a resource the kernel can move
 * through its vocabulary, and the lab's row describing how to talk to it.
 */
export const LAB_INSTRUMENTS_MANAGE = "lab.instruments.manage";

/** How the machine names its sample — the board's four cases, and the whole of the phase's shape. */
export type SampleIdMode = "barcode" | "typed_id" | "run_sheet" | "plate_map";

export type RegisterInstrumentInput = {
  /** The resource code — the estate's name for the machine, e.g. `ANL-CHEM-1`. */
  code: string;
  name: string;
  sampleIdMode: SampleIdMode;
  /** Documentation for a human reading the register. Nothing branches on it (D1). */
  connection?: string | null;
  parentResourceId?: string | null;
};

export type InstrumentRow = {
  id: string;
  resourceId: string;
  code: string;
  name: string;
  status: string;
  sampleIdMode: SampleIdMode;
  connection: string | null;
  active: boolean;
};

async function assertMayManage(exec: Db | Tx, actor: Actor): Promise<void> {
  /**
   * A `user` actor by TYPE before permission: `hasPermission` takes a `users.id` and, handed a
   * system or agent id, returns false — which would report "this user lacks the grant" about
   * something that is not a user. Registering a machine is an estate act with a person behind it.
   *
   * **The BRIDGE never reaches this function.** It authenticates as an `agent` (D2) and its
   * permissions are over ingest, not over the register: a machine may not enrol itself, nor
   * re-map its own codes, which is the whole reason the code map is administrative data.
   */
  if (actor.type !== "user") throw new LabError("user_actor_required", "registering an instrument is a user act");
  if (!(await hasPermission(exec as Db, actor.id, LAB_INSTRUMENTS_MANAGE, "hospital"))) {
    throw new LabError("permission_denied", `registering a laboratory instrument needs ${LAB_INSTRUMENTS_MANAGE}`);
  }
}

/** Registers a machine: a kernel `analyzer` resource and the lab's row for it, in one transaction. */
export async function registerInstrument(
  db: Db, actor: Actor, input: RegisterInstrumentInput, now: Date = new Date(),
): Promise<{ instrumentId: string; resourceId: string }> {
  await assertMayManage(db, actor);
  return await withTx(db, async (tx) => {
    const { resourceId } = await createResource(tx, actor, LAB_RESOURCE_KINDS, {
      kind: "analyzer",
      code: input.code,
      name: input.name,
      parentId: input.parentResourceId ?? null,
      at: now,
    });
    const instrumentId = newId();
    await tx.insert(labInstruments).values({
      id: instrumentId,
      resourceId,
      sampleIdMode: input.sampleIdMode,
      connection: input.connection ?? null,
      createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    });
    return { instrumentId, resourceId };
  });
}

/**
 * Maps one of the instrument's own test codes to one of ours.
 *
 * PER INSTRUMENT, never globally — the board's rule, and the reason is the ordinary case rather
 * than the exotic one: `GLU` is a serum glucose on the chemistry analyser and a urine strip pad on
 * the U120. A global table would have to pick one.
 *
 * Re-mapping an existing code is an UPDATE rather than a second row: the primary key says a code
 * means one thing on one machine, and a second row would make "which analyte is GLU" depend on
 * read order.
 */
export async function mapInstrumentCode(
  db: Db,
  actor: Actor,
  input: { instrumentId: string; instrumentCode: string; analyteId: string; unit?: string | null; factor?: string },
): Promise<void> {
  await assertMayManage(db, actor);
  await withTx(db, async (tx) => {
    const [instrument] = await tx.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
    if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
    const [analyte] = await tx.select().from(labAnalytes).where(eq(labAnalytes.id, input.analyteId));
    if (!analyte) throw new LabError("unknown_analyte", `no analyte ${input.analyteId}`);
    await tx
      .insert(labInstrumentCodes)
      .values({
        instrumentId: input.instrumentId,
        instrumentCode: input.instrumentCode,
        analyteId: input.analyteId,
        unit: input.unit ?? null,
        factor: input.factor ?? "1",
      })
      .onConflictDoUpdate({
        target: [labInstrumentCodes.instrumentId, labInstrumentCodes.instrumentCode],
        set: { analyteId: input.analyteId, unit: input.unit ?? null, factor: input.factor ?? "1" },
      });
  });
}

/** The register, as the inbox header reads it: every machine, its state, and how it names a sample. */
export async function listInstruments(exec: Db | Tx, opts: { activeOnly?: boolean } = {}): Promise<InstrumentRow[]> {
  const rows = await exec
    .select({
      id: labInstruments.id, resourceId: labInstruments.resourceId,
      code: resources.code, name: resources.name, status: resources.status,
      sampleIdMode: labInstruments.sampleIdMode, connection: labInstruments.connection,
      active: labInstruments.active,
    })
    .from(labInstruments)
    .innerJoin(resources, eq(resources.id, labInstruments.resourceId))
    .where(opts.activeOnly === true ? eq(labInstruments.active, true) : undefined)
    .orderBy(asc(resources.code));
  return rows.map((r) => ({ ...r, sampleIdMode: r.sampleIdMode as SampleIdMode }));
}

/** The instrument's code map, as the ingest resolves it. An absent code PARKS the result (D4). */
export async function instrumentCodeMap(
  exec: Db | Tx, instrumentId: string,
): Promise<Map<string, { analyteId: string; unit: string | null; factor: string }>> {
  const rows = await exec
    .select({
      instrumentCode: labInstrumentCodes.instrumentCode, analyteId: labInstrumentCodes.analyteId,
      unit: labInstrumentCodes.unit, factor: labInstrumentCodes.factor,
    })
    .from(labInstrumentCodes)
    .where(eq(labInstrumentCodes.instrumentId, instrumentId));
  return new Map(rows.map((r) => [r.instrumentCode, { analyteId: r.analyteId, unit: r.unit, factor: r.factor }]));
}

/** The instrument behind a resource, for the ingest routes that are addressed by machine. */
export async function instrumentByResource(exec: Db | Tx, resourceId: string): Promise<InstrumentRow | null> {
  const [row] = await exec
    .select({
      id: labInstruments.id, resourceId: labInstruments.resourceId,
      code: resources.code, name: resources.name, status: resources.status,
      sampleIdMode: labInstruments.sampleIdMode, connection: labInstruments.connection,
      active: labInstruments.active,
    })
    .from(labInstruments)
    .innerJoin(resources, eq(resources.id, labInstruments.resourceId))
    .where(and(eq(labInstruments.resourceId, resourceId), eq(labInstruments.active, true)));
  return row ? { ...row, sampleIdMode: row.sampleIdMode as SampleIdMode } : null;
}
