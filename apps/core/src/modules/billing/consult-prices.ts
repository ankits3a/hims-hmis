import { desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { tariffVersions, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import {
  activateVersion, activateVersionDirectly, createDraftVersion, getVersion, listServices, resolveActiveTariffVersion, setTariffItem,
  submitVersion,
} from "../tariff";
import { formatPaise } from "../../kernel/report/money";
import { chargeRulesAt, feeOffNow, loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import type { ChargeRules } from "./config";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CONSULTATION PRICE LIST (owner, 2026-10-05) ═══
 *
 * *"Build a price list in billing screen so that I could change values from there. Revisit charge,
 * New and Renewal charges."* The three prices are tariff items, and a tariff changes only as a
 * VERSION: drafted, submitted for the `tariff_revision` approval, approved, activated. This file is
 * that ceremony for the three consultation prices, nothing else — it calls the tariff module's own
 * writers, so every guard stays where it is:
 *
 *   · propose — `billing.config.write`, the billing manager's door (OWNER RULING 2026-10-05,
 *     below); copies the version in force, changes the prices that differ, and submits it. One
 *     proposal waits at a time.
 *   · approve — `tariff.versions.activate` (the route) AND the approval's own checks: the approver
 *     holds the `owner` role, and is not the person who proposed (requester ≠ approver, and
 *     `activateVersion`'s drafter/submitter ≠ activator). Approving puts the prices into use at once.
 *   · reject — the same door; the version stays dead and a new proposal may be made.
 *   · change now — the same door as approve, with a required reason and no second person
 *     (`activateVersionDirectly`, event `tariff.revision_applied_directly`, `direct: true`).
 *
 * ═══ OWNER RULING 2026-10-05 (money) ═══
 * *"The billing manager, admin can approve or admin can change it directly."* The billing manager
 * proposes; the admin approves, or changes the prices directly. DECIDED: "admin" is the person who
 * holds the `owner` role (the `admin` login carries it); the `admin` ROLE stays the access
 * administrator it is (`seed-admin.ts`: "not a superuser that silently acquires every permission").
 */
export const CONSULT_BRANCHES = ["new", "renewal", "revisit"] as const;
export type ConsultBranch = (typeof CONSULT_BRANCHES)[number];
type Prices = Record<ConsultBranch, number | null>;

export type ConsultPriceRow = { branch: ConsultBranch; serviceId: string | null; code: string | null; activePaise: number | null };
export type PendingConsultPrices = {
  versionId: string;
  versionNo: number;
  approvalId: string | null;
  /** `granted` means approved but not yet in use — an activation that failed after the approval. */
  approvalStatus: "pending" | "granted";
  proposedBy: { id: string; name: string | null };
  proposedAt: string | null;
  note: string | null;
  prices: Prices;
};
export type ConsultPricesView = {
  rows: ConsultPriceRow[];
  activeVersionNo: number | null;
  pending: PendingConsultPrices | null;
};

function branchServices(rules: ChargeRules): Record<ConsultBranch, string | null> {
  return { new: rules.opdConsult.new, renewal: rules.opdConsult.renewal, revisit: rules.opdConsult.revisit ?? null };
}

async function pricesIn(db: Db, versionId: string, svc: Record<ConsultBranch, string | null>): Promise<Prices> {
  const found = await getVersion(db, versionId);
  const items = new Map((found?.items ?? []).map((i) => [i.serviceId, i.pricePaise]));
  const at = (id: string | null): number | null => (id === null ? null : items.get(id) ?? null);
  return { new: at(svc.new), renewal: at(svc.renewal), revisit: at(svc.revisit) };
}

/** The submitted version still waiting on its approval or its activation; a rejected one is dead. */
async function waitingVersion(db: Db): Promise<{ row: typeof tariffVersions.$inferSelect; status: "pending" | "granted" } | null> {
  const submitted = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "submitted")).orderBy(desc(tariffVersions.versionNo));
  for (const row of submitted) {
    const approval = row.approvalId === null ? null : await getApproval(db, row.approvalId);
    if (approval?.status === "pending" || approval?.status === "granted") return { row, status: approval.status };
  }
  return null;
}

export async function consultPricesView(db: Db, now: Date = new Date()): Promise<ConsultPricesView> {
  const { chargeRules } = await loadBillingConfig(db);
  const svc = branchServices(chargeRules);
  const codes = new Map((await listServices(db)).map((s) => [s.id, s.code]));
  const active = await resolveActiveTariffVersion(db, now);
  const activePrices: Prices = active === null ? { new: null, renewal: null, revisit: null } : await pricesIn(db, active.versionId, svc);
  const rows = CONSULT_BRANCHES.map((branch) => ({
    branch, serviceId: svc[branch], code: svc[branch] === null ? null : codes.get(svc[branch]!) ?? null, activePaise: activePrices[branch],
  }));

  const waiting = await waitingVersion(db);
  let pending: PendingConsultPrices | null = null;
  if (waiting !== null) {
    const v = waiting.row;
    const proposer = v.submittedBy ?? v.createdBy;
    const named = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, [proposer]));
    pending = {
      versionId: v.id, versionNo: v.versionNo, approvalId: v.approvalId, approvalStatus: waiting.status,
      proposedBy: { id: proposer, name: named[0]?.fullName ?? null },
      proposedAt: (v.submittedAt ?? v.createdAt)?.toISOString() ?? null,
      note: v.notes,
      prices: await pricesIn(db, v.id, svc),
    };
  }
  return { rows, activeVersionNo: active?.versionNo ?? null, pending };
}

export type ConsultPriceProposal = { prices: Partial<Record<ConsultBranch, number>>; note?: string };

export async function proposeConsultPrices(db: Db, actor: Actor, input: ConsultPriceProposal, now: Date = new Date()): Promise<ConsultPricesView> {
  if (actor.type !== "user") throw new BillingError("fee_not_applicable", "a price is proposed by a named person");
  await draftChange(db, actor, input, now, "");
  return consultPricesView(db, now);
}

/**
 * The change both roads share: refuse while a proposal waits, copy the version in force, set the
 * prices that differ. `submitNote` null leaves the version a DRAFT (the direct road activates it);
 * a string submits it for approval.
 */
async function draftChange(
  db: Db, actor: Actor, input: ConsultPriceProposal, now: Date, submitNote: string | null,
): Promise<{ versionId: string; changes: { branch: ConsultBranch; serviceId: string; paise: number }[] }> {
  for (const [branch, paise] of Object.entries(input.prices)) {
    if (paise === undefined) continue;
    if (!Number.isInteger(paise) || paise < 0) throw new BillingError("invalid_paise", `${branch} price must be a whole number of paise, 0 or more`);
  }
  const { chargeRules } = await loadBillingConfig(db);
  const svc = branchServices(chargeRules);
  if (input.prices.revisit !== undefined && svc.revisit === null) {
    throw new BillingError("revisit_fee_unwired", "no revisit consultation service is set up — run seed:billing");
  }
  if ((await waitingVersion(db)) !== null) {
    throw new BillingError("consult_price_pending", "a price change is already waiting for approval");
  }
  const active = await resolveActiveTariffVersion(db, now);
  if (active === null) throw new BillingError("billing_not_configured", "no tariff version is in force");
  const current = await pricesIn(db, active.versionId, svc);
  const changes = CONSULT_BRANCHES.flatMap((branch) => {
    const paise = input.prices[branch];
    return paise === undefined || paise === current[branch] || svc[branch] === null ? [] : [{ branch, serviceId: svc[branch]!, paise }];
  });
  if (changes.length === 0) throw new BillingError("consult_price_unchanged", "the proposed prices are the prices in force");

  const note = input.note?.trim() || null;
  const describe = changes.map((c) => `${c.branch} ${formatPaise(c.paise)}`).join(", ");
  return withTx(db, async (tx) => {
    const { versionId } = await createDraftVersion(tx, actor, { copyFromVersionId: active.versionId, notes: note ?? `OPD consultation: ${describe}` });
    for (const c of changes) await setTariffItem(tx, actor, versionId, c.serviceId, c.paise);
    if (submitNote !== null) await submitVersion(tx, actor, versionId, `OPD consultation prices: ${describe}${note === null ? "" : ` — ${note}`}${submitNote}`);
    return { versionId, changes };
  });
}

/** Owner ruling 2026-10-05: the admin changes the prices directly — no second person, a reason required, audited. */
export async function changeConsultPricesNow(db: Db, actor: Actor, input: ConsultPriceProposal, now: Date = new Date()): Promise<ConsultPricesView> {
  if (actor.type !== "user") throw new BillingError("fee_not_applicable", "a price is changed by a named person");
  const note = input.note?.trim() ?? "";
  if (note === "") throw new BillingError("consult_price_reason_required", "a direct price change needs a reason");
  const { versionId } = await draftChange(db, actor, input, now, null);
  await activateVersionDirectly(db, actor, versionId, now, note);
  return consultPricesView(db, now);
}

/**
 * Approve (and put into use at once) or reject the waiting proposal. A proposal already approved
 * whose activation failed is activated without a second approval.
 */
export async function decideConsultPrices(
  db: Db, actor: Actor, versionId: string, input: { approve: boolean; note: string }, now: Date = new Date(),
): Promise<ConsultPricesView> {
  const waiting = await waitingVersion(db);
  if (waiting === null || waiting.row.id !== versionId || waiting.row.approvalId === null) {
    throw new BillingError("consult_price_not_pending", `tariff version ${versionId} is not waiting for a decision`);
  }
  const approvalId = waiting.row.approvalId;
  if (!input.approve) {
    if (waiting.status === "granted") throw new BillingError("consult_price_not_pending", `tariff version ${versionId} is already approved`);
    await rejectRequest(db, actor, { approvalId, note: input.note });
    return consultPricesView(db, now);
  }
  if (waiting.status === "pending") await approveRequest(db, actor, { approvalId, note: input.note });
  await activateVersion(db, actor, versionId, now);
  return consultPricesView(db, now);
}

/**
 * What a desk may say about a visit's fee BEFORE it is seated (Desk One's visit-type box): whether
 * the consultation fee is switched off now, and each branch's price in force. `revisit` is null
 * unless a revisit is actually charged (`chargeRulesAt`). Prices only — never a patient's bill.
 */
export type ConsultTerms = { consultFeeOff: boolean; paise: Prices };
export async function consultTerms(db: Db, now: Date = new Date()): Promise<ConsultTerms> {
  const { chargeRules } = await loadBillingConfig(db);
  const rules = await chargeRulesAt(db, chargeRules, now);
  const active = await resolveActiveTariffVersion(db, now);
  const paise: Prices = active === null ? { new: null, renewal: null, revisit: null } : await pricesIn(db, active.versionId, branchServices(rules));
  return { consultFeeOff: feeOffNow(chargeRules, "opdConsult"), paise };
}
