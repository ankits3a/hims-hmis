import { asc, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { resourceStatusHistory, resources } from "../db/schema";
import {
  KERNEL_RESOURCE_KINDS, MAX_RESOURCE_DEPTH, assignResource, changeResourceStatus, createResource,
  resourceBoard, resourceHistory, resourceTree,
} from "./index";
import type { ResourceNode } from "./read";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 13 T4 — the read surface, and Assertion Book rows A6 and A7.
 *
 * Both mutants were BUILT as separate scratch files beside the source, run isolated, and recorded
 * DIED with counts (AGENT-RULES rule 21).
 */
const ACTOR: Actor = { type: "user", id: "U-TEST" };
const KINDS = KERNEL_RESOURCE_KINDS;
const T0 = new Date("2026-08-26T10:00:00.000Z");
const T1 = new Date("2026-08-26T11:00:00.000Z");

describe("the resource registry read surface (Plan 13 T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function mk(kind: string, code: string, parentId: string | null = null): Promise<string> {
    const { resourceId } = await withTx(db, (tx) =>
      createResource(tx, ACTOR, KINDS, { kind, code, name: `${kind} ${code}`, parentId, at: T0 }));
    return resourceId;
  }

  /** `code` at every level, so a tree assertion reads as the shape it is testing. */
  function shape(nodes: ResourceNode[]): unknown {
    return nodes.map((n) => ({ code: n.code, children: shape(n.children) }));
  }

  function codes(nodes: { code: string }[]): string[] {
    return nodes.map((n) => n.code);
  }

  // ═══════════════════════════════════ the tree, normally ═══════════════════════════════════

  it("resourceTree nests children under parents and returns every root when none is named", async () => {
    const f1 = await mk("floor", "1");
    const w1 = await mk("ward", "W1", f1);
    await mk("bed", "B1", w1);
    await mk("bed", "B2", w1);
    const f2 = await mk("floor", "2");

    expect(shape(await resourceTree(db))).toEqual([
      { code: "1", children: [{ code: "W1", children: [{ code: "B1", children: [] }, { code: "B2", children: [] }] }] },
      { code: "2", children: [] },
    ]);
    expect(f2).not.toBe(f1);

    // Rooted at one node, the same tree without its sibling.
    expect(shape(await resourceTree(db, { rootId: w1 })))
      .toEqual([{ code: "W1", children: [{ code: "B1", children: [] }, { code: "B2", children: [] }] }]);
  });

  it("resourceTree's depth is CLAMPED to MAX_RESOURCE_DEPTH, and a caller asking for less gets less", async () => {
    let parent: string | null = null;
    for (let level = 1; level <= 6; level += 1) parent = await mk("ward", `L${level}`, parent);

    const deepestOf = (nodes: ResourceNode[], level = 1): number =>
      nodes.length === 0 ? level - 1 : Math.max(...nodes.map((n) => deepestOf(n.children, level + 1)));

    expect(deepestOf(await resourceTree(db, { depth: 2 }))).toBe(2);
    expect(deepestOf(await resourceTree(db))).toBe(MAX_RESOURCE_DEPTH);
    // 50 is not honoured; six is the structure's own bound and the reader owns it, not the caller.
    expect(deepestOf(await resourceTree(db, { depth: 50 }))).toBe(MAX_RESOURCE_DEPTH);
    expect(await resourceTree(db, { depth: 0 })).toEqual([]);
  });

  it("resourceTree scopes by site and by root kind", async () => {
    await mk("floor", "1");
    await withTx(db, (tx) => createResource(tx, ACTOR, KINDS, { kind: "floor", code: "1", name: "annexe floor", siteId: "annexe", at: T0 }));
    await mk("ward", "W-ROOT");

    expect(codes(await resourceTree(db, { siteId: "annexe" }))).toEqual(["1"]);
    expect(codes(await resourceTree(db, { kind: "ward" }))).toEqual(["W-ROOT"]);
    expect(codes(await resourceTree(db, { kind: "floor", siteId: "main" }))).toEqual(["1"]);
  });

  // ═══════════════════════════════════════════ A6 ═══════════════════════════════════════════

  /**
   * **A6 — `resourceTree` terminates and returns at most `MAX_RESOURCE_DEPTH` levels EVEN AGAINST A
   * DATABASE THAT CONTAINS A CYCLE.**
   *
   * MUTANT: `read.mutant-a6.ts`, a tree builder with no depth counter and no visited set.
   *
   * DISCRIMINATING INPUT: **a cycle inserted by RAW SQL — `A.parent = B; B.parent = A` — bypassing
   * T3's guard entirely.** This is the row that matters most in this task and it is the one an
   * executor is tempted to skip: **a tree test built only through the guarded write path can never
   * construct the input that discriminates**, because `moveResource` refuses to create it. The guard
   * and the reader must be proved independently, or the reader's termination is an inference from
   * someone else's correctness. §2.102 applied to a read.
   *
   * Note the two halves are SEPARATELY load-bearing, and the legs below prove each:
   *   · without the DEPTH CAP the walk never ends;
   *   · without the VISITED SET the walk ends (the cap stops it) and returns SIX LEVELS OF
   *     ALTERNATING DUPLICATES — a "terminating" reader that still answers nonsense.
   */
  it("A6: a cycle inserted by RAW SQL does not hang the tree reader, and does not duplicate a node either", async () => {
    const a = await mk("ward", "A");
    const b = await mk("ward", "B", a);
    // THE INPUT THE WRITE PATH REFUSES TO MAKE. `moveResource(a, b)` throws `cycle`; raw SQL does not.
    await db.execute(sql`update resources set parent_id = ${b} where id = ${a}`);
    const rows = await db.select().from(resources);
    expect(rows.map((r) => `${r.code}<-${r.parentId === a ? "A" : "B"}`).sort()).toEqual(["A<-B", "B<-A"]);

    // TERMINATES. Under the mutant this call does not return.
    const tree = await resourceTree(db);
    // Neither node is a ROOT any more — both have a parent — so an all-roots tree is empty, and
    // that is the honest answer for a corrupt subgraph rather than an invented one.
    expect(tree).toEqual([]);

    // Rooted AT one of them, the walk descends once and then refuses to revisit.
    const rooted = await resourceTree(db, { rootId: a });
    expect(shape(rooted)).toEqual([{ code: "A", children: [{ code: "B", children: [] }] }]);
    // The visited set is what makes that last `children: []` true: B's child IS A, already placed.
    const flatten = (nodes: ResourceNode[]): string[] => nodes.flatMap((n) => [n.id, ...flatten(n.children)]);
    expect(flatten(rooted)).toEqual([a, b]);
    expect(new Set(flatten(rooted)).size).toBe(2);
  });

  it("A6: a self-parent — the one-node cycle — is survived too", async () => {
    const a = await mk("ward", "A");
    await db.execute(sql`update resources set parent_id = ${a} where id = ${a}`);
    expect(await resourceTree(db)).toEqual([]);
    expect(shape(await resourceTree(db, { rootId: a }))).toEqual([{ code: "A", children: [] }]);
  });

  /**
   * A LONGER cycle, because a two-node one can be caught by an accidental `child.id !== parent.id`
   * check that is not a visited set at all. Three nodes A → B → C → A discriminate that.
   */
  it("A6: a three-node cycle is survived, and each node appears exactly once", async () => {
    const a = await mk("ward", "A");
    const b = await mk("ward", "B", a);
    const c = await mk("ward", "C", b);
    await db.execute(sql`update resources set parent_id = ${c} where id = ${a}`);

    const rooted = await resourceTree(db, { rootId: a });
    expect(shape(rooted)).toEqual([{ code: "A", children: [{ code: "B", children: [{ code: "C", children: [] }] }] }]);
    const flatten = (nodes: ResourceNode[]): string[] => nodes.flatMap((n) => [n.id, ...flatten(n.children)]);
    expect(flatten(rooted)).toEqual([a, b, c]);
  });

  // ═══════════════════════════════════════════ A7 ═══════════════════════════════════════════

  /**
   * **A7 — `resourceBoard({ kind, parentId })` returns exactly the DIRECT children of that parent of
   * that kind — never a grandchild, never a sibling parent's child.**
   *
   * MUTANT: `read.mutant-a7.ts`, a board query that filters on `kind` and drops the `parentId`
   * predicate.
   *
   * DISCRIMINATING INPUT: **TWO wards, each holding beds, plus one bed nested a level deeper.** A
   * fixture with ONE parent cannot discriminate: the unfiltered query returns the identical set.
   * §2.102 — name the field that coincides (with one parent, `parentId` is constant across the whole
   * fixture) and build the leg where it differs.
   */
  it("A7: the board is the DIRECT children of ONE parent — not a sibling's, not a grandchild", async () => {
    const w1 = await mk("ward", "W1");
    const w2 = await mk("ward", "W2");
    await mk("bed", "W1-B1", w1);
    await mk("bed", "W1-B2", w1);
    const w2b1 = await mk("bed", "W2-B1", w2);
    // The grandchild: a bed under a bed. DD7 permits it deliberately — there is no containment
    // matrix — which is exactly why the board has to exclude it by DEPTH rather than by kind.
    await mk("bed", "W2-B1-A", w2b1);

    // THE DISCRIMINATING LEG. With one ward in the fixture these three would be identical.
    expect(codes(await resourceBoard(db, { kind: "bed", parentId: w1 }))).toEqual(["W1-B1", "W1-B2"]);
    expect(codes(await resourceBoard(db, { kind: "bed", parentId: w2 }))).toEqual(["W2-B1"]);
    expect(codes(await resourceBoard(db, { kind: "bed", parentId: w2b1 }))).toEqual(["W2-B1-A"]);
    // …and the unfiltered set is genuinely DIFFERENT from each of them, which is what makes the
    // three assertions above evidence rather than coincidence.
    const all = await db.select().from(resources).orderBy(asc(resources.code));
    expect(all.filter((r) => r.kind === "bed")).toHaveLength(4);
  });

  it("A7: the board carries status and the whole occupancy triad, which is what a bed board renders", async () => {
    const w1 = await mk("ward", "W1");
    const b1 = await mk("bed", "B1", w1);
    await mk("bed", "B2", w1);
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, b1, { occupantType: "admission", occupantRef: "ADM-1", at: T1 }));

    const board = await resourceBoard(db, { kind: "bed", parentId: w1 });
    expect(board.map((r) => ({ code: r.code, status: r.status, t: r.occupantType, ref: r.occupantRef, since: r.since })))
      .toEqual([
        { code: "B1", status: "occupied", t: "admission", ref: "ADM-1", since: T1 },
        { code: "B2", status: "available", t: null, ref: null, since: null },
      ]);
    // A board row is FLAT — it is a snapshot, not a subtree, and shipping `children` on it would
    // invite a caller to render a tree from a query that fetched one level.
    expect(board[0]).not.toHaveProperty("children");
  });

  it("A7: with no parentId the board is the ROOTS of that kind, and roots are not everything", async () => {
    const w1 = await mk("ward", "W1");
    await mk("bed", "LOOSE", null); // a bed hanging at the root — legal, DD7 has no matrix
    await mk("bed", "IN-W1", w1);
    expect(codes(await resourceBoard(db, { kind: "bed" }))).toEqual(["LOOSE"]);
    expect(codes(await resourceBoard(db, { kind: "ward" }))).toEqual(["W1"]);
  });

  it("A7: the board scopes by site", async () => {
    await mk("bed", "B1");
    await withTx(db, (tx) => createResource(tx, ACTOR, KINDS, { kind: "bed", code: "B1", name: "annexe bed", siteId: "annexe", at: T0 }));
    expect(await resourceBoard(db, { kind: "bed", siteId: "annexe" })).toHaveLength(1);
    expect(await resourceBoard(db, { kind: "bed" })).toHaveLength(2);
  });

  // ══════════════════════════════════════ the history ══════════════════════════════════════

  it("resourceHistory is one resource's transitions, oldest first, by seq — and it is scoped to that resource", async () => {
    const b1 = await mk("bed", "B1");
    const b2 = await mk("bed", "B2");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b1, "blocked", { reason: "repair", at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b2, "cleaning", { at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b1, "available", { at: T1 }));

    const history = await resourceHistory(db, b1);
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "available"], ["available", "blocked"], ["blocked", "available"],
    ]);
    // B2's rows are interleaved by seq in the table and must not appear here.
    expect(await db.select().from(resourceStatusHistory)).toHaveLength(5);
    expect(history.every((h) => h.resourceId === b1)).toBe(true);
  });

  it("resourceHistory's limit takes the OLDEST rows, so a limited read is a prefix and not a sample", async () => {
    const b1 = await mk("bed", "B1");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b1, "blocked", { at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b1, "available", { at: T1 }));
    expect((await resourceHistory(db, b1, { limit: 2 })).map((h) => h.toStatus)).toEqual(["available", "blocked"]);
  });

  it("resourceHistory for a resource with no history is empty rather than an error", async () => {
    expect(await resourceHistory(db, "NOSUCH")).toEqual([]);
  });
});
