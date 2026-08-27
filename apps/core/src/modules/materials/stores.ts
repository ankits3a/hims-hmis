import { and, asc, eq, ne, sql } from "drizzle-orm";
import { createResource } from "../../kernel/resources/registry";
import { collectResourceKinds } from "../../kernel/resources/kinds";
import { resources } from "../../kernel/db/schema";
import { MATERIALS_RESOURCE_KINDS } from "./kinds";
import { TRANSIT_STORE_CODE } from "./config";
import { MaterialsError } from "./errors";
import { ResourceError } from "../../kernel/resources/errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type StoreRow = typeof resources.$inferSelect;

/**
 * PLAN 14 T5 / DD2, DD9 — stock LOCATIONS, which are registry resources of kind `store`.
 *
 * ═══ THERE IS NO `stores` TABLE, AND THAT IS THE WHOLE POINT ═══
 *
 * Central stores, sub-stores, the OT's consignment bin, the quarantine bin and `IN-TRANSIT` are all
 * rows in `resources`. Plan 13 built the registry so that a place is a place wherever it is; a
 * private `stores` table here would be the seventh copy of one concept and exactly what §2.54
 * names. What this file adds is the MATERIALS-SPECIFIC vocabulary on top: creating one with the
 * right kind, finding the transit store, and excluding it from the pickers.
 *
 * ═══ `ensureTransitStore` IS LAZY, AND THAT IS A DECISION (DD9) ═══
 *
 * A two-sided issue moves stock `from → IN-TRANSIT` and then `IN-TRANSIT → to`. The transit store
 * is a REAL row with a REAL balance because the question "where is the stock right now, between the
 * two signatures" must have an answer, and "nowhere" is the answer that loses a carton. It is
 * created on FIRST USE rather than seeded, because `seed-materials.ts` deliberately writes no
 * master data (a seed that invented a hospital's stock locations would be placeholder commercial
 * data in a live item master) and because a site that never transfers anything never needs one.
 *
 * **`listStores` excludes it by code, in ONE predicate, in ONE reader** — Plan 13 DD9's discipline.
 * Every other caller sees the transit store exactly as the real place it is, because for the ledger
 * it IS one: `postMovement` neither knows nor cares that a resource is called `IN-TRANSIT`.
 */

/**
 * The kind declarations `createResource` validates against. Built from THIS module's own
 * declaration rather than from a booted registry, because `createStore` may be called from a
 * transaction that has no Nest context (a seed, a test, a worker job) — and the only kind it can
 * create is `store`, which this module owns outright (DD2).
 *
 * `collectResourceKinds` is not used here: it takes a `ModuleRegistry` and its purpose is the
 * duplicate-claim refusal at BOOT. That refusal has already happened by the time any of this runs,
 * in both processes, which is what T2 closed.
 */
const STORE_KINDS = MATERIALS_RESOURCE_KINDS;
// Referenced so the import above is not dead weight and so a reader can see the two are related:
// the boot collector guards the SET of declarations; this file uses the one declaration it owns.
void collectResourceKinds;

export async function createStore(
  tx: Tx,
  actor: Actor,
  input: { code: string; name: string; parentId?: string | null; siteId?: string; attributes?: Record<string, unknown> },
): Promise<{ resourceId: string }> {
  return createResource(tx, actor, STORE_KINDS, {
    kind: "store",
    code: input.code,
    name: input.name,
    parentId: input.parentId ?? null,
    siteId: input.siteId,
    attributes: input.attributes,
  });
}

/**
 * The per-site `IN-TRANSIT` store, created on first use.
 *
 * **The read-then-create is racy by construction and the unique index is what makes it safe.**
 * `resources_site_kind_code_lower_ux` is unique on `(site_id, kind, lower(code))`, so two
 * concurrent first-issues at one site cannot both create one: the loser's insert violates the index
 * and this function re-reads rather than propagating a constraint name. That is the
 * `INSERT … ON CONFLICT DO NOTHING` cold-start shape from `nextEpisodeNo`, expressed against a
 * function that does more than an insert.
 */
export async function ensureTransitStore(tx: Tx, siteId = "main"): Promise<string> {
  const found = await findStoreByCode(tx, TRANSIT_STORE_CODE, siteId);
  if (found !== undefined) return found.id;
  try {
    /**
     * ═══ SECOND-PASS FINDING R1 — THE CREATE RUNS IN A SAVEPOINT, AND IT HAS TO ═══
     *
     * The first remediation of M2 fixed the PREDICATE (below) and stopped there, which made the
     * recovery reachable and still broken. `createResource` raises `duplicate_code` off a REAL
     * unique-index violation (`registry.ts`: `catch (e) { if (isUniqueViolation(e)) … }`), and a
     * constraint violation puts the enclosing Postgres transaction into the ABORTED state. Every
     * subsequent command on it answers `25P02 current transaction is aborted` — so the re-read in
     * the `catch` would have thrown a SECOND, more confusing error on top of the first, and the
     * race would still have surfaced as a 500.
     *
     * **Fixing the predicate without fixing the transaction state is Plan 13's lesson repeating:
     * a remediation is unreviewed code, and this one shipped its own defect inside the fix.**
     *
     * Drizzle's nested `transaction()` is a `savepoint`/`rollback to savepoint` pair, so the
     * violation rolls back to the savepoint ONLY. The caller's transaction — which by this point
     * may already hold ledger locks — survives intact and the re-read below can run on it.
     */
    const { resourceId } = await tx.transaction(async (sp) =>
      createStore(sp, { type: "system", id: "materials-transit" }, {
        code: TRANSIT_STORE_CODE,
        name: "In transit",
        siteId,
        attributes: { system: true, reason: "DD9 two-sided issue: stock between two signatures" },
      }));
    return resourceId;
  } catch (e) {
    /**
     * ═══ CLOSE REVIEW M2 — THIS RECOVERY WAS DEAD CODE ═══
     *
     * It tested for a raw Postgres `23505`. But `createResource` has ALREADY converted that
     * violation into `ResourceError("duplicate_code", …)`, whose `.code` is the STRING
     * `"duplicate_code"` — so the comparison could never be true, the re-read never ran, and the
     * race this function documents surfaced as an unmapped `ResourceError` (M1) and therefore as a
     * **500 on `POST /materials/transfers`** for the second of two storekeepers issuing stock for
     * the first time at a site.
     *
     * A `catch` that cannot fire is worse than no `catch`: it reads as a handled case.
     */
    const isDuplicate = e instanceof ResourceError
      ? e.code === "duplicate_code"
      : typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
    if (isDuplicate) {
      const raced = await findStoreByCode(tx, TRANSIT_STORE_CODE, siteId);
      if (raced !== undefined) return raced.id;
    }
    throw e;
  }
}

export async function findStoreByCode(
  db: Db | Tx, code: string, siteId = "main",
): Promise<StoreRow | undefined> {
  const rows = await db.select().from(resources)
    .where(and(
      eq(resources.kind, "store"),
      eq(resources.siteId, siteId),
      sql`lower(${resources.code}) = ${code.trim().toLowerCase()}`,
    ))
    .limit(1);
  return rows[0];
}

/**
 * A resource id resolved to a `store`, or `unknown_store`.
 *
 * **It checks the KIND, not merely the existence.** A ledger row keyed on a `room` resource would
 * be accepted by the foreign key and would put stock in a consulting room — the FK says "this is a
 * resource", and only this function says "this is a place stock can be".
 */
export async function requireStore(db: Db | Tx, resourceId: string): Promise<StoreRow> {
  const rows = await db.select().from(resources).where(eq(resources.id, resourceId));
  const row = rows[0];
  if (row === undefined) {
    throw new MaterialsError("unknown_store", `resource ${resourceId} not found`);
  }
  if (row.kind !== "store") {
    throw new MaterialsError(
      "unknown_store",
      `resource ${resourceId} is a "${row.kind}", not a store — stock lives in stores (DD2)`,
      { kind: row.kind },
    );
  }
  if (row.status === "retired") {
    throw new MaterialsError(
      "unknown_store",
      `store ${row.code} is retired and cannot receive or issue stock`,
      { status: row.status },
    );
  }
  return row;
}

/**
 * Every store a human picks from — **`IN-TRANSIT` excluded, by code, here and nowhere else**
 * (DD9, and Plan 13 DD9's one-predicate-one-reader discipline).
 *
 * `retired` stores are excluded too, which is Plan 13's DD2 working as designed: one state column,
 * and every picker filters the status rather than a second `active` boolean that could disagree
 * with it.
 */
export async function listStores(
  db: Db | Tx,
  opts: { siteId?: string; includeTransit?: boolean } = {},
): Promise<StoreRow[]> {
  const clauses = [eq(resources.kind, "store"), ne(resources.status, "retired")];
  if (opts.siteId !== undefined) clauses.push(eq(resources.siteId, opts.siteId));
  if (opts.includeTransit !== true) {
    clauses.push(sql`lower(${resources.code}) <> ${TRANSIT_STORE_CODE.toLowerCase()}`);
  }
  return db.select().from(resources).where(and(...clauses)).orderBy(asc(resources.code));
}
