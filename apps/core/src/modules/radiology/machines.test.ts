import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { events, resourceStatusHistory, resources } from "../../kernel/db/schema";
import { createResource } from "../../kernel/resources/registry";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { withTx } from "../../kernel/db/client";
import { imagingDevices } from "./devices";
import { createImagingDevice, editImagingDevice, setImagingDeviceStatus } from "./machines";
import { scheduleStudy } from "./schedule";
import { RadiologyError } from "./errors";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS4 T1 — **the machine register's write door.** Create, edit, status with a reason.
 *
 * The negatives are the point: a bad or duplicate AE title would make the modality worklist pull the
 * wrong patients or none; a status change with no reason leaves the engineer and the inspector with
 * a history that says nothing; and a register that could walk a room, a bed or a bench through the
 * device door would be a kernel write with radiology's permission on it.
 */
describe("the imaging machine register (18-S RS4 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let admin: Actor;
  let roomId: string;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    admin = fx.radiologist;
    ({ resourceId: roomId } = await withTx(db, (tx) => createResource(tx, admin, KERNEL_RESOURCE_KINDS, {
      kind: "room", code: "RAD-R2", name: "CT room 2",
    })));
  });
  afterEach(() => { fx.unregister(); });

  const refusal = async (p: Promise<unknown>): Promise<RadiologyError> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof RadiologyError) return e;
      throw e;
    }
    throw new Error("expected a RadiologyError, the call succeeded");
  };

  const register = (over: Partial<Parameters<typeof createImagingDevice>[2]> = {}) =>
    withTx(db, (tx) => createImagingDevice(tx, admin, {
      code: "CT-2", name: "CT scanner 2", modality: "ct", roomId, aeTitle: "CT_2", ...over,
    }));

  describe("register", () => {
    it("writes a device with modality, room, AE title and portable, and the counter's list shows them", async () => {
      const { deviceResourceId } = await register({ portable: true });
      const row = (await imagingDevices(db, DAY)).find((d) => d.id === deviceResourceId)!;
      expect(row).toMatchObject({
        code: "CT-2", name: "CT scanner 2", modality: "ct", room: "CT room 2", roomId,
        aeTitle: "CT_2", portable: true, status: "available", ionising: true, licensedNow: false,
      });
      const registered = await db.select().from(events)
        .where(and(eq(events.name, "resource.registered"), eq(events.correlationId, deviceResourceId)));
      expect(registered).toHaveLength(1);
    });

    it.each([
      ["lower case", "ct_2"],
      ["a space", "CT 2"],
      ["seventeen characters", "ABCDEFGHIJKLMNOPQ"],
      ["punctuation", "CT-2"],
    ])("refuses an AE title with %s (invalid_ae_title) and writes nothing", async (_label, aeTitle) => {
      const e = await refusal(register({ aeTitle }));
      expect(e.code).toBe("invalid_ae_title");
      expect(await db.select().from(resources).where(eq(resources.code, "CT-2"))).toHaveLength(0);
    });

    it("refuses an AE title another machine already answers to, naming that machine", async () => {
      await register();
      const e = await refusal(register({ code: "CT-3", name: "CT scanner 3" }));
      expect(e.code).toBe("duplicate_ae_title");
      expect(e.message).toContain("CT-2 (CT scanner 2)");
      expect(e.message).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    });

    it("refuses a room that is not a room, and a modality outside the vocabulary", async () => {
      expect((await refusal(register({ roomId: fx.devices.ct! }))).code).toBe("invalid_device");
      expect((await refusal(register({ modality: "CT" }))).code).toBe("invalid_device");
    });

    it("is a person's act — a system actor is refused", async () => {
      const e = await refusal(withTx(db, (tx) => createImagingDevice(tx, { type: "system", id: "x" }, {
        code: "CT-9", name: "x", modality: "ct",
      })));
      expect(e.code).toBe("user_actor_required");
    });
  });

  describe("edit", () => {
    it("sets and clears the AE title and keeps attribute keys it does not own", async () => {
      const { deviceResourceId } = await register();
      await db.update(resources).set({ attributes: { modality: "ct", aeTitle: "CT_2", pacsNode: "ORTHANC" } })
        .where(eq(resources.id, deviceResourceId));
      await withTx(db, (tx) => editImagingDevice(tx, admin, deviceResourceId, { aeTitle: "CT_TWO", portable: true }));
      let [row] = await db.select().from(resources).where(eq(resources.id, deviceResourceId));
      expect(row!.attributes).toEqual({ modality: "ct", aeTitle: "CT_TWO", pacsNode: "ORTHANC", portable: true });
      await withTx(db, (tx) => editImagingDevice(tx, admin, deviceResourceId, { aeTitle: null, roomId: null }));
      [row] = await db.select().from(resources).where(eq(resources.id, deviceResourceId));
      expect(row!.attributes).toEqual({ modality: "ct", pacsNode: "ORTHANC", portable: true });
      expect(row!.parentId).toBeNull();
    });

    it("keeping its own AE title is not a duplicate; taking another machine's is", async () => {
      const { deviceResourceId } = await register();
      await withTx(db, (tx) => editImagingDevice(tx, admin, deviceResourceId, { aeTitle: "CT_2", name: "CT scanner two" }));
      const other = await register({ code: "CT-3", name: "CT scanner 3", aeTitle: "CT_3" });
      const e = await refusal(withTx(db, (tx) => editImagingDevice(tx, admin, other.deviceResourceId, { aeTitle: "CT_2" })));
      expect(e.code).toBe("duplicate_ae_title");
    });

    it("refuses a modality change — the studies, doses and licences were recorded against it", async () => {
      const { deviceResourceId } = await register();
      const e = await refusal(withTx(db, (tx) => editImagingDevice(tx, admin, deviceResourceId, { modality: "mri" })));
      expect(e.code).toBe("invalid_device");
    });
  });

  describe("status", () => {
    it("refuses a change with no reason, and the machine stays as it was", async () => {
      const e = await refusal(withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, { status: "down", reason: "   " })));
      expect(e.code).toBe("reason_required");
      const [row] = await db.select().from(resources).where(eq(resources.id, fx.devices.ct!));
      expect(row!.status).toBe("available");
    });

    it("down: keeps the reason on the history and the event, and returns the booked studies to move", async () => {
      const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "k1", NOW);
      await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
      }));
      const out = await withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, {
        status: "down", reason: "tube arcing — service engineer called",
      }));
      expect(out.from).toBe("available");
      expect(out.to).toBe("down");
      expect(out.studiesToMove).toEqual([expect.objectContaining({
        studyId: study.studyId, accessionNo: study.accessionNo, status: "scheduled", scheduledAt: SLOT.toISOString(),
      })]);
      const history = await db.select().from(resourceStatusHistory)
        .where(and(eq(resourceStatusHistory.resourceId, fx.devices.ct!), eq(resourceStatusHistory.toStatus, "down")));
      expect(history.map((h) => h.reason)).toEqual(["tube arcing — service engineer called"]);
      const changed = await db.select().from(events)
        .where(and(eq(events.name, "resource.status_changed"), eq(events.correlationId, fx.devices.ct!)));
      expect(changed.map((c) => (c.payload as { reason: string }).reason)).toEqual(["tube arcing — service engineer called"]);

      const back = await withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, { status: "available", reason: "tube replaced" }));
      expect(back.studiesToMove).toEqual([]);
    });

    it("a QA block is lifted only by the QA register, and a retired machine stays retired", async () => {
      await withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, { status: "qa_blocked", reason: "phantom failed" }));
      const e = await refusal(withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, { status: "available", reason: "looks fine" })));
      expect(e.code).toBe("device_status_locked");
      expect(e.message).toContain("QA");

      await withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.mri!, { status: "retired", reason: "sold" }));
      const r = await refusal(withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.mri!, { status: "available", reason: "bought back" })));
      expect(r.code).toBe("device_status_locked");
      expect((await refusal(withTx(db, (tx) => editImagingDevice(tx, admin, fx.devices.mri!, { name: "x" })))).code)
        .toBe("device_status_locked");
    });

    it("in_use is not a status a person sets", async () => {
      const e = await refusal(withTx(db, (tx) => setImagingDeviceStatus(tx, admin, fx.devices.ct!, { status: "in_use", reason: "x" })));
      expect(e.code).toBe("invalid_device");
    });
  });

  describe("a resource that is not an imaging machine is untouched", () => {
    it("refuses a room through every door, and the room's row does not move", async () => {
      /** A room TAGGED with a modality — the kind check, not the missing attribute, must refuse it. */
      await db.update(resources).set({ attributes: { modality: "ct" } }).where(eq(resources.id, roomId));
      const [before] = await db.select().from(resources).where(eq(resources.id, roomId));
      expect((await refusal(withTx(db, (tx) => setImagingDeviceStatus(tx, admin, roomId, { status: "retired", reason: "x" })))).code)
        .toBe("unknown_device");
      expect((await refusal(withTx(db, (tx) => editImagingDevice(tx, admin, roomId, { name: "renamed" })))).code)
        .toBe("unknown_device");
      const [after] = await db.select().from(resources).where(eq(resources.id, roomId));
      expect(after).toEqual(before);
    });
  });
});
