import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { resourceStatusHistory, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { changeResourceStatus, createResource } from "../../kernel/resources/registry";
import { RADIOLOGY_RESOURCE_KINDS } from "../radiology";
import { aerbManifest } from "./manifest";
import { qaDueList, recordQa, sweepOverdueQa } from "./qa";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T3 — **an overdue QA blocks the machine; only a passing QA lifts it.**
 *
 * 18c's D4 said an overdue QA is not a block; RS11 reverses it (owner ruling 5). The mutants:
 * "the sweep writes nothing" (the calendar goes red and the CT keeps booking), and "a pass of one
 * test clears the machine while another is still overdue".
 */
describe("QA overdue → qa_blocked (18-S RS11 T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let ct: string;
  let xr: string;
  const NOW = new Date("2026-09-29T06:00:00Z"); // 11:30 IST, 29 Sep 2026

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "radiation_safety_officer");
    for (const p of aerbManifest.permissions) await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    ({ actor: rso } = await mkUser(db, "rso.mondal", ["radiation_safety_officer"]));
    ct = (await withTx(db, (tx) => createResource(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "CT-1", name: "CT scanner", attributes: { modality: "ct" },
    }))).resourceId;
    xr = (await withTx(db, (tx) => createResource(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "XR-1", name: "X-ray room 1", attributes: { modality: "xray" },
    }))).resourceId;
  });

  const qa = (deviceResourceId: string, over: Partial<Parameters<typeof recordQa>[3]> = {}) =>
    withTx(db, (tx) => recordQa(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      deviceResourceId, qaType: "Periodic QA (agency)", result: "pass",
      performedBy: "QA agency", performedOn: "2024-09-01", nextDueOn: null, ...over,
    }, { now: NOW }));

  const status = async (id: string): Promise<string> =>
    (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;

  it("due date = the record's next-due date, else performed + 2 years (ruling 5)", async () => {
    await qa(ct, { performedOn: "2024-09-01" });
    await qa(xr, { performedOn: "2026-01-10", nextDueOn: "2026-10-15" });
    const rows = await qaDueList(db, { onDate: "2026-09-29" });
    const byCode = Object.fromEntries(rows.map((r) => [r.deviceCode, r]));
    expect(byCode["CT-1"]).toMatchObject({ dueOn: "2026-09-01", defaultInterval: true, state: "overdue", daysOverdue: 28 });
    expect(byCode["XR-1"]).toMatchObject({ dueOn: "2026-10-15", defaultInterval: false, state: "due" });
  });

  it("the sweep puts an overdue AVAILABLE machine into qa_blocked through the registry writer", async () => {
    await qa(ct, { performedOn: "2024-09-01" });
    await qa(xr, { performedOn: "2026-01-10", nextDueOn: "2027-01-10" });
    const out = await sweepOverdueQa(db, RADIOLOGY_RESOURCE_KINDS, NOW);
    expect(out.blocked.map((b) => b.deviceCode)).toEqual(["CT-1"]);
    expect(await status(ct)).toBe("qa_blocked");
    expect(await status(xr)).toBe("available");
    const h = (await db.select().from(resourceStatusHistory).where(eq(resourceStatusHistory.resourceId, ct)))
      .find((x) => x.toStatus === "qa_blocked");
    expect(h!.actorId).toBe("aerb-qa-overdue-sweep");
    expect(h!.reason).toContain("QA overdue: Periodic QA (agency) (due 2026-09-01)");
    /** Idempotent: a second run touches nothing. */
    expect((await sweepOverdueQa(db, RADIOLOGY_RESOURCE_KINDS, NOW)).blocked).toHaveLength(0);
  });

  it("never stops a machine that is down or in maintenance (somebody else's status)", async () => {
    await qa(ct, { performedOn: "2024-09-01" });
    await withTx(db, (tx) => changeResourceStatus(tx, rso, RADIOLOGY_RESOURCE_KINDS, ct, "down", { reason: "tube arcing" }));
    const out = await sweepOverdueQa(db, RADIOLOGY_RESOURCE_KINDS, NOW);
    expect(out.blocked).toHaveLength(0);
    expect(out.skipped).toEqual([{ deviceResourceId: ct, deviceCode: "CT-1", status: "down" }]);
    expect(await status(ct)).toBe("down");
  });

  it("only a passing QA lifts it — and not while ANOTHER test on the machine is still overdue", async () => {
    await qa(ct, { performedOn: "2024-09-01" });
    await qa(ct, { qaType: "Radiation survey", performedOn: "2024-08-01" });
    await sweepOverdueQa(db, RADIOLOGY_RESOURCE_KINDS, NOW);
    expect(await status(ct)).toBe("qa_blocked");

    const first = await qa(ct, { performedOn: "2026-09-28" });
    expect(first.releasedRecordId).toBeNull();
    expect(first.stillOverdue).toEqual(["Radiation survey"]);
    expect(await status(ct)).toBe("qa_blocked");

    await qa(ct, { qaType: "Radiation survey", performedOn: "2026-09-28" });
    expect(await status(ct)).toBe("available");
  });
});
