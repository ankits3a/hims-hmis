import { and, eq, inArray } from "drizzle-orm";
import { services, tariffItems, tariffVersions, users } from "../../kernel/db/schema";
import { approvals } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { TariffError } from "./errors";
import { tariffServiceSwitchedOn } from "./events";
import { updateService } from "./services";
import { resolveActiveTariffVersion } from "./versions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GO-LIVE SCREENS — SWITCH ON N SERVICES, NEVER ONE UNPRICED ═══
 *
 * `POST /tariff/services/switch-on` (same `tariff.services.manage` as the single PATCH). In ONE transaction it turns
 * each named service on and appends one `tariff.service_switched_on` event per service it turned on. A service already
 * on is reported back and left alone (no event), so a retried click is harmless.
 *
 * THE RULE THE SINGLE PATCH DOES NOT HAVE: every named service must carry a price above zero in the version IN FORCE
 * now. One unpriced service refuses the whole request (`service_unpriced`, naming every one) and nothing changes, so
 * nothing goes live without a price. `PATCH /tariff/services/:id` keeps its behaviour (no price check, no event).
 */
export const SWITCH_ON_MAX = 500;

export type SwitchOnResult = { versionNo: number; switchedOn: string[]; alreadyOn: string[] };

export async function switchOnServices(db: Db, actor: Actor, serviceIds: readonly string[], at: Date = new Date()): Promise<SwitchOnResult> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) throw new TariffError("unknown_service", "no service named");
  const version = await resolveActiveTariffVersion(db, at);
  if (version === null) throw new TariffError("version_not_active", "no tariff version is in force — nothing can be priced");
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(services).where(inArray(services.id, ids)).for("update");
    const found = new Set(rows.map((r) => r.id));
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length > 0) throw new TariffError("unknown_service", `unknown service(s): ${unknown.join(", ")}`);
    const prices = await tx.select({ serviceId: tariffItems.serviceId, pricePaise: tariffItems.pricePaise }).from(tariffItems)
      .where(and(eq(tariffItems.versionId, version.versionId), inArray(tariffItems.serviceId, ids)));
    const priceOf = new Map(prices.map((p) => [p.serviceId, p.pricePaise]));
    const unpriced = rows.filter((r) => (priceOf.get(r.id) ?? 0) <= 0).map((r) => r.code).sort();
    if (unpriced.length > 0) {
      throw new TariffError("service_unpriced", `no price in tariff version ${version.versionNo} (in force) for: ${unpriced.join(", ")}`);
    }
    const switchedOn: string[] = [];
    const alreadyOn: string[] = [];
    for (const r of [...rows].sort((a, b) => a.code.localeCompare(b.code))) {
      if (r.active) { alreadyOn.push(r.code); continue; }
      await updateService(tx, actor, r.id, { active: true });
      await appendEvent(tx, tariffServiceSwitchedOn.make({
        actor,
        payload: { serviceId: r.id, code: r.code, versionId: version.versionId, versionNo: version.versionNo, pricePaise: priceOf.get(r.id) as number },
      }));
      switchedOn.push(r.code);
    }
    return { versionNo: version.versionNo, switchedOn, alreadyOn };
  });
}

/**
 * GO-LIVE SCREENS — the versions list as the billing office shows it: who drafted and who submitted each version
 * (names), and the state of the approval behind a submitted one. Read-only; the controller adds it to
 * `GET /tariff/versions` (additive fields).
 */
export type OfficeVersion = {
  id: string; versionNo: number; status: string; notes: string | null; effectiveFrom: Date | null;
  createdBy: string; createdByName: string | null; createdAt: Date;
  submittedBy: string | null; submittedByName: string | null; submittedAt: Date | null;
  activatedBy: string | null; activatedAt: Date | null; approvalId: string | null; approvalStatus: string | null;
};

export async function listVersionsForOffice(db: Db): Promise<OfficeVersion[]> {
  const rows = await db.select().from(tariffVersions);
  rows.sort((a, b) => b.versionNo - a.versionNo);
  const people = [...new Set(rows.flatMap((r) => [r.createdBy, r.submittedBy ?? ""]).filter((x) => x !== ""))];
  const names = new Map((people.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, people))).map((u) => [u.id, u.name]));
  const approvalIds = rows.map((r) => r.approvalId).filter((x): x is string => x !== null);
  const statusOf = new Map((approvalIds.length === 0 ? [] : await db.select({ id: approvals.id, status: approvals.status }).from(approvals)
    .where(inArray(approvals.id, approvalIds))).map((a) => [a.id, a.status]));
  return rows.map((r) => ({
    id: r.id, versionNo: r.versionNo, status: r.status, notes: r.notes, effectiveFrom: r.effectiveFrom,
    createdBy: r.createdBy, createdByName: names.get(r.createdBy) ?? null, createdAt: r.createdAt,
    submittedBy: r.submittedBy, submittedByName: r.submittedBy === null ? null : names.get(r.submittedBy) ?? null, submittedAt: r.submittedAt,
    activatedBy: r.activatedBy, activatedAt: r.activatedAt, approvalId: r.approvalId,
    approvalStatus: r.approvalId === null ? null : statusOf.get(r.approvalId) ?? null,
  }));
}
