import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import { getApprovalType } from "../src/kernel/approvals/types";
import { withTx } from "../src/kernel/db/client";
import { listDefinitions } from "../src/kernel/workflow/definitions";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPE_KEYS } from "../src/modules/ipd";
import { formatGoLiveSetup, ipdGoLiveSetup } from "../scripts/ipd-golive-setup";
import type { Db } from "../src/kernel/db/client";

/** #798 — the go-live day setup: plan without --confirm, approval types + a DRAFT workflow with it, "already" on a rerun. */
describe("ipd-golive-setup", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  const counts = async (): Promise<string> => JSON.stringify((await db.execute(sql`select
    (select count(*) from events) as e, (select count(*) from approval_types) as t, (select count(*) from workflow_definitions) as d,
    (select count(*) from sod_pairs) as s, (select count(*) from tariff_versions) as v, (select count(*) from role_assignments) as r`)).rows[0]);
  const ALL = Object.values(IPD_APPROVAL_TYPE_KEYS).sort();

  it("without --confirm: prints the plan and writes nothing", async () => {
    const before = await counts();
    const r = await ipdGoLiveSetup(db, { confirm: false });
    expect(r).toMatchObject({ mode: "plan", approvalTypesPresent: [], workflow: null });
    if (r.mode !== "plan") throw new Error("unreachable");
    expect([...r.approvalTypesMissing].sort()).toEqual(ALL);
    expect(formatGoLiveSetup(r)[0]).toMatch(/PLAN \(nothing written; add --confirm/);
    expect(await counts()).toBe(before);
  });

  it("with --confirm: registers the approval types and DRAFTS the workflow (never active); no tariff, no role; a rerun says already", async () => {
    const first = await ipdGoLiveSetup(db, { confirm: true });
    if (first.mode !== "applied") throw new Error("expected applied");
    expect([...first.approvalTypes.registered].sort()).toEqual(ALL);
    for (const k of ALL) expect(await withTx(db, (tx) => getApprovalType(tx, k))).toBeTruthy();
    expect(first.workflow.action).toBe("drafted");
    const defs = await listDefinitions(db, ADMISSION_WORKFLOW_DEF_KEY);
    expect(defs.map((d) => d.status)).toEqual(["draft"]);
    expect(defs[0]!.activatedBy).toBeNull();
    const after = JSON.parse(await counts()) as Record<string, string>;
    expect({ v: after.v, r: after.r }).toEqual({ v: "0", r: "0" });

    const before = await counts();
    const second = await ipdGoLiveSetup(db, { confirm: true });
    if (second.mode !== "applied") throw new Error("expected applied");
    expect(second.approvalTypes.registered).toEqual([]);
    expect(second.workflow).toMatchObject({ action: "already", definitionId: first.workflow.definitionId, status: "draft" });
    expect(await counts()).toBe(before);

    const plan = await ipdGoLiveSetup(db, { confirm: false });
    expect(plan).toMatchObject({ mode: "plan", approvalTypesMissing: [], workflow: { status: "draft" } });
  });

  it("is not a seed and is not in deploy.sh (deploy runs every seed)", () => {
    const deploy = readFileSync(resolve(__dirname, "..", "..", "..", "docker", "prod", "deploy.sh"), "utf8");
    expect(deploy).not.toMatch(/ipd-golive-setup/);
    const pkg = readFileSync(resolve(__dirname, "..", "package.json"), "utf8");
    expect(pkg).not.toMatch(/ipd-golive-setup/);
  });
});
