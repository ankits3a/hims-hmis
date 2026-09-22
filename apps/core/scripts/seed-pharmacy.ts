import { and, eq, sql } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { resources, sodPairs } from "../src/kernel/db/schema";
import { createStore, requireStore, setStoreCustodianRoles, storeCustodianRoles } from "../src/modules/materials";
import { OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, activatePharmacyDefinitions } from "../src/modules/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * PLAN 16c T5 — `seed:pharmacy`: the two things a deploy must have before the counter's first scan.
 *
 *   1. The `PHARM-OPD` store (D2) — a registry resource of kind `store`, found by code and created
 *      once; the pick reserves against it and a counter with no store refuses every claim with
 *      `store_missing`, which is the honest failure and a bad first day.
 *   2. The `pharmacy_dispense` definition (D8), Class C — drafted and activated once; `startInstance`
 *      throws `no_active_definition` otherwise and the claim rolls back.
 *
 * Idempotent, the `seed-ot` shape: a second run finds both and creates nothing. It runs in
 * `deploy.sh` after `seed-ot.js` and before `seed-roles.js`, and `deploy-parity.test.ts` pins it.
 */
const activator: Actor = { type: "user", id: "seed-pharmacy" };

export type PharmacySeedResult = {
  storeId: string; created: string[]; found: string[];
  /** 14c — the store's custodian roles were written on this run (a new store, or one seeded before them). */
  custodiansSet: boolean;
  definitions: { activated: string[]; alreadyActive: string[] };
};

/** 14c — the pharmacy's own staff keep `PHARM-OPD`, so a blind count of it never goes to them. */
export const PHARMACY_CUSTODIAN_ROLES = ["pharmacy", "pharmacy_assistant"] as const;

async function findStore(exec: Tx, code: string, siteId = "main"): Promise<string | undefined> {
  const rows = await exec.select({ id: resources.id }).from(resources)
    .where(and(eq(resources.kind, "store"), eq(resources.siteId, siteId), sql`lower(${resources.code}) = ${code.toLowerCase()}`))
    .limit(1);
  return rows[0]?.id;
}

/**
 * PHARMACY P19 (R-174) — the walk-in retail counter's store, beside the OPD counter's. Created on
 * every deploy; it sells nothing until its Form 20/21 licence is recorded.
 */
const PHARMACY_STORES = [
  { code: OPD_PHARMACY_STORE_CODE, name: "OPD pharmacy counter" },
  { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" },
] as const;

export async function ensurePharmacyCounter(db: Db, actor: Actor): Promise<PharmacySeedResult> {
  const created: string[] = [];
  const found: string[] = [];
  const storeIds: string[] = [];
  let custodiansSet = false;
  for (const store of PHARMACY_STORES) {
    const id = await withTx(db, async (tx) => {
      const existing = await findStore(tx, store.code);
      if (existing !== undefined) { found.push(store.code); return existing; }
      const { resourceId } = await createStore(tx, actor, { code: store.code, name: store.name });
      created.push(store.code);
      return resourceId;
    });
    storeIds.push(id);
    const set = await withTx(db, async (tx) => {
      const have = storeCustodianRoles(await requireStore(tx, id));
      if (PHARMACY_CUSTODIAN_ROLES.every((r) => have.includes(r))) return false;
      await setStoreCustodianRoles(tx, actor, id, [...have, ...PHARMACY_CUSTODIAN_ROLES]);
      return true;
    });
    custodiansSet = custodiansSet || set;
  }
  const storeId = storeIds[0]!;
  if ((await db.select({ k: sodPairs.pairKey }).from(sodPairs).limit(1)).length === 0) await seedSodPairs(db);
  const definitions = await activatePharmacyDefinitions(db, actor);
  return { storeId, created, found, custodiansSet, definitions };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const r = await ensurePharmacyCounter(db, activator);
    console.log(JSON.stringify({ seed: "pharmacy", ...r }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
