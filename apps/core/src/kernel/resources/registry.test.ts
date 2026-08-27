import { asc, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { events, resourceStatusHistory, resources } from "../db/schema";
import {
  KERNEL_RESOURCE_KINDS, assignResource, changeResourceStatus, createResource, moveResource,
  releaseResource, retireResource, updateResource,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 13 T3 — the write surface, and the five Assertion Book rows A1–A5.
 *
 * Every row's mutant was BUILT as a separate scratch file beside this one, run isolated, and
 * recorded DIED with counts (AGENT-RULES rule 21). The comments below name each mutant and say
 * which fixture kills it — and, where an obvious-looking input would NOT discriminate, they say
 * that too, because the next reader will reach for it.
 */
const ACTOR: Actor = { type: "user", id: "U-TEST" };
const KINDS = KERNEL_RESOURCE_KINDS;

/** A fixed instant so `since` and history `at` are asserted by VALUE rather than by ordering luck. */
const T0 = new Date("2026-08-26T10:00:00.000Z");
const T1 = new Date("2026-08-26T11:00:00.000Z");
const T2 = new Date("2026-08-26T12:00:00.000Z");

describe("the resource registry write surface (Plan 13 T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function mk(kind: string, code: string, over: Record<string, unknown> = {}): Promise<string> {
    const { resourceId } = await withTx(db, (tx) =>
      createResource(tx, ACTOR, KINDS, { kind, code, name: `${kind} ${code}`, at: T0, ...over }));
    return resourceId;
  }

  async function rowOf(id: string) {
    const rows = await db.select().from(resources).where(eq(resources.id, id));
    return rows[0]!;
  }

  async function historyOf(id: string) {
    return db.select().from(resourceStatusHistory)
      .where(eq(resourceStatusHistory.resourceId, id))
      .orderBy(asc(resourceStatusHistory.seq));
  }

  async function eventNames(): Promise<string[]> {
    const rows = await db.select({ name: events.name }).from(events).orderBy(asc(events.seq));
    return rows.map((r) => r.name);
  }

  // ═══════════════════════════════ the basics the rows build on ═══════════════════════════════

  it("createResource registers a place, stamps audit, and appends one history row and one event", async () => {
    const id = await mk("room", "12");
    const row = await rowOf(id);
    expect({ kind: row.kind, code: row.code, status: row.status, siteId: row.siteId, parentId: row.parentId })
      .toEqual({ kind: "room", code: "12", status: "available", siteId: "main", parentId: null });
    expect({ createdBy: row.createdBy, updatedBy: row.updatedBy }).toEqual({ createdBy: "U-TEST", updatedBy: "U-TEST" });
    expect(await historyOf(id)).toHaveLength(1);
    expect(await eventNames()).toEqual(["resource.registered"]);
  });

  it("a duplicate (site, kind, code) is a typed refusal and leaves ONE row", async () => {
    await mk("room", "B-4");
    await expect(mk("room", "b-4")).rejects.toMatchObject({ code: "duplicate_code" });
    expect(await db.select().from(resources)).toHaveLength(1);
    // A bed '12' and a room '12' are different things — DD13's whole reason for scoping the index.
    await mk("bed", "B-4");
    expect((await db.select().from(resources)).map((r) => r.kind).sort()).toEqual(["bed", "room"]);
  });

  it("an explicit status outside the kind's vocabulary is refused, and the default is the declared `initial`", async () => {
    await expect(mk("floor", "1", { status: "cleaning" })).rejects.toMatchObject({ code: "unknown_status" });
    // `cleaning` IS a legal status — for a bed. A floor does not admit it, and the vocabulary is
    // per-kind precisely so that this refusal is possible at all (no CHECK could express it).
    const bedId = await mk("bed", "1", { status: "cleaning" });
    expect((await rowOf(bedId)).status).toBe("cleaning");
    expect((await rowOf(await mk("floor", "2"))).status).toBe("available");
  });

  it("updateResource changes the description and emits `resource.updated` naming the fields that moved", async () => {
    const id = await mk("room", "12");
    await withTx(db, (tx) => updateResource(tx, ACTOR, KINDS, id, { name: "Consult Room 12", attributes: { floor: "2" } }, { at: T1 }));
    const row = await rowOf(id);
    expect({ name: row.name, attributes: row.attributes }).toEqual({ name: "Consult Room 12", attributes: { floor: "2" } });
    expect(await eventNames()).toEqual(["resource.registered", "resource.updated"]);
    // A patch that changes nothing writes nothing — no row touched, no event, no noise in the log.
    await withTx(db, (tx) => updateResource(tx, ACTOR, KINDS, id, {}, { at: T2 }));
    expect(await eventNames()).toEqual(["resource.registered", "resource.updated"]);
  });

  it("retireResource is a status move and not a delete, and an OCCUPIED resource cannot be retired", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T1 }));
    await expect(
      withTx(db, (tx) => retireResource(tx, ACTOR, KINDS, id)),
    ).rejects.toMatchObject({ code: "already_occupied" });
    await withTx(db, (tx) => releaseResource(tx, ACTOR, KINDS, id, { at: T2 }));
    await withTx(db, (tx) => retireResource(tx, ACTOR, KINDS, id, { at: T2 }));
    expect((await rowOf(id)).status).toBe("retired");
    // The row and its whole history survive: every `occupant_ref` that ever named it is still true.
    expect((await historyOf(id)).map((h) => h.toStatus)).toEqual(["available", "occupied", "cleaning", "retired"]);
  });

  // ═══════════════════════════════════════════ A1 ═══════════════════════════════════════════

  /**
   * **A1 — a move that would make a resource its own ancestor is refused with `cycle`, AT ANY DEPTH.**
   *
   * MUTANT: `registry.mutant.ts`, whose ancestor check is `if (newParentId === id) throw cycle` —
   * the one-hop case only.
   *
   * DISCRIMINATING INPUT: a three-level chain `floor → room → bed`, then `moveResource(floor, under:
   * bed)`. The one-hop mutant sees `floor.parentId` becoming `bed.id ≠ floor.id` and ALLOWS it; the
   * shipped walk reaches `floor` from `bed` and refuses.
   *
   * **The obvious input — `moveResource(x, under: x)` — does NOT discriminate: both implementations
   * refuse it.** It is asserted below anyway, and labelled, because the next reader will reach for
   * it and should find out here rather than by writing a mutant that survives.
   */
  it("A1: a move that would make a resource its own ancestor is refused at ANY depth, not just one hop", async () => {
    const floor = await mk("floor", "1");
    const room = await mk("room", "12", { parentId: floor });
    const bed = await mk("bed", "12-A", { parentId: room });

    // THE DISCRIMINATING LEG: three levels up, so the one-hop check cannot see it.
    await expect(
      withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, floor, bed)),
    ).rejects.toMatchObject({ code: "cycle" });
    // …and two levels up, which the one-hop check also cannot see.
    await expect(
      withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, floor, room)),
    ).rejects.toMatchObject({ code: "cycle" });

    // THIS LEG DOES NOT DISCRIMINATE — the one-hop mutant refuses it too. Kept as documentation of
    // the input a reader will reach for first, never as evidence.
    await expect(
      withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, floor, floor)),
    ).rejects.toMatchObject({ code: "cycle" });

    // Nothing moved: a refused move is a refused move, not a partial one.
    expect((await rowOf(floor)).parentId).toBeNull();
    // And a LEGAL move still works — a guard that refuses everything would pass every leg above.
    const otherFloor = await mk("floor", "2");
    await withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, room, otherFloor));
    expect((await rowOf(room)).parentId).toBe(otherFloor);
  });

  // ═══════════════════════════════════════════ A2 ═══════════════════════════════════════════

  /**
   * **A2 — the occupancy triad moves together.**
   *
   * MUTANT: a `releaseResource` that clears `occupantRef` and `occupantType` but leaves `since`
   * standing.
   *
   * DISCRIMINATING INPUT: **assign → release → RE-assign, asserting `since` equals the SECOND
   * assignment's instant.** A single assign-then-release leg asserting `since === null` would kill
   * that mutant too; the re-assign leg is what proves the field is re-STAMPED rather than merely
   * cleared. §2.102: a fixture that never re-uses a resource cannot tell a stale timestamp from a
   * fresh one.
   *
   * ═══ CORRECTED IN EXECUTION — THE PLAN'S A2 ROW CLAIMED ONE KILL IT DOES NOT GET (F1) ═══
   *
   * The plan says the re-assign leg *"kills both"* — the mutant above AND its sneakier sibling, an
   * `assignResource` that sets `since` only when it is currently null (`since: existing.since ?? at`).
   * **IT DOES NOT.** `registry.mutant-a2b.ts` was built and run isolated and SURVIVED, 17/17 passed.
   *
   * The reason is worth writing down because it is the general shape: after a CORRECT release,
   * `since` is always null, so `existing.since ?? at` always evaluates to `at`. Through the shipped
   * write path the sibling is an EQUIVALENT mutant — it is reachable only from a state the shipped
   * release cannot produce. A fixture built entirely through the guarded path can never construct
   * the input that discriminates it, which is A6's lesson arriving one row early.
   *
   * So the leg below builds that state the way A6 builds its cycle: **by RAW SQL**, an inconsistent
   * row carrying a stale `since` with no occupant. That kills the sibling and is the only thing
   * that does.
   */
  it("A2: assign, release and RE-assign move all three triad fields together, and `since` is the SECOND assignment's instant", async () => {
    const id = await mk("bed", "1");

    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T0 }));
    const assigned = await rowOf(id);
    expect({ t: assigned.occupantType, r: assigned.occupantRef, s: assigned.since, st: assigned.status })
      .toEqual({ t: "admission", r: "ADM-1", s: T0, st: "occupied" });

    await withTx(db, (tx) => releaseResource(tx, ACTOR, KINDS, id, { at: T1 }));
    const released = await rowOf(id);
    // `onRelease` for a bed is CLEANING, not available — §11.2's discharge cascade in one field.
    expect({ t: released.occupantType, r: released.occupantRef, s: released.since, st: released.status })
      .toEqual({ t: null, r: null, s: null, st: "cleaning" });

    // THE LEG THAT KILLS BOTH MUTANTS. A second occupant, a second instant.
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-2", at: T2 }));
    const reassigned = await rowOf(id);
    expect({ t: reassigned.occupantType, r: reassigned.occupantRef, s: reassigned.since })
      .toEqual({ t: "admission", r: "ADM-2", s: T2 });
    expect(reassigned.since).not.toEqual(T0);
  });

  /**
   * F1's corrected leg — see the block above. The row is constructed by RAW SQL because the shipped
   * write path cannot produce it: a stale `since` standing on a resource with no occupant. Against
   * `since: existing.since ?? at` the stale instant survives the assignment; against the shipped
   * unconditional stamp it is replaced.
   */
  it("A2: `since` is stamped UNCONDITIONALLY — a stale value on an unoccupied row does not survive an assignment", async () => {
    const id = await mk("bed", "1");
    await db.execute(sql`update resources set since = ${T0.toISOString()} where id = ${id}`);
    expect((await rowOf(id)).since).toEqual(T0);

    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T2 }));
    expect((await rowOf(id)).since).toEqual(T2);
  });

  it("A2: assigning an occupied resource throws `already_occupied`; releasing a free one throws `not_occupied`", async () => {
    const id = await mk("bed", "1");
    await expect(
      withTx(db, (tx) => releaseResource(tx, ACTOR, KINDS, id)),
    ).rejects.toMatchObject({ code: "not_occupied" });

    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T0 }));
    await expect(
      withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-2", at: T1 })),
    ).rejects.toMatchObject({ code: "already_occupied" });
    // The first occupant is untouched — a refused assignment must not half-evict anybody.
    expect((await rowOf(id)).occupantRef).toBe("ADM-1");
  });

  it("A2: a kind declaring `occupied: null` is not assignable at all", async () => {
    const floor = await mk("floor", "1");
    await expect(
      withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, floor, { occupantType: "admission", occupantRef: "ADM-1" })),
    ).rejects.toMatchObject({ code: "not_assignable" });
  });

  // ═══════════════════════════════════════════ A3 ═══════════════════════════════════════════

  /**
   * **A3 — `resource_status_history` is append-only and each row's `fromStatus` is the value that
   * was there BEFORE.**
   *
   * MUTANT: a `changeResourceStatus` that reads `fromStatus` from the row AFTER updating it, so
   * every row records `from === to`.
   *
   * DISCRIMINATING INPUT: **two consecutive DIFFERENT transitions on one resource — `available →
   * blocked → available` — asserted as an ordered triple WITH the creation row.** A fixture that
   * transitions `available → available` hides it completely (the shipped code returns early and
   * writes nothing); a single transition proves only half, catching the value but not the ordering.
   * §2.102, and §2.93's shape one layer out: a formula verified where its operands coincide has not
   * been verified.
   */
  it("A3: history is the ordered triple (null→available), (available→blocked), (blocked→available), by seq", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "blocked", { reason: "repair", at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "available", { reason: "repaired", at: T2 }));

    const history = await historyOf(id);
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "available"],
      ["available", "blocked"],
      ["blocked", "available"],
    ]);
    // `seq` is the ordering key and it is strictly increasing — ids are ULIDs and are never one.
    expect(history.map((h) => h.seq)).toEqual([...history.map((h) => h.seq)].sort((a, b) => a - b));
    expect(new Set(history.map((h) => h.seq)).size).toBe(3);
    expect(history.map((h) => h.reason)).toEqual(["registered", "repair", "repaired"]);
    expect(await eventNames()).toEqual(["resource.registered", "resource.status_changed", "resource.status_changed"]);
  });

  /**
   * ═══ CLOSE / M1 — DD6's BICONTIDIONAL, PINNED WHERE IT WAS NOT ═══
   *
   * The independent reviewer found that `changeResourceStatus` enforced the occupancy invariant
   * nowhere: A2 covered `assignResource`/`releaseResource` and nothing covered the third door.
   * These are the legs that were missing, and each one names the state that was reachable.
   */
  it("M1: `changeResourceStatus` cannot manufacture an occupied resource with no occupant", async () => {
    const id = await mk("bed", "1");
    await expect(
      withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "occupied", { at: T1 })),
    ).rejects.toMatchObject({ code: "not_occupied" });
    // Nothing moved. A board reading `status='occupied'` would have rendered a bed with nobody in it.
    expect((await rowOf(id)).status).toBe("available");
    expect(await historyOf(id)).toHaveLength(1);
  });

  it("M1: `changeResourceStatus` cannot free an occupied resource behind the triad's back", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T0 }));
    // THE ROW THAT MATTERS: a bed picker filtering `status='available'` — the query
    // `resources_kind_status_idx` exists for — would have offered this bed with a patient in it.
    await expect(
      withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "available", { at: T1 })),
    ).rejects.toMatchObject({ code: "already_occupied" });
    await expect(
      withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "blocked", { at: T1 })),
    ).rejects.toMatchObject({ code: "already_occupied" });
    // …and the same door `retireResource` already guarded, which this one used to bypass.
    await expect(
      withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "retired", { at: T1 })),
    ).rejects.toMatchObject({ code: "already_occupied" });

    const row = await rowOf(id);
    expect({ st: row.status, r: row.occupantRef, s: row.since }).toEqual({ st: "occupied", r: "ADM-1", s: T0 });
  });

  it("M1: the guard applies only to assignable kinds — a floor's statuses still move freely", async () => {
    const floor = await mk("floor", "1");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, floor, "blocked", { at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, floor, "available", { at: T2 }));
    expect((await historyOf(floor)).map((h) => h.toStatus)).toEqual(["available", "blocked", "available"]);
  });

  it("M1: release then re-status still works — the guard refuses the SHORTCUT, not the sequence", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, id, { occupantType: "admission", occupantRef: "ADM-1", at: T0 }));
    await withTx(db, (tx) => releaseResource(tx, ACTOR, KINDS, id, { at: T1 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "available", { at: T2 }));
    expect((await historyOf(id)).map((h) => h.toStatus)).toEqual(["available", "occupied", "cleaning", "available"]);
  });

  it("A3: a no-op transition writes NOTHING — no history row, no event", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "available", { at: T1 }));
    expect(await historyOf(id)).toHaveLength(1);
    expect(await eventNames()).toEqual(["resource.registered"]);
  });

  /**
   * Append-only is not enforced by a trigger — it is enforced by there being NO CODE that updates
   * or deletes this table, so the instrument is mechanical rather than behavioural. Asserted here
   * so the property has a home; the grep is repeated at close over the whole tree.
   */
  it("A3: nothing in the registry updates or deletes a history row — the table has one writer", async () => {
    const id = await mk("bed", "1");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "blocked", { at: T1 }));
    const before = await historyOf(id);
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, id, "cleaning", { at: T2 }));
    const after = await historyOf(id);
    // The rows that existed are byte-identical afterwards; the only change is one MORE row.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  // ═══════════════════════════════════════════ A4 ═══════════════════════════════════════════

  /**
   * **A4 — a kind or a status that no INSTALLED manifest declares is refused.**
   *
   * MUTANT: a validator that checks `kind` against the `ResourceKind` union (the TYPE) instead of
   * the boot-collected declarations.
   *
   * DISCRIMINATING INPUT: **`kind: "theatre"`.** It is a member of the union — so a type-only check
   * passes it — and NO manifest declares it in this phase (Plan 15 will). **A nonsense kind like
   * `"banana"` does NOT discriminate: it fails both checks.** This input is the whole distinction
   * between "a legal string" and "a kind this hospital has".
   */
  it("A4: `theatre` is a legal string and not a kind this hospital has — refused, while `banana` proves nothing", async () => {
    // THE DISCRIMINATING LEG. `theatre` is in the union AND in the resources_kind_ck CHECK, so
    // Postgres would store it; only the declaration check refuses it.
    await expect(mk("theatre", "OT-1")).rejects.toMatchObject({ code: "unknown_kind" });

    // NON-DISCRIMINATING, and labelled so nobody mistakes it for the row's evidence: `banana` is
    // outside the union, outside the CHECK and outside the declarations, so it fails everywhere.
    await expect(mk("banana", "X")).rejects.toMatchObject({ code: "unknown_kind" });

    // Nothing was written by either refusal.
    expect(await db.select().from(resources)).toHaveLength(0);
    // …and the five kernel kinds ARE creatable, so the guard is not simply refusing everything.
    for (const kind of ["floor", "ward", "hall", "room", "bed"]) await mk(kind, `C-${kind}`);
    expect(await db.select().from(resources)).toHaveLength(5);
  });

  it("A4: every write function refuses an undeclared kind, not just createResource", async () => {
    // A row whose kind no manifest declares can exist — raw SQL and T6's backfill both bypass the
    // application. Every function that touches it must refuse rather than guess a vocabulary.
    await db.execute(sql`
      insert into resources (id, kind, code, name, status, site_id, created_by, updated_by)
      values ('R-OT', 'theatre', 'OT-1', 'Theatre 1', 'available', 'main', 'raw', 'raw')
    `);
    const undeclared = { code: "unknown_kind" };
    await expect(withTx(db, (tx) => updateResource(tx, ACTOR, KINDS, "R-OT", { name: "x" }))).rejects.toMatchObject(undeclared);
    await expect(withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, "R-OT", null))).rejects.toMatchObject(undeclared);
    await expect(withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, "R-OT", "blocked"))).rejects.toMatchObject(undeclared);
    await expect(withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, "R-OT", { occupantType: "run", occupantRef: "X" }))).rejects.toMatchObject(undeclared);
    await expect(withTx(db, (tx) => retireResource(tx, ACTOR, KINDS, "R-OT"))).rejects.toMatchObject(undeclared);
  });

  it("A4: a status outside the kind's vocabulary is refused on the change path too", async () => {
    const floor = await mk("floor", "1");
    await expect(
      withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, floor, "cleaning", { at: T1 })),
    ).rejects.toMatchObject({ code: "unknown_status" });
  });

  // ═══════════════════════════════════════════ A5 ═══════════════════════════════════════════

  /**
   * **A5 — `MAX_RESOURCE_DEPTH` is enforced on the write path, and it is read from `kinds.ts`
   * rather than restated.**
   *
   * MUTANT: a `createResource`/`moveResource` with the depth counter removed.
   *
   * DISCRIMINATING INPUT: **a seven-deep chain built one `createResource` at a time.** The SEVENTH
   * call throws `too_deep` against the shipped code and succeeds against the mutant. Six or fewer
   * does not discriminate — the cap is six.
   */
  it("A5: the seventh level is refused with `too_deep`, and the sixth is not", async () => {
    let parent: string | null = null;
    for (let level = 1; level <= 6; level += 1) {
      parent = await mk("ward", `L${level}`, { parentId: parent });
    }
    // SIX is legal. A test that stopped here would pass against the mutant too.
    expect(await db.select().from(resources)).toHaveLength(6);
    await expect(mk("ward", "L7", { parentId: parent })).rejects.toMatchObject({ code: "too_deep" });
    expect(await db.select().from(resources)).toHaveLength(6);
  });

  /**
   * A MOVE MUST COUNT THE WHOLE SUBTREE, not just the node being moved. Re-parenting a three-level
   * branch under a four-level chain puts its leaf at level SEVEN while the moved node itself lands
   * at five — so a depth check that measured only the moved node would allow it.
   */
  it("A5: a move counts the moved subtree's own height, not just the node", async () => {
    let deep: string | null = null;
    for (let level = 1; level <= 4; level += 1) deep = await mk("ward", `D${level}`, { parentId: deep });

    const branchRoot = await mk("ward", "B1");
    const branchMid = await mk("ward", "B2", { parentId: branchRoot });
    await mk("bed", "B3", { parentId: branchMid });

    // branchRoot is 3 levels tall; under a 4-deep chain its leaf would be at 7.
    await expect(
      withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, branchRoot, deep)),
    ).rejects.toMatchObject({ code: "too_deep" });
    expect((await rowOf(branchRoot)).parentId).toBeNull();

    // Under a 3-deep chain the same branch lands exactly at the cap and is allowed.
    const threeDeep = await db.select({ id: resources.id }).from(resources).where(eq(resources.code, "D3"));
    await withTx(db, (tx) => moveResource(tx, ACTOR, KINDS, branchRoot, threeDeep[0]!.id));
    expect((await rowOf(branchRoot)).parentId).toBe(threeDeep[0]!.id);
  });
});
