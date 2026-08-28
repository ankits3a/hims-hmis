import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { withTx } from "../src/kernel/db/client";
import { otDefinitions, resources } from "../src/kernel/db/schema";
import { createResource } from "../src/kernel/resources/registry";
import { KERNEL_RESOURCE_KINDS } from "../src/kernel/resources/kinds";
import { createStore } from "../src/modules/materials";
import { registerOtApprovalTypes } from "../src/modules/ot/approval-types";
import { OT_DEFINITION_SEEDS, draftDefinition } from "../src/modules/ot/definitions";
import {
  DAYCARE_RECOVERY_BAY_CLASS, OT_CONSIGNMENT_STORE_CODE, OT_RECOVERY_BAY_CODES,
  OT_RESOURCE_KINDS, OT_THEATRE_CODE,
} from "../src/modules/ot/kinds";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * PLAN 15 T2 / DD3 + DD6 — the mini-OT's deploy-time seed: **one theatre, two recovery bays, one
 * consignment bin, and two approval types.** Idempotent, in `deploy.sh`, run on every deploy.
 *
 * ═══ WHY THE PHYSICAL UNIT IS SEEDED BY SCRIPT AND NEVER BY SCREEN (DD3) ═══
 *
 * `seed-materials.ts` seeds no store and says why: an item master and a vendor list are
 * hospital-specific commercial data and a seed that invented them would put placeholder rows in a
 * live master. **This is the opposite case and the distinction is worth stating rather than
 * assuming.** The day-care unit is ONE theatre and TWO bays — that is the whole of §11.16-A's
 * "existing law at one-theatre scale", it is fixed by the building rather than by a purchasing
 * decision, and every one of this module's write paths needs those rows to exist before the first
 * booking. A unit whose theatre must be hand-created before the first case can be booked is a unit
 * whose first case is booked against a typo.
 *
 * `OT-CONSIGN` is here for a sharper reason still (adversarial finding F14): Plan 14's `0034`
 * created the consignment TABLES and not a single `store` ROW, and `consignmentDeployed.storeResourceId`
 * is a required field. Without this row the first implant scan has nowhere to deploy FROM — and it
 * would fail at the table, in theatre, mid-case.
 *
 * ═══ THE BAYS ARE KERNEL `bed` ROWS, WHICH IS WHY TWO KIND VOCABULARIES ARE PASSED ═══
 *
 * `createResource` takes the declarations to validate against. The theatre validates against
 * `OT_RESOURCE_KINDS`; the bays against `KERNEL_RESOURCE_KINDS`, because `bed` is the kernel's kind
 * and this module deliberately does not claim it (F1). Passing OT's list for a bay would throw
 * `unknown_kind`, correctly.
 *
 * ═══ IDEMPOTENCY IS A FIND-OR-CREATE ON `(site, kind, lower(code))` ═══
 *
 * That triple is UNIQUE in the registry (`resources_site_kind_code_lower_ux`), so the read-then-create
 * is safe against a re-run and against a race: a loser's insert violates the index rather than
 * creating a second theatre. **Spike Q2 measured production holding `room × 2` and nothing else**,
 * so on the first deploy all four rows are created; on every later deploy all four are found. The
 * seed never UPDATES a row it finds — a theatre someone has since renamed, moved or blocked stays
 * exactly as the hospital left it, which is `seed-tariff.ts`'s "a deploy must never overwrite a
 * corrected value" applied to a place.
 *
 * ═══ IT DRAFTS DEFINITION DATA AND ACTIVATES NONE OF IT — DD6's RULING ═══
 *
 * DD6: *"a seed that activates a Class-B definition is the theatre the owner named."* So this
 * installs three DRAFTS — the R-3.18 criteria whitelist, §3A's deposit policy and F24b's PACU
 * scales — and publishes nothing. A human publishes them through the approvals engine (T9's
 * runbook); until then `bookCase` refuses everything with `definition_not_active`, which is the
 * honest state of a unit nobody has yet said what it may do.
 *
 * **The drafts land at T3 rather than T2** (finding T2-c): the plan puts "DD6 drafts" in T2's
 * Produces and their zod schemas in T3's, and a seed cannot validate a body against a schema that
 * does not exist yet. Drafts are inert, so one task later costs nothing.
 *
 * **`privileges` is deliberately NOT drafted.** A privilege list names REAL surgeon user ids, which
 * a seed cannot know and must not invent — a placeholder id in a credentialing list is exactly the
 * commercial-placeholder failure `seed-tariff.ts` was rewritten to avoid, with a patient on the end
 * of it. The MS drafts it at go-live from the credentialing committee's own list.
 *
 * **A re-run drafts nothing new.** A draft is created only when the kind has NO row at all, so the
 * second deploy leaves the MS's own published v1 — and any draft they are still working on —
 * exactly where they are. A seed that re-drafted on every deploy would bury a real draft under a
 * pile of identical ones.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @hmis/core seed:ot
 */

/** The `seed-materials.ts` / `seed-tariff.ts` activator precedent: a fixed script identity, of
 *  actor type "user", whose id differs from the module's fixed system drafter. */
const activator: Actor = { type: "user", id: "seed-ot" };

async function findByCode(exec: Tx, kind: string, code: string, siteId = "main"): Promise<string | undefined> {
  const rows = await exec.select({ id: resources.id }).from(resources)
    .where(and(
      eq(resources.kind, kind),
      eq(resources.siteId, siteId),
      sql`lower(${resources.code}) = ${code.toLowerCase()}`,
    ))
    .limit(1);
  return rows[0]?.id;
}

export type OtSeedResult = {
  theatreId: string;
  bayIds: string[];
  consignmentStoreId: string;
  created: string[];
  found: string[];
};

/**
 * Ensures the day-care unit's four registry rows exist, in ONE transaction so a half-created unit
 * cannot survive a failure — a theatre with one bay and no consignment bin is a unit that boots and
 * then refuses the first implant scan.
 *
 * Exported so `seed-ot.test.ts` can drive it against a real database rather than asserting about a
 * script it never runs (the `seed-roles.ts` convention).
 */
export async function ensureOtUnit(db: Db, actor: Actor): Promise<OtSeedResult> {
  return withTx(db, async (tx) => {
    const created: string[] = [];
    const found: string[] = [];

    async function ensure(
      kind: string,
      kinds: typeof OT_RESOURCE_KINDS | typeof KERNEL_RESOURCE_KINDS,
      code: string,
      name: string,
      parentId: string | null,
      attributes?: Record<string, unknown>,
    ): Promise<string> {
      const existing = await findByCode(tx, kind, code);
      if (existing !== undefined) { found.push(code); return existing; }
      const { resourceId } = await createResource(tx, actor, kinds, { kind, code, name, parentId, attributes });
      created.push(code);
      return resourceId;
    }

    const theatreId = await ensure(
      "theatre", OT_RESOURCE_KINDS, OT_THEATRE_CODE, "Day-care Theatre 1", null,
    );

    const bayIds: string[] = [];
    for (const [index, code] of OT_RECOVERY_BAY_CODES.entries()) {
      bayIds.push(await ensure(
        // The kernel's vocabulary, not this module's — see the header.
        "bed", KERNEL_RESOURCE_KINDS, code, `Recovery Bay ${String(index + 1)}`, theatreId,
        // R-3.9 — a CODE with no tariff link. Day-care bills by procedure package, never bed-hours.
        { class: DAYCARE_RECOVERY_BAY_CLASS },
      ));
    }

    // F14 — through `materials.createStore`, never by inserting a `store` row here: the store kind
    // belongs to the module that owns the ledger keyed on it, and `createStore` is where its
    // vocabulary and its `occupied: null` refusal live.
    const existingStore = await findByCode(tx, "store", OT_CONSIGNMENT_STORE_CODE);
    let consignmentStoreId: string;
    if (existingStore !== undefined) {
      consignmentStoreId = existingStore;
      found.push(OT_CONSIGNMENT_STORE_CODE);
    } else {
      const store = await createStore(tx, actor, {
        code: OT_CONSIGNMENT_STORE_CODE,
        name: "OT Consignment Bin",
        parentId: theatreId,
      });
      consignmentStoreId = store.resourceId;
      created.push(OT_CONSIGNMENT_STORE_CODE);
    }

    return { theatreId, bayIds, consignmentStoreId, created, found };
  });
}

/**
 * Installs the three DD6 seed bodies as DRAFTS, once. Exported so `seed-ot.test.ts` can prove the
 * idempotence the deploy path depends on, and prove that nothing becomes active.
 */
export async function ensureOtDefinitionDrafts(
  db: Db, actor: Actor,
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const seed of OT_DEFINITION_SEEDS) {
    const existing = await db.select({ id: otDefinitions.id }).from(otDefinitions)
      .where(eq(otDefinitions.kind, seed.kind)).limit(1);
    if (existing.length > 0) { skipped.push(seed.kind); continue; }
    await withTx(db, (tx) => draftDefinition(tx, actor, { kind: seed.kind, body: seed.body }));
    created.push(seed.kind);
  }
  return { created, skipped };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    // The SoD pair rows the workflow drafter/activator check reads must exist before the approval
    // registration below can draft-then-activate a definition. `seedSodPairs` is an ensure and every
    // other module's seed calls it, which makes THIS script self-sufficient rather than dependent on
    // a deploy order a later phase may reorder.
    await seedSodPairs(db);
    await registerOtApprovalTypes(db, activator);
    console.log("approval types ensured: ot_definition_publish, ot_deposit_exception");

    const unit = await ensureOtUnit(db, activator);
    console.log(`day-care unit ensured — created: [${unit.created.join(", ") || "none"}], found: [${unit.found.join(", ") || "none"}]`);

    const drafts = await ensureOtDefinitionDrafts(db, activator);
    console.log(`definition drafts ensured — created: [${drafts.created.join(", ") || "none"}], already present: [${drafts.skipped.join(", ") || "none"}]`);
    console.log("NOTHING IS ACTIVE: an MS publishes the three drafts and drafts `privileges` themselves (DD6, T9's runbook)");
  } finally {
    await pool.end();
  }
}

// Guarded so a test can import from this file without the script running itself on import — the
// `seed-roles.ts` / `seed-materials.ts` house convention.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
