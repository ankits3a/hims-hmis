import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../events/append";
import { resourceStatusHistory, resources } from "../db/schema";
import { ResourceError } from "./errors";
import { MAX_RESOURCE_DEPTH, findKindDecl } from "./kinds";
import {
  resourceAssigned, resourceRegistered, resourceReleased, resourceStatusChanged, resourceUpdated,
} from "./events";
import type { Actor } from "@hmis/contracts";
import type { ResourceKindDecl } from "./kinds";
import type { Tx } from "../db/client";

/**
 * PLAN 13 T3 — the resource registry's WRITE SURFACE.
 *
 * Seven functions, all `(tx, actor, kinds, …)`, the `opd/masters.ts` and `formulary/masters.ts`
 * shape. Each writes its event INSIDE THE CALLER'S TRANSACTION; each status change appends exactly
 * one `resource_status_history` row; **creation appends its row with `fromStatus: null`.**
 *
 * ═══ WHY `kinds` IS A REQUIRED THIRD PARAMETER AND NOT A DEFAULT ═══
 *
 * A4's whole point is the difference between *a legal string* and *a kind this hospital has*:
 * `theatre` is in the `resources_kind_ck` CHECK, so Postgres would store it, and it becomes
 * creatable only when Plan 15 installs the manifest that declares it. Which means the write path
 * must validate against the DECLARATIONS OF THE INSTALLED MANIFESTS, not against the union.
 *
 * The obvious alternatives were both worse:
 *   · **A module-level set assigned at boot** — a mutable global whose value depends on whether
 *     something booted, which makes every test either a boot or a lie.
 *   · **A default of `KERNEL_RESOURCE_KINDS`** — silently correct today and silently WRONG the day
 *     Plan 15 declares `theatre` on its own manifest, because a caller that forgot the argument
 *     would refuse a kind that is properly declared. A default that goes stale without a
 *     typecheck error is the same shape as §2.54's two copies.
 *
 * A required parameter cannot go stale. `modules/opd/masters.ts` passes `KERNEL_RESOURCE_KINDS`
 * (T6) and that is exactly right rather than a shortcut: `room` IS a kernel kind, and OPD creating
 * a theatre is a thing that should not compile past review, let alone run.
 *
 * ═══ THE ANCESTOR WALK IS BOUNDED, AND IT REPORTS `too_deep` FOR A DATABASE-LEVEL CYCLE ═══
 *
 * `ancestorsOf` walks `parent_id` upward at most `MAX_RESOURCE_DEPTH + 1` times. Against a tree it
 * reaches the root; against a database that already contains a cycle — which raw SQL can insert
 * and `resources.test.ts` proves Postgres will accept — it hits the cap and the caller answers
 * `too_deep` rather than looping forever. **That is a deliberate second-best**: the honest answer
 * would be "this tree is corrupt", the union has no code for it, and the plan's §5 closes the union
 * at T2. Reported here rather than fixed silently; the reader's own independent termination is A6.
 */

/** The `billing/sessions.ts` helper, same shape: a raw 23505 under a race becomes a typed refusal. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

type ResourceRow = typeof resources.$inferSelect;

/** The declaration for `row.kind`, or `unknown_kind`. */
function requireDecl(kinds: readonly ResourceKindDecl[], kind: string): ResourceKindDecl {
  const decl = findKindDecl(kinds, kind);
  if (decl === undefined) {
    throw new ResourceError(
      "unknown_kind",
      `"${kind}" is not a resource kind this hospital has — no installed manifest declares it`,
    );
  }
  return decl;
}

async function requireResource(tx: Tx, id: string): Promise<ResourceRow> {
  const rows = await tx.select().from(resources).where(eq(resources.id, id));
  const row = rows[0];
  if (row === undefined) throw new ResourceError("unknown_resource", `resource ${id} not found`);
  return row;
}

/**
 * The ids from `id`'s parent up to the root, nearest first. Bounded — see the header.
 *
 * It is deliberately NOT a recursive CTE. There is no `WITH RECURSIVE` anywhere in this repository
 * (measured at plan time), a recursive CTE has no natural cap, and the bound is the whole point:
 * this walk runs on the write path against a table raw SQL can corrupt.
 */
async function ancestorsOf(tx: Tx, id: string | null): Promise<string[]> {
  const chain: string[] = [];
  let cursor = id;
  for (let hop = 0; hop <= MAX_RESOURCE_DEPTH && cursor !== null; hop += 1) {
    chain.push(cursor);
    const rows = await tx.select({ parentId: resources.parentId }).from(resources).where(eq(resources.id, cursor));
    const row = rows[0];
    if (row === undefined) {
      throw new ResourceError("unknown_resource", `resource ${cursor} not found (walking ancestors)`);
    }
    cursor = row.parentId;
  }
  return chain;
}

/**
 * How many levels hang BELOW `id`, counting `id` itself as 1. Bounded at `MAX_RESOURCE_DEPTH + 1`
 * levels and returns that ceiling rather than the truth when the subtree is deeper.
 *
 * **A move must check the whole subtree, not just the moved node**, and this is the half that is
 * easy to miss: re-parenting a ward under a room is legal for the ward and can push its beds past
 * the cap. Level-by-level rather than per-node, so a wide floor costs one query per LEVEL.
 */
async function subtreeHeight(tx: Tx, id: string): Promise<number> {
  let frontier = [id];
  let height = 0;
  while (frontier.length > 0 && height <= MAX_RESOURCE_DEPTH) {
    height += 1;
    // CLOSE / M5 — the predicate is IN SQL and it uses `resources_parent_idx`. This shipped as an
    // unfiltered `select … from resources` filtered in JS: a FULL TABLE SCAN, once per level, up to
    // seven times, INSIDE THE CALLER'S WRITE TRANSACTION, on every move. Correct and a scaling
    // landmine on the one table the IPD cluster is about to make large.
    const rows = await tx.select({ id: resources.id }).from(resources)
      .where(inArray(resources.parentId, frontier));
    frontier = rows.map((r) => r.id);
  }
  return height;
}

/** Refuses `too_deep` when placing a node of height `height` under `parentId` would exceed the cap. */
async function requireDepth(tx: Tx, parentId: string | null, height: number): Promise<void> {
  const above = parentId === null ? 0 : (await ancestorsOf(tx, parentId)).length;
  if (above + height > MAX_RESOURCE_DEPTH) {
    throw new ResourceError(
      "too_deep",
      `that placement would be ${above + height} levels deep and MAX_RESOURCE_DEPTH is ${MAX_RESOURCE_DEPTH}`,
      { above, height, max: MAX_RESOURCE_DEPTH },
    );
  }
}

/** One history row. The ONLY writer of this table in the codebase — there is no update and no delete path (A3). */
async function appendHistory(
  tx: Tx,
  actor: Actor,
  row: { resourceId: string; fromStatus: string | null; toStatus: string; occupantType: string | null; occupantRef: string | null; reason: string | null; at: Date },
): Promise<void> {
  await tx.insert(resourceStatusHistory).values({ id: newId(), actorId: actor.id, ...row });
}

/** The four fields every event payload in this catalog identifies its subject by. */
function subjectOf(row: Pick<ResourceRow, "id" | "kind" | "code" | "siteId">) {
  return { resourceId: row.id, kind: row.kind, code: row.code, siteId: row.siteId };
}

export type CreateResourceInput = {
  kind: string;
  code: string;
  name: string;
  parentId?: string | null;
  siteId?: string;
  attributes?: Record<string, unknown>;
  /** Defaults to the kind's declared `initial`. An explicit value must be in the kind's vocabulary. */
  status?: string;
  /** The injected instant — `operating_mode_changes.at`'s convention. Defaults to now. */
  at?: Date;
};

/**
 * Register a place. Appends the creation history row with **`fromStatus: null`** — "there was no
 * previous status" is a fact, and writing the initial status into both columns would make every row
 * read `from === to` at the exact point the distinction first matters (A3's mutant).
 */
export async function createResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  input: CreateResourceInput,
): Promise<{ resourceId: string }> {
  const decl = requireDecl(kinds, input.kind);
  const status = input.status ?? decl.initial;
  if (!decl.statuses.includes(status)) {
    throw new ResourceError("unknown_status", `"${status}" is not a status the kind "${input.kind}" admits`);
  }
  const parentId = input.parentId ?? null;
  if (parentId !== null) await requireResource(tx, parentId);
  await requireDepth(tx, parentId, 1);

  const id = newId();
  const at = input.at ?? new Date();
  const siteId = input.siteId ?? "main";
  try {
    await tx.insert(resources).values({
      id, kind: input.kind, parentId, code: input.code, name: input.name,
      attributes: input.attributes ?? {}, status, siteId,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    // `resources_site_kind_code_lower_ux` is an EXPRESSION index, so there is no
    // `onConflictDoNothing` target to name — the refusal is read off the violation instead (the
    // `formulary/masters.ts` and tariff `services.ts` precedent).
    if (isUniqueViolation(e)) {
      throw new ResourceError("duplicate_code", `a ${input.kind} with code "${input.code}" already exists at site "${siteId}"`);
    }
    throw e;
  }
  await appendHistory(tx, actor, {
    resourceId: id, fromStatus: null, toStatus: status, occupantType: null, occupantRef: null,
    reason: "registered", at,
  });
  await appendEvent(tx, resourceRegistered.make({
    payload: { resourceId: id, kind: input.kind, code: input.code, siteId, name: input.name, parentId, status },
    actor, correlationId: id, occurredAt: at,
  }));
  return { resourceId: id };
}

/**
 * Change a place's description — its `name`, its `code`, its `attributes`. **NOT its parent** (that
 * is `moveResource`) and **not its status** (that is `changeResourceStatus`): a function that could
 * change any of the three would make `resource.updated` and `resource.status_changed` overlap, and
 * a consumer would have to read both to know what happened.
 */
export async function updateResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  patch: { name?: string; code?: string; attributes?: Record<string, unknown> },
  opts: { at?: Date } = {},
): Promise<void> {
  const existing = await requireResource(tx, id);
  requireDecl(kinds, existing.kind);
  const changed = (["name", "code", "attributes"] as const).filter((k) => patch[k] !== undefined);
  if (changed.length === 0) return;
  const at = opts.at ?? new Date();
  try {
    await tx.update(resources).set({ ...patch, updatedBy: actor.id, updatedAt: at }).where(eq(resources.id, id));
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ResourceError("duplicate_code", `a ${existing.kind} with that code already exists at site "${existing.siteId}"`);
    }
    throw e;
  }
  await appendEvent(tx, resourceUpdated.make({
    payload: {
      ...subjectOf({ ...existing, code: patch.code ?? existing.code }),
      changed: [...changed],
      fromParentId: existing.parentId, toParentId: existing.parentId,
    },
    actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * Re-parent a resource.
 *
 * **THE CYCLE CHECK WALKS ANCESTORS TO THE ROOT — it is not a one-hop comparison** (A1). Postgres
 * cannot express "not my own ancestor", so this walk is the only guard there is, and the mutant
 * that checks `newParentId === id` passes every one-hop test while happily making a floor a
 * descendant of its own bed.
 */
export async function moveResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  newParentId: string | null,
  opts: { at?: Date } = {},
): Promise<void> {
  const existing = await requireResource(tx, id);
  requireDecl(kinds, existing.kind);
  if (newParentId === existing.parentId) return;

  if (newParentId !== null) {
    await requireResource(tx, newParentId);
    // The chain STARTS at the proposed parent, so `newParentId === id` is caught by the same walk
    // that catches the seven-hop case. One instrument, not two.
    const chain = await ancestorsOf(tx, newParentId);
    if (chain.includes(id)) {
      throw new ResourceError(
        "cycle",
        `moving ${id} under ${newParentId} would make it its own ancestor`,
        { chain },
      );
    }
  }
  await requireDepth(tx, newParentId, await subtreeHeight(tx, id));

  const at = opts.at ?? new Date();
  await tx.update(resources).set({ parentId: newParentId, updatedBy: actor.id, updatedAt: at }).where(eq(resources.id, id));
  await appendEvent(tx, resourceUpdated.make({
    payload: { ...subjectOf(existing), changed: ["parentId"], fromParentId: existing.parentId, toParentId: newParentId },
    actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * Move the status, and record what it moved FROM.
 *
 * `fromStatus` is read off the row BEFORE the update. A3's mutant reads it after, so every history
 * row records `from === to` — invisible to any fixture that transitions a resource to the status it
 * already holds, and invisible to a single-transition fixture in the ordering half.
 */
export async function changeResourceStatus(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  toStatus: string,
  opts: { reason?: string; at?: Date } = {},
): Promise<void> {
  const existing = await requireResource(tx, id);
  const decl = requireDecl(kinds, existing.kind);
  if (!decl.statuses.includes(toStatus)) {
    throw new ResourceError("unknown_status", `"${toStatus}" is not a status the kind "${existing.kind}" admits`);
  }
  /**
   * ═══ CLOSE / M1 — DD6's BICONDITIONAL IS ENFORCED HERE TOO, NOT ONLY ON assign/release ═══
   *
   * The independent reviewer found this hole and was right about it. DD6 states the invariant as
   * `occupant_ref` non-null ⟺ `occupant_type` non-null ⟺ `since` non-null ⟺ `status` is the kind's
   * `occupied`, and says it is *"enforced at the write path in one place"*. It was enforced along
   * `assignResource`/`releaseResource` only; this function validated the status against the kind's
   * vocabulary and never looked at the occupancy triad. Three states were reachable:
   *
   *   · → `occupied` on a FREE bed: an occupied bed with nobody in it, which `resourceBoard`
   *     renders and `resources_kind_status_idx` is documented to serve.
   *   · → `available` on an OCCUPIED bed: a bed picker filtering `status='available'` — the exact
   *     query that index exists for — offers a bed with a patient in it. `assignResource` then
   *     refuses with `already_occupied` on a bed the board just said was free.
   *   · → `retired` on an OCCUPIED bed: silently bypasses `retireResource`'s own guard, whose
   *     comment says a retired bed with a patient in it is the row DD2 exists to prevent. Two
   *     doors, one locked.
   *
   * NOTHING IN PLAN 13 COULD REACH ANY OF THEM — the write surface has no route (DD14) and OPD's
   * `updateRoom` only ever passes `available`/`retired` to a room nothing can occupy. It is fixed
   * now rather than later because this is the kernel API the IPD cluster and the mini-OT are about
   * to build bed management on, and the plan books the invariant as already held.
   *
   * NO NEW ERROR CODE. `errors.ts` closes its union for the phase and says a later task needing a
   * code it lacks has found a plan defect; the two existing codes carry the meaning exactly, and
   * `already_occupied` is the same refusal `retireResource` already makes for the same reason.
   */
  if (decl.occupied !== null) {
    if (toStatus === decl.occupied && existing.occupantRef === null) {
      throw new ResourceError(
        "not_occupied",
        `"${toStatus}" is the occupied status for kind "${existing.kind}" and resource ${id} has no ` +
          "occupant — use assignResource, which sets the whole triad in one write",
      );
    }
    if (toStatus !== decl.occupied && existing.status === decl.occupied && existing.occupantRef !== null) {
      throw new ResourceError(
        "already_occupied",
        `resource ${id} is occupied by ${existing.occupantType ?? "?"} ${existing.occupantRef}; ` +
          "use releaseResource, which clears the whole triad in one write",
      );
    }
  }

  const from = existing.status;
  if (from === toStatus) return;
  const at = opts.at ?? new Date();
  const reason = opts.reason ?? null;

  await tx.update(resources).set({ status: toStatus, updatedBy: actor.id, updatedAt: at }).where(eq(resources.id, id));
  await appendHistory(tx, actor, {
    resourceId: id, fromStatus: from, toStatus,
    occupantType: existing.occupantType, occupantRef: existing.occupantRef, reason, at,
  });
  await appendEvent(tx, resourceStatusChanged.make({
    payload: { ...subjectOf(existing), from, to: toStatus, reason },
    actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * Put something in it. **The occupancy triad moves together or not at all** (DD6, A2):
 * `occupantType`, `occupantRef`, `since` and the kind's `occupied` status are ONE write.
 *
 * `since` is set on EVERY assignment, unconditionally. The sneaky mutant here is not the one that
 * forgets to null it on release — it is the one that sets it *only when it is currently null*, which
 * survives every assign-then-release fixture and leaves a re-assigned bed claiming an occupancy that
 * began under a previous patient.
 */
export async function assignResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  input: { occupantType: string; occupantRef: string; at?: Date; reason?: string },
): Promise<void> {
  const existing = await requireResource(tx, id);
  const decl = requireDecl(kinds, existing.kind);
  if (decl.occupied === null) {
    throw new ResourceError("not_assignable", `the kind "${existing.kind}" is not assignable — it declares occupied: null`);
  }
  if (existing.occupantRef !== null) {
    throw new ResourceError(
      "already_occupied",
      `resource ${id} is already occupied by ${existing.occupantType ?? "?"} ${existing.occupantRef}`,
    );
  }
  const at = input.at ?? new Date();
  await tx.update(resources)
    .set({
      status: decl.occupied, occupantType: input.occupantType, occupantRef: input.occupantRef,
      since: at, updatedBy: actor.id, updatedAt: at,
    })
    .where(eq(resources.id, id));
  await appendHistory(tx, actor, {
    resourceId: id, fromStatus: existing.status, toStatus: decl.occupied,
    occupantType: input.occupantType, occupantRef: input.occupantRef, reason: input.reason ?? null, at,
  });
  await appendEvent(tx, resourceAssigned.make({
    payload: { ...subjectOf(existing), occupantType: input.occupantType, occupantRef: input.occupantRef, status: decl.occupied },
    actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * Take it back. Nulls all three triad fields and sets **the kind's `onRelease`, which for a bed and
 * a room is `cleaning` and not `available`** — §11.2's discharge cascade, carried on the payload so
 * no consumer has to infer it from the verb.
 */
export async function releaseResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  opts: { at?: Date; reason?: string } = {},
): Promise<void> {
  const existing = await requireResource(tx, id);
  const decl = requireDecl(kinds, existing.kind);
  if (existing.occupantRef === null) {
    throw new ResourceError("not_occupied", `resource ${id} has no occupant to release`);
  }
  const at = opts.at ?? new Date();
  await tx.update(resources)
    .set({
      status: decl.onRelease, occupantType: null, occupantRef: null, since: null,
      updatedBy: actor.id, updatedAt: at,
    })
    .where(eq(resources.id, id));
  await appendHistory(tx, actor, {
    resourceId: id, fromStatus: existing.status, toStatus: decl.onRelease,
    occupantType: null, occupantRef: null, reason: opts.reason ?? null, at,
  });
  await appendEvent(tx, resourceReleased.make({
    payload: {
      ...subjectOf(existing),
      occupantType: existing.occupantType ?? "unknown", occupantRef: existing.occupantRef,
      status: decl.onRelease,
    },
    actor, correlationId: id, occurredAt: at,
  }));
}

/**
 * DD2's replacement for `active: false`. It is `changeResourceStatus` to the kind's declared
 * `retired` and nothing more — deliberately NOT a delete, because `resource_status_history` and
 * every `occupant_ref` that ever named this row are still true.
 *
 * **An occupied resource cannot be retired.** A retired bed with a patient in it is a row that
 * disagrees with itself in exactly the way DD2 exists to prevent, one column further along.
 */
export async function retireResource(
  tx: Tx,
  actor: Actor,
  kinds: readonly ResourceKindDecl[],
  id: string,
  opts: { reason?: string; at?: Date } = {},
): Promise<void> {
  const existing = await requireResource(tx, id);
  const decl = requireDecl(kinds, existing.kind);
  if (existing.occupantRef !== null) {
    throw new ResourceError(
      "already_occupied",
      `resource ${id} is occupied by ${existing.occupantType ?? "?"} ${existing.occupantRef} and cannot be retired`,
    );
  }
  await changeResourceStatus(tx, actor, kinds, id, decl.retired, { reason: opts.reason ?? "retired", at: opts.at });
}
