import { eq } from "drizzle-orm";
import { createDb, withTx, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { activateDefinition, approveDefinition, createDraft } from "../src/kernel/workflow/definitions";
import { approveRequest } from "../src/kernel/approvals/decisions";
import { roleAssignments, users } from "../src/kernel/db/schema";
import { getActiveDefinition } from "../src/kernel/workflow/definitions";
import { RADIOLOGY_WORKFLOW_DEFINITIONS } from "../src/modules/radiology";
import { upsertGstCategory } from "../src/modules/tariff";
import {
  activateVersion, createDraftVersion, listServices, resolveActiveTariffVersion, setTariffItem,
  submitVersion,
} from "../src/modules/tariff";
import type { Actor } from "@hmis/contracts";

/**
 * `npx tsx scripts/dev-radiology-standup.ts` — the imaging department's commissioning ceremony,
 * executable. **PLAN 18a-iii, written while standing radiology up for the first time.**
 *
 * ═══ WHY THIS EXISTS: THE SEEDS DO NOT FINISH THE JOB, AND NOTHING SAID SO ═══
 *
 * `seed:radiology` gives the department its study-type book, its five machines and the tariff
 * SERVICE rows. It does not — and by design should not — perform the three CEREMONIES between
 * those rows and a scan a radiographer can actually start. Each of the three is a governed act
 * requiring named humans, and each was found here by being STOPPED by it, in this order:
 *
 *   1. **The two `imaging_*` workflow definitions are activated by nothing.** `imaging_study` and
 *      `imaging_gate` are `changeClass: "A"`; `RADIOLOGY_WORKFLOW_DEFINITIONS` is referenced by the
 *      e2e test and the test helper and by NO seed, script or runbook. Without them the department
 *      has no state machine at all. **This is the one that has no owner** — the other two are the
 *      owner's data by decision.
 *   2. **No ACTIVE tariff version.** Deliberate (owner item O6): prices are the owner's data and a
 *      seed that invented them would be inventing money. Radiology meets it as `402
 *      payment_required` on `startAcquisition` — DD12a takes the money before a routine self-pay
 *      scan — and then as `tariff_item_missing` behind that.
 *   3. **No `investigation` GST category.** Every imaging service is that category and `seed:tariff`
 *      seeds eight without it, so pricing refuses `gst_config_missing`. The laboratory hits the
 *      identical wall for the identical reason; it is one ruling, not two.
 *
 * ═══ THE THREE-PERSON RULE, WHICH IS NOT WHAT THE DOCUMENTS SAY ═══
 *
 * A Class-A definition is commonly described as needing "two keys, owner and medical
 * superintendent". It needs **three distinct humans**. `approveDefinition` refuses a second
 * approval from the same PERSON, and — the one that is not written down anywhere — the SoD pair
 * `workflow_drafter_activator` refuses an activation by whoever drafted it. So: a drafter, two
 * approvers, and an activator who is not the drafter. Discovered by `SodViolationError`, not by
 * reading.
 *
 * ═══ WHAT IT REFUSES TO DO ═══
 *
 * **It files no AERB licence, and that must stay true.** 18c refuses an ionising study on a machine
 * with no active licence, and a script that seeded one would be a hospital claiming paper it does
 * not hold — `aerb/licences.ts` makes the same argument in its own words. The gap is cleared by a
 * human entering real certificates at `/radiology/radiation-safety`. On a dev database that means
 * the CT, the X-ray units and the mammography unit REFUSE, deliberately, and that refusal is the
 * rehearsal the go-live runbook asks for.
 *
 * It also refuses to run against production, two ways.
 */

/** DEV PLACEHOLDER PRICES, in paise. Mid-range Indian corporate-hospital list rates so a walk
 *  produces a plausible bill. **They are not the owner's tariff** and every one is replaced through
 *  the tariff screens before go-live. */
const DEV_PRICES_PAISE: Record<string, number> = {
  "RAD-XR-CHEST": 35_000, "RAD-XR-KUB": 40_000, "RAD-XR-SPINE-LS": 50_000,
  "RAD-XR-SKULL": 45_000, "RAD-XR-KNEE": 40_000,
  "RAD-USG-ABDO": 120_000, "RAD-USG-KUB": 90_000, "RAD-USG-THYROID": 90_000,
  "RAD-USG-DOPPLER-LL": 220_000, "RAD-USG-PELVIS": 100_000,
  "RAD-USG-OBS-EARLY": 120_000, "RAD-USG-OBS-ANOMALY": 250_000,
  "RAD-CT-HEAD": 250_000, "RAD-CT-CHEST": 350_000, "RAD-CT-KUB": 300_000,
  "RAD-CT-ABDO-CONTRAST": 600_000,
  "RAD-MRI-BRAIN": 700_000, "RAD-MRI-LS-SPINE": 750_000, "RAD-MRI-BRAIN-GAD": 950_000,
  "RAD-MMG-BILATERAL": 220_000,
};

function refuseProduction(url: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-radiology-standup refuses to run with NODE_ENV=production");
  }
  if (url.includes(":5434")) {
    throw new Error("dev-radiology-standup refuses port 5434 — that is hmis-prod-db-1");
  }
}

async function holderOf(db: Db, roleKey: string): Promise<Actor> {
  const rows = await db.select({ id: users.id, username: users.username })
    .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(eq(roleAssignments.roleKey, roleKey));
  const row = rows[0];
  if (!row) {
    throw new Error(
      `no user holds "${roleKey}" — seed:roles mints authority and assigns nobody. `
      + "Provision the roster (cat roster.json | pnpm seed:staff) before standing the department up.",
    );
  }
  return { type: "user", id: row.id };
}

export async function standUpRadiology(db: Db): Promise<string[]> {
  const log: string[] = [];

  const owner = await holderOf(db, "owner");
  const ms = await holderOf(db, "medical_superintendent");
  /** The drafter must differ from the activator (`workflow_drafter_activator`), so it cannot be
   *  either approver if one of them activates. `opd_admin` is the administrator who drives a
   *  go-live; any third account holding a role would do. */
  const drafter = await holderOf(db, "opd_admin");

  // ── 1. The state machines ────────────────────────────────────────────────────────────────────
  for (const definition of RADIOLOGY_WORKFLOW_DEFINITIONS) {
    if (await withTx(db, (tx) => getActiveDefinition(tx, definition.key))) {
      log.push(`workflow definition ${definition.key}: already active`);
      continue;
    }
    const draft = await createDraft(db, drafter, definition);
    await approveDefinition(db, owner, { definitionId: draft.definitionId, roleKey: "owner", note: "stand-up" });
    await approveDefinition(db, ms, {
      definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "stand-up",
    });
    await activateDefinition(db, owner, draft.definitionId);
    log.push(`workflow definition ${definition.key}: ACTIVATED (drafted by a third person; SoD)`);
  }

  // ── 2. The GST category every imaging service needs ──────────────────────────────────────────
  await withTx(db, (tx) => upsertGstCategory(tx, owner, {
    category: "investigation",
    /** 9018x is diagnostic-imaging services. A DEV PLACEHOLDER: the SAC and the exemption are a
     *  CA-and-owner ruling, and this row is labelled so nobody mistakes it for one. */
    sacCode: "999316", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
  }));
  log.push('gst_config "investigation": DEV PLACEHOLDER written (exempt, SAC 999316) — CA ruling required');

  // ── 3. A priced, active tariff version ───────────────────────────────────────────────────────
  if (await withTx(db, (tx) => resolveActiveTariffVersion(tx, new Date()))) {
    log.push("tariff: a version is already active, left alone");
    return log;
  }
  const all = await withTx(db, (tx) => listServices(tx));
  const { versionId, versionNo } = await withTx(db, (tx) => createDraftVersion(tx, drafter, {
    notes: "dev stand-up — imaging list, DEV PLACEHOLDER prices",
  }));
  let priced = 0;
  for (const svc of all) {
    const paise = DEV_PRICES_PAISE[svc.code] ?? (svc.code.startsWith("OPD-CONSULT") ? 50_000 : null);
    if (paise === null) continue;
    await withTx(db, (tx) => setTariffItem(tx, drafter, versionId, svc.id, paise));
    priced += 1;
  }
  /** `submitVersion` opens the approval; the approver must hold `owner` and must not be the
   *  requester. `activateVersion` then refuses the drafter AND the submitter, so `owner` does both
   *  halves and `drafter` neither. */
  const { approvalId } = await withTx(db, (tx) => submitVersion(tx, drafter, versionId, "dev stand-up"));
  await approveRequest(db, owner, { approvalId, note: "dev stand-up" });
  /** BACKDATED: `resolveActiveTariffVersion` wants `effectiveFrom <= the moment being priced`, and
   *  the walk's encounters already exist. */
  await activateVersion(db, owner, versionId, new Date("2026-01-01T00:00:00.000Z"));
  log.push(`tariff version ${String(versionNo)}: ${String(priced)} services priced and ACTIVE (DEV PLACEHOLDER prices)`);
  return log;
}

async function main(): Promise<void> {
  const url = requireEnv("DATABASE_URL");
  refuseProduction(url);
  const { db, pool } = createDb(url);
  try {
    for (const line of await standUpRadiology(db)) console.log(`  ${line}`);
    console.log(
      "\nSTILL REQUIRED, and neither is this script's to do:\n"
      + "  · every ionising machine's AERB licence, entered at /radiology/radiation-safety until\n"
      + "    GET /aerb/licences/gaps comes back empty. Until then the CT, the X-ray units and the\n"
      + "    mammography unit REFUSE device_not_licensed — deliberately (18c D3).\n"
      + "  · real prices and a real SAC ruling. Everything this wrote is a labelled DEV placeholder.",
    );
  } finally { await pool.end(); }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e: unknown) => { console.error(e); process.exit(1); });
}
