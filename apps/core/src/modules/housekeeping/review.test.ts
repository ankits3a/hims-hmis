import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, newId } from "@hmis/contracts";
import { events } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deliverBedEvents, eventsAbout, mkHousekeepingWorld, releaseBed } from "../../../test/helpers/housekeeping";
import { seedCursors } from "../../kernel/worker/seed-cursors";
import { assignBed, markBedClean } from "../ipd";
import { acceptTask, completeTask, findTasks, startTask } from "../tasks";
import { bedCleans, handleBedEvent, nudgeClean, verifyClean } from "./index";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";
import type { IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { HousekeepingWorld } from "../../../test/helpers/housekeeping";
import type { TaskRow } from "../tasks";

/**
 * PR #750 review findings 1–7 — each check failed against the shipped turnover before its fix. Every instant is the
 * real clock's or derived from an event's own; nothing pins a date.
 */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("housekeeping — PR #750 review", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HousekeepingWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHousekeepingWorld(db); });

  const assign = async (bedId: string) =>
    assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
  const cleansOf = (bedId: string) => findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId });
  const releaseEvent = async (bedId: string): Promise<DispatchedEvent> =>
    (await eventsAbout(db, bedId)).filter((e) => e.name === "resource.released").at(-1)!;
  async function occupiedThenReleased(code: string): Promise<string> {
    const bedId = await w.bed(code);
    await assign(bedId);
    await releaseBed(db, w.dutyManager, bedId);
    return bedId;
  }
  async function cleanIt(task: TaskRow): Promise<TaskRow> {
    const by = { type: "user" as const, id: task.assigneeId! };
    await acceptTask(db, by, { taskId: task.id });
    await startTask(db, by, { taskId: task.id });
    return completeTask(db, by, { taskId: task.id, proof: { kind: "tap" } });
  }

  it("(1) idempotency is keyed on the event, not the wall clock: a worker clock behind the event's still raises once", async () => {
    const bedId = await occupiedThenReleased("V-1");
    const e = await releaseEvent(bedId);
    const behind = new Date(e.occurredAt.getTime() - 60_000);
    expect((await handleBedEvent(db, e, behind)).raised).not.toBeNull();
    expect((await handleBedEvent(db, e, behind)).raised).toBeNull();
    const cleans = await cleansOf(bedId);
    expect(cleans).toHaveLength(1);
    expect(cleans[0]!.mergedCount).toBe(0);
  });

  it("(2) a release handled after the bed was re-occupied still records its clean, cancelled with the reason", async () => {
    const bedId = await occupiedThenReleased("V-2");
    await markBedClean(db, w.nurse, { idempotencyKey: randomUUID(), bedId, cleanedAt: new Date().toISOString(), checklistDone: true });
    await assign(bedId);
    await handleBedEvent(db, await releaseEvent(bedId));
    const cleans = await cleansOf(bedId);
    expect(cleans).toHaveLength(1);
    expect(cleans[0]).toMatchObject({ state: "cancelled", cancelReason: "Bed re-occupied before cleaning" });
  });

  it("(3) leaving cleaning cancels a cleaned-but-unchecked clean too, and the clocks show only beds still in cleaning", async () => {
    const bedId = await occupiedThenReleased("V-3");
    await deliverBedEvents(db, bedId);
    const [task] = await cleansOf(bedId);
    await cleanIt(task!);
    await markBedClean(db, w.nurse, { idempotencyKey: randomUUID(), bedId, cleanedAt: new Date().toISOString(), checklistDone: true });
    // Before the consumer catches up, the clocks already leave the bed out (it is available).
    expect((await bedCleans(db)).cleans.map((c) => c.bedId)).not.toContain(bedId);
    await deliverBedEvents(db, bedId);
    expect((await cleansOf(bedId))[0]).toMatchObject({ id: task!.id, state: "cancelled" });
  });

  it("(4) the terminal reason travels on the release event itself; the history row is only a fallback", async () => {
    const bedId = await occupiedThenReleased("V-4");
    const e = await releaseEvent(bedId);
    // The same event, as the kernel now writes it for a terminal release, at an instant no history row has.
    const moved: DispatchedEvent = {
      ...e, seq: e.seq + 100_000, occurredAt: new Date(e.occurredAt.getTime() + 1_000),
      payload: { ...(e.payload as object), reason: "clean:terminal" },
    };
    expect((await handleBedEvent(db, moved)).raised?.kind).toBe(HOUSEKEEPING_KINDS.terminal);
  });

  it("(5) cursor seeding backfills one clean for every bed already in cleaning, once", async () => {
    const a = await occupiedThenReleased("V-5A");
    const b = await occupiedThenReleased("V-5B");
    await seedCursors(db);
    await seedCursors(db);
    expect(await cleansOf(a)).toHaveLength(1);
    expect(await cleansOf(b)).toHaveLength(1);
    // The release, delivered after the backfill, is the same clean.
    await deliverBedEvents(db, a);
    expect(await cleansOf(a)).toHaveLength(1);
  });

  it("(6) a nudge's version bump does not make the check stale: verify compares the state", async () => {
    const bedId = await occupiedThenReleased("V-6");
    await deliverBedEvents(db, bedId);
    const [task] = await cleansOf(bedId);
    const seen = task!.version;
    await nudgeClean(db, w.desk, { taskId: task!.id });
    await cleanIt(task!);
    await expect(verifyClean(db, w.nurse, { taskId: task!.id, version: seen })).resolves.toMatchObject({ state: "verified" });
  });

  it("(7) the clean stores when the bed was released, and the clocks read it", async () => {
    const bedId = await occupiedThenReleased("V-7");
    const e = await releaseEvent(bedId);
    const later = new Date(e.occurredAt.getTime() + 30 * 60_000);
    const { raised } = await handleBedEvent(db, e, later);
    expect((raised as unknown as { raisedAt: Date }).raisedAt).toEqual(e.occurredAt);
    const view = (await bedCleans(db)).cleans.find((c) => c.bedId === bedId)!;
    expect(view.raisedAt).toBe(e.occurredAt.toISOString());
    expect(await db.select().from(events).where(and(eq(events.name, "resource.released"), eq(events.correlationId, bedId)))).toHaveLength(1);
  });
});
