import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { patients, phiAccessLog, resources } from "../../kernel/db/schema";
import { createResource } from "../../kernel/resources/registry";
import { withTx } from "../../kernel/db/client";
import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
import { scheduleStudy } from "./schedule";
import { imagingDevices } from "./devices";
import { bedsideStudiesFor, portableRound } from "./bedside";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS2b P2 + P3 — the machine list a counter picks from, and the portable round.
 *
 * The fixture is a working hospital (`setupRadiologyFixture`): DEV-XRAY and DEV-CT licensed,
 * DEV-USG and DEV-MRI needing no licence. Each case adds what it is about — a portable machine, a
 * bed, a device outside the imaging vocabulary.
 */
describe("the imaging machines and the portable round (18-S RS2b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let trolley: string;
  let portableXray: string;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  const addDevice = async (code: string, attributes: Record<string, unknown>) =>
    (await withTx(db, (tx) => createResource(tx, fx.radiographer, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code, name: `${code} machine`, attributes,
    }))).resourceId;

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    trolley = await addDevice("USG-P1", { modality: "usg", portable: true });
    /** No licence filed — the state the seeded PX-1 is in until the RSO files one. */
    portableXray = await addDevice("PX-1", { modality: "xray", portable: true });
  });
  afterEach(() => { fx.unregister(); });

  describe("GET /radiology/devices — imagingDevices", () => {
    it("lists every imaging machine with portable read from attributes and AERB licensed-now", async () => {
      const rows = await imagingDevices(db, DAY);
      const by = Object.fromEntries(rows.map((r) => [r.code, r]));

      expect(rows.map((r) => r.code)).toEqual(["DEV-CT", "DEV-MRI", "DEV-USG", "DEV-XRAY", "PX-1", "USG-P1"]);
      expect(by["USG-P1"]).toMatchObject({
        id: trolley, modality: "usg", portable: true, ionising: false, licensedNow: null, status: "available",
      });
      /** Ionising, portable, and NOT licensed — the row the counter must see marked. */
      expect(by["PX-1"]).toMatchObject({ id: portableXray, portable: true, ionising: true, licensedNow: false });
      expect(by["DEV-XRAY"]).toMatchObject({ portable: false, ionising: true, licensedNow: true });
      expect(by["DEV-CT"]).toMatchObject({ portable: false, ionising: true, licensedNow: true });
      expect(by["DEV-MRI"]).toMatchObject({ portable: false, ionising: false, licensedNow: null, room: null });
    });

    it("leaves out a resource that is not an imaging machine, one outside the vocabulary, and a retired one", async () => {
      await db.insert(resources).values({
        id: newId(), kind: "bed", code: "B-12", name: "bed 12", status: "available",
        attributes: { modality: "xray" }, createdBy: "t", updatedBy: "t",
      });
      await addDevice("CATH-1", { modality: "cathlab" });
      const retired = await addDevice("XR-OLD", { modality: "xray" });
      await db.update(resources).set({ status: "retired" }).where(eq(resources.id, retired));

      const codes = (await imagingDevices(db, DAY)).map((r) => r.code);
      expect(codes).not.toContain("B-12");
      expect(codes).not.toContain("CATH-1");
      expect(codes).not.toContain("XR-OLD");
      expect(codes).toHaveLength(6);
    });

    it("names the room a machine hangs off", async () => {
      const [room] = await db.insert(resources).values({
        id: newId(), kind: "room", code: "R-2", name: "Room 2", status: "available",
        createdBy: "t", updatedBy: "t",
      }).returning();
      await db.update(resources).set({ parentId: room!.id }).where(eq(resources.id, fx.devices.ct!));
      const ct = (await imagingDevices(db, DAY)).find((r) => r.code === "DEV-CT");
      expect(ct?.room).toBe("Room 2");
    });
  });

  describe("GET /radiology/portable/round — portableRound", () => {
    /** One USG per 25 fictional hours (the duplicate window is 24 h), booked at SLOT + seq hours. */
    const bookUsg = async (deviceResourceId: string, bedsideLocation?: string) => {
      seq += 1;
      const { studyId, accessionNo } = await placeAndCreateStudy(
        db, fx, "USG-ABDO", `r${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
      );
      await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId, deviceResourceId, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
        ...(bedsideLocation === undefined ? {} : { bedsideLocation }),
      }));
      return { studyId, accessionNo };
    };

    it("lists only studies with a bedside location, sorted by place then slot", async () => {
      const w5 = await bookUsg(trolley, "Ward 5 · bed 1");
      const inDept = await bookUsg(trolley);
      const w3b12 = await bookUsg(trolley, "Ward 3 · bed 12");
      const w3b4 = await bookUsg(trolley, "Ward 3 · bed 4");
      const onFixed = await bookUsg(fx.devices.usg!);

      const rows = await portableRound(db, fx.radiographer);

      expect(rows.map((r) => r.bedsideLocation)).toEqual(["Ward 3 · bed 12", "Ward 3 · bed 4", "Ward 5 · bed 1"]);
      expect(rows.map((r) => r.studyId)).toEqual([w3b12.studyId, w3b4.studyId, w5.studyId]);
      expect(rows.map((r) => r.studyId)).not.toContain(inDept.studyId);
      expect(rows.map((r) => r.studyId)).not.toContain(onFixed.studyId);
      expect(rows[0]).toMatchObject({
        accessionNo: w3b12.accessionNo, studyTypeCode: "USG-ABDO", status: "scheduled", priority: "routine",
        deviceResourceId: trolley, deviceCode: "USG-P1", patientName: "Asha Devi", restricted: false,
      });
    });

    it("shows a confidential patient's alias and logs one PHI row per patient", async () => {
      await db.update(patients).set({ isConfidential: true, alias: "Priya M." })
        .where(eq(patients.id, fx.patientId));
      await bookUsg(trolley, "Ward 3 · bed 12");
      await bookUsg(trolley, "Ward 3 · bed 4");

      const rows = await portableRound(db, fx.radiographer);

      expect(rows.map((r) => r.patientName)).toEqual(["Priya M.", "Priya M."]);
      expect(JSON.stringify(rows)).not.toContain("Asha Devi");
      const log = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "imaging.worklist"));
      expect(log.filter((l) => l.patientId === fx.patientId && l.reason?.startsWith("portable round"))).toHaveLength(1);
    });

    it("refuses a system actor — the round names patients", async () => {
      await expect(portableRound(db, { type: "system", id: "x" })).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("bedsideStudiesFor — the IPD seam", () => {
    it("returns a ward's bedside studies by case-insensitive prefix, in the round's row shape", async () => {
      const bookAt = async (bedsideLocation: string) => {
        seq += 1;
        const { studyId } = await placeAndCreateStudy(
          db, fx, "USG-ABDO", `s${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
        );
        await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
          studyId, deviceResourceId: trolley, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000), bedsideLocation,
        }));
        return studyId;
      };
      const a = await bookAt("Ward 3 · bed 12");
      await bookAt("Ward 5 · bed 1");
      /** `%` is a character in a ward name, not a wildcard. */
      await bookAt("Ward 30% · bed 2");

      const rows = await bedsideStudiesFor(db, fx.radiographer, "ward 3");
      expect(rows.map((r) => r.studyId)).toEqual([a]);
      expect(Object.keys(rows[0]!).sort()).toEqual(Object.keys((await portableRound(db, fx.radiographer))[0]!).sort());
      expect(await bedsideStudiesFor(db, fx.radiographer, "Ward 30%")).toHaveLength(1);
      expect(await bedsideStudiesFor(db, fx.radiographer, "Ward _")).toHaveLength(0);
    });
  });
});
