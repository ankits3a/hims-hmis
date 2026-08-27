import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { opdDepartments, opdDoctors, resources, users } from "../../kernel/db/schema";
import {
  KERNEL_RESOURCE_KINDS, ResourceError, changeResourceStatus, createResource, findKindDecl,
  updateResource,
} from "../../kernel/resources";
import { OpdError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type DepartmentRow = typeof opdDepartments.$inferSelect;
export type DoctorRow = typeof opdDoctors.$inferSelect;

/**
 * ═══ PLAN 13 T6 / DD9 — ROOMS NOW LIVE IN THE KERNEL REGISTRY, AND THIS SHAPE DOES NOT MOVE ═══
 *
 * `RoomRow` was `typeof opdRooms.$inferSelect`. It is now an EXPLICIT type with **the same field
 * names**, produced by the mapper below over a `resources` row. The point of keeping the shape is
 * that `opd-masters.controller.ts` compiles unchanged, the HTTP contract is unchanged, and
 * `apps/web/src/screens/opd-admin.tsx` renders the same JSON — so the blast radius of moving a
 * table is ONE file, and `opd-admin.test.tsx` stays green WITH NO EDIT.
 *
 * **This is a facade, and a facade is a place where two vocabularies can drift** — the plan says so
 * itself and invites the reviewer to attack it. It is chosen because the alternative, changing the
 * response shape, pulls a screen, its tests and a contract into a phase whose subject is a table,
 * and buys nothing this phase can use. The drift is bounded by there being exactly TWO derived
 * fields and by both being asserted in `masters.test.ts`:
 *
 *   `floor`  ← `attributes->>'floor'`   ·   `active` ← `status !== retired`
 *
 * The registry has NO `active` boolean by deliberate design (DD2): one state column cannot disagree
 * with itself. `activeOnly` therefore becomes a status predicate **in this one mapper**, not a rule
 * every caller has to remember.
 */
export type RoomRow = {
  id: string;
  code: string;
  name: string;
  floor: string | null;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};

/**
 * `room` is a KERNEL kind, declared by `resourcesManifest`, so OPD passes the kernel declarations
 * rather than a boot-collected set. That is exact rather than a shortcut: OPD creates rooms and
 * nothing else, and `createResource` refusing an OPD-authored theatre is the desired outcome.
 */
const ROOM_DECL = findKindDecl(KERNEL_RESOURCE_KINDS, "room")!;
/** DD2's one predicate, in one place. `active: false` IS `status === retired` and nothing else. */
const ROOM_RETIRED = ROOM_DECL.retired;

type ResourceRow = typeof resources.$inferSelect;

/** THE MAPPER. The only place a registry row becomes a `RoomRow`. */
function toRoomRow(r: ResourceRow): RoomRow {
  const floor = (r.attributes as { floor?: unknown }).floor;
  return {
    id: r.id, code: r.code, name: r.name,
    // A room whose `attributes` never carried a floor reads `null`, exactly as the old column did.
    // `0032` writes `{}` rather than `{"floor": null}` for that case — a field that exists and says
    // nothing is worse than an absent one, and this line is why.
    floor: typeof floor === "string" ? floor : null,
    active: r.status !== ROOM_RETIRED,
    createdBy: r.createdBy, createdAt: r.createdAt,
    updatedBy: r.updatedBy, updatedAt: r.updatedAt,
  };
}

/**
 * `ResourceError` → `OpdError`, so nothing foreign escapes an OPD route into
 * `opd-masters.controller.ts`'s `toHttp`, which knows only `OpdError` and would answer 500.
 *
 * **Only TWO codes are reachable from this file** and the rest are rethrown deliberately rather than
 * mapped to a plausible-looking neighbour: `unknown_kind` cannot fire (`room` is kernel-declared),
 * `unknown_status` cannot (every status passed here comes from `ROOM_DECL`), `cycle`/`too_deep`
 * cannot (OPD never sets a parent), and the three occupancy codes cannot (OPD has no assign path —
 * nothing assigns anything until Plan 15). A translator that guessed at those would turn a genuine
 * bug into a misleading refusal, which is worse than the 500 it avoids.
 */
function asOpdError(e: unknown, roomId?: string): never {
  if (e instanceof ResourceError) {
    if (e.code === "duplicate_code") throw new OpdError("duplicate_room_code", e.message);
    if (e.code === "unknown_resource") throw new OpdError("unknown_room", `room ${roomId ?? "?"} not found`);
  }
  throw e;
}

function requireUserActor(actor: Actor): void {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "only a user actor may write OPD masters");
}

export async function createDepartment(tx: Tx, actor: Actor, input: { code: string; name: string }): Promise<{ departmentId: string }> {
  requireUserActor(actor);
  const id = newId();
  const rows = await tx
    .insert(opdDepartments)
    .values({ id, code: input.code, name: input.name, createdBy: actor.id, updatedBy: actor.id })
    .onConflictDoNothing({ target: opdDepartments.code })
    .returning({ id: opdDepartments.id });
  if (rows.length === 0) throw new OpdError("duplicate_department_code", `department code "${input.code}" already exists`);
  return { departmentId: id };
}

export async function updateDepartment(tx: Tx, actor: Actor, id: string, patch: { name?: string; active?: boolean }): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, id));
  if (!existing[0]) throw new OpdError("unknown_department", `department ${id} not found`);
  await tx.update(opdDepartments).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(opdDepartments.id, id));
}

export async function listDepartments(db: Db, opts: { activeOnly?: boolean } = {}): Promise<DepartmentRow[]> {
  const rows = await db.select().from(opdDepartments).orderBy(opdDepartments.name);
  return opts.activeOnly ? rows.filter((r) => r.active) : rows;
}

/**
 * DELEGATES INTO THE REGISTRY (DD9). The signature, the refusal code and the return shape are
 * unchanged, so the controller and the screen above it are untouched.
 *
 * **A room now emits `resource.registered`** where `createRoom` emitted nothing at all. That is
 * DD8's widening paying for itself in the very first caller: `createRoom`'s silence was an audit
 * hole in OPD, and carrying it into a kernel table IPD and the mini-OT will build on would have
 * made it a hole in the foundation.
 */
export async function createRoom(tx: Tx, actor: Actor, input: { code: string; name: string; floor?: string }): Promise<{ roomId: string }> {
  requireUserActor(actor);
  try {
    const { resourceId } = await createResource(tx, actor, KERNEL_RESOURCE_KINDS, {
      kind: "room",
      code: input.code,
      name: input.name,
      // `{}` and not `{ floor: null }` — see `toRoomRow`, and `0032` writes the same shape.
      attributes: input.floor === undefined ? {} : { floor: input.floor },
    });
    return { roomId: resourceId };
  } catch (e) {
    asOpdError(e);
  }
}

/**
 * The three-field patch becomes up to two registry calls, and the split is the registry's own seam
 * rather than an accident: `name`/`floor` are DESCRIPTION (`updateResource`) and `active` is STATE
 * (`changeResourceStatus`), and the registry keeps `resource.updated` and `resource.status_changed`
 * from overlapping precisely so a consumer need not read both to know what happened.
 *
 * **`active: true` FORCES the kind's `initial`, which is `available`.** Today that is exactly right:
 * a room's only two reachable statuses through this path are `available` and `retired`, because
 * nothing in this phase can occupy or block one. From Plan 15 on it will not be — reactivating a
 * room that a module had put into `cleaning` or `blocked` would reset it to `available`, and a
 * boolean cannot express which of four states to return to. **The `active` toggle is the shape that
 * has to go when the registry gains a second writer**, and it is written down here rather than
 * discovered then (CLOSE / m5).
 *
 * **`active: false` goes through `changeResourceStatus` and NOT through `retireResource`** —
 * ~~`retireResource` additionally refuses an OCCUPIED resource … routing around it keeps DD9's
 * promise exactly rather than nearly.~~ **THAT ARGUMENT IS DEAD AS OF THIS PHASE'S CLOSE (M1) AND
 * IS STRUCK RATHER THAN DELETED, because it explains why the call is shaped this way.** The
 * occupied-resource refusal MOVED INTO `changeResourceStatus`, so the route-around now buys
 * nothing: `updateRoom({ active: false })` on an occupied room raises `already_occupied` either
 * way. `opd-masters.controller.ts`'s `toHttp` maps it (CLOSE pass 2 / R2) instead of letting it
 * reach the counter as a 500. It still cannot fire in this phase — nothing can occupy a room until
 * Plan 15 — and when it can, the refusal is the correct answer rather than a silent retirement of
 * a room with somebody in it.
 */
export async function updateRoom(tx: Tx, actor: Actor, id: string, patch: { name?: string; floor?: string | null; active?: boolean }): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(resources).where(eq(resources.id, id));
  const row = existing[0];
  if (!row || row.kind !== "room") throw new OpdError("unknown_room", `room ${id} not found`);

  try {
    if (patch.name !== undefined || patch.floor !== undefined) {
      const attributes = patch.floor === undefined
        ? undefined
        // `floor: null` CLEARS it — the key is dropped rather than set to null, which is what makes
        // `toRoomRow`'s `typeof floor === "string"` and the migration's mapping agree.
        : patch.floor === null ? {} : { floor: patch.floor };
      await updateResource(tx, actor, KERNEL_RESOURCE_KINDS, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(attributes === undefined ? {} : { attributes }),
      });
    }
    if (patch.active !== undefined) {
      const target = patch.active ? ROOM_DECL.initial : ROOM_RETIRED;
      await changeResourceStatus(tx, actor, KERNEL_RESOURCE_KINDS, id, target, {
        reason: patch.active ? "reactivated by opd masters" : "deactivated by opd masters",
      });
    }
  } catch (e) {
    asOpdError(e, id);
  }
}

/**
 * Every room, whatever its place in the tree.
 *
 * **It reads `resources` directly rather than through `resourceBoard`**, and the difference matters:
 * the board returns the DIRECT children of one parent, so a room hung under a floor would silently
 * vanish from the OPD masters list the day somebody built the building's tree. `listRooms` means
 * every room, and it says so in SQL.
 *
 * `activeOnly` is now a status predicate (DD2). One predicate, one place.
 */
export async function listRooms(db: Db, opts: { activeOnly?: boolean } = {}): Promise<RoomRow[]> {
  const rows = await db.select().from(resources)
    .where(eq(resources.kind, "room"))
    .orderBy(asc(resources.code));
  const mapped = rows.map(toRoomRow);
  return opts.activeOnly ? mapped.filter((r) => r.active) : mapped;
}

// CLOSE / m4 — a `getRoom(db, id)` shipped here with zero callers, zero tests, no entry in T6's
// Produces list, and a doc comment claiming it was "the shape `schedules.ts` and the controller
// need" when neither used it. Removed rather than wired: `schedules.ts` needs a SET of rooms and
// queries for them directly, and the controller reads through `listRooms`. An unused export on a
// facade is a second vocabulary waiting for its first caller.

export async function createDoctor(
  tx: Tx,
  actor: Actor,
  input: { username: string; displayName: string; registrationNo?: string; departmentId: string; specialty?: string },
): Promise<{ doctorId: string; userId: string }> {
  requireUserActor(actor);
  const userRows = await tx.select().from(users).where(eq(users.username, input.username));
  const user = userRows[0];
  if (!user) throw new OpdError("unknown_user", `no user with username "${input.username}"`);

  const deptRows = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId));
  const dept = deptRows[0];
  if (!dept) throw new OpdError("unknown_department", `department ${input.departmentId} not found`);
  if (!dept.active) throw new OpdError("department_inactive", `department ${input.departmentId} is inactive`);

  const id = newId();
  const rows = await tx
    .insert(opdDoctors)
    .values({
      id,
      userId: user.id,
      displayName: input.displayName,
      registrationNo: input.registrationNo ?? null,
      departmentId: input.departmentId,
      specialty: input.specialty ?? null,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .onConflictDoNothing({ target: opdDoctors.userId })
    .returning({ id: opdDoctors.id });
  if (rows.length === 0) throw new OpdError("user_already_doctor", `user "${input.username}" already has a doctor profile`);
  return { doctorId: id, userId: user.id };
}

export async function updateDoctor(
  tx: Tx,
  actor: Actor,
  id: string,
  patch: { displayName?: string; registrationNo?: string | null; departmentId?: string; specialty?: string | null; active?: boolean },
): Promise<void> {
  requireUserActor(actor);
  const existing = await tx.select().from(opdDoctors).where(eq(opdDoctors.id, id));
  if (!existing[0]) throw new OpdError("unknown_doctor", `doctor ${id} not found`);
  if (patch.departmentId !== undefined) {
    const deptRows = await tx.select().from(opdDepartments).where(eq(opdDepartments.id, patch.departmentId));
    const dept = deptRows[0];
    if (!dept) throw new OpdError("unknown_department", `department ${patch.departmentId} not found`);
    if (!dept.active) throw new OpdError("department_inactive", `department ${patch.departmentId} is inactive`);
  }
  await tx.update(opdDoctors).set({ ...patch, updatedBy: actor.id, updatedAt: new Date() }).where(eq(opdDoctors.id, id));
}

export async function listDoctors(db: Db, opts: { departmentId?: string; activeOnly?: boolean } = {}): Promise<DoctorRow[]> {
  const rows = await db.select().from(opdDoctors).orderBy(opdDoctors.displayName);
  return rows.filter(
    (r) => (opts.departmentId === undefined || r.departmentId === opts.departmentId) && (!opts.activeOnly || r.active),
  );
}

export async function getDoctor(db: Db, id: string): Promise<DoctorRow | null> {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.id, id));
  return rows[0] ?? null;
}

export async function doctorForUser(db: Db | Tx, userId: string): Promise<DoctorRow | null> {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.userId, userId));
  return rows[0] ?? null;
}
