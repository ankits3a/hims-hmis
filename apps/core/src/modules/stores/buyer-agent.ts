import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { argsHash } from "../../kernel/copilot/act";
import { readCopilotGate, toolHalted } from "../../kernel/copilot/halt";
import { withTx } from "../../kernel/db/client";
import {
  copilotActs, itemCategories, itemStockLevels, items, orgDepartments, purchaseOrders, stockBalances, storesAgentProposalSteps, storesAgentProposals,
  storesAwards, storesPurchaseRequestLines, storesPurchaseRequestStamps, storesPurchaseRequests, storesRfqs, vendors,
} from "../../kernel/db/schema";
import { NON_SUPPLIER_VENDOR_CODES, contractRatesFor, onOrderAt, purchaseHistoryByItem } from "../materials";
import { STORES_BUYING_MANAGE, holds, recordAct } from "./access";
import { makePoFromGroup } from "./awards";
import { bandOfLines, getBuyGroup, groupRequests, requireGroup } from "./buy-groups";
import { approvedPrIds, byItem, centralStoreId, ex, groupLines, lineKey, membership, peopleNamed, vendorNames } from "./buying-common";
import { StoresError } from "./errors";
import { groupQuotes } from "./quotes";
import { createRfq, getRfq } from "./rfq";
import { quarterOf, scorecardFigures } from "./scorecard";
import { supplierKyc } from "./suppliers";
import { raisePurchaseRequest } from "./purchase-requests";
import { sendOwnerOverBudgetList } from "./budgets";
import type { PoView } from "../materials";
import type {
  Actor, StoresAgentProposalKind, StoresAgentProposalStatus, StoresBand, WireAgentLine, WireAgentProposal, WireAgentSupplier, WireBuyGroup, WireRfq,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S5c (#1115, decisions 5 and 6, "Audit by construction"; D21, D22) — THE BUYER AGENT: IT DRAFTS, A PERSON ACTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Four drafts, each a `stores_agent_proposals` row and nothing more:
 *   grouping   22:00 IST, the worker's job (`runBuyerNight`): approved ROUTINE requests not yet grouped, put together by
 *              category, then likely supplier (an open rate contract, else the last supplier). Urgent and emergency
 *              requests are never grouped or held: they are on "Buy now" the moment they are approved (S5b, a read).
 *              At most THREE open proposals per department (`central` for the store's own requests): a fourth is not
 *              written, and the run says which department was capped.
 *   rfq_draft  asked at the desk for one group: the items, the delivery place and dates, and the suppliers best first
 *              (every one that "can quote", those approved for the category first, then the scorecard, then those who
 *              supplied the items before). The buyer ticks at least three; confirming creates the RFQ UNSENT —
 *              `sendRfq` stays the one send, a person's tap (decision 6).
 *   po_draft   for a band A group whose every line is on a live rate contract or has its one quote on file: the PO as
 *              Make PO would make it. Confirming makes it as a DRAFT (`source: agent`); submit, the tier's approval and
 *              Send PO are the people's, unchanged.
 *   quote_read `quote-reader.ts`: lines read from a supplier's PDF, each confirmed by the buyer.
 *
 * A CONFIRM IS THE ONLY WRITE, and it writes the record, its `copilot_acts` row (the confirming person, the draft as the
 * proposal, `confirm_id` = `sa_<draft>` so the unique index refuses a second act for one draft) and the closing step in
 * ONE transaction. It re-reads the state first: lines grouped meanwhile, an RFQ made by hand, a different quote — then
 * `state_changed`, and nothing is written. The agent never sends, orders, awards or signs.
 *
 * The copilot's halt (`draft` or `global`) stops every agent draft (`runBuyerNight` writes nothing; a desk draft answers
 * `agent_paused`). No model is used here: grouping and suggestions are rules over rows, so they work with the model off.
 */
export const BUYER_AGENT: Actor = { type: "agent", id: "stores-buyer-agent" };
export const PROPOSAL_CAP_PER_DEPARTMENT = 3;
export const CENTRAL_KEY = "central";
export const AGENT_TOOLS = {
  grouping: "stores.buyer_grouping", rfq_draft: "stores.buyer_rfq_draft", quote_read: "stores.buyer_quote_read", po_draft: "stores.buyer_po_draft",
} as const satisfies Record<StoresAgentProposalKind, string>;
/** Reply-by and delivery the RFQ draft proposes (DECIDED): seven days to quote by 17:00 IST, delivery fourteen days later. */
const REPLY_DAYS = 7;
const DELIVERY_AFTER_REPLY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUGGEST = 3;
const MAX_SUPPLIERS = 30;

type ProposalRow = typeof storesAgentProposals.$inferSelect;
type StepRow = typeof storesAgentProposalSteps.$inferSelect;
type GroupingPayload = {
  label: string; categoryId: string | null; categoryName: string | null; vendorId: string | null; vendorName: string | null;
  lines: { prId: string; lineIdx: number }[];
};
type RfqDraftPayload = { suppliers: WireAgentSupplier[]; replyBy: string; deliveryDate: string; askedBy: string };
type PoDraftPayload = { lines: { itemId: string; vendorId: string; ratePaise: number; discountBps: number; gstRateBps: number; via: "contract" | "quote" }[]; askedBy: string };

export async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "the buying desk is the buyer's", { permission: STORES_BUYING_MANAGE });
}

/** Is the copilot's draft switch (or the global one) down? One indexed read, no cache (`kernel/copilot/halt.ts`). */
export async function agentHalted(db: Db | Tx, now: Date): Promise<boolean> {
  return toolHalted({ kind: "draft" }, (await readCopilotGate(db as Db, now)).halts);
}

export async function requireProposal(db: Db | Tx, id: string, kind?: StoresAgentProposalKind): Promise<ProposalRow> {
  const [p] = await ex(db).select().from(storesAgentProposals).where(eq(storesAgentProposals.id, id));
  if (p === undefined || (kind !== undefined && p.kind !== kind)) throw new StoresError("unknown_proposal", "no such draft", { proposalId: id });
  return p;
}

async function stepsOf(db: Db | Tx, ids: readonly string[]): Promise<StepRow[]> {
  if (ids.length === 0) return [];
  return ex(db).select().from(storesAgentProposalSteps).where(inArray(storesAgentProposalSteps.proposalId, [...ids])).orderBy(asc(storesAgentProposalSteps.at), asc(storesAgentProposalSteps.id));
}

const CLOSING = new Set(["confirmed", "dismissed", "superseded"]);
function statusOf(steps: readonly StepRow[]): StoresAgentProposalStatus {
  const close = steps.find((s) => CLOSING.has(s.kind));
  return (close?.kind as StoresAgentProposalStatus | undefined) ?? "open";
}

/** Lock the draft's row for this confirm and refuse a closed one: two taps cannot both write. */
export async function lockOpen(tx: Tx, id: string, kind: StoresAgentProposalKind): Promise<ProposalRow> {
  const [p] = await tx.select().from(storesAgentProposals).where(eq(storesAgentProposals.id, id)).for("update");
  if (p === undefined || p.kind !== kind) throw new StoresError("unknown_proposal", "no such draft", { proposalId: id });
  if (statusOf(await stepsOf(tx, [id])) !== "open") throw new StoresError("proposal_closed", "this draft is already done");
  return p;
}

/**
 * The confirm's ledger: the `copilot_acts` row naming the person, the closing step, one act. Same transaction as the
 * record it made. Returns the act's id.
 */
export async function recordConfirm(
  tx: Tx, actor: Actor, p: ProposalRow, args: unknown, result: { module: string; rowId: string }, now: Date,
): Promise<string> {
  const actId = newId();
  const confirmId = `sa_${p.id}`;
  await tx.insert(copilotActs).values({
    id: actId, at: now, actorId: actor.id, tool: AGENT_TOOLS[p.kind as StoresAgentProposalKind], subjectPatientId: null, argsHash: argsHash(args),
    proposalId: p.id, confirmId, resultModule: result.module, resultRowId: result.rowId,
  });
  await tx.insert(storesAgentProposalSteps).values({ id: newId(), proposalId: p.id, kind: "confirmed", confirmId, resultRowId: result.rowId, by: actor.id, at: now });
  await recordAct(tx, actor, now, { act: "confirm_agent_draft", refId: p.id, after: { kind: p.kind, confirmId, actId, resultRowId: result.rowId } });
  return actId;
}

// ═══════════════════════════════ reads ═══════════════════════════════

async function linesOfRequests(db: Db | Tx, refs: readonly { prId: string; lineIdx: number }[]): Promise<WireAgentLine[]> {
  if (refs.length === 0) return [];
  const prIds = [...new Set(refs.map((r) => r.prId))];
  const rows = await ex(db).select({ l: storesPurchaseRequestLines, name: items.name, uom: items.baseUom }).from(storesPurchaseRequestLines)
    .innerJoin(items, eq(items.id, storesPurchaseRequestLines.itemId)).where(inArray(storesPurchaseRequestLines.prId, prIds));
  const want = new Set(refs.map((r) => lineKey(r.prId, r.lineIdx)));
  return rows.filter((r) => want.has(lineKey(r.l.prId, r.l.lineIdx))).map(({ l, name, uom }) => ({
    lineIdx: l.lineIdx, prId: l.prId, itemId: l.itemId, itemName: name, qtyBase: l.qtyBase, baseUom: uom, estimatePaise: l.qtyBase * l.unitEstimatePaise,
    vendorId: null, ratePaise: null, discountBps: null, gstRateBps: null, source: null, state: "draft" as const,
  }));
}

async function departmentNames(db: Db | Tx, keys: readonly string[]): Promise<{ id: string | null; name: string }[]> {
  const ids = keys.filter((k) => k !== CENTRAL_KEY);
  const names = new Map(ids.length === 0 ? [] : (await ex(db).select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, ids))).map((d) => [d.id, d.name] as const));
  return keys.map((k) => (k === CENTRAL_KEY ? { id: null, name: "Central store" } : { id: k, name: names.get(k) ?? k }));
}

export async function proposalViews(db: Db | Tx, rows: readonly ProposalRow[], now: Date): Promise<WireAgentProposal[]> {
  if (rows.length === 0) return [];
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const person = await peopleNamed(db, steps.map((s) => s.by));
  const vnames = await vendorNames(db, rows.map((r) => r.vendorId).filter((x): x is string => x !== null));
  const out: WireAgentProposal[] = [];
  for (const p of rows) {
    const mine = steps.filter((s) => s.proposalId === p.id);
    const status = statusOf(mine);
    const close = mine.find((s) => CLOSING.has(s.kind));
    const base: WireAgentProposal = {
      id: p.id, kind: p.kind as StoresAgentProposalKind, status, madeAt: p.madeAt.toISOString(), byAgent: p.madeBy === BUYER_AGENT.id,
      label: null, band: null, estimatePaise: null, departments: await departmentNames(db, p.departmentIds), groupId: p.groupId, rfqId: p.rfqId,
      vendorId: p.vendorId, vendorName: p.vendorId === null ? null : (vnames.get(p.vendorId)?.name ?? null), lines: [], suppliers: [], replyBy: null,
      deliveryDate: null, readable: null, reader: null, hasDocument: p.documentKey !== null,
      closed: close === undefined ? null : { kind: close.kind as StoresAgentProposalStatus, by: person(close.by), at: close.at.toISOString(), resultRowId: close.resultRowId },
    };
    if (p.kind === "grouping") {
      const pay = p.payload as GroupingPayload;
      const lines = await linesOfRequests(db, pay.lines);
      base.label = pay.label;
      base.vendorName = pay.vendorName;
      base.lines = lines;
      base.estimatePaise = lines.reduce((a, l) => a + (l.estimatePaise ?? 0), 0);
      if (status === "open") base.band = (await bandOfRefs(db, pay.lines, now)).band;
    } else if (p.kind === "rfq_draft") {
      const pay = p.payload as RfqDraftPayload;
      base.suppliers = pay.suppliers;
      base.replyBy = pay.replyBy;
      base.deliveryDate = pay.deliveryDate;
      if (p.groupId !== null) {
        const g = await getBuyGroup(db, p.groupId, now);
        base.label = g.label;
        base.band = g.band;
        base.estimatePaise = g.estimatePaise;
        base.lines = g.lines.map((l) => ({ ...l, estimatePaise: l.estimatePaise, vendorId: null, ratePaise: null, discountBps: null, gstRateBps: null, source: null, state: "draft" as const }));
      }
    } else if (p.kind === "po_draft") {
      const pay = p.payload as PoDraftPayload;
      if (p.groupId !== null) {
        const g = await getBuyGroup(db, p.groupId, now);
        base.label = g.label;
        base.band = g.band;
        base.estimatePaise = g.estimatePaise;
        const asked = new Map(byItem(await groupLines(db, p.groupId)).map((l) => [l.itemId, l] as const));
        base.lines = pay.lines.map((l, i) => {
          const a = asked.get(l.itemId);
          return {
            lineIdx: i, prId: null, itemId: l.itemId, itemName: a?.itemName ?? l.itemId, qtyBase: a?.qtyBase ?? 0, baseUom: a?.baseUom ?? "",
            estimatePaise: null, vendorId: l.vendorId, ratePaise: l.ratePaise, discountBps: l.discountBps, gstRateBps: l.gstRateBps,
            source: { page: 0, text: l.via === "contract" ? "Rate contract" : "Quote on file" }, state: "draft" as const,
          };
        });
        const vn = await vendorNames(db, pay.lines.map((l) => l.vendorId));
        base.vendorName = [...new Set(pay.lines.map((l) => vn.get(l.vendorId)?.name ?? l.vendorId))].join(", ");
      }
    } else {
      Object.assign(base, await quoteReadView(db, p, mine));
    }
    out.push(base);
  }
  return out;
}

export async function getProposal(db: Db | Tx, id: string, now: Date = new Date()): Promise<WireAgentProposal> {
  return (await proposalViews(db, [await requireProposal(db, id)], now))[0]!;
}

/** The buying desk's list of the agent's drafts (newest first), by kind and status. */
export async function agentProposals(
  db: Db, actor: Actor, filter: { kind?: StoresAgentProposalKind; status?: StoresAgentProposalStatus } = {}, now: Date = new Date(),
): Promise<WireAgentProposal[]> {
  await requireBuyer(db, actor);
  const rows = await db.select().from(storesAgentProposals)
    .where(filter.kind === undefined ? undefined : eq(storesAgentProposals.kind, filter.kind)).orderBy(desc(storesAgentProposals.madeAt)).limit(200);
  const views = await proposalViews(db, rows, now);
  return filter.status === undefined ? views : views.filter((v) => v.status === filter.status);
}

async function bandOfRefs(db: Db | Tx, refs: readonly { prId: string; lineIdx: number }[], now: Date): Promise<{ band: StoresBand; split: boolean }> {
  const prIds = [...new Set(refs.map((r) => r.prId))];
  if (prIds.length === 0) return { band: "A", split: false };
  const rows = await ex(db).select({ l: storesPurchaseRequestLines, pr: storesPurchaseRequests }).from(storesPurchaseRequestLines)
    .innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesPurchaseRequestLines.prId)).where(inArray(storesPurchaseRequestLines.prId, prIds));
  const want = new Set(refs.map((r) => lineKey(r.prId, r.lineIdx)));
  return bandOfLines(db, rows.filter((r) => want.has(lineKey(r.l.prId, r.l.lineIdx))).map(({ l, pr }) => ({
    prId: pr.id, prNo: pr.prNo, lineIdx: l.lineIdx, itemId: l.itemId, itemName: "", baseUom: "", categoryId: l.categoryId, qtyBase: l.qtyBase,
    unitEstimatePaise: l.unitEstimatePaise, onContract: l.onContract, equipment: l.equipment, source: pr.source, departmentId: pr.departmentId,
    shelfId: pr.shelfId, priority: pr.priority, raisedBy: pr.raisedBy, raisedAt: pr.raisedAt,
  })), now);
}

// ═══════════════════════════════ the night (22:00 IST) ═══════════════════════════════

export type BuyerNightRun = {
  halted: boolean;
  shortfall: { prId: string | null; lines: number; noPrice: string[] };
  proposals: string[];
  superseded: number;
  capped: { departmentId: string; lines: number }[];
  overBudgetNotices: number;
};

/** Open grouping drafts whose lines have moved on (grouped by hand, request no longer approved): superseded, freeing the cap. */
async function supersedeStale(db: Db, now: Date): Promise<{ superseded: number; held: Set<string>; openPerDept: Map<string, number> }> {
  const rows = await db.select().from(storesAgentProposals).where(eq(storesAgentProposals.kind, "grouping"));
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const open = rows.filter((r) => statusOf(steps.filter((s) => s.proposalId === r.id)) === "open");
  const prIds = [...new Set(open.flatMap((r) => (r.payload as GroupingPayload).lines.map((l) => l.prId)))];
  const where = await membership(db, prIds);
  const ok = await approvedPrIds(db, prIds);
  const closed = await closedPrIds(db, prIds);
  let superseded = 0;
  const held = new Set<string>();
  const openPerDept = new Map<string, number>();
  for (const r of open) {
    const lines = (r.payload as GroupingPayload).lines;
    const stale = lines.some((l) => (where.get(lineKey(l.prId, l.lineIdx)) ?? null) !== null || !ok.has(l.prId) || closed.has(l.prId));
    if (stale) {
      await db.insert(storesAgentProposalSteps).values({ id: newId(), proposalId: r.id, kind: "superseded", by: BUYER_AGENT.id, at: now }).onConflictDoNothing();
      superseded += 1;
      continue;
    }
    for (const l of lines) held.add(lineKey(l.prId, l.lineIdx));
    for (const d of r.departmentIds) openPerDept.set(d, (openPerDept.get(d) ?? 0) + 1);
  }
  return { superseded, held, openPerDept };
}

/** Requests with a decline or cancel stamp, or already on an order (their group has a PO). */
async function closedPrIds(db: Db | Tx, prIds: readonly string[]): Promise<Set<string>> {
  if (prIds.length === 0) return new Set();
  const stamps = await ex(db).select({ prId: storesPurchaseRequestStamps.prId }).from(storesPurchaseRequestStamps)
    .where(and(inArray(storesPurchaseRequestStamps.prId, [...prIds]), ne(storesPurchaseRequestStamps.kind, "approved")));
  return new Set(stamps.map((s) => s.prId));
}

/** The likely supplier of each item: the cheapest open rate contract, else the last paid receipt's supplier. */
async function likelySuppliers(db: Db | Tx, itemIds: readonly string[], now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemIds.length === 0) return out;
  const [contracts, history] = await Promise.all([contractRatesFor(db, itemIds, now), purchaseHistoryByItem(db, itemIds, 1)]);
  for (const id of itemIds) {
    const c = contracts.get(id)?.[0];
    const h = history.get(id)?.[0];
    if (c !== undefined) out.set(id, c.vendorId);
    else if (h !== undefined) out.set(id, h.vendorId);
  }
  return out;
}

/**
 * Flow 3: the central store's items at or under their reorder level, less what is on order (approved/sent POs not yet
 * received, drafts and POs awaiting approval) and less what open central requests already ask for, become ONE central
 * request to the materials head (who approves it). Raised by the agent (`raisePurchaseRequest`'s agent path), routine.
 * An item with no price on record is left for the materials head to ask by hand (`noPrice`).
 */
export async function raiseCentralShortfall(db: Db, now: Date): Promise<BuyerNightRun["shortfall"]> {
  let central: string;
  try { central = await centralStoreId(db); } catch { return { prId: null, lines: 0, noPrice: [] }; }
  const levels = await db.select({ itemId: itemStockLevels.itemId, reorder: itemStockLevels.reorderBase, max: itemStockLevels.maxBase })
    .from(itemStockLevels).innerJoin(items, eq(items.id, itemStockLevels.itemId))
    .where(and(eq(itemStockLevels.storeResourceId, central), sql`${items.trackMode} is not null`, ne(items.class, "drug"), eq(items.active, true)));
  if (levels.length === 0) return { prId: null, lines: 0, noPrice: [] };
  const ids = levels.map((l) => l.itemId);
  const have = new Map((await db.select({ itemId: stockBalances.itemId, q: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)` }).from(stockBalances)
    .where(and(eq(stockBalances.resourceId, central), inArray(stockBalances.itemId, ids))).groupBy(stockBalances.itemId)).map((r) => [r.itemId, Number(r.q)] as const));
  const coming = await onOrderAt(db, central, ids);
  const asked = await openCentralAsks(db, ids);
  const lines: { itemId: string; qtyBase: number }[] = [];
  for (const l of levels) {
    const owed = (coming.get(l.itemId)?.onOrderBase ?? 0) + (coming.get(l.itemId)?.inDraftBase ?? 0) + (asked.get(l.itemId) ?? 0);
    const now0 = (have.get(l.itemId) ?? 0) + owed;
    if (now0 > l.reorder) continue;
    const want = l.max - now0;
    if (want > 0) lines.push({ itemId: l.itemId, qtyBase: want });
  }
  if (lines.length === 0) return { prId: null, lines: 0, noPrice: [] };
  const noPrice: string[] = [];
  for (;;) {
    const todo = lines.filter((l) => !noPrice.includes(l.itemId));
    if (todo.length === 0) return { prId: null, lines: 0, noPrice };
    try {
      const pr = await raisePurchaseRequest(db, BUYER_AGENT, {
        source: "central", priority: "routine", note: "Night shortfall", lines: todo.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })),
      }, now, { agent: true });
      return { prId: pr.id, lines: todo.length, noPrice };
    } catch (e) {
      const itemId = e instanceof StoresError && e.code === "estimate_required" ? (e.detail?.itemId as string | undefined) : undefined;
      if (itemId === undefined) throw e;
      noPrice.push(itemId);
    }
  }
}

/** What open central or planner requests (not declined or cancelled, not yet on an order) already ask for, per item. */
async function openCentralAsks(db: Db, itemIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await db.select({ l: storesPurchaseRequestLines }).from(storesPurchaseRequestLines)
    .innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesPurchaseRequestLines.prId))
    .where(and(inArray(storesPurchaseRequests.source, ["central", "planner"]), inArray(storesPurchaseRequestLines.itemId, [...itemIds])));
  const prIds = [...new Set(rows.map((r) => r.l.prId))];
  const closed = await closedPrIds(db, prIds);
  const where = await membership(db, prIds);
  const groups = [...new Set([...where.values()].filter((g): g is string => g !== null))];
  const ordered = new Set(groups.length === 0 ? [] : (await db.select({ g: storesAwards.groupId }).from(storesAwards)
    .innerJoin(purchaseOrders, eq(purchaseOrders.awardId, storesAwards.id))
    .where(and(inArray(storesAwards.groupId, groups), ne(purchaseOrders.status, "cancelled")))).map((r) => r.g));
  const out = new Map<string, number>();
  for (const { l } of rows) {
    if (closed.has(l.prId)) continue;
    const g = where.get(lineKey(l.prId, l.lineIdx)) ?? null;
    if (g !== null && ordered.has(g)) continue;
    out.set(l.itemId, (out.get(l.itemId) ?? 0) + l.qtyBase);
  }
  return out;
}

/**
 * THE NIGHT'S RUN (22:00 IST, `runBuyerNightIfDue` on the minute sweep; idempotent, so a second run writes nothing new). In order:
 * the owner's monthly over-budget list (not an agent draft: a notice, once per month), then — unless the copilot's
 * draft switch is down — the central shortfall request, stale drafts superseded, and the grouping preview.
 */
export async function runBuyerNight(db: Db, now: Date = new Date()): Promise<BuyerNightRun> {
  const overBudgetNotices = await sendOwnerOverBudgetList(db, now);
  if (await agentHalted(db, now)) {
    return { halted: true, shortfall: { prId: null, lines: 0, noPrice: [] }, proposals: [], superseded: 0, capped: [], overBudgetNotices };
  }
  const shortfall = await raiseCentralShortfall(db, now);
  const { superseded, held, openPerDept } = await supersedeStale(db, now);

  // Approved routine requests, lines not in a group or an open draft.
  const prs = (await db.select({ pr: storesPurchaseRequests }).from(storesPurchaseRequests)
    .innerJoin(storesPurchaseRequestStamps, and(eq(storesPurchaseRequestStamps.prId, storesPurchaseRequests.id), eq(storesPurchaseRequestStamps.kind, "approved")))
    .where(eq(storesPurchaseRequests.priority, "routine")).orderBy(asc(storesPurchaseRequests.raisedAt)).limit(500)).map((r) => r.pr);
  const closed = await closedPrIds(db, prs.map((p) => p.id));
  const live = prs.filter((p) => !closed.has(p.id));
  const where = await membership(db, live.map((p) => p.id));
  const lines = live.length === 0 ? [] : await db.select({ l: storesPurchaseRequestLines, cat: itemCategories.name }).from(storesPurchaseRequestLines)
    .leftJoin(itemCategories, eq(itemCategories.id, storesPurchaseRequestLines.categoryId))
    .where(inArray(storesPurchaseRequestLines.prId, live.map((p) => p.id))).orderBy(asc(storesPurchaseRequestLines.lineIdx));
  const free = lines.filter(({ l }) => (where.get(lineKey(l.prId, l.lineIdx)) ?? null) === null && !held.has(lineKey(l.prId, l.lineIdx)));
  const likely = await likelySuppliers(db, [...new Set(free.map((f) => f.l.itemId))], now);
  const vnames = await vendorNames(db, [...likely.values()]);
  const deptOf = new Map(live.map((p) => [p.id, p.source === "department" && p.departmentId !== null ? p.departmentId : CENTRAL_KEY] as const));

  // Buckets: category, then likely supplier, in the order the requests came.
  const buckets = new Map<string, { categoryId: string | null; categoryName: string | null; vendorId: string | null; refs: { prId: string; lineIdx: number }[] }>();
  for (const { l, cat } of free) {
    const vendorId = likely.get(l.itemId) ?? null;
    const key = `${l.categoryId ?? "-"}|${vendorId ?? "-"}`;
    const b = buckets.get(key) ?? { categoryId: l.categoryId, categoryName: cat, vendorId, refs: [] };
    b.refs.push({ prId: l.prId, lineIdx: l.lineIdx });
    buckets.set(key, b);
  }

  // The cap: a department's lines go into a draft only while it has fewer than three open; a draft left empty is not written.
  const capped = new Map<string, number>();
  const written: { id: string; payload: GroupingPayload; departmentIds: string[] }[] = [];
  for (const b of buckets.values()) {
    const depts = [...new Set(b.refs.map((r) => deptOf.get(r.prId)!))];
    const room = depts.filter((d) => (openPerDept.get(d) ?? 0) < PROPOSAL_CAP_PER_DEPARTMENT);
    const refs = b.refs.filter((r) => room.includes(deptOf.get(r.prId)!));
    for (const r of b.refs) if (!room.includes(deptOf.get(r.prId)!)) { const d = deptOf.get(r.prId)!; capped.set(d, (capped.get(d) ?? 0) + 1); }
    if (refs.length === 0) continue;
    const kept = [...new Set(refs.map((r) => deptOf.get(r.prId)!))];
    for (const d of kept) openPerDept.set(d, (openPerDept.get(d) ?? 0) + 1);
    const vendorName = b.vendorId === null ? null : (vnames.get(b.vendorId)?.name ?? null);
    written.push({
      id: newId(), departmentIds: kept,
      // Names only (data): the screen says "Any supplier" in the reader's language when no supplier is likely.
      payload: { label: [b.categoryName ?? "—", vendorName].filter((x): x is string => x !== null).join(" · "), categoryId: b.categoryId, categoryName: b.categoryName, vendorId: b.vendorId, vendorName, lines: refs },
    });
  }
  {
    await withTx(db, async (tx) => {
      if (written.length > 0) {
        await tx.insert(storesAgentProposals).values(written.map((w) => ({
          id: w.id, kind: "grouping", departmentIds: w.departmentIds, vendorId: w.payload.vendorId, payload: w.payload, madeBy: BUYER_AGENT.id, madeAt: now,
        })));
      }
      await recordAct(tx, BUYER_AGENT, now, {
        act: "agent_night", refId: shortfall.prId,
        after: {
          night: nightOf(now) ?? istDayString(now), proposals: written.map((w) => w.id), shortfallPr: shortfall.prId, noPrice: shortfall.noPrice, superseded,
          capped: Object.fromEntries(capped),
        },
      });
    });
  }
  return {
    halted: false, shortfall, proposals: written.map((w) => w.id), superseded,
    capped: [...capped].filter(([d]) => d !== CENTRAL_KEY).map(([departmentId, n]) => ({ departmentId, lines: n })), overBudgetNotices,
  };
}

/**
 * THE 22:00 IST CLOCK, ON THE MINUTE SWEEP (`runStoresChaser`, S3's precedent: no new job name in the scheduler's
 * census). The night of D runs once, at the first minute from 22:00 on D to 07:00 on D+1 that finds no `agent_night`
 * act for D (a worker down at 22:00 still runs it when it is back, before the buyer's morning). A halted night writes no
 * act, so it runs the minute the halt is lifted. One transaction under an advisory lock, so two workers cannot both run it.
 */
export const BUYER_NIGHT_FROM_HOUR = 22;
export const BUYER_NIGHT_UNTIL_HOUR = 7;

export function nightOf(now: Date): string | null {
  const { start } = istDayWindow(now);
  const hours = (now.getTime() - start.getTime()) / 3_600_000;
  if (hours >= BUYER_NIGHT_FROM_HOUR) return istDayString(now);
  if (hours < BUYER_NIGHT_UNTIL_HOUR) return istDayString(new Date(start.getTime() - 1));
  return null;
}

export async function runBuyerNightIfDue(db: Db, now: Date = new Date()): Promise<BuyerNightRun | null> {
  const night = nightOf(now);
  if (night === null) return null;
  const since = new Date(now.getTime() - 36 * 3_600_000);
  const ran = async (exec: Db | Tx): Promise<boolean> => (await ex(exec).execute(sql`
    select 1 from events where name = 'stores.act_recorded' and recorded_at >= ${since.toISOString()}::timestamptz
      and payload->>'act' = 'agent_night' and payload->'after'->>'night' = ${night} limit 1`)).rows.length > 0;
  if (await ran(db)) return null;
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stores-buyer-night'))`);
    if (await ran(tx)) return null;
    return runBuyerNight(tx as unknown as Db, now);
  });
}

// ═══════════════════════════════ confirm / dismiss ═══════════════════════════════

/** The buyer's tap on a night grouping draft: the group is made as the buyer's own, with the draft's lines. */
export async function confirmGroupingProposal(db: Db, actor: Actor, proposalId: string, now: Date = new Date()): Promise<{ group: WireBuyGroup; actId: string }> {
  await requireBuyer(db, actor);
  const { groupId, actId } = await withTx(db, (tx) => confirmGroupingInTx(tx, actor, proposalId, now, true));
  return { group: await getBuyGroup(db, groupId, now), actId: actId! };
}

/**
 * The confirm's body, in the caller's transaction. `ledger` false: the copilot's confirm path writes its own
 * `copilot_acts` row (kernel `confirmProposal`), so only the closing step and the act are written here.
 */
export async function confirmGroupingInTx(tx: Tx, actor: Actor, proposalId: string, now: Date, ledger: boolean, confirmId?: string): Promise<{ groupId: string; actId: string | null }> {
  const p = await lockOpen(tx, proposalId, "grouping");
  const pay = p.payload as GroupingPayload;
  const prIds = [...new Set(pay.lines.map((l) => l.prId))];
  const where = await membership(tx, prIds);
  const ok = await approvedPrIds(tx, prIds);
  const closed = await closedPrIds(tx, prIds);
  if (pay.lines.some((l) => (where.get(lineKey(l.prId, l.lineIdx)) ?? null) !== null || !ok.has(l.prId) || closed.has(l.prId))) {
    throw new StoresError("state_changed", "these requests have moved on since the draft: look again");
  }
  const g = await groupRequests(tx as unknown as Db, actor, { lines: pay.lines, label: pay.label }, now);
  if (ledger) return { groupId: g.id, actId: await recordConfirm(tx, actor, p, pay, { module: "stores", rowId: g.id }, now) };
  await tx.insert(storesAgentProposalSteps).values({ id: newId(), proposalId: p.id, kind: "confirmed", confirmId: confirmId ?? null, resultRowId: g.id, by: actor.id, at: now });
  await recordAct(tx, actor, now, { act: "confirm_agent_draft", refId: p.id, after: { kind: p.kind, confirmId: confirmId ?? null, resultRowId: g.id } });
  return { groupId: g.id, actId: null };
}

/** "Not this one": the draft is closed with the person's reason; nothing else changes. */
export async function dismissProposal(db: Db, actor: Actor, proposalId: string, reason: string | null, now: Date = new Date()): Promise<WireAgentProposal> {
  await requireBuyer(db, actor);
  await withTx(db, async (tx) => {
    const p = await requireProposal(tx, proposalId);
    await lockOpen(tx, proposalId, p.kind as StoresAgentProposalKind);
    await tx.insert(storesAgentProposalSteps).values({ id: newId(), proposalId, kind: "dismissed", reason: reason?.trim() || null, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "dismiss_agent_draft", refId: proposalId, reason: reason?.trim() || null, after: { kind: p.kind } });
  });
  return getProposal(db, proposalId, now);
}

// ═══════════════════════════════ the RFQ draft ═══════════════════════════════

/** Suppliers for an RFQ of these lines, best first (decision 6). */
export async function suggestSuppliers(db: Db | Tx, categoryIds: readonly (string | null)[], itemIds: readonly string[], now: Date): Promise<WireAgentSupplier[]> {
  const candidates = await ex(db).select({ id: vendors.id, legal: vendors.legalName, trade: vendors.tradeName }).from(vendors)
    .where(and(eq(vendors.status, "active"), sql`${vendors.pan} is not null`, notInArray(sql`upper(${vendors.code})`, [...NON_SUPPLIER_VENDOR_CODES])))
    .orderBy(asc(vendors.code)).limit(200);
  const history = await purchaseHistoryByItem(db, itemIds, 3);
  const supplied = new Set([...history.values()].flat().map((h) => h.vendorId));
  const contracts = await contractRatesFor(db, itemIds, now);
  for (const c of [...contracts.values()].flat()) supplied.add(c.vendorId);
  const quarter = quarterOf(now);
  const cats = [...new Set(categoryIds)];
  const out: WireAgentSupplier[] = [];
  for (const v of candidates) {
    const k = await supplierKyc(db, v.id, now);
    if (k.level === "none") continue;
    let approved = true;
    for (const c of cats.length === 0 ? [null] : cats) {
      const kc = await supplierKyc(db, v.id, now, { categoryId: c });
      if (kc.missing.includes("category")) approved = false;
    }
    out.push({
      vendorId: v.id, name: v.trade ?? v.legal, kyc: k.level, missing: k.missing, approvedForCategory: approved,
      score: supplied.has(v.id) || approved ? (await scorecardFigures(db, v.id, quarter)).score : null, suppliedBefore: supplied.has(v.id), suggested: false,
    });
  }
  out.sort((a, b) => Number(b.approvedForCategory) - Number(a.approvedForCategory) || (b.score ?? -1) - (a.score ?? -1)
    || Number(b.suppliedBefore) - Number(a.suppliedBefore) || a.name.localeCompare(b.name));
  out.slice(0, SUGGEST).forEach((s) => { if (s.approvedForCategory) s.suggested = true; });
  return out.slice(0, MAX_SUPPLIERS);
}

/** The agent's RFQ for a group, at the buyer's ask: a draft; nothing is created until the buyer confirms it. */
export async function draftRfq(db: Db, actor: Actor, groupId: string, now: Date = new Date()): Promise<WireAgentProposal> {
  await requireBuyer(db, actor);
  if (await agentHalted(db, now)) throw new StoresError("agent_paused", "the agent is paused: make the RFQ by hand");
  await requireGroup(db, groupId);
  const [had] = await db.select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, groupId)).limit(1);
  if (had !== undefined) throw new StoresError("group_locked", "this group already has an RFQ", { rfqId: had.id });
  const lines = await groupLines(db, groupId);
  if (lines.length === 0) throw new StoresError("item_required", "the group has no lines");
  const suppliers = await suggestSuppliers(db, lines.map((l) => l.categoryId), [...new Set(lines.map((l) => l.itemId))], now);
  const replyBy = replyByFrom(now);
  const deliveryDate = istDayString(new Date(replyBy.getTime() + DELIVERY_AFTER_REPLY_DAYS * DAY_MS));
  const id = newId();
  const payload: RfqDraftPayload = { suppliers, replyBy: replyBy.toISOString(), deliveryDate, askedBy: actor.id };
  await db.insert(storesAgentProposals).values({
    id, kind: "rfq_draft", departmentIds: departmentKeys(lines), groupId, payload, madeBy: BUYER_AGENT.id, madeAt: now,
  });
  return getProposal(db, id, now);
}

/** 17:00 IST, seven days on. */
function replyByFrom(now: Date): Date {
  const day = istDayString(new Date(now.getTime() + REPLY_DAYS * DAY_MS));
  return new Date(`${day}T17:00:00+05:30`);
}

const departmentKeys = (lines: readonly { source: string; departmentId: string | null }[]): string[] =>
  [...new Set(lines.map((l) => (l.source === "department" && l.departmentId !== null ? l.departmentId : CENTRAL_KEY)))];

/** The buyer ticks the suppliers (at least three for bands B and C, checked at send) and confirms: the RFQ exists, unsent. */
export async function confirmRfqDraft(
  db: Db, actor: Actor, proposalId: string, input: { vendorIds: string[]; replyBy?: Date | null; deliveryDate?: string | null }, now: Date = new Date(),
): Promise<{ rfq: WireRfq; actId: string }> {
  await requireBuyer(db, actor);
  const { rfqId, actId } = await withTx(db, async (tx) => {
    const p = await lockOpen(tx, proposalId, "rfq_draft");
    const pay = p.payload as RfqDraftPayload;
    const [had] = await tx.select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, p.groupId!)).limit(1);
    if (had !== undefined) throw new StoresError("state_changed", "an RFQ was made for this group meanwhile", { rfqId: had.id });
    const args = { groupId: p.groupId!, replyBy: input.replyBy ?? new Date(pay.replyBy), deliveryDate: input.deliveryDate ?? pay.deliveryDate, vendorIds: [...new Set(input.vendorIds)] };
    const rfq = await createRfq(tx as unknown as Db, actor, args, now);
    return { rfqId: rfq.id, actId: await recordConfirm(tx, actor, p, { ...args, replyBy: args.replyBy.toISOString() }, { module: "stores", rowId: rfq.id }, now) };
  });
  return { rfq: await getRfq(db, rfqId, now), actId };
}

// ═══════════════════════════════ the PO draft (band A) ═══════════════════════════════

async function poLinesFor(db: Db | Tx, groupId: string, now: Date): Promise<PoDraftPayload["lines"]> {
  const asked = byItem(await groupLines(db, groupId));
  const contracts = await contractRatesFor(db, asked.map((l) => l.itemId), now);
  const quotes = await groupQuotes(db, groupId);
  return asked.map((l) => {
    const c = contracts.get(l.itemId)?.[0];
    if (c !== undefined) return { itemId: l.itemId, vendorId: c.vendorId, ratePaise: Math.round(c.ratePaise / c.multiplier), discountBps: 0, gstRateBps: c.gstRateBps, via: "contract" as const };
    const q = quotes.find((x) => x.lines.some((ql) => ql.itemId === l.itemId));
    if (q === undefined) throw new StoresError("quote_needed", `a quote is needed for ${l.itemName}`, { itemId: l.itemId });
    const ql = q.lines.find((x) => x.itemId === l.itemId)!;
    return { itemId: l.itemId, vendorId: q.quote.vendorId, ratePaise: ql.ratePaise, discountBps: ql.discountBps, gstRateBps: ql.gstRateBps, via: "quote" as const };
  });
}

/** The agent's PO for a band A group (contract lines, or the one quote on file): a draft until the buyer confirms it. */
export async function draftPo(db: Db, actor: Actor, groupId: string, now: Date = new Date()): Promise<WireAgentProposal> {
  await requireBuyer(db, actor);
  if (await agentHalted(db, now)) throw new StoresError("agent_paused", "the agent is paused: make the PO by hand");
  await requireGroup(db, groupId);
  const [rfq] = await db.select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, groupId)).limit(1);
  if (rfq !== undefined) throw new StoresError("rfq_needed", "this group is quoted through its RFQ", { rfqId: rfq.id });
  const glines = await groupLines(db, groupId);
  if (glines.length === 0) throw new StoresError("item_required", "the group has no lines");
  const { band } = await bandOfLines(db, glines, now);
  if (band !== "A") throw new StoresError("rfq_needed", "three quotes are needed: make an RFQ", { band });
  const [awarded] = await db.select({ id: storesAwards.id }).from(storesAwards).where(eq(storesAwards.groupId, groupId)).limit(1);
  if (awarded !== undefined) throw new StoresError("already_ordered", "this group is already awarded");
  const payload: PoDraftPayload = { lines: await poLinesFor(db, groupId, now), askedBy: actor.id };
  const id = newId();
  await db.insert(storesAgentProposals).values({ id, kind: "po_draft", departmentIds: departmentKeys(glines), groupId, payload, madeBy: BUYER_AGENT.id, madeAt: now });
  return getProposal(db, id, now);
}

/** The buyer confirms: Make PO runs as the buyer with `source: agent`; the PO is a draft (submit, tier, send are people's). */
export async function confirmPoDraft(db: Db, actor: Actor, proposalId: string, input: { reason?: string | null }, now: Date = new Date()): Promise<{ pos: PoView[]; actId: string }> {
  await requireBuyer(db, actor);
  return withTx(db, async (tx) => {
    const p = await lockOpen(tx, proposalId, "po_draft");
    const pay = p.payload as PoDraftPayload;
    const nowLines = await poLinesFor(tx, p.groupId!, now);
    const key = (l: PoDraftPayload["lines"]): string => [...l].map((x) => `${x.itemId}:${x.vendorId}:${String(x.ratePaise)}:${String(x.discountBps)}:${String(x.gstRateBps)}`).sort().join(",");
    if (key(nowLines) !== key(pay.lines)) throw new StoresError("state_changed", "the rates have changed since the draft: draft it again");
    const made = await makePoFromGroup(tx as unknown as Db, actor, p.groupId!, { reason: input.reason ?? null, source: "agent" }, now);
    const actId = await recordConfirm(tx, actor, p, pay, { module: "stores", rowId: made.pos[0]?.id ?? made.award.id }, now);
    return { pos: made.pos, actId };
  });
}

/** Open drafts for the desk's tabs, newest first (the desk's one read). */
export async function openProposals(db: Db, now: Date): Promise<WireAgentProposal[]> {
  const rows = await db.select().from(storesAgentProposals)
    .where(sql`not exists (select 1 from stores_agent_proposal_steps s where s.proposal_id = ${storesAgentProposals.id} and s.kind in ('confirmed', 'dismissed', 'superseded'))`)
    .orderBy(desc(storesAgentProposals.madeAt)).limit(100);
  return proposalViews(db, rows, now);
}


// ═══════════════════════════════ the quote read's view (`quote-reader.ts` writes it) ═══════════════════════════════

export type QuoteReadLine = {
  lineIdx: number; itemId: string; itemName: string; qtyBase: number; baseUom: string; ratePaise: number | null; discountBps: number | null;
  gstRateBps: number | null; source: { page: number; text: string } | null;
};
export type QuoteReadPayload = { lines: QuoteReadLine[]; readable: boolean; reader: "model" | "rules"; pages: number; askedBy: string };

/** A quote read as the desk shows it: each line as read (with its source), or as the person confirmed or dropped it. */
export async function quoteReadView(db: Db | Tx, p: ProposalRow, steps: readonly StepRow[]): Promise<Partial<WireAgentProposal>> {
  void db;
  const pay = p.payload as QuoteReadPayload;
  return {
    readable: pay.readable, reader: pay.reader, label: null,
    lines: pay.lines.map((l) => {
      const s = steps.find((x) => x.lineIdx === l.lineIdx && (x.kind === "line_confirmed" || x.kind === "line_dropped"));
      const d = (s?.data ?? null) as { ratePaise?: number; discountBps?: number; gstRateBps?: number } | null;
      return {
        lineIdx: l.lineIdx, prId: null, itemId: l.itemId, itemName: l.itemName, qtyBase: l.qtyBase, baseUom: l.baseUom, estimatePaise: null, vendorId: p.vendorId,
        ratePaise: d?.ratePaise ?? l.ratePaise, discountBps: d?.discountBps ?? l.discountBps, gstRateBps: d?.gstRateBps ?? l.gstRateBps, source: l.source,
        state: s === undefined ? "draft" as const : s.kind === "line_confirmed" ? "confirmed" as const : "dropped" as const,
      };
    }),
  };
}
