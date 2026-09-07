import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  interfaces, labAnalytes, labInstrumentCodes, labInstruments, labOrderableAnalytes, labSpecimenItems,
  labSpecimens, orderItems, resources,
} from "../../kernel/db/schema";
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

/**
 * 17-E T2 — the bridge's own grant, and it is SEPARATE from `manage` on purpose. A machine account
 * that could also register machines and re-map codes could rename any test it reports.
 */
export const LAB_INSTRUMENTS_READ = "lab.instruments.read";

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

/**
 * ═══ 17-E T7b — POINT A MACHINE AT THE `interfaces` ROW ITS BRIDGE HEARTBEATS ON ═══
 *
 * Q5 rules that `interface_down` is written *"only by the bridge's own heartbeat lapse, never by
 * idleness"*, and `kernel/ops/interfaces.ts` has emitted both liveness edges since Plan 11c. What was
 * missing was the JOIN: no row said which registered device belongs to which analyser, so
 * `interface.down` had nowhere to land. This writes that row, and it is the whole of the link.
 *
 * ═══ IT IS AN ESTATE ACT, ON `lab.instruments.manage`, AND THE BRIDGE CANNOT PERFORM IT ═══
 *
 * `assertMayManage` refuses a non-`user` actor before it looks at any grant. A machine account that
 * could re-point its own interface row could take another analyser's outage onto itself, or move its
 * own off — which is the same reasoning that keeps the code map administrative (see the header).
 *
 * ═══ IT IS ALSO THE UNLINK, AND `null` IS A REAL ARGUMENT ═══
 *
 * A bridge is decommissioned or re-cabled to a different machine, and the register has to be able to
 * say so. Unlinking leaves `resources.status` exactly as it stands — clearing it would either invent
 * a recovery the engineer never made or erase an outage that is real, which is the reasoning
 * `deactivateInterface` already applies to the interface row itself.
 */
export async function linkInstrumentInterface(
  db: Db,
  actor: Actor,
  input: { instrumentId: string; interfaceId: string | null },
  now: Date = new Date(),
): Promise<void> {
  await assertMayManage(db, actor);
  await withTx(db, async (tx) => {
    const [instrument] = await tx.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
    if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
    /**
     * CHECKED HERE RATHER THAN LEFT TO THE FOREIGN KEY. `lab_instruments_interface_id_fkey` would
     * refuse the same row, but as a raw Postgres error the controller maps to a 500 — "the server
     * broke" told to an administrator who mistyped an id. A domain refusal names the missing row.
     */
    if (input.interfaceId !== null) {
      const [iface] = await tx.select({ id: interfaces.id }).from(interfaces).where(eq(interfaces.id, input.interfaceId));
      if (!iface) throw new LabError("unknown_interface", `no registered interface ${input.interfaceId}`);
    }
    await tx
      .update(labInstruments)
      .set({ interfaceId: input.interfaceId, updatedBy: actor.id, updatedAt: now })
      .where(eq(labInstruments.id, input.instrumentId));
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

/**
 * ═══ 17-E T2 — THE MACHINE ASKS WHAT TO RUN, AND IS TOLD ONLY THAT ═══
 *
 * The board's chemistry analyser is *"ASTM both ways: it asks the server what to run"*. This is the
 * server's half of that sentence, and it is modelled on 18b's `mwl.ts` deliberately: a route the
 * bridge PULLS, rather than files a consumer writes into a directory that does not exist yet.
 *
 * ═══ WHAT IS WITHHELD IS THE DESIGN ═══
 *
 * The answer is a list of the instrument's OWN test codes and nothing else. No patient name, no
 * UHID, no date of birth, no diagnosis, no order number. An analyser needs a test list; a bench PC
 * on a flat hospital LAN, speaking ASTM in clear text, is the last place in the building to put
 * PHI — and the protocol has no way to protect it even if we wanted to.
 *
 * So this reader takes a SPECIMEN NUMBER and returns CODES. It is the narrowest possible answer to
 * the machine's question, and the narrowness is the security property rather than a convenience.
 *
 * ═══ AND ONLY WHAT THIS INSTRUMENT CAN ACTUALLY RUN ═══
 *
 * The intersection with the instrument's own code map is not an optimisation. An analyser told to
 * run a test it has no channel for either errors or, worse, runs something adjacent and reports it
 * under a code we will later fail to map — which is a parked result at best. The machine is told
 * what it can do, in its own vocabulary.
 */
export type WorklistEntry = { instrumentCode: string; analyteCode: string };

export async function instrumentWorklist(
  db: Db, actor: Actor, input: { instrumentId: string; sampleId: string },
): Promise<{ specimenNo: string; entries: WorklistEntry[] }> {
  if (!(await hasPermission(db, actor.id, LAB_INSTRUMENTS_READ, "hospital"))) {
    throw new LabError("permission_denied", `pulling an instrument worklist needs ${LAB_INSTRUMENTS_READ}`);
  }
  const [instrument] = await db.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
  if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
  if (!instrument.active) {
    throw new LabError("unknown_instrument", `laboratory instrument ${input.instrumentId} is not active`);
  }

  /**
   * A specimen the bench has NOT received is not work: the tube is still in transit, or was
   * rejected and is awaiting a redraw. Answering for one would have the analyser aspirate from a
   * rack position holding nothing, or holding the tube that replaced it.
   */
  const [specimen] = await db
    .select({ id: labSpecimens.id, status: labSpecimens.status })
    .from(labSpecimens)
    .where(eq(labSpecimens.specimenNo, input.sampleId));
  if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.sampleId}`);
  if (specimen.status !== "received") {
    return { specimenNo: input.sampleId, entries: [] };
  }

  const codeMap = await instrumentCodeMap(db, input.instrumentId);
  if (codeMap.size === 0) return { specimenNo: input.sampleId, entries: [] };
  const byAnalyte = new Map([...codeMap].map(([instrumentCode, m]) => [m.analyteId, instrumentCode]));

  const rows = await db
    .select({ analyteId: labOrderableAnalytes.analyteId, analyteCode: labAnalytes.code })
    .from(labSpecimenItems)
    .innerJoin(orderItems, eq(orderItems.id, labSpecimenItems.orderItemId))
    .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, orderItems.serviceId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
    .where(and(
      eq(labSpecimenItems.specimenId, specimen.id),
      eq(labSpecimenItems.active, true),
      eq(orderItems.status, "in_progress"),
    ));

  const seen = new Set<string>();
  const entries: WorklistEntry[] = [];
  for (const r of rows) {
    const instrumentCode = byAnalyte.get(r.analyteId);
    if (instrumentCode === undefined || seen.has(instrumentCode)) continue;
    seen.add(instrumentCode);
    entries.push({ instrumentCode, analyteCode: r.analyteCode });
  }
  entries.sort((a, b) => a.instrumentCode.localeCompare(b.instrumentCode));
  return { specimenNo: input.sampleId, entries };
}
