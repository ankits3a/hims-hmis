import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { alerts, maintenanceTickets, resources } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkMaintenanceWorld } from "../../../test/helpers/maintenance";
import { assignBed, releaseReservation, reserveBed } from "../ipd";
import { acceptTask, completeTask, startTask, verifyTask } from "../tasks";
import { confirmTicket, raiseTicket } from "./index";
import type { Actor, IpdBedNeed, RaiseTicketInput } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { MaintenanceWorld } from "../../../test/helpers/maintenance";

/** E1.5 MAINTENANCE — PR #754 review findings, one check each. */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.5 maintenance — review findings", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: MaintenanceWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkMaintenanceWorld(db); });

  const bedStatus = async (id: string): Promise<string> => (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;
  const ticket = async (id: string) => (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, id)))[0]!;
  const raise = (by: Actor, input: Partial<RaiseTicketInput> & { placeResourceId: string }, now?: Date) =>
    raiseTicket(db, by, { itemKind: "bed", urgency: "urgent", description: "Fault", ...input }, now === undefined ? {} : { now });
  async function fix(ticketId: string, by: Actor): Promise<string> {
    const taskId = (await ticket(ticketId)).taskId!;
    await acceptTask(db, by, { taskId });
    await startTask(db, by, { taskId });
    await completeTask(db, by, { taskId, proof: { kind: "tap" } });
    return taskId;
  }

  it("1. two tickets on one block confirmed at once: the bed is unblocked (the count runs under the bed lock)", async () => {
    const bedId = await w.bed("RV-ONE");
    const a = await raise(w.nurse, { placeResourceId: bedId });
    const b = await raise(w.nurse, { placeResourceId: bedId, itemKind: "oxygen_point" });
    expect(b.bed).toBe("joined_block");
    const taskA = await fix(a.ticketId, w.tech);
    await fix(b.ticketId, w.tech);
    let second: Promise<unknown> | null = null;
    await db.transaction(async (tx) => {
      await verifyTask(tx, w.nurse, { taskId: taskA }); // A closes its ticket and has decided about the block
      second = confirmTicket(db, w.confirmer, { ticketId: b.ticketId }); // B starts while A is uncommitted
      await new Promise((r) => setTimeout(r, 600));
    });
    await second;
    expect((await ticket(a.ticketId)).state).toBe("closed");
    expect((await ticket(b.ticketId)).state).toBe("closed");
    expect(await bedStatus(bedId)).toBe("cleaning");
  });

  it("2. a ticket on a reserved bed blocks nothing, but the bed cannot be assigned or reserved again while it is open", async () => {
    const bedId = await w.bed("RV-TWO");
    const admissionId = newId();
    const patientId = await w.patient("female");
    const hold = await reserveBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId, bedId, patientId, need: GENERAL });
    const r = await raise(w.nurse, { placeResourceId: bedId });
    expect(r.bed).toBe("not_blocked_reserved");
    await expect(assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId, bedId, patientId, need: GENERAL }))
      .rejects.toMatchObject({ code: "repair_ticket_open", fix: "Close the repair ticket" });
    await releaseReservation(db, w.desk, { idempotencyKey: randomUUID(), reservationId: hold.reservationId, reason: "bed_unsuitable" });
    await expect(reserveBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId, need: GENERAL }))
      .rejects.toMatchObject({ code: "repair_ticket_open" });
  });

  it("3. the replacement bell rings once, on the ticket that crosses the threshold; the fourth keeps the flag and rings nothing", async () => {
    const t0 = new Date();
    const at = (days: number) => new Date(t0.getTime() - days * 86_400_000);
    const ac = { placeResourceId: w.roomId, itemKind: "ac" as const, description: "Not cooling" };
    for (const days of [20, 10, 5]) {
      const r = await raise(w.nurse, ac, at(days));
      await fix(r.ticketId, w.tech);
      await confirmTicket(db, w.nurse, { ticketId: r.ticketId });
    }
    const fourth = await raise(w.nurse, ac, t0);
    expect(fourth.replacementFlag).toBe(true);
    const bells = await db.select().from(alerts).where(and(eq(alerts.userId, w.supervisor.id), eq(alerts.kind, "maintenance.replacement")));
    expect(bells).toHaveLength(1);
  });

  it("4. a bed in a status the beds module will not block from still gets its ticket recorded, and the answer says so", async () => {
    const bedId = await w.bed("RV-FOUR");
    await db.update(resources).set({ status: "occupied" }).where(eq(resources.id, bedId)); // kernel occupied, no occupant
    const r = await raise(w.nurse, { placeResourceId: bedId });
    expect(r.bed).toBe("not_blocked_status");
    expect((await ticket(r.ticketId)).state).toBe("open");
    expect((await ticket(r.ticketId)).bedBlockId).toBeNull();
  });
});
