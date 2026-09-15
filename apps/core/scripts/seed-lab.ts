import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { getApprovalType } from "../src/kernel/approvals/types";
import { sodPairs } from "../src/kernel/db/schema";
import {
  LAB_APPROVAL_TYPES, activateLabDefinitions, registerLabApprovalTypes,
} from "../src/modules/lab";
import type { ActivateLabDefinitionsReport } from "../src/modules/lab";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PHASE 11i T1 — `seed:lab`: the two rows the laboratory throws without.
 *
 * ═══ WHY A SEED AND NOT A RUNBOOK STEP ═══
 *
 * `activateLabDefinitions` and `registerLabApprovalTypes` have shipped since 17a. Their only
 * caller until this file was `test/helpers/lab.ts:216`. So the laboratory has been DEPLOYED since
 * migration `0046` and has been unable to take a single order the whole time: `startInstance`
 * throws `no_active_definition` for a key with no ACTIVE row, and `requestApproval` throws
 * `unknown_type` for `lab_release_unpaid`. Nothing in the deploy asked, and nothing could have —
 * the runbook said the definitions were "not a deploy step", which predates Plan 11g / DD2
 * reaching the lab: *the deploy establishes the rows its own modules throw without.*
 *
 * `seed-pharmacy.ts` is the precedent, one module over, and this file is deliberately its shape:
 * a synthetic `user` activator, idempotent, run before `seed-roles.js`, pinned by
 * `deploy-parity.test.ts`.
 *
 * ═══ WHY A `user` ACTOR AND NOT A `system` ONE ═══
 *
 * `activateDefinition` refuses anything but a `user` actor — an activation is somebody's act, and
 * the audit row has to name one. The DRAFTER inside `activateLabDefinitions` is a distinct
 * `system` identity, which is all `assertNotSodPair` compares. Widening the refusal to admit a
 * `system` activator would be weakening a guard to make a seed convenient; the seed adopts the
 * guard's vocabulary instead, exactly as pharmacy's does.
 *
 * ═══ WHAT IT DOES NOT TOUCH ═══
 *
 * No CA-signed row: nothing in `gst_config`, `billing_config` or the tariff. No catalogue — the
 * hospital's analytes and their reference ranges are the pathologist's (runbook §4), and a seed
 * that invented them would put invented clinical bands in a live range book. No user, no
 * credential, no department: those are `/admin/users` and the OPD masters screen, by hand.
 *
 * Class C, which is why a deploy may establish it at all: `CHANGE_CLASS_POLICY.C` is
 * `requiredRoles: []` (D-15). Class A and B definitions are never established by a deploy — that
 * boundary is `seed-ot`'s DD6 and 11i D2 keeps it.
 */
const activator: Actor = { type: "user", id: "seed-lab" };

export type LabSeedResult = {
  definitions: ActivateLabDefinitionsReport;
  approvalTypes: { registered: string[]; alreadyRegistered: string[] };
};

export async function ensureLabStandUp(db: Db, actor: Actor): Promise<LabSeedResult> {
  // `registerLabApprovalTypes` drafts an `approval_<typeKey>` definition and activates it, and
  // `assertNotSodPair` reads the pair table to do so. The pharmacy seed carries the same guard for
  // the same reason: on a database seeded before the pairs existed, the pairs are simply absent.
  if ((await db.select({ k: sodPairs.pairKey }).from(sodPairs).limit(1)).length === 0) {
    await seedSodPairs(db);
  }

  const definitions = await activateLabDefinitions(db, actor);

  // Read the verdict BEFORE the call so the report can say which of the two halves this run did.
  // `registerLabApprovalTypes` is idempotent and returns nothing; its own test proves that a
  // second call neither drafts a redundant version nor hits `duplicate_type`.
  const before = new Set<string>();
  for (const spec of LAB_APPROVAL_TYPES) {
    if ((await withTx(db, (tx) => getApprovalType(tx, spec.typeKey))) !== null) before.add(spec.typeKey);
  }
  await registerLabApprovalTypes(db, actor);

  return {
    definitions,
    approvalTypes: {
      registered: LAB_APPROVAL_TYPES.filter((s) => !before.has(s.typeKey)).map((s) => s.typeKey),
      alreadyRegistered: LAB_APPROVAL_TYPES.filter((s) => before.has(s.typeKey)).map((s) => s.typeKey),
    },
  };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const r = await ensureLabStandUp(db, activator);
    console.log(JSON.stringify({ seed: "lab", ...r }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  }); // seed-script convention: fail loud, exit non-zero
}
