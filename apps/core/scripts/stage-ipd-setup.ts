import { inArray } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { tariffVersions } from "../src/kernel/db/schema";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { createDraft, listDefinitions } from "../src/kernel/workflow/definitions";
import { ADMISSION_WORKFLOW_DEF_KEY, IPD_APPROVAL_TYPE_KEYS, admissionWorkflowDefinition, registerIpdApprovalTypes } from "../src/modules/ipd";
import { importIpdTariff } from "../src/modules/tariff";
import { UAT_SAMPLE_MARKER, UAT_SAMPLE_TARIFF_NOTE, uatSampleTariffCsv } from "./fixtures/ipd-uat-sample-tariff";
import { assertSyntheticDataAllowed } from "./synthetic-door";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * `node dist/scripts/stage-ipd-setup.js` — inside the UAT api container ONLY.
 *
 * ═══ STAGING-ONLY: MAKE IPD TESTABLE END TO END WITHOUT BYPASSING ANY APPROVAL ═══
 *
 * The script is idempotent: every step checks first and reports "already" on a rerun. It does three things.
 *
 *  a. Registers the IPD approval types (`registerIpdApprovalTypes`). This is the same go-live step every module's seed
 *     takes for its own types (seed-ot, seed-tariff): a system drafter, the script's own activator identity, and the
 *     SoD pairs ensured first.
 *  b. DRAFTS the `ipd_admission` workflow definition (change class A) as a system drafter, and stops there. Approval
 *     (medical superintendent + owner, two people) and activation (the owner) stay with them:
 *     `POST /workflow/definitions/:id/approve` and `/activate`. The script never approves or activates it.
 *  c. Imports the UAT SAMPLE IPD tariff (`scripts/fixtures/ipd-uat-sample-tariff.ts`) through `importIpdTariff` as a
 *     DRAFT tariff version. Its services are created INACTIVE. Submit → owner's approval → activation → switching the
 *     services on remain people's acts.
 *
 * REFUSES unless all three hold: the synthetic-data door is open (`HMIS_SYNTHETIC_DATA_OK=1`, which only
 * /opt/hmis-uat/.env carries and production's deploy refuses); the environment label starts with "UAT"; and the
 * database is not production's port (:5434).
 */
export const SCRIPT = "stage-ipd-setup";

/** The script's own identity, on the seed-ot / seed-tariff precedent: never a person's account. */
export const SETUP_ACTOR: Actor = { type: "user", id: "seed-ipd-stage" };
const DRAFTER: Actor = { type: "system", id: "ipd-stage-setup" };

export function assertStagingOnly(env: NodeJS.ProcessEnv): void {
  const url = env.DATABASE_URL ?? "";
  if (url === "") throw new Error(`${SCRIPT}: DATABASE_URL is not set`);
  assertSyntheticDataAllowed(SCRIPT, env);
  if (!(env.HMIS_ENVIRONMENT_LABEL ?? "").trim().toUpperCase().startsWith("UAT")) {
    throw new Error(`${SCRIPT}: REFUSED — HMIS_ENVIRONMENT_LABEL is "${env.HMIS_ENVIRONMENT_LABEL ?? ""}", not a UAT label. Staging only.`);
  }
  if (url.includes(":5434")) throw new Error(`${SCRIPT}: REFUSED — that is production's database port.`);
}

export type StageIpdReport = {
  approvalTypes: { registered: string[]; alreadyPresent: string[]; billVoid: string };
  workflow: { action: "drafted" | "already"; definitionId: string; version: number; status: string };
  tariff: { action: "drafted" | "already" | "refused"; lines: string[] };
};

export async function stageIpdSetup(db: Db): Promise<StageIpdReport> {
  // a. approval types
  await seedSodPairs(db);
  const { registered } = await registerIpdApprovalTypes(db, SETUP_ACTOR);
  const all = Object.values(IPD_APPROVAL_TYPE_KEYS);
  const billVoid = all.includes("ipd_bill_void") ? "included" : "not in this tree (IPD_APPROVAL_TYPE_KEYS has no ipd_bill_void)";

  // b. the admission workflow — a draft, and nothing more
  const defs = await listDefinitions(db, ADMISSION_WORKFLOW_DEF_KEY);
  const live = defs.find((d) => d.status === "active") ?? defs.find((d) => d.status === "draft");
  let workflow: StageIpdReport["workflow"];
  if (live !== undefined) {
    workflow = { action: "already", definitionId: live.id, version: live.version, status: live.status };
  } else {
    const d = await createDraft(db, DRAFTER, admissionWorkflowDefinition);
    workflow = { action: "drafted", definitionId: d.definitionId, version: d.version, status: "draft" };
  }

  // c. the UAT SAMPLE tariff — a draft version
  const pending = await db.select({ versionNo: tariffVersions.versionNo, status: tariffVersions.status, notes: tariffVersions.notes })
    .from(tariffVersions).where(inArray(tariffVersions.status, ["draft", "submitted", "activated"]));
  const sample = pending.find((v) => (v.notes ?? "").includes(UAT_SAMPLE_MARKER));
  let tariff: StageIpdReport["tariff"];
  if (sample !== undefined) {
    tariff = { action: "already", lines: [`tariff version ${sample.versionNo} (${sample.status}) is the UAT sample already`] };
  } else {
    const r = await importIpdTariff(db, SETUP_ACTOR, uatSampleTariffCsv(), { apply: true, notes: UAT_SAMPLE_TARIFF_NOTE });
    if (!r.ok) {
      tariff = { action: "refused", lines: r.errors.map((e) => `${e.line === null ? "file" : `line ${e.line}`}: ${e.problem}`) };
    } else {
      tariff = {
        action: "drafted",
        lines: [
          `${r.items.length} sample rates, copied from version ${r.copiedFromVersionNo ?? "none in force"}`,
          `services created INACTIVE: ${r.servicesCreated.length}`,
          r.draft === null ? "no draft written" : `DRAFT tariff version ${r.draft.versionNo} (${r.draft.versionId})`,
        ],
      };
    }
  }
  return { approvalTypes: { registered, alreadyPresent: all.filter((k) => !registered.includes(k)), billVoid }, workflow, tariff };
}

async function main(): Promise<void> {
  assertStagingOnly(process.env);
  const { db, pool } = createDb(process.env.DATABASE_URL as string);
  try {
    const r = await stageIpdSetup(db);
    console.log(`${SCRIPT} — ${process.env.HMIS_ENVIRONMENT_LABEL ?? ""}`);
    console.log(`a. approval types registered: [${r.approvalTypes.registered.join(", ") || "none"}]; already: [${r.approvalTypes.alreadyPresent.join(", ") || "none"}]; ipd_bill_void: ${r.approvalTypes.billVoid}`);
    console.log(`b. workflow ${ADMISSION_WORKFLOW_DEF_KEY}: ${r.workflow.action} — v${r.workflow.version} ${r.workflow.status} (${r.workflow.definitionId}). Approve (MS + owner) and activate (owner): POST /workflow/definitions/${r.workflow.definitionId}/approve, then /activate`);
    console.log(`c. tariff (${UAT_SAMPLE_MARKER}): ${r.tariff.action}`);
    for (const l of r.tariff.lines) console.log(`   ${l}`);
    if (r.tariff.action === "refused") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
