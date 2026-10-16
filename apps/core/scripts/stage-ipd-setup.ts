import { and, eq, inArray } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { roleAssignments, roles, tariffVersions, users } from "../src/kernel/db/schema";
import { appendEvent } from "../src/kernel/events/append";
import { roleAssigned } from "../src/kernel/auth/events";
import { assignRole } from "../src/kernel/auth/permissions";
import { ADMISSION_WORKFLOW_DEF_KEY } from "../src/modules/ipd";
import { draftAdmissionWorkflowStep, registerIpdApprovalTypesStep } from "./ipd-setup-steps";
import type { AdmissionWorkflowReport, ApprovalTypesReport } from "./ipd-setup-steps";
import { ipdRateServiceCode } from "@hmis/contracts";
import { services, tariffItems } from "../src/kernel/db/schema";
import { importIpdTariff, setDraftVersionNotes, setTariffItem } from "../src/modules/tariff";
import { LEGACY_SAMPLE_MARKERS, UAT_SAMPLE_MARKER, UAT_SAMPLE_TARIFF_NOTE, uatSampleTariffCsv, uatSampleTariffRows } from "./fixtures/ipd-uat-sample-tariff";
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
 *  a. Registers the IPD approval types (`registerIpdApprovalTypesStep`, shared with `ipd-golive-setup`). This is the same go-live step every module's seed
 *     takes for its own types (seed-ot, seed-tariff): a system drafter, the script's own activator identity, and the
 *     SoD pairs ensured first.
 *  b. DRAFTS (`draftAdmissionWorkflowStep`, shared) the `ipd_admission` workflow definition (change class A) as a system drafter, and stops there. Approval
 *     (medical superintendent + owner, two people) and activation (the owner) stay with them:
 *     `POST /workflow/definitions/:id/approve` and `/activate`. The script never approves or activates it.
 *  c. Imports the UAT SAMPLE IPD tariff (`scripts/fixtures/ipd-uat-sample-tariff.ts`) through `importIpdTariff` as a
 *     DRAFT tariff version. Its services are created INACTIVE. Submit → owner's approval → activation → switching the
 *     services on remain people's acts.
 *
 *  d. Grants the TESTING roles (ward nurse, nursing supervisor, nursing superintendent, dietician, kitchen staff) to the
 *     one all-roles test account (owner 2026-10-14), and to nobody else. The account is found by what it is — the single
 *     active account holding both `owner` and `admin` with the most hospital roles — never by a name in this file. Each
 *     grant is `assignRole` + a `role.assigned` event in one transaction, exactly what `POST /admin/users/:id/roles`
 *     writes. It creates no user and refuses when the account is not unique.
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
  approvalTypes: ApprovalTypesReport;
  workflow: AdmissionWorkflowReport;
  tariff: { action: "drafted" | "updated" | "already" | "refused"; lines: string[] };
  testingRoles: { action: "granted" | "already" | "refused"; granted: string[]; already: string[]; missingRoles: string[]; why?: string };
};

/** The roles the IPD nursing and diet screens need; no seed assigns them to anyone. */
export const TESTING_ROLES = ["ward_nurse", "nursing_supervisor", "nursing_superintendent", "dietician", "kitchen_staff"] as const;

/**
 * Step d. The all-roles account = the ONE active account holding `owner` and `admin` at hospital scope with strictly
 * the most hospital roles. No such account, or a tie → refused, nothing written. `stage-er-setup` reuses it with its role.
 */
export async function grantTestingRoles(
  db: Db, testingRoles: readonly string[] = TESTING_ROLES,
): Promise<StageIpdReport["testingRoles"]> {
  const rows = await db.select({ userId: roleAssignments.userId, roleKey: roleAssignments.roleKey }).from(roleAssignments)
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(users.active, true), eq(roleAssignments.scopeType, "hospital")));
  const held = new Map<string, Set<string>>();
  for (const r of rows) held.set(r.userId, (held.get(r.userId) ?? new Set()).add(r.roleKey));
  const candidates = [...held.entries()].filter(([, set]) => set.has("owner") && set.has("admin"))
    .map(([userId, set]) => ({ userId, set, n: set.size })).sort((a, b) => b.n - a.n);
  const none = { granted: [], already: [], missingRoles: [] };
  if (candidates.length === 0) return { action: "refused", ...none, why: "no active account holds both owner and admin" };
  if (candidates.length > 1 && candidates[0]!.n === candidates[1]!.n) {
    return { action: "refused", ...none, why: "more than one account ties for the most roles — the all-roles account is not unique" };
  }
  const account = candidates[0]!;
  const existing = new Set((await db.select({ key: roles.key }).from(roles).where(inArray(roles.key, [...testingRoles]))).map((r) => r.key));
  const granted: string[] = [];
  const already: string[] = [];
  const missingRoles = testingRoles.filter((r) => !existing.has(r));
  await withTx(db, async (tx) => {
    for (const roleKey of testingRoles) {
      if (!existing.has(roleKey)) continue;
      if (account.set.has(roleKey)) { already.push(roleKey); continue; }
      const { id: assignmentId } = await assignRole(tx, { userId: account.userId, roleKey, scopeType: "hospital" });
      await appendEvent(tx, roleAssigned.make({
        actor: SETUP_ACTOR, payload: { assignmentId, userId: account.userId, roleKey, scopeType: "hospital", scopeId: null },
      }));
      granted.push(roleKey);
    }
  });
  return { action: granted.length > 0 ? "granted" : "already", granted, already, missingRoles };
}

export async function stageIpdSetup(db: Db): Promise<StageIpdReport> {
  // a. approval types, b. the admission workflow (a draft, and nothing more) — the steps go-live day shares
  const approvalTypes = await registerIpdApprovalTypesStep(db, SETUP_ACTOR);
  const workflow = await draftAdmissionWorkflowStep(db, DRAFTER);

  // c. the decision-0074 IPD rate card — a draft version (an earlier placeholder draft is brought up to it in place)
  const tariff = await ensureRateCardDraft(db);
  // d. the testing roles for the one all-roles account
  const testingRoles = await grantTestingRoles(db);
  return { approvalTypes, workflow, tariff, testingRoles };
}

/**
 * Step c. A version carrying the rate card's marker (or an earlier placeholder's):
 * - still a DRAFT → its IPD rates and note are brought to the fixture with `setTariffItem` / `setDraftVersionNotes`
 *   (draft-only writers), only where they differ; nothing changed → "already";
 * - submitted or activated → left alone ("already"): what went for approval is never rewritten.
 * None → the importer drafts one.
 */
export async function ensureRateCardDraft(db: Db): Promise<StageIpdReport["tariff"]> {
  const markers = [UAT_SAMPLE_MARKER, ...LEGACY_SAMPLE_MARKERS];
  const versions = await db.select({ id: tariffVersions.id, versionNo: tariffVersions.versionNo, status: tariffVersions.status, notes: tariffVersions.notes })
    .from(tariffVersions).where(inArray(tariffVersions.status, ["draft", "submitted", "activated"]));
  const sample = versions.filter((v) => markers.some((m) => (v.notes ?? "").includes(m))).sort((a, b) => b.versionNo - a.versionNo)[0];
  if (sample !== undefined && sample.status !== "draft") {
    return { action: "already", lines: [`tariff version ${sample.versionNo} (${sample.status}) carries the rate card; not rewritten`] };
  }
  if (sample !== undefined) {
    const rows = uatSampleTariffRows().map((r) => ({ code: ipdRateServiceCode(r.bedClass, r.component), paise: r.rupees * 100 }));
    const svc = await db.select({ id: services.id, code: services.code }).from(services).where(inArray(services.code, rows.map((r) => r.code)));
    const idOf = new Map(svc.map((x) => [x.code, x.id]));
    const missing = rows.filter((r) => !idOf.has(r.code)).map((r) => r.code);
    if (missing.length > 0) return { action: "refused", lines: [`draft ${sample.versionNo} lacks services: ${missing.join(", ")}`] };
    const have = new Map((await db.select({ serviceId: tariffItems.serviceId, pricePaise: tariffItems.pricePaise }).from(tariffItems)
      .where(eq(tariffItems.versionId, sample.id))).map((i) => [i.serviceId, i.pricePaise]));
    let changed = 0;
    await withTx(db, async (tx) => {
      for (const r of rows) {
        const id = idOf.get(r.code) as string;
        if (have.get(id) === r.paise) continue;
        await setTariffItem(tx, SETUP_ACTOR, sample.id, id, r.paise);
        changed += 1;
      }
      if (sample.notes !== UAT_SAMPLE_TARIFF_NOTE) await setDraftVersionNotes(tx, SETUP_ACTOR, sample.id, UAT_SAMPLE_TARIFF_NOTE);
    });
    const noteChanged = sample.notes !== UAT_SAMPLE_TARIFF_NOTE;
    return {
      action: changed > 0 || noteChanged ? "updated" : "already",
      lines: [`DRAFT tariff version ${sample.versionNo}: ${changed} of ${rows.length} rates rewritten${noteChanged ? ", note updated" : ""}`],
    };
  }
  const r = await importIpdTariff(db, SETUP_ACTOR, uatSampleTariffCsv(), { apply: true, notes: UAT_SAMPLE_TARIFF_NOTE });
  if (!r.ok) return { action: "refused", lines: r.errors.map((e) => `${e.line === null ? "file" : `line ${e.line}`}: ${e.problem}`) };
  return {
    action: "drafted",
    lines: [
      `${r.items.length} rates, copied from version ${r.copiedFromVersionNo ?? "none in force"}`,
      `services created INACTIVE: ${r.servicesCreated.length}`,
      r.draft === null ? "no draft written" : `DRAFT tariff version ${r.draft.versionNo} (${r.draft.versionId})`,
    ],
  };
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
    const tr = r.testingRoles;
    console.log(`d. testing roles for the all-roles account: ${tr.action}${tr.why === undefined ? "" : ` — ${tr.why}`}; granted: [${tr.granted.join(", ") || "none"}]; already: [${tr.already.join(", ") || "none"}]; roles not seeded: [${tr.missingRoles.join(", ") || "none"}]`);
    if (r.tariff.action === "refused" || tr.action === "refused") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
