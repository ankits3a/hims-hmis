import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  addMachineInput, batchRefInput, finishCycleInput, handToCssdInput, linenDisinfected, machineDownInput, machineUpInput,
  mendReturnInput, newId, recordQcInput, startCycleInput,
} from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  linenCondemnRequests, linenCycleBatches, linenLaundryBatches, linenMachines, linenMovements, linenQcResults, linenWashCycles,
  resources,
} from "../../kernel/db/schema";
import { isModuleOn } from "../../kernel/modules/switch";
import { raiseTicket } from "../maintenance";
import { LinenError } from "./errors";
import { signerOf } from "./floor";
import { LINEN_SYSTEM } from "./kinds";
import { lock, movement, parse, requireItems, stamp, tx } from "./intents";
import { LINEN_CSSD_RECEIVE } from "./manifest";
import type { Actor, LinenMachineCard, LinenMachineKind, LinenPlantBatch, LinenPlantView, LinenStream, LinenBatchState } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { BatchRow, Exec } from "./intents";

/**
 * ═══ THE PLANT (LD-1, #978, D2 D5 D6 D7) ═══ — machines, wash cycles, quality check, theatre sets to CSSD, mending.
 *
 * An in-house batch waits (`sent`), washes in one cycle (`washing`), and is released to quality check (`qc`). A cycle
 * holds batches of ONE infected flag and ONE stream (`mixed_cycle`, `mixed_stream`; the table's composite keys refuse a
 * mixed load too). An infected cycle that did not hold the disinfection temperature for its time sends its batches to
 * `rewash`; they cannot be released until a cycle meets it (D2). A machine marked down takes no cycle (D5).
 * Quality check splits every washed piece into pass, rewash, mend and condemn, each a ledger row (D6); a condemn waits for
 * a second person (the four-eyes request). Theatre sets passed go to CSSD on a CSSD signature, never to the store (D7).
 */
export type MachineRow = typeof linenMachines.$inferSelect;
export type CycleRow = typeof linenWashCycles.$inferSelect;

async function machineFor(t: Tx, machineId: string): Promise<MachineRow> {
  const m = (await t.select().from(linenMachines).where(eq(linenMachines.id, machineId)).for("update"))[0];
  if (m === undefined || !m.active) throw new LinenError("unknown_machine", { machineId });
  return m;
}

async function batchFor(t: Tx, batchId: string): Promise<BatchRow> {
  const b = (await t.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, batchId)).for("update"))[0];
  if (b === undefined) throw new LinenError("unknown_batch", { batchId });
  return b;
}

export async function addMachine(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<MachineRow> {
  const input = parse(addMachineInput, raw);
  return tx(exec, async (t) => {
    await lock(t, "plant");
    const now = await stamp(t, nowIn);
    if ((await t.select({ id: linenMachines.id }).from(linenMachines).where(eq(linenMachines.code, input.code))).length > 0) {
      throw new LinenError("code_taken", { code: input.code });
    }
    if (input.placeId !== undefined) {
      const place = (await t.select({ status: resources.status }).from(resources).where(eq(resources.id, input.placeId)))[0];
      if (place === undefined || place.status === "retired") throw new LinenError("unknown_place", { placeId: input.placeId });
    }
    return (await t.insert(linenMachines).values({
      id: newId(), code: input.code, kind: input.kind, name: input.name, placeResourceId: input.placeId ?? null, state: "up",
      updatedBy: actor.id, updatedAt: now,
    }).returning())[0]!;
  });
}

/**
 * A breakdown: the machine takes no new cycle; its waiting work shows as "send to vendor" while no washer is up (D5).
 * A machine with a place raises a repair ticket there (the machine's code is the item tag; a second report of the same
 * open fault joins it — maintenance's own rule), after the machine is marked down: a refused ticket never keeps a
 * broken machine in use. The ticket is raised by the linen system actor; the machine row names who marked it down.
 */
export async function markMachineDown(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<MachineRow> {
  const input = parse(machineDownInput, raw);
  const down = await tx(exec, async (t) => {
    const m = await machineFor(t, input.machineId);
    const now = await stamp(t, nowIn);
    return (await t.update(linenMachines).set({ state: "down", downReason: input.reason, updatedBy: actor.id, updatedAt: now })
      .where(eq(linenMachines.id, m.id)).returning())[0]!;
  });
  if (down.placeResourceId === null || !isModuleOn("maintenance")) return down;
  const ticket = await raiseTicket(exec as Db, LINEN_SYSTEM, {
    placeResourceId: down.placeResourceId, itemKind: "other", itemTag: down.code, category: "general", urgency: "urgent",
    description: `Laundry ${down.kind} ${down.name} is down: ${input.reason}`, source: "device",
  }, nowIn === undefined ? {} : { now: nowIn });
  return (await (exec as Db).update(linenMachines).set({ ticketId: ticket.ticketId })
    .where(and(eq(linenMachines.id, down.id), eq(linenMachines.state, "down"))).returning())[0] ?? down;
}

export async function markMachineUp(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<MachineRow> {
  const input = parse(machineUpInput, raw);
  return tx(exec, async (t) => {
    const m = await machineFor(t, input.machineId);
    const now = await stamp(t, nowIn);
    return (await t.update(linenMachines).set({ state: "up", downReason: null, ticketId: null, updatedBy: actor.id, updatedAt: now })
      .where(eq(linenMachines.id, m.id)).returning())[0]!;
  });
}

/** Load batches into a machine. Refused on a machine down or running, and on a load that mixes infected or streams. */
export async function startCycle(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<CycleRow> {
  const input = parse(startCycleInput, raw);
  return tx(exec, async (t) => {
    const m = await machineFor(t, input.machineId);
    if (m.state === "down") throw new LinenError("machine_down", { machineId: m.id, reason: m.downReason });
    const running = await t.select({ id: linenWashCycles.id }).from(linenWashCycles)
      .where(and(eq(linenWashCycles.machineId, m.id), isNull(linenWashCycles.finishedAt)));
    if (running.length > 0) throw new LinenError("machine_busy", { machineId: m.id, cycleId: running[0]!.id });
    const ids = [...new Set(input.batchIds)];
    const batches: BatchRow[] = [];
    for (const id of [...ids].sort()) batches.push(await batchFor(t, id));
    for (const b of batches) {
      if (b.mode !== "in_house" || (b.state !== "sent" && b.state !== "rewash")) throw new LinenError("not_in_plant", { batchId: b.id, state: b.state });
    }
    if (new Set(batches.map((b) => b.infected)).size > 1) throw new LinenError("mixed_cycle");
    if (new Set(batches.map((b) => b.stream)).size > 1) throw new LinenError("mixed_stream", { streams: batches.map((b) => b.stream) });
    const now = await stamp(t, nowIn);
    const first = batches[0]!;
    const cycle = (await t.insert(linenWashCycles).values({
      id: newId(), machineId: m.id, program: input.program, infected: first.infected, stream: first.stream,
      startedBy: actor.id, startedAt: now,
    }).returning())[0]!;
    await t.insert(linenCycleBatches).values(batches.map((b) => ({ cycleId: cycle.id, batchId: b.id, infected: b.infected, stream: b.stream })));
    await t.update(linenLaundryBatches).set({ state: "washing" }).where(inArray(linenLaundryBatches.id, ids));
    return cycle;
  });
}

/**
 * The cycle's readings: temperature reached, minutes held, chemical dosed. An infected cycle below the disinfection rule
 * sends its batches to rewash (D2).
 */
export async function finishCycle(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<CycleRow> {
  const input = parse(finishCycleInput, raw);
  return tx(exec, async (t) => {
    const c = (await t.select().from(linenWashCycles).where(eq(linenWashCycles.id, input.cycleId)).for("update"))[0];
    if (c === undefined) throw new LinenError("unknown_cycle", { cycleId: input.cycleId });
    if (c.finishedAt !== null) throw new LinenError("cycle_finished", { cycleId: c.id });
    const now = await stamp(t, nowIn);
    const disinfected = c.infected ? linenDisinfected(input.tempC, input.holdMin) : null;
    const row = (await t.update(linenWashCycles).set({
      finishedBy: actor.id, finishedAt: now, tempC: input.tempC, holdMin: input.holdMin, chemical: input.chemical, disinfected,
    }).where(eq(linenWashCycles.id, c.id)).returning())[0]!;
    if (disinfected === false) {
      const ids = (await t.select({ id: linenCycleBatches.batchId }).from(linenCycleBatches).where(eq(linenCycleBatches.cycleId, c.id))).map((r) => r.id);
      await t.update(linenLaundryBatches).set({ state: "rewash" }).where(inArray(linenLaundryBatches.id, ids));
    }
    return row;
  });
}

/** Out of the machine to quality check. An infected batch that missed the disinfection rule cannot be released (D2). */
export async function releaseBatch(exec: Exec, _actor: Actor, raw: unknown, nowIn?: Date): Promise<BatchRow> {
  const input = parse(batchRefInput, raw);
  return tx(exec, async (t) => {
    const b = await batchFor(t, input.batchId);
    if (b.state === "rewash") throw new LinenError("disinfection_missed", { batchId: b.id });
    if (b.mode !== "in_house" || b.state !== "washing") throw new LinenError("not_in_plant", { batchId: b.id, state: b.state });
    // A failed infected cycle moved the batch to rewash, and only a new cycle moves it back to washing: so a batch here
    // with every cycle finished had its last cycle pass. The infected check below is the belt to that brace.
    const cycles = (await t.select({ c: linenWashCycles }).from(linenCycleBatches)
      .innerJoin(linenWashCycles, eq(linenWashCycles.id, linenCycleBatches.cycleId))
      .where(eq(linenCycleBatches.batchId, b.id))).map((r) => r.c);
    if (cycles.length === 0 || cycles.some((c) => c.finishedAt === null)) throw new LinenError("machine_busy", { batchId: b.id });
    if (b.infected && !cycles.some((c) => c.disinfected === true)) throw new LinenError("disinfection_missed", { batchId: b.id });
    await stamp(t, nowIn);
    return (await t.update(linenLaundryBatches).set({ state: "qc" }).where(eq(linenLaundryBatches.id, b.id)).returning())[0]!;
  });
}

/** Waiting in-house work goes to the vendor instead (the "send to vendor" button of D5). */
export async function routeToVendor(exec: Exec, _actor: Actor, raw: unknown): Promise<BatchRow> {
  const input = parse(batchRefInput, raw);
  return tx(exec, async (t) => {
    const b = await batchFor(t, input.batchId);
    if (b.mode !== "in_house" || (b.state !== "sent" && b.state !== "rewash")) throw new LinenError("not_in_plant", { batchId: b.id, state: b.state });
    return (await t.update(linenLaundryBatches).set({ mode: "vendor", state: "sent" }).where(eq(linenLaundryBatches.id, b.id)).returning())[0]!;
  });
}

async function washedPieces(t: Tx, batchId: string): Promise<Map<string, number>> {
  const rows = await t.select({ itemCode: linenMovements.itemCode, qty: linenMovements.qty }).from(linenMovements)
    .where(and(eq(linenMovements.batchId, batchId), eq(linenMovements.kind, "laundry_out")));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.itemCode, (out.get(r.itemCode) ?? 0) + r.qty);
  return out;
}

/**
 * Quality check of a batch released from the machine. Per item the four outcomes add up to what was washed
 * (`qc_mismatch`). Pass goes to the store (`laundry_in`) — or, for theatre sets, waits for CSSD; rewash goes back to the
 * soiled room (`qc_rewash`); mend goes to mending (`qc_mend`); condemn raises a request a second person decides (D6).
 */
export async function recordQc(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ batchId: string; movements: number; condemnRequests: number }> {
  const input = parse(recordQcInput, raw);
  return tx(exec, async (t) => {
    const b = await batchFor(t, input.batchId);
    if (b.state !== "qc") throw new LinenError("not_at_qc", { batchId: b.id, state: b.state });
    if ((await t.select({ id: linenQcResults.id }).from(linenQcResults).where(eq(linenQcResults.batchId, b.id)).limit(1)).length > 0) {
      throw new LinenError("not_at_qc", { batchId: b.id, state: "checked" });
    }
    await requireItems(t, input.lines.map((l) => ({ itemCode: l.itemCode, qty: 1 })));
    const washed = await washedPieces(t, b.id);
    for (const l of input.lines) {
      const sent = washed.get(l.itemCode);
      if (sent === undefined) throw new LinenError("not_in_batch", { itemCode: l.itemCode });
      if (l.pass + l.rewash + l.mend + l.condemn !== sent) throw new LinenError("qc_mismatch", { itemCode: l.itemCode, washed: sent });
    }
    const missing = [...washed.keys()].find((code) => !input.lines.some((l) => l.itemCode === code));
    if (missing !== undefined) throw new LinenError("qc_mismatch", { itemCode: missing, washed: washed.get(missing) });
    const now = await stamp(t, nowIn);
    const theatre = (b.stream as LinenStream) === "theatre";
    let moved = 0;
    let requests = 0;
    for (const l of input.lines) {
      let condemnRequestId: string | null = null;
      if (l.condemn > 0) {
        condemnRequestId = (await t.insert(linenCondemnRequests).values({
          id: newId(), wardResourceId: null, itemCode: l.itemCode, qty: l.condemn, reason: `Quality check, batch ${b.batchNo}`,
          state: "requested", requestedBy: actor.id, requestedAt: now,
        }).returning())[0]!.id;
        requests += 1;
      }
      await t.insert(linenQcResults).values({
        id: newId(), batchId: b.id, itemCode: l.itemCode, pass: l.pass, rewash: l.rewash, mend: l.mend, condemn: l.condemn,
        condemnRequestId, checkedBy: actor.id, checkedAt: now,
      });
      const rows = [
        ...(l.pass > 0 && !theatre ? [movement("laundry_in", { itemCode: l.itemCode, qty: l.pass }, actor, now, { batchId: b.id })] : []),
        ...(l.rewash > 0 ? [movement("qc_rewash", { itemCode: l.itemCode, qty: l.rewash }, actor, now, { batchId: b.id })] : []),
        ...(l.mend > 0 ? [movement("qc_mend", { itemCode: l.itemCode, qty: l.mend }, actor, now, { batchId: b.id })] : []),
      ];
      if (rows.length > 0) await t.insert(linenMovements).values(rows);
      moved += rows.length;
    }
    // A theatre batch stays at quality check until CSSD signs for its sets.
    if (!theatre) {
      await t.update(linenLaundryBatches).set({
        state: "received", receivedAt: now, receivedBy: actor.id, piecesReceived: input.lines.reduce((n, l) => n + l.pass, 0),
      }).where(eq(linenLaundryBatches.id, b.id));
    }
    return { batchId: b.id, movements: moved, condemnRequests: requests };
  });
}

/** Theatre sets that passed quality check go to CSSD on the CSSD nurse's signature (PIN and the CSSD permission) (D7). */
export async function handToCssd(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ batchId: string; movements: number }> {
  const input = parse(handToCssdInput, raw);
  const signer = await signerOf(exec, input.cssdSign);
  if (!(await hasPermission(exec as Db, signer, LINEN_CSSD_RECEIVE, "hospital"))) throw new LinenError("not_cssd");
  return tx(exec, async (t) => {
    const b = await batchFor(t, input.batchId);
    if ((b.stream as LinenStream) !== "theatre") throw new LinenError("not_theatre", { batchId: b.id });
    if (b.receivedAt !== null) throw new LinenError("already_received", { batchId: b.id });
    const qc = await t.select().from(linenQcResults).where(eq(linenQcResults.batchId, b.id));
    if (qc.length === 0) throw new LinenError("qc_missing", { batchId: b.id });
    const now = await stamp(t, nowIn);
    const rows = qc.filter((q) => q.pass > 0).map((q) => movement("issue_to_cssd", { itemCode: q.itemCode, qty: q.pass }, actor, now, { batchId: b.id }));
    if (rows.length > 0) await t.insert(linenMovements).values(rows);
    await t.update(linenLaundryBatches).set({
      state: "received", receivedAt: now, receivedBy: signer, piecesReceived: qc.reduce((n, q) => n + q.pass, 0),
    }).where(eq(linenLaundryBatches.id, b.id));
    return { batchId: b.id, movements: rows.length };
  });
}

/** Pieces at mending per item: sent there by quality check, less returned to the store. */
export async function mendingPool(exec: Exec): Promise<Record<string, number>> {
  const r = await exec.execute<{ i: string; n: string }>(sql`
    select item_code as i, sum(case when kind = 'qc_mend' then qty else -qty end) as n
      from linen_movements where kind in ('qc_mend', 'mend_return') group by item_code`);
  const out: Record<string, number> = {};
  for (const row of r.rows) if (Number(row.n) !== 0) out[row.i] = Number(row.n);
  return out;
}

/** Mended pieces back to the linen store. */
export async function mendReturn(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ movements: number }> {
  const input = parse(mendReturnInput, raw);
  return tx(exec, async (t) => {
    await requireItems(t, input.lines);
    await lock(t, "plant");
    const now = await stamp(t, nowIn);
    const pool = await mendingPool(t);
    for (const l of input.lines) {
      if (l.qty > (pool[l.itemCode] ?? 0)) throw new LinenError("exceeds_mending", { itemCode: l.itemCode, atMending: pool[l.itemCode] ?? 0 });
    }
    await t.insert(linenMovements).values(input.lines.map((l) => movement("mend_return", l, actor, now)));
    return { movements: input.lines.length };
  });
}

/** The plant: machines, the in-house queue, and the work to send to the vendor while every washer is down (D5). */
export async function plantView(exec: Exec, now: Date): Promise<LinenPlantView> {
  const machines = await exec.select().from(linenMachines).where(eq(linenMachines.active, true)).orderBy(asc(linenMachines.kind), asc(linenMachines.code));
  const running = new Set((await exec.select({ m: linenWashCycles.machineId }).from(linenWashCycles).where(isNull(linenWashCycles.finishedAt))).map((r) => r.m));
  const batches = await exec.select().from(linenLaundryBatches)
    .where(and(eq(linenLaundryBatches.mode, "in_house"), isNull(linenLaundryBatches.receivedAt))).orderBy(asc(linenLaundryBatches.sentAt));
  const queue: LinenPlantBatch[] = batches.map((b) => ({
    batchId: b.id, batchNo: b.batchNo, infected: b.infected, stream: b.stream as LinenStream, state: b.state as LinenBatchState,
    pieces: b.piecesSent, sentAt: b.sentAt.toISOString(),
  }));
  const washersUp = machines.filter((m) => m.kind === "washer" && m.state === "up").length;
  const cards: LinenMachineCard[] = machines.map((m) => ({
    id: m.id, code: m.code, kind: m.kind as LinenMachineKind, name: m.name, state: m.state as "up" | "down", downReason: m.downReason,
    running: running.has(m.id),
  }));
  return {
    serverNow: now.toISOString(), machines: cards, queue,
    vendorQueue: washersUp > 0 ? [] : queue.filter((q) => q.state === "sent" || q.state === "rewash"),
  };
}
