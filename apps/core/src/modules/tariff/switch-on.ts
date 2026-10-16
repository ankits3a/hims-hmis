import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { services, tariffItems, tariffVersions, users } from "../../kernel/db/schema";
import { approvals } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { TariffError } from "./errors";
import { tariffServiceSwitchedOn } from "./events";
import { updateService } from "./services";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GO-LIVE SCREENS — SWITCH ON N SERVICES, NEVER ONE UNPRICED ═══
 *
 * `POST /tariff/services/switch-on` (same `tariff.services.manage` as the single PATCH). In ONE transaction it turns
 * each named service on and appends one `tariff.service_switched_on` event per service it turned on. A service already
 * on is reported back and left alone (no event), so a retried click is harmless.
 *
 * THE RULES THE SINGLE PATCH DOES NOT HAVE: every named service must be an `IPD_` service (`not_ipd_service`) and,
 * unless it is already on, carry a price above zero in the version IN FORCE now. One unpriced service refuses the
 * whole request (`service_unpriced`, naming every one) and nothing changes, so nothing goes live without a price.
 * `PATCH /tariff/services/:id` keeps its behaviour (no price check, no event, any code).
 */
export const SWITCH_ON_MAX = 500;
/** The codes the bulk door accepts (the IPD rate card's services, `ipdRateServiceCode`). */
export const IPD_SERVICE_PREFIX = "IPD_";

export type SwitchOnResult = { versionNo: number; switchedOn: string[]; alreadyOn: string[] };

export async function switchOnServices(db: Db, actor: Actor, serviceIds: readonly string[], at: Date = new Date()): Promise<SwitchOnResult> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) throw new TariffError("unknown_service", "no service named");
  return withTx(db, async (tx) => {
    // The lock `activateVersion` takes before it changes what is in force — so the version read below cannot
    // change under this transaction — then the in-force version, read INSIDE the transaction.
    await tx.execute(sql`select id from tariff_versions where status in ('submitted', 'activated') order by id for update`);
    const version = (await tx.select({ versionId: tariffVersions.id, versionNo: tariffVersions.versionNo }).from(tariffVersions)
      .where(and(eq(tariffVersions.status, "activated"), lte(tariffVersions.effectiveFrom, at)))
      .orderBy(desc(tariffVersions.effectiveFrom)).limit(1))[0];
    if (version === undefined) throw new TariffError("version_not_active", "no tariff version is in force — nothing can be priced");

    const rows = await tx.select().from(services).where(inArray(services.id, ids)).for("update");
    const found = new Set(rows.map((r) => r.id));
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length > 0) throw new TariffError("unknown_service", `unknown service(s): ${unknown.join(", ")}`);
    // DECIDED: the bulk door is the IPD go-live tool. Any other code goes through the single PATCH.
    const notIpd = rows.filter((r) => !r.code.startsWith(IPD_SERVICE_PREFIX)).map((r) => r.code).sort();
    if (notIpd.length > 0) throw new TariffError("not_ipd_service", `the bulk switch-on takes ${IPD_SERVICE_PREFIX} services only: ${notIpd.join(", ")}`);

    const prices = await tx.select({ serviceId: tariffItems.serviceId, pricePaise: tariffItems.pricePaise }).from(tariffItems)
      .where(and(eq(tariffItems.versionId, version.versionId), inArray(tariffItems.serviceId, ids)));
    const priceOf = new Map(prices.map((p) => [p.serviceId, p.pricePaise]));
    // DECIDED: a service ALREADY ON is skipped before the price check, so retrying a request that half-landed (or
    // naming one that someone switched on by hand) is harmless. This door never turns anything off, so it cannot
    // make an unpriced service live by skipping it.
    const unpriced = rows.filter((r) => !r.active && (priceOf.get(r.id) ?? 0) <= 0).map((r) => r.code).sort();
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
  createdBy: string | null; createdByName: string | null; createdAt: Date;
  submittedBy: string | null; submittedByName: string | null; submittedAt: Date | null;
  activatedBy: string | null; activatedAt: Date | null; approvalId: string | null; approvalStatus: string | null;
};

/**
 * `withNames` false (a `tariff.read`-only caller, e.g. a doctor): the drafter, submitter and activator are left out —
 * ids and names alike. DECIDED: who prepared a price list is the billing office's and the owner's to see.
 */
export async function listVersionsForOffice(db: Db, opts: { withNames: boolean }): Promise<OfficeVersion[]> {
  const rows = await db.select().from(tariffVersions);
  rows.sort((a, b) => b.versionNo - a.versionNo);
  const people = opts.withNames ? [...new Set(rows.flatMap((r) => [r.createdBy, r.submittedBy ?? ""]).filter((x) => x !== ""))] : [];
  const names = new Map((people.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, people))).map((u) => [u.id, u.name]));
  const approvalIds = rows.map((r) => r.approvalId).filter((x): x is string => x !== null);
  const statusOf = new Map((approvalIds.length === 0 ? [] : await db.select({ id: approvals.id, status: approvals.status }).from(approvals)
    .where(inArray(approvals.id, approvalIds))).map((a) => [a.id, a.status]));
  const n = opts.withNames;
  return rows.map((r) => ({
    id: r.id, versionNo: r.versionNo, status: r.status, notes: r.notes, effectiveFrom: r.effectiveFrom,
    createdBy: n ? r.createdBy : null, createdByName: n ? names.get(r.createdBy) ?? null : null, createdAt: r.createdAt,
    submittedBy: n ? r.submittedBy : null,
    submittedByName: n && r.submittedBy !== null ? names.get(r.submittedBy) ?? null : null, submittedAt: r.submittedAt,
    activatedBy: n ? r.activatedBy : null, activatedAt: r.activatedAt, approvalId: r.approvalId,
    approvalStatus: r.approvalId === null ? null : statusOf.get(r.approvalId) ?? null,
  }));
}
