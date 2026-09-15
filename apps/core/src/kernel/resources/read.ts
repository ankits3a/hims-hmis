import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { resourceStatusHistory, resources } from "../db/schema";
import { MAX_RESOURCE_DEPTH } from "./kinds";
import type { Db } from "../db/client";

/**
 * PLAN 13 T4 — the resource registry's READ SURFACE: tree, board, history.
 *
 * All three take **`Db`, never `Tx`, and hold no lock.** A board is read by a display that refreshes
 * on a timer; a reader that took a transaction would hold one open for as long as a screen is
 * pointed at it.
 *
 * ═══ WHY THIS IS AN ITERATIVE LEVEL-BY-LEVEL FETCH AND NOT A RECURSIVE CTE ═══
 *
 * **There is no `WITH RECURSIVE` anywhere in this repository** — measured at plan time and re-checked
 * here — so whichever shape was chosen was new ground, and the choice is argued rather than
 * defaulted:
 *
 *   · A recursive CTE has **no natural cap**. Postgres will happily walk a cycle until it exhausts
 *     memory, and the `resources` table can contain one: `parent_id` is a plain self-reference,
 *     Postgres cannot express "not my own ancestor", and `resources.test.ts` proves the database
 *     ACCEPTS a self-parent. Adding `WHERE depth < 6` to a CTE gets the cap back but not the visited
 *     set — a two-node cycle `A ↔ B` still yields six levels of alternating duplicates.
 *   · The iterative walk carries **both** bounds where they can be read: the depth cap is
 *     `MAX_RESOURCE_DEPTH` from `kinds.ts` (DD7's one constant, one owner — the same number the
 *     write guard reads), and the visited set is a `Set` in this file.
 *
 * **A6's whole point is that these two guards must be proved INDEPENDENTLY of the write path.** A
 * tree test built only through `createResource` can never construct the input that discriminates,
 * because T3 refuses to create it — so the reader's termination would be an inference from someone
 * else's correctness rather than a measurement of its own. The test inserts the cycle by raw SQL.
 *
 * The cost, stated: one query per LEVEL rather than one query per tree, so a six-level tree is six
 * round trips regardless of width. That is the right trade for a structure whose depth is capped at
 * six by construction and whose width is a hospital's worth of beds.
 */

export type ResourceNode = {
  id: string;
  kind: string;
  code: string;
  name: string;
  status: string;
  parentId: string | null;
  siteId: string;
  attributes: Record<string, unknown>;
  occupantType: string | null;
  occupantRef: string | null;
  since: Date | null;
  children: ResourceNode[];
};

export type ResourceBoardRow = Omit<ResourceNode, "children">;

type Row = typeof resources.$inferSelect;

function toNode(r: Row): ResourceNode {
  return {
    id: r.id, kind: r.kind, code: r.code, name: r.name, status: r.status,
    parentId: r.parentId, siteId: r.siteId, attributes: r.attributes,
    occupantType: r.occupantType, occupantRef: r.occupantRef, since: r.since,
    children: [],
  };
}

export type ResourceTreeOptions = {
  /** Start here. Omitted ⇒ every root (a resource with no parent) at the site. */
  rootId?: string;
  /** Keep only nodes of this kind. Applied to the ROOTS only — a filtered tree is still a tree. */
  kind?: string;
  siteId?: string;
  /** Levels to return, counting the roots as 1. Clamped to `MAX_RESOURCE_DEPTH`. */
  depth?: number;
};

/**
 * The tree, depth-capped and cycle-safe.
 *
 * **`depth` is CLAMPED, not trusted.** A caller asking for 50 levels gets six. The clamp is on the
 * read side rather than in the controller's zod schema because this function is module-facing too
 * (Plan 15 calls it directly), and a bound that only exists at the HTTP edge is a bound that the
 * first in-process caller walks straight past.
 */
export async function resourceTree(db: Db, opts: ResourceTreeOptions = {}): Promise<ResourceNode[]> {
  const maxDepth = Math.min(opts.depth ?? MAX_RESOURCE_DEPTH, MAX_RESOURCE_DEPTH);
  if (maxDepth < 1) return [];

  const rootWhere = [
    ...(opts.siteId === undefined ? [] : [eq(resources.siteId, opts.siteId)]),
    ...(opts.kind === undefined ? [] : [eq(resources.kind, opts.kind)]),
  ];
  // CLOSE / M5 — `isNull` IN SQL, not a JS filter over every matching row. The root query shipped
  // as "fetch every resource of that kind and keep the ones with no parent", which reads the whole
  // table to return its top level.
  const roots = opts.rootId === undefined
    ? await db.select().from(resources).where(and(isNull(resources.parentId), ...rootWhere))
        .orderBy(asc(resources.kind), asc(resources.code))
    : await db.select().from(resources).where(eq(resources.id, opts.rootId));

  const nodes = roots.map(toNode);
  // THE VISITED SET. It is seeded with the roots, so a cycle that runs back through a root is caught
  // on the first descent rather than on the seventh.
  const visited = new Set(nodes.map((n) => n.id));
  let frontier = nodes;

  for (let level = 1; level < maxDepth && frontier.length > 0; level += 1) {
    const parentIds = frontier.map((n) => n.id);
    const children = await db.select().from(resources)
      .where(and(
        inArray(resources.parentId, parentIds),
        // CLOSE / m3 — THE SITE PREDICATE BELONGS ON THE DESCENT TOO. It shipped on the ROOT query
        // only, so `resourceTree({ siteId: "main" })` would pull children from another site into a
        // tree that claims to be one site's. Inert today (production has exactly one site value,
        // spike Q4) and wrong the moment a second one exists — which is the case DD3's column was
        // added early precisely to make cheap.
        ...(opts.siteId === undefined ? [] : [eq(resources.siteId, opts.siteId)]),
      ))
      .orderBy(asc(resources.kind), asc(resources.code));
    const byParent = new Map(frontier.map((n) => [n.id, n]));
    const next: ResourceNode[] = [];
    for (const child of children) {
      // A row already placed is a CYCLE (or a diamond, which this table cannot hold): skip it
      // rather than descend into it. Without this line `A.parent = B; B.parent = A` yields six
      // levels of alternating duplicates even with the depth cap, which is a "terminating" reader
      // that still returns nonsense.
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const node = toNode(child);
      byParent.get(child.parentId!)?.children.push(node);
      next.push(node);
    }
    frontier = next;
  }
  return nodes;
}

export type ResourceBoardOptions = {
  kind: string;
  /** The parent whose DIRECT children to list. Omitted ⇒ roots of that kind. */
  parentId?: string;
  siteId?: string;
};

/**
 * A flat snapshot of the DIRECT children of one parent, of one kind, carrying status and the
 * occupancy triad. This is what §11.2's bed board renders.
 *
 * **`parentId` is a predicate, not a hint** (A7). A board query that filtered on `kind` alone and
 * dropped it returns every bed in the hospital — and a fixture with ONE parent cannot tell the two
 * apart, because `parentId` is constant across it.
 */
export async function resourceBoard(db: Db, opts: ResourceBoardOptions): Promise<ResourceBoardRow[]> {
  // CLOSE / M5 — as the tree above: `isNull` in SQL. `GET /resources/board?kind=bed` with no
  // parentId read EVERY bed row in the hospital to return the root-level ones, and it is behind a
  // live HTTP route.
  const direct = await db.select().from(resources)
    .where(and(
      eq(resources.kind, opts.kind),
      ...(opts.siteId === undefined ? [] : [eq(resources.siteId, opts.siteId)]),
      opts.parentId === undefined ? isNull(resources.parentId) : eq(resources.parentId, opts.parentId),
    ))
    .orderBy(asc(resources.code));
  // A board row is FLAT by construction rather than by stripping a `children` off a node: shipping
  // an always-empty `children: []` on a snapshot would invite a caller to render a TREE from a
  // query that fetched exactly one level.
  return direct.map((r) => ({
    id: r.id, kind: r.kind, code: r.code, name: r.name, status: r.status,
    parentId: r.parentId, siteId: r.siteId, attributes: r.attributes,
    occupantType: r.occupantType, occupantRef: r.occupantRef, since: r.since,
  }));
}

/**
 * EVERY resource of one kind, WHEREVER IT SITS IN THE TREE — PHASE 11i T2.
 *
 * `resourceBoard` and `resourceTree` both filter to ROOTS of a kind, because both answer "what is
 * directly under this parent" — a board is one level by construction. A readiness census asks a
 * different question: *does this hospital have a bench at all?* A bench parented under a floor is
 * still a bench, and a census built on `resourceBoard` would report a hospital with three nested
 * benches as having none. Two module reads already do this select by hand (`aerb/read.ts`'s
 * `unlicensedDevices` and `aerbPickers`, both `kind = 'device'`); this is the same read with a
 * name, so the next caller does not write a third copy.
 *
 * Retired rows are excluded by default: a retired bench is not a bench the lab can run on.
 */
export async function listResourcesOfKind(
  db: Db, kind: string, opts: { siteId?: string; includeRetired?: boolean } = {},
): Promise<ResourceBoardRow[]> {
  const rows = await db.select().from(resources)
    .where(and(
      eq(resources.kind, kind),
      ...(opts.siteId === undefined ? [] : [eq(resources.siteId, opts.siteId)]),
      ...(opts.includeRetired === true ? [] : [sql`${resources.status} <> 'retired'`]),
    ))
    .orderBy(asc(resources.code));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, code: r.code, name: r.name, status: r.status,
    parentId: r.parentId, siteId: r.siteId, attributes: r.attributes,
    occupantType: r.occupantType, occupantRef: r.occupantRef, since: r.since,
  }));
}

export type ResourceHistoryRow = typeof resourceStatusHistory.$inferSelect;

/**
 * One resource's transitions, **oldest first, ordered by `seq`.**
 *
 * `seq` and not `at`, and not `id`: ids are ULIDs and are never an ordering key (`ids.ts` WARNING,
 * ledger §3.26), and `at` is the injected instant, so two transitions can carry the same one. The
 * index `resource_status_history_resource_seq_idx` is exactly this read.
 */
export async function resourceHistory(
  db: Db,
  resourceId: string,
  opts: { limit?: number } = {},
): Promise<ResourceHistoryRow[]> {
  const q = db.select().from(resourceStatusHistory)
    .where(eq(resourceStatusHistory.resourceId, resourceId))
    .orderBy(asc(resourceStatusHistory.seq));
  return opts.limit === undefined ? q : q.limit(opts.limit);
}
