import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { events } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { DIET_PERMISSIONS, dietManifest, handleDietEvent, istDayStart, mealRounds, slotOf } from "../../src/modules/diet";
import { acceptHandover, ipdManifest, startTransfer } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { tasksManifest } from "../../src/modules/tasks";
import { ensureRole, mkUser } from "./opd";
import { mkTransferWorld } from "./ipd";
import type { Actor, DietMeal } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { DispatchedEvent } from "../../src/kernel/events/subscriptions";
import type { MealSlot } from "../../src/modules/diet";
import type { TransferWorld } from "./ipd";

/**
 * E4.4 DIET — the transfer world (two wards, real admit and transfer acts) plus the diet people, each holding exactly
 * the strings `scripts/seed-roles.ts` gives the role: `dietDoctor` (doctor: view, order, npo), `nurse` (view, npo,
 * serve), `dietician` (all six), `kitchen` (view, kitchen). Every act in the suites passes an explicit instant
 * (`ist(...)`); no code under test reads the real clock.
 */
export type DietWorld = TransferWorld & {
  dietDoctor: Actor; nurse: Actor; dietician: Actor; kitchen: Actor;
  slot(meal: DietMeal, date: string): Promise<MealSlot>;
  /** Start and accept a transfer to `toBedId` at `at` (the real ipd acts). */
  transfer(admissionId: string, toBedId: string, at: Date): Promise<void>;
  /** Deliver every event about the admission (commit order) to diet's consumer, as the worker's dispatcher would. */
  deliver(admissionId: string, now: Date): Promise<void>;
};

/** "YYYY-MM-DDTHH:MM[:SS]" read as IST wall time, through the shared IST helper (no hand-written offset). */
export const ist = (s: string): Date => {
  const [date, time = "00:00:00"] = s.split("T");
  const [h = 0, m = 0, sec = 0] = time.split(":").map(Number);
  return new Date(istDayStart(date!).getTime() + ((h * 60 + m) * 60 + sec) * 1000);
};

const SBAR = { situation: "Stable", background: "Synthetic", assessment: "Synthetic", recommendation: "Synthetic" };

export async function mkDietWorld(db: Db): Promise<DietWorld> {
  const w = await mkTransferWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, tasksManifest, dietManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, readonly string[]> = {
    doctor: ["diet.view", "diet.order", "diet.npo", "diet.clinical.view"],
    // The ward nurse's grants arrive with ipd-nursing at integration; the fixture plays her with the OPD `nurse` key.
    nurse: ["diet.view", "diet.npo", "diet.serve", "diet.clinical.view"],
    dietician: DIET_PERMISSIONS,
    kitchen_staff: ["diet.view", "diet.kitchen"],
    support_staff: ["tasks.work", "diet.serve"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    // Only strings the manifest declares (a census run against an older diet commit must fail on behaviour, not here).
    for (const p of perms) if (registry.allPermissions().includes(p)) await grantPermissionToRole(db, registry, role, p);
  }
  const dietDoctor = (await mkUser(db, "diet.doctor", ["doctor"])).actor;
  const nurse = (await mkUser(db, "diet.nurse", ["nurse"])).actor;
  const dietician = (await mkUser(db, "diet.dietician", ["dietician"])).actor;
  const kitchen = (await mkUser(db, "diet.kitchen", ["kitchen_staff"])).actor;
  return {
    ...w, dietDoctor, nurse, dietician, kitchen,
    slot: async (meal, date) => slotOf((await mealRounds(db)).find((r) => r.meal === meal)!, date),
    transfer: async (admissionId, toBedId, at) => {
      const s = await startTransfer(db, w.sender, { idempotencyKey: randomUUID(), admissionId, toBedId, reason: "bed_management", handover: SBAR }, { now: at });
      await acceptHandover(db, w.receiver, { idempotencyKey: randomUUID(), transferId: s.transferId }, { now: new Date(at.getTime() + 60_000) });
    },
    deliver: async (admissionId, now) => {
      const rows = await db.select().from(events).where(eq(events.correlationId, admissionId)).orderBy(asc(events.seq));
      for (const r of rows) {
        const e: DispatchedEvent = {
          seq: r.seq, eventId: r.eventId, name: r.name, payload: r.payload, patientId: r.patientId, correlationId: r.correlationId, occurredAt: r.occurredAt,
        };
        await handleDietEvent(db, e, now);
      }
    },
  };
}

/** A synthetic OT event as the dispatcher hands it (the OT booking lane's own suite proves the emit). */
export function otEvent(name: "daycare.booked" | "case.cancelled" | "list.published", payload: Record<string, unknown>, at: Date): DispatchedEvent {
  return { seq: 1, eventId: randomUUID(), name, payload, patientId: null, correlationId: null, occurredAt: at } as DispatchedEvent;
}

/** A stay-ending IPD event as the dispatcher hands it (the discharge lane's own suite proves the emit). */
export function ipdEvent(name: string, payload: Record<string, unknown>, at: Date): DispatchedEvent {
  return { seq: 1, eventId: randomUUID(), name, payload, patientId: null, correlationId: null, occurredAt: at } as DispatchedEvent;
}
