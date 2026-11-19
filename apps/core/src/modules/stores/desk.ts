import { waitingItem } from "../../kernel/desk/waiting";
import { STORES_AUDIT_READ, STORES_AWARD_SIGN, STORES_INDENTS_APPROVE, STORES_SES_CONFIRM, STORES_SHELF_WORK } from "./access";
import { flagsToReview } from "./auditor-agent";
import { msmeBillsDueSoon, servicesDueFor } from "./paying-notices";
import { hasPermission } from "../../kernel/auth/permissions";
import { listAwards } from "./awards";
import { purchaseRequestsToApprove } from "./purchase-requests";
import { lateScansToConfirm, returnsToReceive, ticketsComingBack } from "./custody";
import { ticketsToApprove, ticketsToPick, ticketsToReceive } from "./tickets";
import { STORES_TOWER_READ, boardCards } from "./tower";
import { STORES_ASSETS_MANAGE, faultsToSee } from "./assets";
import { STORES_ASSETS_CONDEMN, condemnationsToSign } from "./condemnation";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskCard, DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";
import type { TicketView } from "./types";
import type { WaitingItem, WaitingKind, WireAuditFlag } from "@hmis/contracts";

/**
 * STORES S2a (#1112, decision 12) — THE THREE NOW CARDS: "Indents to approve" (the department's approvers and
 * the superintendent's stand-in), "To pick" (the supplying store's keepers, the night store's included) and
 * "To receive" (the department's shelf-work holders).
 *
 * Two surfaces, one list each: the desk CARD (`load`, gated at hospital scope by `loadDesk` — the stand-in,
 * the storekeepers) and the WAITING line (`waiting`, `waitingSelfGated`, the roster-leave precedent of
 * decision 0069), which is how a DEPARTMENT-scoped HOD or in-charge, who holds nothing hospital-wide, sees
 * theirs on the phone's home card and My day. Both draw the same `tickets.ts` read, so they cannot disagree.
 * Rows carry a ticket number and a department, never a person or money.
 */
const MAX_ROWS = 8;

function card(key: string, titleKey: string, tickets: TicketView[], href: (t: TicketView) => string, action: string): DeskCard[] {
  if (tickets.length === 0) return [];
  return [{
    key, band: "now", titleKey,
    stats: [{ key: "count", value: String(tickets.length), href: href(tickets[0]!).split("?")[0] ?? null }],
    rows: tickets.slice(0, MAX_ROWS).map((t) => ({
      id: t.id, badge: t.priority === "emergency" ? "!" : null, title: t.indentNo,
      subtitle: `${t.department.name} · ${String(t.lines.length)}`, action, href: href(t),
      severity: t.priority === "emergency" ? "hot" : t.priority === "urgent" ? "warn" : null,
    })),
  }];
}

function line(kind: WaitingKind, tickets: TicketView[]): WaitingItem[] {
  const oldest = tickets.reduce<string | null>((o, t) => (o === null || t.clockFrom < o ? t.clockFrom : o), null);
  const item = waitingItem(kind, tickets.length, oldest);
  return item === null ? [] : [item];
}

const approve = (ctx: DeskProviderCtx) => ticketsToApprove(ctx.db, ctx.actor, ctx.now);
const pick = (ctx: DeskProviderCtx) => ticketsToPick(ctx.db, ctx.actor, ctx.now);
const receive = (ctx: DeskProviderCtx) => ticketsToReceive(ctx.db, ctx.actor, ctx.now);

export const storesApproveDesk: DeskProvider = {
  key: "stores.approve", permission: STORES_INDENTS_APPROVE,
  load: async (ctx) => card("stores.approve", "stores.now.toApprove", await approve(ctx), (t) => `/stores/approve?ticket=${t.id}`, "Open"),
  waiting: async (ctx) => line("stores.indentsToApprove", await approve(ctx)),
  waitingSelfGated: true,
};

export const storesPickDesk: DeskProvider = {
  key: "stores.pick", permission: "materials.stock.issue",
  load: async (ctx) => card("stores.pick", "stores.now.toPick", await pick(ctx), (t) => `/stores/pick?ticket=${t.id}`, "Open"),
  waiting: async (ctx) => line("stores.toPick", await pick(ctx)),
  waitingSelfGated: true,
};

export const storesReceiveDesk: DeskProvider = {
  key: "stores.receive", permission: STORES_SHELF_WORK,
  load: async (ctx) => card("stores.receive", "stores.now.toReceive", await receive(ctx), (t) => `/stores/receive?ticket=${t.id}`, "Open"),
  waiting: async (ctx) => line("stores.toReceive", await receive(ctx)),
  waitingSelfGated: true,
};

/**
 * UX pass (#1112): "To take back" — what is coming back to a store the reader keeps (tickets returning undelivered
 * or sent back, department returns) and the late scans to confirm. One count; every row opens the keeper's To
 * pick screen, where each is one tap. Ticket numbers and shelves only, never a person or money.
 */
export const storesTakeBackDesk: DeskProvider = {
  key: "stores.back", permission: "materials.stock.issue",
  load: async (ctx) => {
    const [tickets, returns, late] = await Promise.all([
      ticketsComingBack(ctx.db, ctx.actor, ctx.now), returnsToReceive(ctx.db, ctx.actor), lateScansToConfirm(ctx.db, ctx.actor),
    ]);
    const rows = [
      ...tickets.map((t) => ({ id: t.id, badge: null, title: t.indentNo, subtitle: t.department.name, action: "Open", href: "/stores/pick", severity: null })),
      ...returns.map((r) => ({ id: r.transferId, badge: null, title: r.shelf.name, subtitle: String(r.lines.length), action: "Open", href: "/stores/pick", severity: null })),
      ...late.map((l) => ({ id: l.handoffId, badge: null, title: l.indentNo, subtitle: "Late scan", action: "Open", href: "/stores/pick", severity: "warn" as const })),
    ];
    if (rows.length === 0) return [];
    return [{ key: "stores.back", band: "now", titleKey: "stores.now.toTakeBack", stats: [{ key: "count", value: String(rows.length), href: "/stores/pick" }], rows: rows.slice(0, MAX_ROWS) }];
  },
};

/**
 * S3 (#1113, decision 13) — "Stuck" (`stores.tower.read`: the materials head, the duty manager, the store, the
 * superintendent, the owner): every ticket past a clock, the longest-broken first, each naming the clock that broke.
 * The tower's own read (`boardCards`), so the card and the board agree. A ticket number and a department per row.
 */
export const storesStuckDesk: DeskProvider = {
  key: "stores.stuck", permission: STORES_TOWER_READ,
  load: async (ctx) => {
    const stuck = (await boardCards(ctx.db, ctx.now)).filter((c) => c.card.lane === "stuck")
      .sort((a, b) => (b.card.clock?.minutes ?? 0) - (a.card.clock?.minutes ?? 0));
    if (stuck.length === 0) return [];
    return [{
      key: "stores.stuck", band: "now", titleKey: "stores.now.stuck",
      stats: [{ key: "count", value: String(stuck.length), href: "/stores/tower" }],
      rows: stuck.slice(0, MAX_ROWS).map(({ card: c }) => ({
        id: c.id, badge: c.priority === "emergency" ? "!" : null, title: c.indentNo,
        subtitle: `${c.department.name} · ${c.clock!.kind} ${String(c.clock!.minutes)} min`, action: "Open", href: `/stores/tickets/${c.id}`,
        severity: "hot" as const,
      })),
    }];
  },
};

/**
 * S4b (#1114, flow step 5) — "Faults to see" (`stores.assets.manage`: biomedical, the materials head): every live unit
 * whose newest fault came after its last repair act, oldest first. A unit name, its last four and its place per row.
 */
export const storesFaultsDesk: DeskProvider = {
  key: "stores.faults", permission: STORES_ASSETS_MANAGE,
  load: async (ctx) => {
    const rows = await faultsToSee(ctx.db);
    if (rows.length === 0) return [];
    return [{
      key: "stores.faults", band: "now", titleKey: "stores.now.faults",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/assets" }],
      rows: rows.slice(0, MAX_ROWS).map((r) => ({
        id: r.unitId, badge: null, title: `${r.name} · ${r.last4}`, subtitle: r.place, action: "Open", href: `/stores/asset?unit=${r.unitId}`, severity: "warn" as const,
      })),
    }];
  },
};

/**
 * S4b (#1114, decision 13) — "Condemnation to sign" (`stores.assets.condemn`): proposals with a seat this person may
 * still sign. The HOD's seat is department-scoped, so it is also a waiting line (the roster-leave precedent).
 */
const toSign = (ctx: DeskProviderCtx) => condemnationsToSign(ctx.db, ctx.actor, ctx.now);
export const storesCondemnDesk: DeskProvider = {
  key: "stores.condemn", permission: STORES_ASSETS_CONDEMN,
  load: async (ctx) => {
    const rows = await toSign(ctx);
    if (rows.length === 0) return [];
    return [{
      key: "stores.condemn", band: "now", titleKey: "stores.now.condemn",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/condemn" }],
      rows: rows.slice(0, MAX_ROWS).map((c) => ({
        id: c.id, badge: null, title: `${c.unit.name} · ${c.unit.last4}`, subtitle: c.condNo, action: "Open", href: `/stores/condemn?c=${c.id}`, severity: "warn" as const,
      })),
    }];
  },
  waiting: async (ctx) => {
    const rows = await toSign(ctx);
    const item = waitingItem("stores.condemnToSign", rows.length, rows.reduce<string | null>((o, c) => (o === null || c.proposedAt < o ? c.proposedAt : o), null));
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

/**
 * S5c (#1115, spec "Notices") — "Purchase to approve / खरीद मंज़ूरी बाकी": the requests waiting for this person (their
 * department's as HOD, stand-in or delegate; the store's for the materials head). The HOD's grant is department-scoped,
 * so it is also a waiting line. A request number and a department per row; never a supplier or money.
 */
const prsToApprove = (ctx: DeskProviderCtx) => purchaseRequestsToApprove(ctx.db, ctx.actor, ctx.now);
export const storesPurchaseApproveDesk: DeskProvider = {
  key: "stores.purchase", permission: STORES_INDENTS_APPROVE,
  load: async (ctx) => {
    const rows = await prsToApprove(ctx);
    if (rows.length === 0) return [];
    return [{
      key: "stores.purchase", band: "now", titleKey: "stores.now.purchaseToApprove",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/buy" }],
      rows: rows.slice(0, MAX_ROWS).map((r) => ({
        id: r.id, badge: r.priority === "emergency" ? "!" : null, title: r.prNo, subtitle: `${r.department?.name ?? "Central store"} · ${String(r.lines.length)}`,
        action: "Open", href: `/stores/buy?pr=${r.id}`, severity: r.priority === "emergency" ? "hot" as const : r.priority === "urgent" ? "warn" as const : null,
      })),
    }];
  },
  waiting: async (ctx) => {
    const rows = await prsToApprove(ctx);
    const item = waitingItem("stores.purchaseToApprove", rows.length, rows.reduce<string | null>((o, r) => (o === null || r.raisedAt < o ? r.raisedAt : o), null));
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

/**
 * S5c (#1115) — "Award to sign / आवंटन पर हस्ताक्षर": awards this person may sign now (a committee seat, the materials
 * head's band B approval, the owner's last signature). The user HOD's seat is department-scoped: a waiting line too.
 */
const toSignAwards = async (ctx: DeskProviderCtx) => (await listAwards(ctx.db, ctx.actor, ctx.now)).filter((a) => a.mine?.canSign === true);
export const storesAwardSignDesk: DeskProvider = {
  key: "stores.award", permission: STORES_AWARD_SIGN,
  load: async (ctx) => {
    const rows = await toSignAwards(ctx);
    if (rows.length === 0) return [];
    return [{
      key: "stores.award", band: "now", titleKey: "stores.now.awardToSign",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/buying" }],
      rows: rows.slice(0, MAX_ROWS).map((a) => ({
        id: a.id, badge: a.equipment ? "!" : null, title: a.rfqNo ?? a.band, subtitle: a.band, action: "Open", href: `/stores/buying?award=${a.id}`, severity: "warn" as const,
      })),
    }];
  },
  waiting: async (ctx) => {
    const rows = await toSignAwards(ctx);
    const item = waitingItem("stores.awardToSign", rows.length, rows.reduce<string | null>((o, a) => (o === null || a.proposedAt < o ? a.proposedAt : o), null));
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

/**
 * S6c (#1116, spec "Notices") — "Service to confirm / सेवा की पुष्टि करें": the department's confirmers' line (their grant is
 * department-scoped, so a waiting line, not a card); the count is the service POs last confirmed at their department
 * whose last month is not yet confirmed (`paying-notices.ts` `servicesDue`).
 */
export const storesServicesDesk: DeskProvider = {
  key: "stores.services", permission: STORES_SES_CONFIRM,
  load: noDeskCards,
  waiting: async (ctx) => {
    const d = await servicesDueFor(ctx.db, ctx.actor, ctx.now);
    const item = waitingItem("stores.servicesToConfirm", d.n, d.since);
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

/** S6c (#1116) — "MSME bill due soon / MSME बिल जल्द देय": the payment preparers' card and line (bill numbers only, no supplier, no amount). */
export const storesMsmeDueDesk: DeskProvider = {
  key: "stores.msmeDue", permission: "materials.payments.prepare",
  load: async (ctx) => {
    const rows = await msmeBillsDueSoon(ctx.db, ctx.now);
    if (rows.length === 0) return [];
    return [{
      key: "stores.msmeDue", band: "now", titleKey: "stores.now.msmeDueSoon",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/pay?tab=due" }],
      rows: rows.slice(0, MAX_ROWS).map((b) => ({ id: b.id, badge: "!", title: b.billNo, subtitle: b.dueDate, action: "Open", href: "/stores/pay?tab=due", severity: "hot" as const })),
    }];
  },
  waiting: async (ctx) => {
    if (ctx.actor.type !== "user" || !(await hasPermission(ctx.db, ctx.actor.id, "materials.payments.prepare", "hospital"))) return [];
    const rows = await msmeBillsDueSoon(ctx.db, ctx.now);
    const item = waitingItem("stores.msmeDueSoon", rows.length, null);
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

/**
 * S6c (#1116, decision 11) — "Flags to review / जाँच के संकेत": the auditor's open flags, for the materials head and the
 * stores auditor only (edge case 8: never a notice board). A flag open for 7 days is marked hot (the spec's "tower card";
 * DECIDED a Now card, because the tower's key set is locked by S3).
 */
const FLAG_WORDS: Record<WireAuditFlag["kind"], string> = {
  use_out_of_pattern: "Use above pattern", price_drift: "Price above contract", split_po: "Split purchase", both_ends: "One person at both ends",
  more_than_book: "More than book",
};
export const storesFlagsDesk: DeskProvider = {
  key: "stores.flags", permission: STORES_AUDIT_READ,
  load: async (ctx) => {
    const rows = await flagsToReview(ctx.db, ctx.actor, ctx.now);
    if (rows.length === 0) return [];
    return [{
      key: "stores.flags", band: "now", titleKey: "stores.now.flagsToReview",
      stats: [{ key: "count", value: String(rows.length), href: "/stores/pay?flags=1" }],
      rows: rows.slice(0, MAX_ROWS).map((f) => ({
        id: f.id, badge: f.stale ? "!" : null, title: FLAG_WORDS[f.kind], subtitle: f.departments.map((d) => d.name).join(", "), action: "Open", href: "/stores/pay?flags=1",
        severity: f.stale ? "hot" as const : "warn" as const,
      })),
    }];
  },
  waiting: async (ctx) => {
    const rows = await flagsToReview(ctx.db, ctx.actor, ctx.now);
    const item = waitingItem("stores.flagsToReview", rows.length, rows[0]?.raisedAt ?? null);
    return item === null ? [] : [item];
  },
  waitingSelfGated: true,
};

export const STORES_DESK_PROVIDERS = [
  storesApproveDesk, storesPickDesk, storesReceiveDesk, storesTakeBackDesk, storesStuckDesk, storesFaultsDesk, storesCondemnDesk, storesPurchaseApproveDesk,
  storesAwardSignDesk, storesServicesDesk, storesMsmeDueDesk, storesFlagsDesk,
] as const;
