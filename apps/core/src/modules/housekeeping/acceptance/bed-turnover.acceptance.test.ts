import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, newId } from "@hmis/contracts";
import { resources } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { deliverBedEvents, eventsAbout, mkHousekeepingWorld, releaseBed } from "../../../../test/helpers/housekeeping";
import { assignBed, markBedClean } from "../../ipd";
import { acceptTask, assignTask, completeTask, findTasks, startTask, verifyTask } from "../../tasks";
import { handleBedEvent, verifyClean } from "../index";
import type { Actor, IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { HousekeepingWorld } from "../../../../test/helpers/housekeeping";
import type { TaskRow } from "../../tasks";

/**
 * E1.4 HOUSEKEEPING (issue #721, decision 0072) — "DONE MEANS" (SPEC-ipd-companions §11, brief §6). Every check
 * calls the intents and delivers the bed's real events to the consumer — never a screen. No date is pinned: every
 * instant is the real clock's, and nothing asserted depends on which one.
 */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.4 housekeeping — bed turnover acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HousekeepingWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHousekeepingWorld(db); });

  const bedStatus = async (id: string): Promise<string> => (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;
  const assign = (bedId: string, patientId: string) =>
    assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId, need: GENERAL });
  const cleansOf = (bedId: string) => findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId });

  /** An occupied bed, released through ipd's seam, its events delivered: returns the bed's one clean. */
  async function releasedBed(code: string, attrs: Record<string, unknown> = {}, terminal = false): Promise<{ bedId: string; task: TaskRow }> {
    const bedId = await w.bed(code, attrs);
    await assign(bedId, await w.patient("male"));
    await releaseBed(db, w.dutyManager, bedId, { terminal });
    await deliverBedEvents(db, bedId);
    const cleans = await cleansOf(bedId);
    expect(cleans).toHaveLength(1);
    return { bedId, task: cleans[0]! };
  }

  /** The worker's road: accept, start, done with a tap. */
  async function cleanIt(task: TaskRow, by: Actor): Promise<TaskRow> {
    await acceptTask(db, by, { taskId: task.id });
    await startTask(db, by, { taskId: task.id });
    return completeTask(db, by, { taskId: task.id, proof: { kind: "tap" } });
  }

  it("(i) a release creates exactly one cleaning task — and the same events delivered twice still one", async () => {
    const { bedId, task } = await releasedBed("H-ONE");
    expect(task.kind).toBe(HOUSEKEEPING_KINDS.routine);
    expect(await bedStatus(bedId)).toBe("cleaning");
    // The dispatcher is at-least-once: every event about the bed, delivered again, then the release alone a third time.
    await deliverBedEvents(db, bedId);
    const released = (await eventsAbout(db, bedId)).filter((e) => e.name === "resource.released");
    expect(released).toHaveLength(1);
    expect((await handleBedEvent(db, released[0]!)).raised).toBeNull();
    expect(await cleansOf(bedId)).toHaveLength(1);
  });

  it("(ii) the bed cannot be assigned until its clean is verified; the check makes it available", async () => {
    const { bedId, task } = await releasedBed("H-TWO");
    const next = await w.patient("female");
    await expect(assign(bedId, next)).rejects.toMatchObject({ code: "bed_not_available" });
    // Cleaned but not yet checked: still not assignable.
    await cleanIt(task, w.hk1);
    expect(await bedStatus(bedId)).toBe("cleaning");
    await expect(assign(bedId, next)).rejects.toMatchObject({ code: "bed_not_available" });
    // The ward nurse side checks it: verified, and in the same transaction the bed is available.
    const verified = await verifyClean(db, w.nurse, { taskId: task.id });
    expect(verified.state).toBe("verified");
    expect(await bedStatus(bedId)).toBe("available");
    await expect(assign(bedId, next)).resolves.toMatchObject({ bedId });
  });

  it("(iii) an isolation bed's release creates a terminal clean that only the housekeeping supervisor can verify", async () => {
    const { bedId, task } = await releasedBed("H-ISO", { isolation: "contact" });
    expect(task.kind).toBe(HOUSEKEEPING_KINDS.terminal);
    await cleanIt(task, w.hk1);
    // The nurse is refused with the rule and the fix — at housekeeping's door and at the engine's.
    await expect(verifyClean(db, w.nurse, { taskId: task.id })).rejects.toMatchObject({
      code: "terminal_needs_supervisor",
      message: "A terminal clean is checked by the housekeeping supervisor (infection control).",
      fix: "Ask the housekeeping supervisor to check this bed.",
    });
    await expect(verifyTask(db, w.nurse, { taskId: task.id })).rejects.toMatchObject({ code: "not_permitted" });
    expect(await bedStatus(bedId)).toBe("cleaning");
    await expect(verifyClean(db, w.supervisor, { taskId: task.id })).resolves.toMatchObject({ state: "verified" });
    expect(await bedStatus(bedId)).toBe("available");
    // A death or absconded release (ipd says terminal) of an ordinary bed is terminal too.
    const { task: death } = await releasedBed("H-DEATH", {}, true);
    expect(death.kind).toBe(HOUSEKEEPING_KINDS.terminal);
  });

  it("(iv) the person who cleaned cannot verify their own clean", async () => {
    const { bedId, task } = await releasedBed("H-SELF");
    // The supervisor hands it to the one person who both cleans and may check routine cleans.
    await assignTask(db, w.supervisor, { taskId: task.id, userId: w.cleanerNurse.id });
    await cleanIt(task, w.cleanerNurse);
    await expect(verifyClean(db, w.cleanerNurse, { taskId: task.id })).rejects.toMatchObject({ code: "verifier_is_doer" });
    expect(await bedStatus(bedId)).toBe("cleaning");
    await expect(verifyClean(db, w.nurse, { taskId: task.id })).resolves.toMatchObject({ state: "verified" });
  });

  it("(v) a bed re-occupied before its clean is checked cancels the open clean", async () => {
    const { bedId, task } = await releasedBed("H-BACK");
    // Marked clean by hand at the Beds board, then given to the next patient.
    await markBedClean(db, w.nurse, { idempotencyKey: randomUUID(), bedId, cleanedAt: new Date().toISOString(), checklistDone: true });
    await assign(bedId, await w.patient("male"));
    expect(await bedStatus(bedId)).toBe("occupied");
    await deliverBedEvents(db, bedId);
    const [after] = await cleansOf(bedId);
    expect(after).toMatchObject({ id: task.id, state: "cancelled" });
    expect(await cleansOf(bedId)).toHaveLength(1);
  });
});
