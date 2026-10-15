import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { seedLabDeskBase } from "../../../../test/helpers/lab";
import { openOpdVisit } from "../../../../test/helpers/opd";
import { opdEncounters } from "../../../kernel/db/schema";
import { registerEncounterResolver } from "../../../kernel/episodes/encounter-resolvers";
import { deskFind } from "../../lab";
import { getEncounter } from "../../opd";
import { OrderingController } from "../ordering.controller";
import type { LabDeskFixture } from "../../../../test/helpers/lab";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #609, spec SPEC-consult-tests-search-2026-10-10 (owner APPROVED 2026-10-10).
 * The server half of "typing hb or cbc lists catalogue rows; picking one shows on the visit and on the
 * lab desk for that patient", and "a name not in the catalogue offers nothing to add".
 *
 * The phone's Tests tab searches `GET /ordering/tests` (decision 0067's one test list: the LIMS
 * catalogue plus imaging and the outside tests). What the doctor picks is written to the visit's
 * advised tests with the row's service id and code, and the lab desk reads exactly that.
 */
describe("#609 — the test list the phone searches, and the lab desk that reads the pick", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  const AT = new Date("2026-08-29T05:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });
  });
  afterEach(() => { fx.unregister(); });

  const ctl = (): OrderingController => new OrderingController(db, { collect: () => [] } as never);
  const search = async (q: string) => (await ctl().tests(q)) as { items: { serviceId: string; code: string; name: string; department: string }[] };

  it("\"hb\" and \"cbc\" list lab catalogue rows by code or name; a name not in the catalogue lists nothing", async () => {
    const hb = (await search("hb")).items.filter((r) => r.department === "lab");
    expect(hb.length).toBeGreaterThan(0);
    for (const r of hb) expect(`${r.code} ${r.name}`.toLowerCase()).toContain("hb");
    expect((await search("cbc")).items).toContainEqual(expect.objectContaining({ code: "CBC", department: "lab" }));
    expect((await search("zzqx not a test")).items).toEqual([]);
  });

  it("the picked row, saved as the visit's advised test, shows on the lab desk under that patient's visit", async () => {
    const cbc = (await search("cbc")).items.find((r) => r.code === "CBC")!;
    const v = await openOpdVisit(db, {
      clerk: fx.desk.actor, patientId: fx.patientId, departmentId: fx.labDepartmentId, doctorId: fx.pathologist.doctorId,
    }, AT);
    // Exactly what the phone sends on the consult note: the row's identity, the name it showed.
    await db.update(opdEncounters).set({ advisedTests: [{ serviceId: cbc.serviceId, code: cbc.code, name: cbc.name, pricePaise: 0 }] })
      .where(eq(opdEncounters.id, v.encounterId));
    const visitNo = (await getEncounter(db, v.encounterId))!.visitNo;

    const hits = await deskFind(db, fx.desk.actor, visitNo, fx.serviceDate);
    const advised = hits[0]?.visit?.advised ?? [];
    expect(advised).toHaveLength(1);
    expect(advised[0]).toMatchObject({ serviceId: cbc.serviceId, code: "CBC", alreadyOrderedItemId: null });
    // The desk recognises it as an orderable lab test (container, specimen) — not an unknown line.
    expect(advised[0]!.orderable).not.toBeNull();
  });
});
