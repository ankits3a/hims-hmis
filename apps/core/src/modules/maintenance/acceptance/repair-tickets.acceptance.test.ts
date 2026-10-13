import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { alerts, maintenanceTickets, resources } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { releaseBed } from "../../../../test/helpers/housekeeping";
import { mkMaintenanceWorld } from "../../../../test/helpers/maintenance";
import { IpdRefusal, assignBed, unblockBed } from "../../ipd";
import { acceptTask, completeTask, getTask, skillRoles, startTask } from "../../tasks";
import { confirmTicket, raiseTicket } from "../index";
import type { Actor, IpdBedNeed, RaiseTicketInput } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { MaintenanceWorld } from "../../../../test/helpers/maintenance";

/**
 * E1.5 MAINTENANCE (issue #722, decision 0072) — "DONE MEANS" (SPEC-ipd-companions §9, brief §7). Every check calls
 * the intents — never a screen. Instants are the real clock's, or explicit offsets from one instant captured here
 * and handed to the code as `now` (the repeat-fault window); no calendar date is pinned.
 */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.5 maintenance — repair tickets acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: MaintenanceWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkMaintenanceWorld(db); });

  const bedStatus = async (id: string): Promise<string> => (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;
  const ticket = async (id: string) => (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, id)))[0]!;
  const raise = (by: Actor, input: Partial<RaiseTicketInput> & { placeResourceId: string }, now?: Date) =>
    raiseTicket(db, by, { itemKind: "bed", urgency: "urgent", description: "Side rail broken", ...input }, now === undefined ? {} : { now });
  const unblockByHand = (bedId: string) => unblockBed(db, w.dutyManager, { idempotencyKey: randomUUID(), bedId, note: "back in service" });

  /** The technician's road on the ticket's task: accept, start, done with a tap. */
  async function fix(ticketId: string, by: Actor): Promise<void> {
    const taskId = (await ticket(ticketId)).taskId!;
    await acceptTask(db, by, { taskId });
    await startTask(db, by, { taskId });
    await completeTask(db, by, { taskId, proof: { kind: "tap" } });
  }

  it("(i) a blocked bed stays blocked until the ticket is closed AND a nurse confirms — fixed alone does not unblock", async () => {
    const bedId = await w.bed("M-ONE");
    const r = await raise(w.nurse, { placeResourceId: bedId, urgency: "critical" });
    expect(r.bed).toBe("blocked");
    expect(await bedStatus(bedId)).toBe("blocked");

    await fix(r.ticketId, w.tech);
    expect((await ticket(r.ticketId)).state).toBe("fixed");
    expect(await bedStatus(bedId)).toBe("blocked"); // the technician's Done is not the nurse's confirmation

    // The technician cannot confirm their own repair; a person without a verifier permission cannot either.
    await expect(confirmTicket(db, w.tech, { ticketId: r.ticketId })).rejects.toMatchObject({ code: "verifier_is_doer" });
    await expect(confirmTicket(db, w.raiser, { ticketId: r.ticketId })).rejects.toMatchObject({ code: "not_permitted" });
    expect(await bedStatus(bedId)).toBe("blocked");

    await confirmTicket(db, w.nurse, { ticketId: r.ticketId });
    const closed = await ticket(r.ticketId);
    expect(closed.state).toBe("closed");
    expect(closed.closedBy).toBe(w.nurse.id);
    // After maintenance the beds rule sends the bed to cleaning, never straight to available.
    expect(await bedStatus(bedId)).toBe("cleaning");
  });

  it("(ii) a manual unblock is refused while the repair ticket is open — and while it is fixed but unconfirmed", async () => {
    const bedId = await w.bed("M-TWO");
    const r = await raise(w.raiser, { placeResourceId: bedId });
    const refusal = await unblockByHand(bedId).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(IpdRefusal);
    expect(refusal).toMatchObject({ code: "repair_ticket_open", fix: "Close the repair ticket" });
    expect(await bedStatus(bedId)).toBe("blocked");

    await fix(r.ticketId, w.tech);
    await expect(unblockByHand(bedId)).rejects.toMatchObject({ code: "repair_ticket_open" });
    expect(await bedStatus(bedId)).toBe("blocked");

    // A confirmer holding `maintenance.confirm` (not `ipd.beds.clean`) closes it too.
    await confirmTicket(db, w.confirmer, { ticketId: r.ticketId });
    expect(await bedStatus(bedId)).toBe("cleaning");
  });

  it("(iii) a ticket on an occupied bed blocks only on release", async () => {
    const bedId = await w.bed("M-THREE");
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
    const r = await raise(w.nurse, { placeResourceId: bedId, itemKind: "oxygen_point", description: "Flowmeter leaking" });
    expect(r.bed).toBe("block_on_release");
    expect(await bedStatus(bedId)).toBe("occupied"); // a request, not a block: the patient stays

    await releaseBed(db, w.dutyManager, bedId);
    expect(await bedStatus(bedId)).toBe("blocked"); // not cleaning: the repair holds it
    await expect(unblockByHand(bedId)).rejects.toMatchObject({ code: "repair_ticket_open" });

    await fix(r.ticketId, w.tech);
    await confirmTicket(db, w.nurse, { ticketId: r.ticketId });
    expect(await bedStatus(bedId)).toBe("cleaning");
  });

  it("(iv) the third fault on one item in 30 days flags it for replacement; the second does not; one outside the window does not count", async () => {
    const t0 = new Date(); // explicit offsets from one captured instant, handed to the code as its `now`
    const at = (days: number) => new Date(t0.getTime() - days * 86_400_000);
    const ac = { placeResourceId: w.roomId, itemKind: "ac" as const, description: "Not cooling" };
    const supervisorBells = () => db.select().from(alerts)
      .where(and(eq(alerts.userId, w.supervisor.id), eq(alerts.kind, "maintenance.replacement")));

    const old = await raise(w.nurse, ac, at(45)); // outside the window
    await fix(old.ticketId, w.tech);
    await confirmTicket(db, w.nurse, { ticketId: old.ticketId });

    const first = await raise(w.nurse, ac, at(20));
    expect(first.replacementFlag).toBe(false);
    await fix(first.ticketId, w.tech);
    await confirmTicket(db, w.nurse, { ticketId: first.ticketId });

    const second = await raise(w.nurse, ac, at(10));
    expect(second.replacementFlag).toBe(false); // the second in 30 days (the 45-day-old one is outside)
    expect(await supervisorBells()).toHaveLength(0);
    await fix(second.ticketId, w.tech);
    await confirmTicket(db, w.nurse, { ticketId: second.ticketId });

    const third = await raise(w.nurse, ac, t0);
    expect(third.replacementFlag).toBe(true);
    expect((await ticket(third.ticketId)).replacementFlag).toBe(true);
    const bells = await supervisorBells();
    expect(bells).toHaveLength(1);
    expect(bells[0]!.refId).toBe(third.ticketId);
  });

  it("(v) a biomedical ticket routes to the biomedical skill — the biomedical engineer gets it, not the technician", async () => {
    const bedId = await w.bed("M-FIVE");
    const bio = await raise(w.nurse, { placeResourceId: bedId, itemKind: "monitor", description: "SpO2 module dead" });
    const bioTask = (await getTask(db, (await ticket(bio.ticketId)).taskId!))!;
    expect((await ticket(bio.ticketId)).category).toBe("biomedical");
    expect(bioTask.kind).toBe("repair_biomedical");
    expect(bioTask.skill).toBe("biomedical");
    expect(skillRoles("biomedical")).toEqual(["biomedical_engineer"]);
    expect(bioTask.assigneeId).toBe(w.bme.id);
    await expect(acceptTask(db, w.tech, { taskId: bioTask.id })).rejects.toMatchObject({ code: "already_taken" });

    const room = await raise(w.nurse, { placeResourceId: w.roomId, itemKind: "plumbing", description: "Basin tap leaking" });
    const general = (await getTask(db, (await ticket(room.ticketId)).taskId!))!;
    expect(general.kind).toBe("repair_general");
    expect(general.assigneeId).toBe(w.tech.id);
  });
});
