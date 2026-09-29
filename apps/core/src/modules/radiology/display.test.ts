import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingStudies, patients, phiAccessLog, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { checkIn } from "./checkin";
import { hallBoard } from "./display";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS3 — **THE WAITING-HALL BOARD.** Per machine: who is on the table now and the next
 * three who are here and waiting, by TOKEN (the accession on the slip) and first name + initial
 * only (DPDP). A confidential patient is a token and nothing else. A machine that is down or
 * unlicensed says so, so the hall is told "the desk will call" rather than left waiting.
 */
describe("the imaging hall board (18-S RS3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  /** 11:30 IST. */
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW, unlicensedModalities: ["xray"] });
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const arrive = async (code: string, deviceKey: string, slot: Date) => {
    seq += 1;
    const s = await placeAndCreateStudy(db, fx, code, `d${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: slot }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: NOW }));
    return s;
  };
  const room = async (deviceKey: string) =>
    (await hallBoard(db, NOW)).rooms.find((r) => r.deviceResourceId === fx.devices[deviceKey]);

  it("shows the checked-in patient as NEXT by token, first name and initial — never the full name", async () => {
    const s = await arrive("USG-ABDO", "usg", new Date("2026-08-31T07:00:00.000Z"));
    const usg = await room("usg");
    expect(usg).toMatchObject({ code: "DEV-USG", closed: null, now: null });
    expect(usg!.next).toEqual([{ token: s.accessionNo, name: "Asha D." }]);
    expect(JSON.stringify(await hallBoard(db, NOW))).not.toContain("Asha Devi");
  });

  it("NOW is the study on the table; NEXT is at most three, STAT first", async () => {
    const onTable = await arrive("USG-ABDO", "usg", new Date("2026-08-31T06:30:00.000Z"));
    await db.update(imagingStudies).set({ status: "in_acquisition" }).where(eq(imagingStudies.id, onTable.studyId));
    const waiting = [];
    for (const h of ["07", "08", "09", "10"]) waiting.push(await arrive("USG-ABDO", "usg", new Date(`2026-08-31T${h}:00:00.000Z`)));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, waiting[3]!.studyId));

    const usg = await room("usg");
    expect(usg!.now).toEqual({ token: onTable.accessionNo, name: "Asha D." });
    expect(usg!.next.map((n) => n.token)).toEqual([waiting[3]!.accessionNo, waiting[0]!.accessionNo, waiting[1]!.accessionNo]);
  });

  it("a confidential patient is a token and no name", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient R-7" }).where(eq(patients.id, fx.patientId));
    const s = await arrive("USG-ABDO", "usg", new Date("2026-08-31T07:00:00.000Z"));
    expect((await room("usg"))!.next).toEqual([{ token: s.accessionNo, name: null }]);
  });

  it("a study checked in on another day is not on today's board", async () => {
    await arrive("USG-ABDO", "usg", new Date("2026-09-01T07:00:00.000Z"));
    expect((await room("usg"))!.next).toEqual([]);
  });

  it("a down machine is `closed: down`; an ionising machine with no AERB licence is `closed: not_licensed`", async () => {
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.usg!));
    expect((await room("usg"))!.closed).toBe("down");
    expect((await room("xray"))!.closed).toBe("not_licensed");
    expect((await room("ct"))!.closed).toBeNull();
  });

  it("a hall TV writes no PHI access row — it discloses a token and a first name, polled every few seconds", async () => {
    await arrive("USG-ABDO", "usg", new Date("2026-08-31T07:00:00.000Z"));
    const before = (await db.select().from(phiAccessLog)).length;
    await hallBoard(db, NOW);
    expect((await db.select().from(phiAccessLog)).length).toBe(before);
  });
});
