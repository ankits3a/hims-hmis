import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { withTx } from "../../src/kernel/db/client";
import { events, orgDepartments, rosterAssignments, rosterPeriods } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { handleBedEvent, housekeepingManifest } from "../../src/modules/housekeeping";
import { ipdManifest, releaseBedOccupant } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { seedOrgDepartments, seedRosterPositions } from "../../src/modules/roster";
import { tasksManifest } from "../../src/modules/tasks";
import { ensureRole, mkUser } from "./opd";
import { mkBedWorld } from "./ipd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { DispatchedEvent } from "../../src/kernel/events/subscriptions";
import type { DocumentStore } from "../../src/kernel/documents/store";
import type { BedWorld } from "./ipd";

/**
 * E1.4 HOUSEKEEPING — the bed world (`mkBedWorld`) plus the people who clean and check: two cleaners
 * (`support_staff`, on a published presence duty around the real clock), a housekeeping supervisor
 * (`services_supervisor` with both housekeeping permissions), a ward-nurse-side checker (`w.cleaner`: ipd.beds.clean)
 * and one person who both cleans and may check routine cleans. No instant here is a pinned date.
 */
export type HousekeepingWorld = BedWorld & {
  hk1: Actor; hk2: Actor; supervisor: Actor; nurse: Actor; cleanerNurse: Actor;
};

export async function mkHousekeepingWorld(db: Db): Promise<HousekeepingWorld> {
  const w = await mkBedWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, tasksManifest, housekeepingManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    support_staff: ["tasks.work"],
    services_supervisor: ["tasks.view", "tasks.work", "tasks.supervise", "housekeeping.view", "housekeeping.verify_terminal"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await ensureRole(db, key);
  const hk1 = (await mkUser(db, "hk.one", ["support_staff"])).actor;
  const hk2 = (await mkUser(db, "hk.two", ["support_staff"])).actor;
  const supervisor = (await mkUser(db, "hk.sup", ["services_supervisor"])).actor;
  const cleanerNurse = (await mkUser(db, "hk.both", ["support_staff", "t_bed_clean"])).actor;

  await seedOrgDepartments(db);
  await seedRosterPositions(db);
  const departmentId = (await db.select({ id: orgDepartments.id }).from(orgDepartments).limit(1))[0]!.id;
  const now = Date.now();
  const periodId = newId();
  await db.insert(rosterPeriods).values({
    id: periodId, scopeType: "department", scopeId: departmentId, departmentId, title: "Housekeeping",
    startsAt: new Date(now - 24 * 3_600_000), endsAt: new Date(now + 24 * 3_600_000), version: 1, status: "published",
    coversPositions: ["staff_nurse"], publishedAt: new Date(now), publishedBy: supervisor.id, contentHash: "fixture",
    createdBy: supervisor.id, updatedBy: supervisor.id,
  });
  for (const a of [hk1, hk2, cleanerNurse]) {
    const id = newId();
    await db.insert(rosterAssignments).values({
      id, periodId, userId: a.id, positionKey: "staff_nurse", startsAt: new Date(now - 3_600_000), endsAt: new Date(now + 8 * 3_600_000),
      mode: "presence", kind: "duty", departmentId, coverScope: "department", effective: true, lineageId: id,
      proposedByActorId: supervisor.id, createdBy: supervisor.id, updatedBy: supervisor.id,
    });
  }
  return { ...w, hk1, hk2, supervisor, nurse: w.cleaner, cleanerNurse };
}

/** Empty an occupied bed through ipd's release seam (what discharge and transfer call). */
export async function releaseBed(db: Db, actor: Actor, bedId: string, opts: { terminal?: boolean } = {}): Promise<void> {
  await withTx(db, (tx) => releaseBedOccupant(tx, actor, bedId, new Date(), opts));
}

/** Every event about a resource, in commit order, shaped as the dispatcher hands them to a consumer. */
export async function eventsAbout(db: Db, resourceId: string): Promise<DispatchedEvent[]> {
  const rows = await db.select().from(events)
    .where(eq(events.correlationId, resourceId)).orderBy(asc(events.seq));
  return rows.map((r) => ({
    seq: r.seq, eventId: r.eventId, name: r.name, payload: r.payload, patientId: r.patientId,
    correlationId: r.correlationId, occurredAt: r.occurredAt,
  }));
}

/** Deliver every event about the bed to housekeeping's consumer, as the worker's dispatcher would. */
export async function deliverBedEvents(db: Db, bedId: string): Promise<void> {
  for (const e of await eventsAbout(db, bedId)) {
    if (e.name.startsWith("resource.")) await handleBedEvent(db, e);
  }
}


/**
 * HK-1 (#973, decision 0086) — the housekeeping world plus what rounds, rotas and door requests need: a contractor
 * attendant (`hkC`, `support_staff`, on duty), an infection-control officer, a toilet and a hall on the bed world's floor,
 * a second floor with one room, the server key QR tokens are signed with, and an in-memory photo store.
 * No instant here is a pinned date.
 */
export type HkWorld = HousekeepingWorld & {
  hkC: Actor; infection: Actor;
  toiletId: string; hallId: string; floor2Id: string; room2Id: string;
  key: Buffer; store: DocumentStore;
};

export const HK_TEST_KEY = Buffer.alloc(32, 7);

export class MemoryStore implements DocumentStore {
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.blobs.set(key, bytes); }
  async get(key: string): Promise<Buffer> {
    const b = this.blobs.get(key);
    if (b === undefined) throw new Error(`no blob ${key}`);
    return b;
  }
  async remove(key: string): Promise<void> { this.blobs.delete(key); }
}

export async function mkHkWorld(db: Db): Promise<HkWorld> {
  const w = await mkHousekeepingWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, tasksManifest, housekeepingManifest]) registry.install(m);
  const grants: Record<string, string[]> = {
    services_supervisor: ["housekeeping.setup.manage", "housekeeping.rota.manage", "housekeeping.confirm"],
    infection_control: ["tasks.view", "housekeeping.view", "housekeeping.verify_terminal", "housekeeping.confirm"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const hkC = (await mkUser(db, "hk.contract", ["support_staff"])).actor;
  const infection = (await mkUser(db, "hk.ic", ["infection_control"])).actor;
  const period = (await db.select().from(rosterPeriods).where(eq(rosterPeriods.title, "Housekeeping")))[0]!;
  const now = Date.now();
  const dutyId = newId();
  await db.insert(rosterAssignments).values({
    id: dutyId, periodId: period.id, userId: hkC.id, positionKey: "staff_nurse", startsAt: new Date(now - 3_600_000),
    endsAt: new Date(now + 8 * 3_600_000), mode: "presence", kind: "duty", departmentId: period.departmentId!,
    coverScope: "department", effective: true, lineageId: dutyId, proposedByActorId: w.supervisor.id,
    createdBy: w.supervisor.id, updatedBy: w.supervisor.id,
  });
  const SETUP: Actor = { type: "system", id: "test-hk-world" };
  const place = (kind: string, code: string, parentId: string | null) =>
    withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind, code, name: code, parentId })).then((r) => r.resourceId);
  const toiletId = await place("room", "F-T-WC", w.floorId);
  const hallId = await place("hall", "F-T-LOBBY", w.floorId);
  const floor2Id = await place("floor", "F-2", null);
  const room2Id = await place("room", "F-2-R", floor2Id);
  return { ...w, hkC, infection, toiletId, hallId, floor2Id, room2Id, key: HK_TEST_KEY, store: new MemoryStore() };
}
