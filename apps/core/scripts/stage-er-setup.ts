import { createDb, withTx } from "../src/kernel/db/client";
import { createDraft, listDefinitions } from "../src/kernel/workflow/definitions";
import { ER_EPISODE_WORKFLOW_DEF_KEY, ER_SATELLITE_STORE_CODE, erEpisodeWorkflowDefinition } from "../src/modules/emergency";
import { createStore, findStoreByCode } from "../src/modules/materials";
import { createDraftVersion, createService, resolveActiveTariffVersion, setDraftVersionNotes, setTariffItem, updateService } from "../src/modules/tariff";
import { services, tariffItems, tariffVersions } from "../src/kernel/db/schema";
import { eq, inArray } from "drizzle-orm";
import { LEGACY_SAMPLE_MARKERS, UAT_SAMPLE_MARKER as IPD_SAMPLE_MARKER } from "./fixtures/ipd-uat-sample-tariff";
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
 *  d. (ER lane 6, #813) The UAT SAMPLE ER tariff (`fixtures/er-uat-sample-tariff.ts`): its four services created
 *     INACTIVE, their rates written into ONE draft. The tariff keeps one pending version at a time (the IPD importer refuses
 *     a second), so when the IPD sample draft (`stage-ipd-setup` step c) is still a DRAFT the rates go INTO it, and the
 *     owner activates IPD and ER with one approval. An ER-only draft left beside it by the first version of this step is
 *     retired by its note (the tariff module has no cancel or delete for a draft; a retired draft is never submitted).
 *     With no draft pending at all, it drafts its own copy of the version in force; with some other version pending it
 *     refuses rather than open a second. Submit → the owner's approval → activation → switching the services on stay
 *     people's acts (0076: go-live waits for the incumbent's real rates).
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
  sampleTariff: {
    action: "drafted" | "merged" | "already" | "refused"; versionNo: number | null; servicesCreated: string[]; retired: number[]; why?: string;
  };
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
  // d. the UAT SAMPLE ER tariff — services inactive, the rates in ONE draft (the IPD sample draft when there is one)
  const sampleTariff = await ensureErRatesDraft(db);
  return { workflow, store, testingRoles, sampleTariff };
}

/** The note an ER-only draft is retired with: no sample marker, so neither setup script ever picks it again. */
export const ER_RETIRED_NOTE_PREFIX = "RETIRED (stage-er-setup)";
const isErSampleNote = (notes: string | null): boolean => (notes ?? "").includes(ER_UAT_SAMPLE_MARKER) && (notes ?? "").includes("ER tariff");
const isIpdSampleNote = (notes: string | null): boolean => [IPD_SAMPLE_MARKER, ...LEGACY_SAMPLE_MARKERS].some((m) => (notes ?? "").includes(m));

/** Step d. Idempotent: a rerun that finds every ER rate already in the target draft and no ER-only draft left writes nothing. */
export async function ensureErRatesDraft(db: Db): Promise<StageErReport["sampleTariff"]> {
  return withTx(db, async (tx) => {
    const have = new Map((await tx.select({ id: services.id, code: services.code }).from(services)
      .where(inArray(services.code, ER_UAT_SAMPLE_RATES.map((r) => r.code)))).map((r) => [r.code, r.id] as const));
    const pending = (await tx.select({ id: tariffVersions.id, versionNo: tariffVersions.versionNo, status: tariffVersions.status, notes: tariffVersions.notes })
      .from(tariffVersions).where(inArray(tariffVersions.status, ["draft", "submitted"]))).sort((a, b) => b.versionNo - a.versionNo);
    const ipdDraft = pending.find((v) => v.status === "draft" && isIpdSampleNote(v.notes));
    const erDrafts = pending.filter((v) => v.status === "draft" && isErSampleNote(v.notes));
    const others = pending.filter((v) => v !== ipdDraft && !erDrafts.includes(v));
    let target = ipdDraft ?? erDrafts[0];
    if (target === undefined && others.length > 0) {
      return { action: "refused" as const, versionNo: null, servicesCreated: [], retired: [],
        why: `tariff version ${others.map((o) => `${o.versionNo} (${o.status})`).join(", ")} is pending; finish or reject it first` };
    }
    const created: string[] = [];
    for (const r of ER_UAT_SAMPLE_RATES) {
      if (have.has(r.code)) continue;
      const { serviceId } = await createService(tx, ER_SETUP_ACTOR, { code: r.code, name: r.name, category: r.category });
      await updateService(tx, ER_SETUP_ACTOR, serviceId, { active: false });
      have.set(r.code, serviceId);
      created.push(r.code);
    }
    let drafted = false;
    if (target === undefined) {
      const current = await resolveActiveTariffVersion(tx as unknown as Db, new Date());
      const d = await createDraftVersion(tx, ER_SETUP_ACTOR, { notes: ER_UAT_SAMPLE_TARIFF_NOTE, ...(current === null ? {} : { copyFromVersionId: current.versionId }) });
      target = { id: d.versionId, versionNo: d.versionNo, status: "draft", notes: ER_UAT_SAMPLE_TARIFF_NOTE };
      drafted = true;
    }
    const inTarget = new Map((await tx.select({ serviceId: tariffItems.serviceId, pricePaise: tariffItems.pricePaise }).from(tariffItems)
      .where(eq(tariffItems.versionId, target.id))).map((i) => [i.serviceId, i.pricePaise] as const));
    let written = 0;
    for (const r of ER_UAT_SAMPLE_RATES) {
      const id = have.get(r.code) as string;
      if (inTarget.get(id) === r.pricePaise) continue;
      await setTariffItem(tx, ER_SETUP_ACTOR, target.id, id, r.pricePaise);
      written += 1;
    }
    const retired: number[] = [];
    for (const v of erDrafts) {
      if (v.id === target.id) continue;
      await setDraftVersionNotes(tx, ER_SETUP_ACTOR, v.id,
        `${ER_RETIRED_NOTE_PREFIX}: its ER sample rates are in draft version ${target.versionNo}, with the IPD rate card — never submit this version`);
      retired.push(v.versionNo);
    }
    const action = drafted ? "drafted" as const : written > 0 || retired.length > 0 || created.length > 0 ? "merged" as const : "already" as const;
    return { action, versionNo: target.versionNo, servicesCreated: created, retired };
  });
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
    const t = r.sampleTariff;
    console.log(`d. UAT SAMPLE ER tariff: ${t.action}${t.why === undefined ? "" : ` — ${t.why}`} — draft version ${String(t.versionNo ?? "—")}; services created INACTIVE: [${t.servicesCreated.join(", ") || "none"}]; ER-only drafts retired: [${t.retired.join(", ") || "none"}]`);
    if (tr.action === "refused" || t.action === "refused") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
