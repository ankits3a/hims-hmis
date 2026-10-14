import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, newId } from "@hmis/contracts";
import { alerts, taskEvents } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deliverBedEvents, mkHousekeepingWorld, releaseBed } from "../../../test/helpers/housekeeping";
import { assignBed, blockBed, unblockBed } from "../ipd";
import { findTasks, raiseTask } from "../tasks";
import { bedCleans, housekeepingBoard, nudgeClean, verifyClean } from "./index";
import type { IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { HousekeepingWorld } from "../../../test/helpers/housekeeping";

/** E1.4 — the reads, the nudge and the unblock path, beside the acceptance checks. No pinned dates. */
jest.setTimeout(90_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("housekeeping — reads, nudge, unblock", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HousekeepingWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHousekeepingWorld(db); });

  async function released(code: string, attrs: Record<string, unknown> = {}): Promise<string> {
    const bedId = await w.bed(code, attrs);
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
    await releaseBed(db, w.dutyManager, bedId);
    await deliverBedEvents(db, bedId);
    return bedId;
  }

  it("bedCleans gives each bed's clean with its clock and the cleaner's initials only", async () => {
    const a = await released("R-A");
    const b = await released("R-B", { isolation: "droplet" });
    const view = await bedCleans(db);
    const byBed = new Map(view.cleans.map((c) => [c.bedId, c]));
    expect(byBed.get(a)).toMatchObject({ kind: HOUSEKEEPING_KINDS.routine, terminal: false, late: false });
    expect(byBed.get(b)).toMatchObject({ kind: HOUSEKEEPING_KINDS.terminal, terminal: true });
    // Dispatched on raise to an on-duty cleaner: initials, never the full name.
    expect(byBed.get(a)!.assigneeInitials).toMatch(/^[A-Z]\.( [A-Z]\.)*$/);
    expect(byBed.get(a)!.minutes).toBeGreaterThanOrEqual(0);
  });

  it("the housekeeping board shows housekeeping's kinds only", async () => {
    await released("R-C");
    await raiseTask(db, w.supervisor, { kind: "general", placeResourceId: w.roomId });
    const board = await housekeepingBoard(db);
    const kinds = board.floors.flatMap((f) => f.tasks.map((t) => t.kind));
    expect(kinds).toEqual([HOUSEKEEPING_KINDS.routine]);
    expect(board.counts.open).toBe(1);
  });

  it("a nudge escalates the clean once, bells the supervisor, and a second nudge within five minutes is refused", async () => {
    const bedId = await released("R-N");
    const [task] = await findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId });
    await nudgeClean(db, w.desk, { taskId: task!.id });
    const ev = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task!.id), eq(taskEvents.act, "escalated")));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ nudge: true });
    const bells = await db.select().from(alerts).where(and(eq(alerts.userId, w.supervisor.id), eq(alerts.kind, "task.nudge")));
    expect(bells).toHaveLength(1);
    await expect(nudgeClean(db, w.desk, { taskId: task!.id })).rejects.toMatchObject({ code: "nudged_recently" });
  });

  it("an infection-control block ending into cleaning raises a terminal clean; a non-housekeeping task cannot be verified here", async () => {
    const bedId = await w.bed("R-IC");
    await blockBed(db, w.desk, {
      idempotencyKey: randomUUID(), bedId, reason: "infection_control", note: "MRSA",
      expectedReturnAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await unblockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId });
    await deliverBedEvents(db, bedId);
    const cleans = await findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId });
    expect(cleans.map((c) => c.kind)).toEqual([HOUSEKEEPING_KINDS.terminal]);
    const { task } = await raiseTask(db, w.supervisor, { kind: "general", placeResourceId: w.roomId });
    await expect(verifyClean(db, w.supervisor, { taskId: task.id })).rejects.toMatchObject({ code: "not_a_clean" });
  });
});
