import { createDb, withTx } from "../src/kernel/db/client";
import { createDraft, listDefinitions } from "../src/kernel/workflow/definitions";
import { ER_EPISODE_WORKFLOW_DEF_KEY, ER_SATELLITE_STORE_CODE, erEpisodeWorkflowDefinition } from "../src/modules/emergency";
import { createStore, findStoreByCode } from "../src/modules/materials";
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
  return { workflow, store, testingRoles };
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
    if (tr.action === "refused") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
