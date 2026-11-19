import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { resources, stockBalances, storeIndents, storesTicketDetails } from "../../kernel/db/schema";
import { asciiDigits } from "../../kernel/copilot/mask";
import { STORES_INDENTS_APPROVE, STORES_NIGHTSTORE_ISSUE, STORES_SHELF_READ, STORES_SHELF_WORK, holds, isStoresStore, toStoresStore } from "./access";
import { STORES_CARRY, myCustody } from "./custody";
import { findStoreByCode, TRANSIT_STORE_CODE } from "../materials";
import { listStoresItems } from "./items";
import { myShelves } from "./reads";
import { ticketsToApprove, ticketsToPick, ticketsToReceive } from "./tickets";
import { STORES_TOWER_READ, boardCards, redCards, shelfStates } from "./tower";
import type { BoardCard } from "./tower";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor, CopilotAnswerKey, CopilotStoresPlaces, CopilotStoresTickets, StoresTowerLane } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #1113 (S3) — THE STORES CONCIERGE'S SIX READS, declared for the boot collector
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Each wraps the module's own read for the same screen — the tower's `boardCards`, the Now cards' `ticketsTo*`,
 * the porter's `myCustody`, the shelf's states — so an answer and a screen can never disagree. The one act
 * (`stores.reorder`) is `copilot-acts.ts`, behind propose → confirm. The words that route to all seven are
 * `copilot-intents.ts`; no model is on the path (spec #1113 decision 8: cue-routed only).
 *
 * Every answer is a key and parameters (decision 8): counts, minutes and names come from those reads, never from a
 * model. There is no patient anywhere in Stores.
 *
 * ═══ THE DEPARTMENT IS THE SCOPE (`scopedGate`) ═══
 *
 * A ward's in-charge or head holds `stores.shelf.read` AT their department, never hospital-wide. The kernel admits
 * a `scopedGate` tool for an asker who holds its permission at ANY scope, and each tool here then reads only the
 * departments that grant it (`myShelves`, `holds(…, departmentId)`), or the whole hospital for a holder of
 * `stores.tower.read`. Another department's ticket answers "not permitted", never its lane (edge case AI-3).
 *
 * ═══ NEVER A TOOL (decision 10) ═══
 *
 * Approve, decline, review, claim, issue, carry, hand over, receive, resolve a short, write off, a gate pass, any
 * supplier message, any money. Nothing here or in the act reaches one.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });
const notPermitted = (): CopilotAnswer => say("copilot.answer.notPermitted");

/** `MIN` + `YYMMDD` + a four-digit serial (`kernel/episodes/series.ts` `store_indent`). */
const INDENT_RE = /^MIN\d{10}$/;

/**
 * The indent number a subject spells, however it came: the masker hands over the DIGITS (the prefix stays in the
 * question, `mask.ts`), a typed one may carry the prefix, dashes or Devanagari digits. Null for anything else.
 */
export function indentNoOf(subject: string): string | null {
  const s = asciiDigits(subject).replace(/[\s-]/g, "").toUpperCase();
  const n = /^\d{10}$/.test(s) ? `MIN${s}` : s;
  return INDENT_RE.test(n) ? n : null;
}

const towerReader = (db: Db | Tx, actor: Actor): Promise<boolean> => holds(db, actor, STORES_TOWER_READ);

/** The departments whose shelves this person reads (all of them for the tower and the masters). */
async function readableDepartments(db: Db, actor: Actor): Promise<Set<string> | "all"> {
  if (await towerReader(db, actor)) return "all";
  return new Set((await myShelves(db, actor)).map((s) => s.departmentId).filter((x): x is string => x !== null));
}

/** What happens next on a lane: the HOD approves, the store picks, the porter or the receiver closes it. */
function nextOf(lane: Exclude<StoresTowerLane, "stuck">): "approve" | "pick" | "receive" | "none" {
  if (lane === "requested") return "approve";
  if (lane === "approved" || lane === "picking") return "pick";
  if (lane === "in_transit") return "receive";
  return "none";
}

/** The board's card as the concierge says it: lane, holder, minutes, and the next step (or the clock that broke). */
export function ticketAnswer(c: BoardCard): CopilotAnswer {
  const holder = c.card.holder?.name ?? "";
  if (c.card.lane === "stuck") {
    return say("copilot.answer.storesTicketStuck", { ticket: c.card.indentNo, clock: c.card.clock!.kind, minutes: c.card.clock!.minutes, holder });
  }
  return say("copilot.answer.storesTicketWhere", { ticket: c.card.indentNo, lane: c.card.lane, holder, minutes: c.card.minutes, next: nextOf(c.under) });
}

/* ═══════════════════════════════════ the six reads ═══════════════════════════════════ */

const whereIsTicket: CopilotToolDecl = {
  intent: "stores.where_is_ticket",
  permission: STORES_SHELF_READ,
  alsoAdmits: [STORES_TOWER_READ],
  scopedGate: true,
  needsSubject: false,
  kind: "read",
  /**
   * `boardCards` for the one ticket: lane, holder, minutes, next step (the tower's card, D9). With no number, the
   * asker's own newest ticket still on the board ("mera saman kahan hai", programme edge case AI-10).
   */
  async run(ctx) {
    const now = new Date();
    const no = ctx.subject === null ? null : indentNoOf(ctx.subject);
    if (ctx.subject !== null && no === null) return say("copilot.answer.storesNoTicket");
    let indentId: string | null = null;
    let departmentId: string | null = null;
    if (no !== null) {
      const [row] = await ctx.db.select({ id: storeIndents.id, dept: storesTicketDetails.departmentId }).from(storeIndents)
        .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id)).where(eq(storeIndents.indentNo, no));
      if (row === undefined) return say("copilot.answer.storesNoTicket");
      ({ id: indentId, dept: departmentId } = row);
    } else {
      const [row] = await ctx.db.select({ id: storeIndents.id, dept: storesTicketDetails.departmentId }).from(storeIndents)
        .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
        .where(and(eq(storeIndents.requestedBy, ctx.actor.id), notInArray(storeIndents.status, ["cancelled", "rejected"])))
        .orderBy(desc(storeIndents.requestedAt)).limit(1);
      if (row === undefined) return say("copilot.answer.storesNoTicket");
      ({ id: indentId, dept: departmentId } = row);
    }
    if (!(await towerReader(ctx.db, ctx.actor)) && !(await holds(ctx.db, ctx.actor, STORES_SHELF_READ, departmentId))) return notPermitted();
    const [card] = await boardCards(ctx.db, now, [indentId]);
    if (card === undefined) return say("copilot.answer.storesNoTicket");
    return ticketAnswer(card);
  },
};

const myTickets: CopilotToolDecl = {
  intent: "stores.my_tickets",
  permission: STORES_SHELF_READ,
  scopedGate: true,
  needsSubject: false,
  kind: "read",
  /** The asker's departments' open tickets, counted by lane (the tower's lanes). */
  async run(ctx) {
    const depts = await readableDepartments(ctx.db, ctx.actor);
    if (depts !== "all" && depts.size === 0) return say("copilot.answer.storesNoShelf");
    const cards = (await boardCards(ctx.db, new Date())).filter((c) => depts === "all" || depts.has(c.card.department.id));
    if (cards.length === 0) return say("copilot.answer.storesMyTicketsNone");
    const n = (lane: StoresTowerLane): number => cards.filter((c) => c.card.lane === lane).length;
    return say("copilot.answer.storesMyTickets", {
      requested: n("requested"), approved: n("approved"), picking: n("picking"), transit: n("in_transit"), delivered: n("delivered"), stuck: n("stuck"),
    });
  },
};

const waitingForMe: CopilotToolDecl = {
  intent: "stores.waiting_for_me",
  permission: STORES_INDENTS_APPROVE,
  alsoAdmits: ["materials.stock.issue", STORES_NIGHTSTORE_ISSUE, STORES_CARRY, STORES_SHELF_WORK],
  scopedGate: true,
  needsSubject: false,
  kind: "read",
  /**
   * The Now cards' own reads, each already scoped to the asker: approvals of the departments they approve for
   * (never their own ticket), picks of the stores they keep, the tickets in their hands, receipts for their shelves.
   */
  async run(ctx) {
    const now = new Date();
    const [approve, pick, carry, receive] = await Promise.all([
      ticketsToApprove(ctx.db, ctx.actor, now), ticketsToPick(ctx.db, ctx.actor, now), myCustody(ctx.db, ctx.actor, now), ticketsToReceive(ctx.db, ctx.actor, now),
    ]);
    const tickets = [...new Set([...approve.map((t) => t.indentNo), ...pick.map((t) => t.indentNo), ...carry.map((r) => r.ticket.indentNo), ...receive.map((t) => t.indentNo)])];
    if (tickets.length === 0) return say("copilot.answer.storesWaitingNone");
    const payload: CopilotStoresTickets = { kind: "storesTickets", tickets };
    return { ...say("copilot.answer.storesWaiting", { approve: approve.length, pick: pick.length, carry: carry.length, receive: receive.length }), payload };
  },
};

/** Words of a name worth matching: three letters or more, lower case. */
const wordsOf = (s: string): string[] => s.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 3);

/**
 * The Stores item a question names: the one with the most of its name's (or an alias's) words in the question, a
 * question word counting when it starts with the name's word ("refills" names "refill"). Ties go to the shorter name.
 * Item names are data, never instructions (edge case AI-4): they are only compared.
 */
export async function itemNamed(db: Db | Tx, text: string): Promise<{ id: string; name: string } | null> {
  const asked = wordsOf(text);
  let best: { id: string; name: string; score: number } | null = null;
  for (const i of (await listStoresItems(db)).filter((x) => x.active)) {
    for (const label of [i.name, ...i.searchAliases]) {
      const want = wordsOf(label);
      const score = want.filter((w) => asked.some((a) => a.startsWith(w))).length;
      if (score === 0) continue;
      if (best === null || score > best.score || (score === best.score && i.name.length < best.name.length)) best = { id: i.id, name: i.name, score };
    }
  }
  return best === null ? null : { id: best.id, name: best.name };
}

const whereIsItem: CopilotToolDecl = {
  intent: "stores.where_is_item",
  permission: STORES_SHELF_READ,
  alsoAdmits: [STORES_TOWER_READ],
  scopedGate: true,
  needsSubject: false,
  kind: "read",
  /**
   * On hand per place the asker may see (decision 8): every Stores store (central, sub, night), the asker's own
   * shelves (every shelf for the tower), and IN-TRANSIT. Each quantity is the materials balance, a ledger sum.
   */
  async run(ctx) {
    const item = await itemNamed(ctx.db, ctx.typed ?? ctx.question);
    if (item === null) return say("copilot.answer.storesNoItem");
    const all = (await ctx.db.select().from(resources).where(and(eq(resources.kind, "store"), ne(resources.status, "retired"))))
      .filter((r) => isStoresStore(r)).map((r) => ({ ...toStoresStore(r), name: r.name }));
    const tower = await towerReader(ctx.db, ctx.actor);
    const mine = new Set((await myShelves(ctx.db, ctx.actor)).map((s) => s.id));
    const places = all.filter((s) => s.kind !== "shelf" || tower || mine.has(s.id));
    const transit = await findStoreByCode(ctx.db, TRANSIT_STORE_CODE);
    const ids = [...places.map((p) => p.id), ...(transit === null || transit === undefined ? [] : [transit.id])];
    const bal = new Map<string, number>();
    for (const b of await ctx.db.select({ resourceId: stockBalances.resourceId, qty: stockBalances.qtyOnHand }).from(stockBalances)
      .where(and(eq(stockBalances.itemId, item.id), inArray(stockBalances.resourceId, ids.length === 0 ? [""] : ids)))) {
      bal.set(b.resourceId, (bal.get(b.resourceId) ?? 0) + b.qty);
    }
    const rows: CopilotStoresPlaces["rows"] = [
      ...places.map((p) => ({ place: p.name, kind: (p.kind === "shelf" ? "shelf" : "store") as "shelf" | "store", qty: bal.get(p.id) ?? 0 })),
      ...(transit === null || transit === undefined ? [] : [{ place: TRANSIT_STORE_CODE, kind: "transit" as const, qty: bal.get(transit.id) ?? 0 }]),
    ].filter((r) => r.qty !== 0);
    const payload: CopilotStoresPlaces = { kind: "storesPlaces", item: item.name, rows };
    return { ...say("copilot.answer.storesItemWhere", { item: item.name, total: rows.reduce((n, r) => n + r.qty, 0) }), payload };
  },
};

const shelfLow: CopilotToolDecl = {
  intent: "stores.shelf_low",
  permission: STORES_SHELF_READ,
  scopedGate: true,
  needsSubject: false,
  kind: "read",
  /** The asker's shelves' Low and Out items: the floor map's rule (`shelfStates`), the shelf screen's words. */
  async run(ctx) {
    const shelves = await myShelves(ctx.db, ctx.actor);
    if (shelves.length === 0) return say("copilot.answer.storesNoShelf");
    const states = await shelfStates(ctx.db, shelves.map((s) => s.id));
    const low = states.reduce((n, s) => n + s.low, 0);
    const out = states.reduce((n, s) => n + s.out, 0);
    const named = states.filter((s) => s.low + s.out > 0).map((s) => s.shelfName);
    const shelf = (named.length === 0 ? shelves.map((s) => s.name) : named).slice(0, 3).join(", ");
    return low + out === 0 ? say("copilot.answer.storesShelfLowNone", { shelf }) : say("copilot.answer.storesShelfLow", { shelf, low, out });
  },
};

const stuck: CopilotToolDecl = {
  intent: "stores.stuck",
  permission: STORES_TOWER_READ,
  needsSubject: false,
  kind: "read",
  /** The tower's red cards (uncapped), counted by kind. */
  async run(ctx) {
    const now = new Date();
    const cards = await boardCards(ctx.db, now);
    const red = await redCards(ctx.db, now, cards, await shelfStates(ctx.db));
    if (red.length === 0) return say("copilot.answer.storesStuckNone");
    const n = (k: string): number => red.filter((c) => c.kind === k).length;
    return say("copilot.answer.storesStuck", { count: red.length, stuck: n("stuck"), short: n("short"), out: n("out"), pass: n("pass"), overBook: n("over_book") });
  },
};

export const storesCopilotReadTools: readonly CopilotToolDecl[] = [whereIsTicket, myTickets, waitingForMe, whereIsItem, shelfLow, stuck];

/** The shelves this person may reorder for: every shelf of a department where they hold `stores.shelf.work`. */
export async function workShelves(db: Db, actor: Actor): Promise<{ id: string; name: string; departmentId: string }[]> {
  const out: { id: string; name: string; departmentId: string }[] = [];
  const may = new Map<string, boolean>();
  for (const s of await myShelves(db, actor)) {
    if (s.departmentId === null) continue;
    if (!may.has(s.departmentId)) may.set(s.departmentId, await holds(db, actor, STORES_SHELF_WORK, s.departmentId));
    if (may.get(s.departmentId) === true) out.push({ id: s.id, name: s.name, departmentId: s.departmentId });
  }
  return out;
}
