import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { getApprovalType } from "../src/kernel/approvals/types";
import { loadBillingConfig } from "../src/modules/billing/config";
import { BILLING_APPROVAL_TYPES } from "../src/modules/billing/approval-types";
import { getGstSettings, listGstCategories } from "../src/modules/tariff/gst-config";
import { TARIFF_APPROVAL_TYPES } from "../src/modules/tariff/approval-types";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core check:config-present` — PLAN 11g / DD2, THE DEPLOY'S SECOND HALF.
 *
 * ═══ WHY THIS IS NOT `validate:config`, AND THE DIFFERENCE IS LOAD-BEARING ═══
 *
 * `scripts/validate-config.ts` is the GO-LIVE gate (Plan 11c D5): `runConfigValidation` refuses
 * unless a CA has signed the tax configuration (`ops.ca_signature_missing`) and unless a tariff
 * version is ACTIVE at the instant it runs. Both are false in production today and both are the
 * owner's runbook items to make true. Wiring that verdict to `deploy.sh`'s exit status would make
 * EVERY deploy fail until the CA signs, which is not a gate — it is a broken deploy.
 *
 * This script asks the strictly narrower question a DEPLOY has to ask: **are the configuration
 * rows the modules THROW without actually present?** It is the answer to the 2026-08-24 smoke
 * test's D2, where production was deployed with `billing_config` EMPTY and reported healthy:
 * `issueInvoice` threw `billing_not_configured` on every invoice, the nightly `runDailyClose` had
 * been failing for a day, and a doctor could not start a consultation because billing could not
 * price the fee. Nothing in the deploy asked.
 *
 * ═══ IT READS THROUGH THE MODULES' OWN LOADERS, NEVER ITS OWN SELECTS ═══
 *
 * `loadBillingConfig`, `getGstSettings`, `listGstCategories` and `getApprovalType` are the exact
 * functions the running system calls. That is `kernel/ops/validate.ts:20`'s recorded lesson — *a
 * gate that builds its own view of the config eventually validates something the engine will
 * never see* — and it is why a missing row produces the engine's OWN error text here, including
 * the seed command it names.
 *
 * EXIT CODE IS THE VERDICT (rules 16-17: read the VALUE):
 *   0  every required row present
 *   1  at least one absent — or the check itself could not be evaluated
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, so nobody re-derives it: CA sign-off, an active tariff
 * version, real prices, or whether any of the values are RIGHT. Those are `validate:config`'s and
 * the go-live runbook's. This script only answers "can the modules run at all".
 */

type Problem = { code: string; detail: string };

/** Exported so the test drives the same function the script does, not a second copy of it. */
export async function checkConfigPresent(db: Db): Promise<{ ok: boolean; problems: Problem[] }> {
  const problems: Problem[] = [];

  // 1. billing_config 'main'. `loadBillingConfig` THROWS `billing_not_configured` when the row is
  //    absent, and `updateBillingConfig` is an UPDATE … WHERE id='main' that cannot create it — so
  //    a deployment without this row has no route back except the seed. This is D2 exactly.
  try {
    await loadBillingConfig(db);
  } catch (e) {
    problems.push({
      code: "billing_config_missing",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. gst_settings 'main' — same shape, same loud error naming its own seed.
  try {
    await getGstSettings(db);
  } catch (e) {
    problems.push({
      code: "gst_settings_missing",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. At least one gst_config category. Zero rows means every taxable line fails at the counter
  //    with `gst_config_missing` — in front of a patient, which is where the smoke test met it.
  const categories = await listGstCategories(db);
  if (categories.length === 0) {
    problems.push({
      code: "gst_config_empty",
      detail: "gst_config holds no category rows — run: pnpm --filter @hmis/core seed:tariff",
    });
  }

  // 4. Every approval type the shipped modules gate on. `requestApproval` throws `unknown_type`
  //    for a key no row carries, so an unregistered type is a route that cannot complete — which
  //    is what `tariff_revision` was until this phase (report D7, gap 2).
  for (const spec of [...BILLING_APPROVAL_TYPES, ...TARIFF_APPROVAL_TYPES]) {
    const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
    if (row === null) {
      problems.push({
        code: "approval_type_unregistered",
        detail:
          `approval type "${spec.typeKey}" is registered by no row — ` +
          "run: pnpm --filter @hmis/core seed:billing and seed:tariff",
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const { ok, problems } = await checkConfigPresent(db);
    // Every problem first, so a `grep ERROR` over the deploy transcript is the whole worklist —
    // the `validate-config.ts` convention.
    for (const p of problems) console.log(`ERROR ${p.code}: ${p.detail}`);
    console.log(`config-present: ok=${String(ok)} problems=${problems.length}`);
    if (!ok) process.exit(1);
  } finally {
    await pool.end();
  }
}
// Guarded so `test/check-config-present.test.ts` can import `checkConfigPresent` without the
// script running itself on import — the `seed-roles.ts` / `seed-admin.ts` house convention.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  }); // seed-script convention: fail loud, exit non-zero
}
