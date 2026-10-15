import { createDb, withTx } from "../src/kernel/db/client";
import { createDraft, listDefinitions } from "../src/kernel/workflow/definitions";
import { ER_EPISODE_WORKFLOW_DEF_KEY, ER_SATELLITE_STORE_CODE, erEpisodeWorkflowDefinition } from "../src/modules/emergency";
import { createStore, findStoreByCode } from "../src/modules/materials";
import { createDraftVersion, createService, resolveActiveTariffVersion, setTariffItem, updateService } from "../src/modules/tariff";
import { services, tariffVersions } from "../src/kernel/db/schema";
import { inArray } from "drizzle-orm";
import { ER_UAT_SAMPLE_MARKER, ER_UAT_SAMPLE_RATES, ER_UAT_SAMPLE_TARIFF_NOTE } from "./fixtures/er-uat-sample-tariff";
import { assertStagingOnly, grantTestingRoles } from "./stage-ipd-setup";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { StageIpdReport } from "./stage-ipd-setup";

/**
 * `node dist/scripts/stage-er-setup.js` — inside the UAT api container ONLY. The ER twin of `stage-ipd-setup` (ER lane 4,
 * #811: "is the ER-SAT store seeded somewhere for go-live?" — it was not).
 *
 * ═══ STAGING-ONLY: MAKE THE ER TESTABLE END TO END WITHOUT BYPASSING ANY APPROVAL ═══
 *
 * Idempotent: every step checks first and reports "already" on a rerun.
 *
 *  a. DRAFTS the `er_episode` workflow definition as a system drafter and stops there. Approval (medical superintendent +
 *     owner) and activation (the owner) stay with them: `POST /workflow/definitions/:id/approve` and `/activate`.
 *  b. Creates the ER satellite store (`ER-SAT`: the crash cart and the emergency drugs the ER issues from) when no store
 *     has that code — an EMPTY store. Its stock arrives by a person's transfer from the main store (materials), never by
 *     this script.
 *  c. Grants the casualty nurse role (`er_nurse`) to the one all-roles test account (the IPD script's rule, reused).
 *  d. (ER lane 6, #813) Drafts the UAT SAMPLE ER tariff (`fixtures/er-uat-sample-tariff.ts`): its four services created
 *     INACTIVE and a DRAFT tariff version copied from the one in force with their rates. Submit → the owner's approval →
 *     activation → switching the services on stay people's acts (0076: go-live waits for the incumbent's real rates).
 *
 * PRODUCTION GO-LIVE IS NOT THIS SCRIPT: there the ER-SAT store is created by the materials head (`POST
 * /materials/stores`), stocked by transfer, and the workflow approved and activated by the MS and the owner.
 *
 * REFUSES exactly as `stage-ipd-setup` does: the synthetic-data door must be open, the environment label must start
 * with "UAT", and the database must not be production's port.
 */
export const SCRIPT = "stage-er-setup";
const DRAFTER: Actor = { type: "system", id: "er-stage-setup" };
/** The script's own identity for the store it creates (never a person's account). */
export const ER_SETUP_ACTOR: Actor = { type: "user", id: "seed-er-stage" };
export const ER_TESTING_ROLES = ["er_nurse"] as const;

export type StageErReport = {
  workflow: { action: "drafted" | "already"; definitionId: string; version: number; status: string };
  store: { action: "created" | "already"; storeId: string };
  testingRoles: StageIpdReport["testingRoles"];
  sampleTariff: { action: "drafted" | "already"; versionNo: number | null; servicesCreated: string[] };
};

export { assertStagingOnly };

export async function stageErSetup(db: Db): Promise<StageErReport> {
  // a. the episode workflow — a draft, and nothing more
  const defs = await listDefinitions(db, ER_EPISODE_WORKFLOW_DEF_KEY);
  const live = defs.find((d) => d.status === "active") ?? defs.find((d) => d.status === "draft");
  let workflow: StageErReport["workflow"];
  if (live !== undefined) {
    workflow = { action: "already", definitionId: live.id, version: live.version, status: live.status };
  } else {
    const d = await createDraft(db, DRAFTER, erEpisodeWorkflowDefinition);
    workflow = { action: "drafted", definitionId: d.definitionId, version: d.version, status: "draft" };
  }
  // b. the ER satellite store — empty
  const found = await findStoreByCode(db, ER_SATELLITE_STORE_CODE);
  let store: StageErReport["store"];
  if (found !== undefined) {
    store = { action: "already", storeId: found.id };
  } else {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, ER_SETUP_ACTOR, { code: ER_SATELLITE_STORE_CODE, name: "ER satellite store" }));
    store = { action: "created", storeId: resourceId };
  }
  // c. the casualty nurse role for the one all-roles account
  const testingRoles = await grantTestingRoles(db, ER_TESTING_ROLES);
  // d. the UAT SAMPLE ER tariff — services inactive, a draft version
  const drafted = (await db.select({ versionNo: tariffVersions.versionNo, notes: tariffVersions.notes }).from(tariffVersions))
    .find((v) => (v.notes ?? "").includes(ER_UAT_SAMPLE_MARKER) && (v.notes ?? "").includes("ER tariff"));
  let sampleTariff: StageErReport["sampleTariff"];
  if (drafted !== undefined) {
    sampleTariff = { action: "already", versionNo: drafted.versionNo, servicesCreated: [] };
  } else {
    sampleTariff = await withTx(db, async (tx) => {
      const have = new Map((await tx.select({ id: services.id, code: services.code }).from(services)
        .where(inArray(services.code, ER_UAT_SAMPLE_RATES.map((r) => r.code)))).map((r) => [r.code, r.id] as const));
      const created: string[] = [];
      for (const r of ER_UAT_SAMPLE_RATES) {
        if (have.has(r.code)) continue;
        const { serviceId } = await createService(tx, ER_SETUP_ACTOR, { code: r.code, name: r.name, category: r.category });
        await updateService(tx, ER_SETUP_ACTOR, serviceId, { active: false });
        have.set(r.code, serviceId);
        created.push(r.code);
      }
      const current = await resolveActiveTariffVersion(tx as unknown as Db, new Date());
      const d = await createDraftVersion(tx, ER_SETUP_ACTOR, { notes: ER_UAT_SAMPLE_TARIFF_NOTE, ...(current === null ? {} : { copyFromVersionId: current.versionId }) });
      for (const r of ER_UAT_SAMPLE_RATES) await setTariffItem(tx, ER_SETUP_ACTOR, d.versionId, have.get(r.code)!, r.pricePaise);
      return { action: "drafted" as const, versionNo: d.versionNo, servicesCreated: created };
    });
  }
  return { workflow, store, testingRoles, sampleTariff };
}

async function main(): Promise<void> {
  assertStagingOnly(process.env);
  const { db, pool } = createDb(process.env.DATABASE_URL as string);
  try {
    const r = await stageErSetup(db);
    console.log(`${SCRIPT} — ${process.env.HMIS_ENVIRONMENT_LABEL ?? ""}`);
    console.log(`a. workflow ${ER_EPISODE_WORKFLOW_DEF_KEY}: ${r.workflow.action} — v${r.workflow.version} ${r.workflow.status} (${r.workflow.definitionId}). Approve (MS + owner) and activate (owner): POST /workflow/definitions/${r.workflow.definitionId}/approve, then /activate`);
    console.log(`b. store ${ER_SATELLITE_STORE_CODE}: ${r.store.action} (${r.store.storeId}) — EMPTY: stock it by a transfer from the main store`);
    const tr = r.testingRoles;
    console.log(`c. er_nurse for the all-roles account: ${tr.action}${tr.why === undefined ? "" : ` — ${tr.why}`}; granted: [${tr.granted.join(", ") || "none"}]; already: [${tr.already.join(", ") || "none"}]; roles not seeded: [${tr.missingRoles.join(", ") || "none"}]`);
    console.log(`d. UAT SAMPLE ER tariff: ${r.sampleTariff.action} — draft version ${String(r.sampleTariff.versionNo ?? "—")}; services created INACTIVE: [${r.sampleTariff.servicesCreated.join(", ") || "none"}]`);
    if (tr.action === "refused") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
