import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { aerbManifest } from "./manifest";
import { issueBadge, recordBadgeRead } from "./badges";
import {
  activeDeclarations, declarePregnancy, endPregnancyDeclaration, foetalShare, pregnancyDeclarations,
} from "./pregnancy";
import { attentionList } from "./attention";
import { AerbError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T4 — a declared-pregnant radiation worker.
 *
 * The mutants: "compare her reads with the ordinary investigation level" (a 0.9 mSv quarter is
 * nothing for a radiographer and 90 % of the foetal limit for her), and "count the whole quarter"
 * (a declaration two months into a quarter owes only the days after it).
 */
describe("pregnant radiation worker declarations (18-S RS11 T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let rina: string;
  let badgeId: string;
  const NOW = new Date("2026-07-20T06:00:00Z");

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
    rina = (await mkUser(db, "Rina Devi", [])).id;
    ({ badgeId } = await withTx(db, (tx) => issueBadge(tx, rso, { userId: rina, badgeNo: "JH-40119", issuedOn: "2026-01-01" })));
  });

  const declare = (over: Partial<Parameters<typeof declarePregnancy>[2]> = {}) =>
    withTx(db, (tx) => declarePregnancy(tx, rso, { userId: rina, declaredOn: "2026-05-01", expectedOn: "2026-12-20", ...over }, { now: NOW }));

  it("pro-rates a straddling read by the days worn after the declaration", () => {
    const share = foetalShare({ periodStart: "2026-04-01", periodEnd: "2026-06-30", hp10: 0.91 }, { declaredOn: "2026-05-01", endedOn: null });
    expect(share).toBeCloseTo(0.91 * 61 / 91, 6);
    expect(foetalShare({ periodStart: "2026-01-01", periodEnd: "2026-03-31", hp10: 5 }, { declaredOn: "2026-05-01", endedOn: null })).toBe(0);
  });

  it("a read after the declaration is compared with the 1 mSv foetal limit, not the investigation level", async () => {
    await declare();
    const out = await withTx(db, (tx) => recordBadgeRead(tx, rso, {
      badgeId, periodStart: "2026-05-01", periodEnd: "2026-07-15", hp10Msv: 1.1, reportedOn: "2026-07-18",
    }));
    /** 1.1 mSv over 76 days is far below the ~2.5 mSv pro-rated investigation level … */
    expect(out.investigation).toBe(false);
    /** … and over her foetal limit. */
    expect(out.overFoetalLimit).toBe(true);
    const [row] = await pregnancyDeclarations(db, { onDate: "2026-07-20" });
    expect(row).toMatchObject({ userName: "Rina Devi", active: true, foetalDoseMsv: "1.100", overFoetalLimit: true });
  });

  it("stands on the RSO's list — reassign or restrict — until ended", async () => {
    const { declarationId } = await declare();
    const list = await attentionList(db, rso, { now: NOW });
    const mine = list.find((r) => r.view === "pregnancy")!;
    expect(mine.subject).toBe("Rina Devi");
    expect(mine.detail).toContain("reassign or restrict");
    expect(await activeDeclarations(db, { onDate: "2026-07-20" })).toHaveLength(1);

    await withTx(db, (tx) => endPregnancyDeclaration(tx, rso, declarationId, { onDate: "2026-07-20", reason: "maternity leave began" }));
    expect(await activeDeclarations(db, { onDate: "2026-07-20" })).toHaveLength(0);
    expect((await attentionList(db, rso, { now: NOW })).some((r) => r.view === "pregnancy")).toBe(false);
  });

  it("one active declaration per worker; a future declaration is refused", async () => {
    await declare();
    const e = await declare().then(() => null, (x: unknown) => x);
    expect((e as AerbError).code).toBe("declaration_active");
    const f = await declare({ userId: (await mkUser(db, "Other", [])).id, declaredOn: "2026-08-01" }).then(() => null, (x: unknown) => x);
    expect((f as AerbError).code).toBe("invalid_validity");
  });
});
