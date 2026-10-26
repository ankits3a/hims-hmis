import { HOUSEKEEPING_KINDS, newId } from "@hmis/contracts";
import { randomUUID } from "node:crypto";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deliverBedEvents, mkHkWorld, releaseBed } from "../../../test/helpers/housekeeping";
import { assignBed } from "../ipd";
import { acceptTask, findTasks, startTask } from "../tasks";
import { areaQrToken, confirmClean, defineArea, finishWork, saveChecklist, storeWorkPhoto, toCheck } from "./index";
import type { Db } from "../../kernel/db/client";
import type { HkWorld } from "../../../test/helpers/housekeeping";

/** HK-2 (#974) — the staff app's check list: work done and waiting for a Pass or Fail, with no person and no patient. */
describe("toCheck", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HkWorld;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHkWorld(db); });

  it("lists a finished bed clean until it is passed", async () => {
    const now = new Date();
    const list = await saveChecklist(db, w.supervisor, { name: "Ward", items: [{ text: "Floor mopped" }] });
    const area = await defineArea(db, w.supervisor, { resourceId: w.wardId, areaClass: "B", checklistId: list.id });
    const bedId = await w.bed("HK2-CHK");
    const patientId = await w.patient("male");
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId, need: { requestedClass: "general", isolation: "none", icu: false } });
    await releaseBed(db, w.dutyManager, bedId);
    await deliverBedEvents(db, bedId);
    const [task] = await findTasks(db, { kinds: [HOUSEKEEPING_KINDS.routine], placeResourceId: bedId });
    expect(await toCheck(db)).toEqual([]);
    await acceptTask(db, w.hk1, { taskId: task!.id }, now);
    await startTask(db, w.hk1, { taskId: task!.id }, now);
    const { photoKey } = await storeWorkPhoto(db, w.store, w.hk1, { taskId: task!.id, mime: "image/jpeg", bytes: Buffer.from("bed") });
    await finishWork(db, w.key, w.hk1, { taskId: task!.id, scan: await areaQrToken(db, w.key, area.id), answers: list.items.map((i) => ({ itemId: i.id, ok: true })), photoKey }, now);
    const listed = await toCheck(db);
    expect(listed).toEqual([expect.objectContaining({ taskId: task!.id, kind: HOUSEKEEPING_KINDS.routine, kindLabel: "Bed clean", placeName: "HK2-CHK", terminal: false, fails: 0 })]);
    expect(JSON.stringify(listed)).not.toContain(patientId);
    expect(JSON.stringify(listed)).not.toContain("hk.one");
    await confirmClean(db, w.nurse, { taskId: task!.id, result: "pass" }, now);
    expect(await toCheck(db)).toEqual([]);
  });
});
