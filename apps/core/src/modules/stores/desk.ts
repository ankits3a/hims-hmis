import { waitingItem } from "../../kernel/desk/waiting";
import { STORES_INDENTS_APPROVE, STORES_SHELF_WORK } from "./access";
import { ticketsToApprove, ticketsToPick, ticketsToReceive } from "./tickets";
import type { DeskCard, DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";
import type { TicketView } from "./types";
import type { WaitingItem, WaitingKind } from "@hmis/contracts";

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

export const STORES_DESK_PROVIDERS = [storesApproveDesk, storesPickDesk, storesReceiveDesk] as const;
