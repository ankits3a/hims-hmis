import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { maintenanceTicketEvents, maintenanceTickets, resources } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkMaintenanceWorld } from "../../../test/helpers/maintenance";
import { assignBed, blockBed, reserveBed } from "../ipd";
import { cancelTask, getTask } from "../tasks";
import { bedTickets, cancelTicket, dispatchTicket, maintenanceBoard, raiseTicket } from "./index";
import type { Actor, IpdBedNeed, RaiseTicketInput } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { MaintenanceWorld } from "../../../test/helpers/maintenance";

/** E1.5 MAINTENANCE — the edges around the five done-means: duplicates, joins, cancel, dispatch, reads, refusals. */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.5 maintenance — tickets", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: MaintenanceWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkMaintenanceWorld(db); });

  const bedStatus = async (id: string): Promise<string> => (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;
  const ticket = async (id: string) => (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, id)))[0]!;
  const raise = (by: Actor, input: Partial<RaiseTicketInput> & { placeResourceId: string }) =>
    raiseTicket(db, by, { itemKind: "bed", urgency: "routine", description: "Wheel lock broken", ...input });

  it("a second report of the same open fault is the same ticket (reported again), never a second count", async () => {
    const bedId = await w.bed("MT-DUP");
    const a = await raise(w.nurse, { placeResourceId: bedId });
    const b = await raise(w.raiser, { placeResourceId: bedId, description: "Bed wheel lock again" });
    expect(b).toMatchObject({ ticketId: a.ticketId, merged: true });
    expect(await db.select().from(maintenanceTickets)).toHaveLength(1);
    const acts = (await db.select().from(maintenanceTicketEvents).where(eq(maintenanceTicketEvents.ticketId, a.ticketId))).map((e) => e.act);
    expect(acts).toEqual(["raised", "reported_again"]);
    // A different item on the same bed is a ticket of its own; the bed's block is joined, not doubled.
    const c = await raise(w.nurse, { placeResourceId: bedId, itemKind: "oxygen_point", urgency: "critical", description: "No flow" });
    expect(c.merged).toBe(false);
    expect(c.bed).toBe("joined_block");
    expect((await ticket(c.ticketId)).bedBlockId).toBe((await ticket(a.ticketId)).bedBlockId);
  });

  it("the expected return is the urgency's hours: critical 4 h, urgent 24 h, routine 72 h", async () => {
    const now = new Date();
    for (const [code, urgency, hours] of [["MT-C", "critical", 4], ["MT-U", "urgent", 24], ["MT-R", "routine", 72]] as const) {
      const bedId = await w.bed(code);
      const r = await raiseTicket(db, w.nurse, { placeResourceId: bedId, itemKind: "bed", urgency, description: "x" }, { now });
      expect((await ticket(r.ticketId)).dueAt.getTime() - now.getTime()).toBe(hours * 3_600_000);
    }
  });

  it("a bed blocked by hand for maintenance is joined (source block); a block for another reason is not", async () => {
    const bedId = await w.bed("MT-HAND");
    await blockBed(db, w.dutyManager, {
      idempotencyKey: randomUUID(), bedId, reason: "maintenance", note: "Rail loose", expectedReturnAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const r = await raise(w.nurse, { placeResourceId: bedId });
    expect(r.bed).toBe("joined_block");
    expect((await ticket(r.ticketId)).source).toBe("block");

    const other = await w.bed("MT-IC");
    await blockBed(db, w.dutyManager, {
      idempotencyKey: randomUUID(), bedId: other, reason: "infection_control", note: "C. diff", expectedReturnAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const r2 = await raise(w.nurse, { placeResourceId: other });
    expect(r2.bed).toBe("already_blocked");
    expect((await ticket(r2.ticketId)).bedBlockId).toBeNull();
  });

  it("a reserved bed is not blocked, and the answer says so", async () => {
    const bedId = await w.bed("MT-RES");
    await reserveBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("female"), need: GENERAL });
    const r = await raise(w.nurse, { placeResourceId: bedId });
    expect(r.bed).toBe("not_blocked_reserved");
    expect(await bedStatus(bedId)).toBe("available");
  });

  it("cancel (raised in error) ends the ticket, its open task and the bed's block — to cleaning", async () => {
    const bedId = await w.bed("MT-CAN");
    const r = await raise(w.nurse, { placeResourceId: bedId });
    await expect(cancelTicket(db, w.nurse, { ticketId: r.ticketId, reason: "wrong bed" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelTicket(db, w.manager, { ticketId: r.ticketId, reason: " " })).rejects.toMatchObject({ code: "bad_input" });
    const row = await cancelTicket(db, w.manager, { ticketId: r.ticketId, reason: "wrong bed" });
    expect(row.state).toBe("cancelled");
    expect((await getTask(db, row.taskId!))!.state).toBe("cancelled");
    expect(await bedStatus(bedId)).toBe("cleaning");
    await expect(cancelTicket(db, w.manager, { ticketId: r.ticketId, reason: "again" })).rejects.toMatchObject({ code: "ticket_closed" });
  });

  it("a repair task cancelled on the task board leaves the fault open; dispatch raises it again", async () => {
    const bedId = await w.bed("MT-DIS");
    const r = await raise(w.nurse, { placeResourceId: bedId });
    const first = (await ticket(r.ticketId)).taskId!;
    await expect(dispatchTicket(db, w.manager, { ticketId: r.ticketId })).rejects.toMatchObject({ code: "task_still_open" });
    await cancelTask(db, w.supervisor, { taskId: first, reason: "duplicate on the board" });
    const board = await maintenanceBoard(db);
    expect(board.floors.flatMap((f) => f.tickets).find((t) => t.id === r.ticketId)).toMatchObject({ state: "open", taskId: null });
    const again = await dispatchTicket(db, w.manager, { ticketId: r.ticketId });
    expect(again.taskId).not.toBe(first);
    expect((await getTask(db, again.taskId!))!.state).toBe("assigned");
    expect(await bedStatus(bedId)).toBe("blocked");
  });

  it("refuses a person without maintenance.raise, an unknown place and a retired place", async () => {
    const bedId = await w.bed("MT-REF");
    await expect(raise(w.viewer, { placeResourceId: bedId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(raise(w.nurse, { placeResourceId: "no-such-place" })).rejects.toMatchObject({ code: "unknown_place" });
    await db.update(resources).set({ status: "retired" }).where(eq(resources.id, bedId));
    await expect(raise(w.nurse, { placeResourceId: bedId })).rejects.toMatchObject({ code: "place_retired" });
  });

  it("the board: critical first, blocked beds, waiting-for-nurse; the Beds board line per bed; no patient anywhere", async () => {
    const occupied = await w.bed("MT-OCC");
    const patientId = await w.patient("male", 40, "Ramesh Kumar Secret");
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId: occupied, patientId, need: GENERAL });
    const routine = await raise(w.nurse, { placeResourceId: w.roomId, itemKind: "fixture", description: "Tube light flickering" });
    const critical = await raise(w.nurse, { placeResourceId: occupied, itemKind: "oxygen_point", urgency: "critical", description: "Wall outlet hissing" });
    const board = await maintenanceBoard(db);
    const tickets = board.floors.flatMap((f) => f.tickets);
    expect(tickets.map((t) => t.id)).toEqual([critical.ticketId, routine.ticketId]);
    expect(tickets[0]).toMatchObject({ state: "assigned", blockOnRelease: true, floorName: "F-T", placeCode: "MT-OCC" });
    expect(board.blockedBeds).toEqual([{ bedId: occupied, bedCode: "MT-OCC", ticketNumber: critical.number, state: "assigned", onRelease: true }]);
    expect(board.counts).toMatchObject({ open: 2, critical: 1, toConfirm: 0, blockedBeds: 1, notShown: 0 });
    expect(JSON.stringify(board)).not.toContain("Secret");
    const line = await bedTickets(db);
    expect(line.tickets).toEqual([expect.objectContaining({ bedId: occupied, number: critical.number, state: "assigned", blockOnRelease: true })]);
  });
});
