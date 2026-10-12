import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { withTx } from "../../src/kernel/db/client";
import { events, orgDepartments, rosterAssignments, rosterPeriods } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
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

