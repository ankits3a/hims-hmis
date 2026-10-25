import { createDb } from "../src/kernel/db/client";
import { ADMISSION_WORKFLOW_DEF_KEY } from "../src/modules/ipd";
import {
  draftAdmissionWorkflowStep, findAdmissionWorkflow, planIpdApprovalTypes, registerIpdApprovalTypesStep,
} from "./ipd-setup-steps";
import type { AdmissionWorkflowReport, ApprovalTypesReport } from "./ipd-setup-steps";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * `node dist/scripts/ipd-golive-setup.js [--confirm]` — #798, RUN ONCE ON IPD GO-LIVE DAY (any environment).
 *
 * The production half of `stage-ipd-setup` steps a and b, through the same helpers (`ipd-setup-steps.ts`):
 *  1. registers the IPD approval types (SoD pairs first; a system drafter, this script's own activator identity);
 *  2. creates the `ipd_admission` workflow definition as a DRAFT. The medical superintendent and the owner approve it
 *     and the owner activates it on Admin → Workflows. This script never approves or activates it.
 *
 * It imports NO tariff and assigns NO role. Idempotent: a rerun reports "already".
 * Without `--confirm` it prints the plan and writes nothing.
 *
 * NOT a seed and NOT in `deploy.sh`: `deploy.sh` runs every seed on every deploy, so a seed would register IPD on the
 * next merge, before the owner's go-live day. Runbook: `docs/runbooks/ipd-go-live.md` §3.3.
 */
export const SCRIPT = "ipd-golive-setup";

/** The script's own identity (the seed-ot / seed-tariff precedent): never a person's account. */
export const GOLIVE_SETUP_ACTOR: Actor = { type: "user", id: "seed-ipd-golive" };
const DRAFTER: Actor = { type: "system", id: "ipd-golive-setup" };

export type GoLiveSetupResult =
  | { mode: "plan"; approvalTypesMissing: string[]; approvalTypesPresent: string[]; workflow: { definitionId: string; version: number; status: string } | null }
  | { mode: "applied"; approvalTypes: ApprovalTypesReport; workflow: AdmissionWorkflowReport };

export async function ipdGoLiveSetup(db: Db, opts: { confirm: boolean }): Promise<GoLiveSetupResult> {
  if (!opts.confirm) {
    const types = await planIpdApprovalTypes(db);
    return { mode: "plan", approvalTypesMissing: types.missing, approvalTypesPresent: types.present, workflow: await findAdmissionWorkflow(db) };
  }
  const approvalTypes = await registerIpdApprovalTypesStep(db, GOLIVE_SETUP_ACTOR);
  const workflow = await draftAdmissionWorkflowStep(db, DRAFTER);
  return { mode: "applied", approvalTypes, workflow };
}

export function formatGoLiveSetup(r: GoLiveSetupResult): string[] {
  const list = (xs: string[]): string => (xs.length === 0 ? "none" : xs.join(", "));
  const next = `Then: the medical superintendent and the owner approve ${ADMISSION_WORKFLOW_DEF_KEY} on Admin → Workflows, and the owner activates it.`;
  if (r.mode === "plan") {
    return [
      `${SCRIPT} — PLAN (nothing written; add --confirm to write)`,
      `1. approval types to register: [${list(r.approvalTypesMissing)}]; already: [${list(r.approvalTypesPresent)}]`,
      r.workflow === null
        ? `2. workflow ${ADMISSION_WORKFLOW_DEF_KEY}: would create a DRAFT (never approved or activated here)`
        : `2. workflow ${ADMISSION_WORKFLOW_DEF_KEY}: already — v${r.workflow.version} ${r.workflow.status} (${r.workflow.definitionId}); nothing to do`,
      next,
    ];
  }
  return [
    `${SCRIPT} — DONE`,
    `1. approval types registered: [${list(r.approvalTypes.registered)}]; already: [${list(r.approvalTypes.alreadyPresent)}]`,
    `2. workflow ${ADMISSION_WORKFLOW_DEF_KEY}: ${r.workflow.action} — v${r.workflow.version} ${r.workflow.status} (${r.workflow.definitionId})`,
    next,
  ];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error(`${SCRIPT}: DATABASE_URL is not set`);
  const { db, pool } = createDb(url);
  try {
    for (const l of formatGoLiveSetup(await ipdGoLiveSetup(db, { confirm: process.argv.includes("--confirm") }))) console.log(l);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
