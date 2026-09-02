import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { imagingDefinitions, phiAccessLog, resources } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { addMachine, createRegistration } from "../pcpndt";
import { cancelStudy, scheduleStudy } from "./schedule";
import { MWL_READ, istDayWindow, mwlExport, renderMwlDump, toPersonName } from "./mwl";
import { mintStudyInstanceUid } from "./uid";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18b T1 — the modality worklist export. The assertion book's three: exactly the day's
 * studies in the three statuses (mutant: drop the status filter), a Form F study withheld from an
 * unregistered machine (mutant: skip `assertMachineRegistered`'s reader), one PHI row per patient.
 */
describe("the modality worklist export (18b T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let bridge: Actor;
  let incharge: Actor;
  let nobody: Actor;
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T03:00:00.000Z");
  /** 09:00 UTC is 14:30 IST on the same day. */
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const NEXT_DAY_SLOT = new Date("2026-08-31T20:00:00.000Z"); // 01:30 IST on 1 September
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "R", menu: [],
      permissions: [MWL_READ, "pcpndt.registrations.manage", "pcpndt.registrations.read"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const role of ["modality_bridge", "pcpndt_incharge", "nobody"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "modality_bridge", MWL_READ);
    await grantPermissionToRole(db, registry, "pcpndt_incharge", "pcpndt.registrations.manage");
    await grantPermissionToRole(db, registry, "pcpndt_incharge", "pcpndt.registrations.read");
    ({ actor: bridge } = await mkUser(db, "bridge.one", ["modality_bridge"]));
    ({ actor: incharge } = await mkUser(db, "dr.incharge", ["pcpndt_incharge"]));
    ({ actor: nobody } = await mkUser(db, "no.body", ["nobody"]));
    // The devices carry a modality from the fixture; the export needs an AE title too.
    await db.update(resources).set({ attributes: { modality: "usg", aeTitle: "USG1" } })
      .where(eq(resources.id, fx.devices["usg"]!));
    await db.update(resources).set({ attributes: { modality: "ct", aeTitle: "CT1" } })
      .where(eq(resources.id, fx.devices["ct"]!));
  });
  afterEach(() => { fx.unregister(); });

  const place = async (code = "USG-ABDO") => {
    seq += 1;
    return await placeAndCreateStudy(db, fx, code, `mwl${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };
  const schedule = async (studyId: string, deviceKey: string, at: Date) =>
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: at }));

  it("the IST day is a half-open UTC window starting at 18:30 the evening before", () => {
    const { start, end } = istDayWindow("2026-08-31");
    expect(start.toISOString()).toBe("2026-08-30T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(() => istDayWindow("31-08-2026")).toThrow(/calendar day/);
  });

  it("holds exactly the day's studies in the three statuses — a cancelled one and tomorrow's are not on it", async () => {
    const kept = await place();
    await schedule(kept.studyId, "usg", SLOT);
    const cancelled = await place();
    await schedule(cancelled.studyId, "usg", new Date(SLOT.getTime() + 3_600_000));
    await withTx(db, (tx) => cancelStudy(tx, fx.radiologist, fx.decls, { studyId: cancelled.studyId, reason: "left" }));
    const tomorrow = await place();
    await schedule(tomorrow.studyId, "usg", NEXT_DAY_SLOT);

    const out = await mwlExport(db, bridge, { date: DAY, deviceResourceId: fx.devices["usg"]! });
    expect(out.withheld).toBe(0);
    expect(out.rows.map((r) => r.studyId)).toEqual([kept.studyId]);
    const row = out.rows[0]!;
    expect(row.accessionNo).toBe(kept.accessionNo);
    expect(row.studyInstanceUid).toBe(mintStudyInstanceUid(kept.studyId));
    expect(row.aeTitle).toBe("USG1");
    expect(row.modality).toBe("US");
    expect(row.scheduledDate).toBe("20260831");
    expect(row.scheduledTime).toBe("143000");
    expect(row.patient).toEqual({ uhid: "HMS-00000001-5", personName: "Devi^Asha", birthDate: "19960101", sex: "F" });
    expect(row.procedureCode).toBe("USG-ABDO");
    expect(row.priority).toBe("ROUTINE");

    // Tomorrow's is on tomorrow's list, and a pull is the same list twice (D1).
    const next = await mwlExport(db, bridge, { date: "2026-09-01" });
    expect(next.rows.map((r) => r.studyId)).toEqual([tomorrow.studyId]);
    expect(await mwlExport(db, bridge, { date: DAY })).toEqual(out);
  });

  it("a device without an AE title is simply absent — not an error, and not a withheld row", async () => {
    await db.update(resources).set({ attributes: { modality: "ct" } }).where(eq(resources.id, fx.devices["ct"]!));
    const ct = await place("CT-HEAD");
    await schedule(ct.studyId, "ct", SLOT);
    const usg = await place();
    await schedule(usg.studyId, "usg", SLOT);
    const out = await mwlExport(db, bridge, { date: DAY });
    expect(out.rows.map((r) => r.studyId)).toEqual([usg.studyId]);
    expect(out.withheld).toBe(0);
  });

  it("D2 — a Form F study is withheld from a machine that is not on an active §19 registration, and offered once it is", async () => {
    await db.update(imagingDefinitions).set({
      body: { types: [studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg", body_part: "obstetric", pcpndt_applicable: true })] },
    }).where(eq(imagingDefinitions.kind, "study_types"));
    const study = await place();
    await schedule(study.studyId, "usg", SLOT);

    const before = await mwlExport(db, bridge, { date: DAY });
    expect(before.rows).toEqual([]);
    expect(before.withheld).toBe(1);

    const { registrationId } = await withTx(db, (tx) => createRegistration(tx, incharge, {
      site: "Main", registrationNo: "PNDT/MH/2026/0001", validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => addMachine(tx, incharge, {
      registrationId, deviceResourceId: fx.devices["usg"]!, make: "GE", model: "Voluson", serial: "SN-1",
    }));
    const after = await mwlExport(db, bridge, { date: DAY });
    expect(after.rows.map((r) => r.studyId)).toEqual([study.studyId]);
    expect(after.withheld).toBe(0);
  });

  it("writes one `imaging.worklist` PHI row per patient per pull, and refuses a reader without the permission", async () => {
    const a = await place();
    await schedule(a.studyId, "usg", SLOT);
    const b = await place("XR-CHEST");
    await db.update(resources).set({ attributes: { modality: "xray", aeTitle: "DR1" } }).where(eq(resources.id, fx.devices["xray"]!));
    await schedule(b.studyId, "xray", SLOT);
    await mwlExport(db, bridge, { date: DAY });
    const log = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "imaging.worklist"));
    expect(log).toHaveLength(1); // one patient, two studies
    expect(log[0]!.patientId).toBe(fx.patientId);
    expect(log[0]!.actorId).toBe(bridge.id);

    await expect(mwlExport(db, nobody, { date: DAY })).rejects.toMatchObject({ code: "forbidden" });
    await expect(mwlExport(db, { type: "system", id: "cron" } as Actor, { date: DAY })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("renders the dcmtk dump a bridge feeds to dump2dcm, and PN puts the last token in the family component", () => {
    expect(toPersonName("Asha Devi")).toBe("Devi^Asha");
    expect(toPersonName("Ramesh Kumar Yadav")).toBe("Yadav^Ramesh Kumar");
    expect(toPersonName("Mononym")).toBe("Mononym");
    expect(toPersonName("Ev^il=Na\\me")).toBe("me^Ev il Na");
    const dump = renderMwlDump({
      studyId: "s1", accessionNo: "X2608310001", studyInstanceUid: "2.25.1", status: "scheduled", priority: "STAT",
      patient: { uhid: "HMS-1", personName: "Devi^Asha", birthDate: "19960101", sex: "F" },
      referringPhysician: "dr-consultant", procedureCode: "USG-ABDO", modality: "US",
      deviceResourceId: "d1", aeTitle: "USG1", scheduledDate: "20260831", scheduledTime: "143000",
    });
    for (const line of [
      "(0008,0050) SH [X2608310001]", "(0010,0010) PN [Devi^Asha]", "(0010,0020) LO [HMS-1]",
      "(0010,0030) DA [19960101]", "(0010,0040) CS [F]", "(0020,000d) UI [2.25.1]",
      "(0040,1003) CS [STAT]", "    (0008,0060) CS [US]", "    (0040,0001) AE [USG1]",
      "    (0040,0002) DA [20260831]", "    (0040,0003) TM [143000]", "    (0040,0009) SH [X2608310001]",
    ]) {
      expect(dump).toContain(line);
    }
  });
});
