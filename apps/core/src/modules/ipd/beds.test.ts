import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { IPD_BEDS_TOPIC, IpdBedBoardSchema, newId } from "@hmis/contracts";
import { events } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkBedWorld } from "../../../test/helpers/ipd";
import {
  assignBed, blockBed, ipdTopicsFor, markBedClean, markIncumbentBeds, readBedBoard, releaseIncumbentBed,
  releaseReservation, reserveBed, unblockBed,
} from "./index";
import type { IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { BedWorld } from "../../../test/helpers/ipd";

jest.setTimeout(60_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };

describe("E1.1 bed intents and the capacity board", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: BedWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkBedWorld(db); });

  const act = (bedId: string, patientId: string, admissionId = newId()) => ({
    idempotencyKey: randomUUID(), admissionId, bedId, patientId, need: GENERAL,
  });

  it("a retried assignment with the same idempotency key acts once and answers the first result", async () => {
    const bedId = await w.bed("U-IDEM");
    const input = act(bedId, await w.patient("male"));
    const first = await assignBed(db, w.desk, input);
    const again = await assignBed(db, w.desk, input);
    expect(again).toEqual(first);
    const assigned = await db.select().from(events).where(eq(events.name, "ipd.bed.assigned"));
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.payload).toMatchObject({ admissionId: input.admissionId, provenance: "person" });
  });

  it("reserve → assign by the same admission consumes the hold; a person can release a hold", async () => {
    const a = await w.bed("U-A");
    const b = await w.bed("U-B");
    const p = await w.patient("female");
    const admissionId = newId();
    const held = await reserveBed(db, w.desk, act(a, p, admissionId));
    // A second hold for the same admission moves the hold (the first is released as plan_changed).
    const moved = await reserveBed(db, w.desk, act(b, p, admissionId));
    await expect(releaseReservation(db, w.desk, { idempotencyKey: randomUUID(), reservationId: held.reservationId, reason: "other" }))
      .rejects.toMatchObject({ code: "reservation_ended" });
    await expect(assignBed(db, w.desk, act(b, p, admissionId))).resolves.toMatchObject({ bedId: b });
    await expect(releaseReservation(db, w.desk, { idempotencyKey: randomUUID(), reservationId: moved.reservationId, reason: "other" }))
      .rejects.toMatchObject({ code: "reservation_ended" });
  });

  it("block → unblock → clean: maintenance returns through cleaning; staff shortage returns available", async () => {
    const bedId = await w.bed("U-BLK");
    const ret = new Date(Date.now() + 3_600_000).toISOString();
    await expect(blockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId, reason: "maintenance", note: "Fan", expectedReturnAt: ret }))
      .resolves.toMatchObject({ status: "blocked" });
    await expect(blockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId, reason: "maintenance", note: "Fan", expectedReturnAt: ret }))
      .rejects.toMatchObject({ code: "state_changed" });
    await expect(unblockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId })).resolves.toEqual({ bedId, bedStatus: "cleaning" });
    await expect(unblockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId })).rejects.toMatchObject({ code: "bed_not_blocked" });
    // Marking clean needs ipd.beds.clean (the desk does not hold it) and refuses a time from the future.
    const clean = (at: Date) => ({ idempotencyKey: randomUUID(), bedId, cleanedAt: at.toISOString(), checklistDone: true as const });
    await expect(markBedClean(db, w.desk, clean(new Date()))).rejects.toMatchObject({ code: "ipd_forbidden" });
    await expect(markBedClean(db, w.cleaner, clean(new Date(Date.now() + 3_600_000)))).rejects.toMatchObject({ code: "time_in_future" });
    await expect(markBedClean(db, w.cleaner, clean(new Date()))).resolves.toEqual({ bedId, bedStatus: "available" });
    await expect(markBedClean(db, w.cleaner, clean(new Date()))).rejects.toMatchObject({ code: "bed_not_cleaning" });

    await blockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId, reason: "staff_shortage", note: "Night", expectedReturnAt: ret });
    await expect(unblockBed(db, w.desk, { idempotencyKey: randomUUID(), bedId })).resolves.toEqual({ bedId, bedStatus: "available" });
  });

  it("incumbent beds: dry run writes nothing, apply marks them, a second apply is a no-op, release goes to cleaning", async () => {
    await w.bed("U-INC1");
    const id2 = await w.bed("U-INC2");
    const lines = [{ code: "U-INC1" }, { code: "u-inc2", gender: "male" as const }, { code: "U-NOPE" }];
    const dry = await markIncumbentBeds(db, w.desk, lines);
    expect(dry.problems).toEqual([{ code: "U-NOPE", problem: "no IPD bed has this code" }]);
    expect((await markIncumbentBeds(db, w.desk, lines, { apply: true })).mark).toEqual(["U-INC1", "U-INC2"]); // problems → nothing written
    expect((await readBedBoard(db, w.viewer)).totals.incumbent).toBe(0);
    await markIncumbentBeds(db, w.desk, lines.slice(0, 2), { apply: true });
    expect((await markIncumbentBeds(db, w.desk, lines.slice(0, 2), { apply: true })).already).toEqual(["U-INC1", "U-INC2"]);
    expect((await readBedBoard(db, w.viewer)).totals.incumbent).toBe(2);
    await expect(releaseIncumbentBed(db, w.desk, { idempotencyKey: randomUUID(), bedId: id2 })).resolves.toEqual({ bedId: id2, bedStatus: "cleaning" });
    await expect(releaseIncumbentBed(db, w.desk, { idempotencyKey: randomUUID(), bedId: id2 })).rejects.toMatchObject({ code: "bed_not_incumbent" });
  });

  it("the board counts by the census rules, keeps overflow apart, and never sends a name to the wall", async () => {
    const g1 = await w.bed("U-G1");
    await w.bed("U-G2", { class: "private" });
    await w.bed("U-DC", { class: "daycare", daycare: true });
    const ovf = await w.bed("U-OVF", { class: "overflow", overflow: true });
    await assignBed(db, w.desk, act(g1, await w.patient("female", 40, "Rekha Kumari Devi")));
    await assignBed(db, w.dutyManager, act(ovf, await w.patient("male")));

    const board = await readBedBoard(db, w.viewer);
    expect(IpdBedBoardSchema.parse(board)).toBeTruthy();
    expect(board.totals.census).toEqual({ occupied: 1, total: 2 });
    expect(board.totals.overflow).toEqual({ occupied: 1, total: 1 });
    expect(board.totals.outsideCensus).toEqual({ occupied: 0, total: 1 });
    expect(board.totals.freeByClass).toEqual({ private: 1 });
    const tile = board.floors[0]!.wards[0]!.beds.find((b) => b.code === "U-G1")!;
    expect(tile.occupant).toEqual({ initials: "R. K. D.", name: "Rekha Kumari Devi" });

    const wall = await readBedBoard(db, w.viewer, { wall: true });
    expect(wall.floors[0]!.wards[0]!.beds.find((b) => b.code === "U-G1")!.occupant).toEqual({ initials: "R. K. D.", name: null });
    expect(JSON.stringify(wall)).not.toContain("Rekha");
  });

  it("realtime: every bed act and every place change reaches the board topic; other resources do not", () => {
    expect(ipdTopicsFor({ name: "ipd.bed.cleaned", payload: {} })).toEqual([IPD_BEDS_TOPIC]);
    expect(ipdTopicsFor({ name: "resource.released", payload: { kind: "bed" } })).toEqual([IPD_BEDS_TOPIC]);
    expect(ipdTopicsFor({ name: "resource.status_changed", payload: { kind: "theatre" } })).toEqual([]);
  });
});
