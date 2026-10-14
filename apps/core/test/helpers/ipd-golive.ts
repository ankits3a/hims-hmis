import { randomUUID } from "node:crypto";
import { IPD_REQUIRED_RATE_COMPONENTS, ipdRateServiceCode } from "@hmis/contracts";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { withTx } from "../../src/kernel/db/client";
import { emergencyAdmit } from "../../src/modules/ipd";
import {
  IPD_RATED_CLASSES, activateVersion, createDraftVersion, createService, listServices, resolveActiveTariffVersion, setTariffItem, submitVersion,
} from "../../src/modules/tariff";
import { ensurePharmacyCounter } from "../../scripts/seed-pharmacy";
import { IPD_REQUIRED_ROLES } from "../../scripts/ipd-golive-check";
import { mkChargesWorld } from "./ipd";
import { mkUser } from "./opd";
import type { ChargesWorld } from "./ipd";
import type { Db } from "../../src/kernel/db/client";

/**
 * E3.4 (#732) — a hospital the IPD go-live check calls READY: `mkChargesWorld` (active admission workflow, the IPD
 * approval types, MS and billing manager) plus a rate card pricing EVERY rated class's room, nursing and visit, one
 * active holder of each required role, the PHARM-OPD store, and one real (non-test) patient admitted to a bed.
 */
export async function mkGoLiveReadyWorld(db: Db): Promise<ChargesWorld> {
  const w = await mkChargesWorld(db);
  const current = await resolveActiveTariffVersion(db, new Date());
  const known = new Map((await listServices(db)).map((s) => [s.code, s.id] as const));
  const codes = IPD_RATED_CLASSES.flatMap((c) => IPD_REQUIRED_RATE_COMPONENTS.map((k) => ipdRateServiceCode(c, k)));
  for (const code of codes) {
    if (!known.has(code)) {
      known.set(code, (await withTx(db, (tx) => createService(tx, w.tariffDrafter, { code, name: code, category: "consultation" }))).serviceId);
    }
  }
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, w.tariffDrafter, { copyFromVersionId: current!.versionId });
    for (const code of codes) await setTariffItem(tx, w.tariffDrafter, d.versionId, known.get(code)!, 100_000);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, w.tariffDrafter, version.versionId));
  await approveRequest(db, w.owner, { approvalId: submitted.approvalId, note: "go-live fixture" });
  await activateVersion(db, w.tariffActivator, version.versionId, new Date("2026-01-04T00:00:00Z"));

  for (const { role } of IPD_REQUIRED_ROLES) await mkUser(db, `gl.${role}`, [role]);
  await ensurePharmacyCounter(db, { type: "user", id: "golive-fixture" });

  await w.bed("GL-FREE");
  const patientId = await w.patient("male", 52, "Ramesh Kumar");
  await emergencyAdmit(db, w.admitDesk, {
    idempotencyKey: randomUUID(), patientId, bedId: await w.bed("GL-OCC"), consultantId: w.doctor.id, isolation: "none", mlc: false,
  }, { now: new Date() });
  return w;
}
