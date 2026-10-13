import { randomUUID } from "node:crypto";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ipdAdmissions, ipdBands } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { assignBed, ipdManifest } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { tasksManifest } from "../../src/modules/tasks";
import { transportManifest } from "../../src/modules/transport";
import { mkHousekeepingWorld } from "./housekeeping";
import { ensureRole, mkUser } from "./opd";
import type { Actor, IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { HousekeepingWorld } from "./housekeeping";

/**
 * E1.6 TRANSPORT — the housekeeping world (two `support_staff` on a published presence duty around the real clock:
 * the porters `hk1`, `hk2`) plus a requester (`front_office` with `transport.request`), a ward nurse who may escort
 * (`nurse`), a person who may not (`clerk`), and `admitted(...)`: an open admission on a bed of a given class with a
 * live wristband. The admission row is written directly (the admission desk's own flow is the admit lane's suite);
 * the bed is assigned through ipd's real `assignBed`. No instant here is a pinned date.
 */
export type TransportWorld = HousekeepingWorld & {
  requester: Actor; escortNurse: Actor; clerk: Actor;
  admitted(code: string, cls?: "general" | "icu"): Promise<{ admissionId: string; patientId: string; bedId: string; band: string }>;
};

export async function mkTransportWorld(db: Db): Promise<TransportWorld> {
  const w = await mkHousekeepingWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, tasksManifest, transportManifest]) registry.install(m);
  await syncPermissions(db, registry);
  await ensureRole(db, "transport_desk");
  await grantPermissionToRole(db, registry, "transport_desk", "transport.request");
  await grantPermissionToRole(db, registry, "support_staff", "transport.work");
  await grantPermissionToRole(db, registry, "services_supervisor", "transport.manage");
  const requester = (await mkUser(db, "tr.desk", ["transport_desk"])).actor;
  const escortNurse = (await mkUser(db, "tr.nurse", ["nurse"])).actor;
  const clerk = (await mkUser(db, "tr.clerk", ["transport_desk"])).actor;
  let n = 0;
  return {
    ...w, requester, escortNurse, clerk,
    admitted: async (code, cls = "general") => {
      n += 1;
      const now = new Date();
      const patientId = await w.patient("male");
      const admissionId = newId();
      await db.insert(ipdAdmissions).values({
        id: admissionId, patientId, workflowInstanceId: newId(), state: "admitted", source: "direct", consultantId: w.desk.id,
        requestedClass: cls, isolation: "none", icu: cls === "icu", requestedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
        requestedBy: w.desk.id, admissionNo: `IP-T-${String(n)}`, admittedAt: now, admittedBy: w.desk.id, updatedAt: now,
      });
      const attrs = cls === "icu" ? { class: "icu", icu: true } : {};
      const bedId = await w.bed(code, attrs);
      const need: IpdBedNeed = { requestedClass: cls, isolation: "none", icu: cls === "icu" };
      await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId, bedId, patientId, need });
      const band = `IP-T-${String(n)}-1`;
      await db.insert(ipdBands).values({
        id: newId(), admissionId, serial: band, size: "adult", site: "left_wrist", status: "printed",
        payload: { admissionId, serial: band }, printedBy: w.desk.id, printedAt: now,
      });
      return { admissionId, patientId, bedId, band };
    },
  };
}
