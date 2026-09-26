import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { pharmacyDispenses, pharmacyShortBook } from "../../kernel/db/schema";
import { findDuplicateItems, findStoreByCode, planPaymentRun, planSupplierReturns, sellableBatchesByItem } from "../materials";
import { getPatientSummaries } from "../patients";
import { OPD_PHARMACY_STORE_CODE, istDateOf } from "./config";
import { planPurchaseDrafts } from "./purchase-drafts";
import { searchShelfAt } from "./retail";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";

/**
 * ═══ PD-7 C8 — THE PHARMACY'S TWO QUESTIONS, ANSWERED BY LOOKUP ═══
 *
 * "kitni amoxicillin bachi hai" and "kiska paisa pending hai" — the phase doc's examples, routed by
 * the kernel's phrasebook (or, for the tail, by a model that only ever picks a tool name) and
 * answered HERE by deterministic reads. The model never sees an answer and never writes one
 * (PD-D15); each answer is a key and display-ready parameters the web renders in the operator's
 * language.
 *
 * Both are gated on `pharmacy.dispense.read` — the queue's own permission, so the copilot is neither
 * more nor less reachable than the desk that shows the same facts.
 */

/**
 * The words that carry the QUESTION rather than the medicine — stripped to leave the name. Matched
 * whole (never as substrings), so a brand that happens to contain one keeps it.
 */
const FILLER = new Set([
  "kitni", "kitna", "kitne", "bachi", "bacha", "bache", "hai", "hain", "kya", "ka", "ki", "ke", "ko", "mein", "me", "abhi", "bhi",
  "stock", "shelf", "on", "the", "in", "is", "are", "of", "how", "much", "many", "left", "any", "there", "do", "we", "have", "still", "got",
  "expire", "expires", "expiry", "expiring", "kab", "hoga", "hogi", "tak", "when", "will", "does", "date",
  "batch", "ye", "yeh", "this", "that", "wo", "woh", "dawai", "dawa", "medicine", "tablet", "tablets", "strip", "strips", "goli",
  "स्टॉक", "बची", "बचा", "है", "कितनी", "कितना", "की", "का", "के", "दवा", "कब", "एक्सपायर", "होगी", "होगा", "में", "क्या",
]);

/** The medicine a stock question names, or "" when it names none. Placeholders are never read back. */
export function medicineTermOf(question: string): string {
  return question
    .replace(/<<P\d+>>/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w !== "" && !FILLER.has(w))
    .join(" ");
}

/**
 * PARITY P1 — the words of an "out of X" sentence that are not the drug: the shortage itself, the
 * instruction to write it down, and counter Hindi's connective tissue. Whole words only.
 */
const SHORT_FILLER = new Set([
  ...FILLER,
  "khatam", "khatm", "khtm", "ho", "gaya", "gayi", "gaye", "out", "ran", "finished", "short", "book", "shortbook", "shortage",
  "note", "likh", "likho", "do", "karo", "kar", "please", "add", "to", "it", "mein", "hai", "se", "wala", "wali",
  "खत्म", "ख़त्म", "हो", "गया", "गई", "लिख", "दो",
]);

/** The drug an "out of X" sentence names, in the words as typed (case kept), or [] when it names none. */
function shortWordsOf(question: string): string[] {
  return question
    .replace(/<<P\d+>>/g, " ")
    .normalize("NFC")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w !== "" && !SHORT_FILLER.has(w.toLowerCase()));
}

/** The same, lower-cased — the search term. Exported for its table test. */
export function shortTermOf(question: string): string {
  return shortWordsOf(question).join(" ").toLowerCase();
}

const MAX_LISTED = 5;

/** `P2609190004` → `P-4`, the desk's own display form (PD-D8); anything else as it is. */
function ticketLabel(dispenseNo: string | null): string {
  if (dispenseNo === null) return "—";
  const m = /^([A-Za-z]+)\d{6}(\d+)$/.exec(dispenseNo);
  return m === null ? dispenseNo : `${m[1]!}-${String(Number(m[2]!))}`;
}

export const pharmacyCopilotTools: readonly CopilotToolDecl[] = [
  {
    intent: "stock_on_shelf",
    permission: "pharmacy.dispense.read",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const term = medicineTermOf(ctx.question);
      if (term === "") return { key: "copilot.answer.stockNeedName", params: {} };
      const store = await findStoreByCode(ctx.db, OPD_PHARMACY_STORE_CODE);
      if (store === undefined) return { key: "copilot.answer.stockNotFound", params: { term } };
      /*
        THE SAME SEARCH THE COUNTERS USE (`searchShelfAt`): a product's name or code first, then a
        salt by its name or alias, Schedule X never offered, and `available` the number the pick
        will honour. A copilot quoting a different figure from the shelf beside it is worse than none.
      */
      const now = new Date();
      const found = await searchShelfAt(ctx.db, store.id, term, now);
      if (found.length === 0) return { key: "copilot.answer.stockNotFound", params: { term } };
      const batches = await sellableBatchesByItem(ctx.db, store.id, found.map((f) => f.itemId), now);
      /* The batch the next sale takes: FEFO, the pick's own order. */
      const next = (itemId: string): { batchNo: string; expiryDate: string | null } | undefined =>
        [...(batches.get(itemId) ?? [])].sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999"))[0];

      if (found.length === 1) {
        const f = found[0]!;
        const b = next(f.itemId);
        if (f.available === 0 || b === undefined) return { key: "copilot.answer.stockEmpty", params: { name: f.brandName } };
        return {
          key: "copilot.answer.stockOnShelf",
          params: { name: f.brandName, qty: f.available, uom: f.baseUom, batch: b.batchNo, expiry: b.expiryDate ?? "—" },
        };
      }
      const listed = found.slice(0, MAX_LISTED).map((f) => {
        const b = next(f.itemId);
        return `${f.brandName} · ${String(f.available)} ${f.baseUom}${b === undefined ? "" : ` (${b.expiryDate ?? "—"})`}`;
      });
      return { key: "copilot.answer.stockSeveral", params: { n: found.length, items: listed.join("; ") } };
    },
  },
  {
    intent: "paid_not_collected",
    permission: "pharmacy.dispense.read",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      /*
        PAID AND STANDING (E25): `billed` is the state between the money and the hand-over, and a
        ticket can sit in it across days — so this reads every billed ticket, not today's, oldest
        first, because the oldest is the one whose batch is nearest to dying on the shelf.
      */
      const rows = await ctx.db.select({
        dispenseNo: pharmacyDispenses.dispenseNo, patientId: pharmacyDispenses.patientId, billedAt: pharmacyDispenses.billedAt,
      }).from(pharmacyDispenses).where(eq(pharmacyDispenses.status, "billed")).orderBy(asc(pharmacyDispenses.billedAt)).limit(50);
      /* The desk's own visibility rule: a sealed patient is named by alias, one this reader may not see is left out. */
      const summaries = new Map((await getPatientSummaries(ctx.db, ctx.actor, rows.map((r) => r.patientId))).map((s) => [s.requestedId, s]));
      const visible = rows.flatMap((r) => {
        const s = summaries.get(r.patientId);
        if (s === undefined) return [];
        const who = s.restricted ? (s.alias ?? s.uhid) : (s.name ?? s.alias ?? s.uhid);
        const day = r.billedAt === null ? null : istDateOf(r.billedAt);
        return [`${ticketLabel(r.dispenseNo)} ${who}${day !== null && day !== ctx.serviceDate ? ` (${day})` : ""}`];
      });
      if (visible.length === 0) return { key: "copilot.answer.uncollectedNone", params: {} };
      const shown = visible.slice(0, MAX_LISTED * 2);
      const more = visible.length - shown.length;
      return { key: "copilot.answer.uncollected", params: { n: visible.length, items: shown.join(", ") + (more > 0 ? ` +${String(more)}` : "") } };
    },
  },
  {
    /*
      ═══ PARITY P1 — "Pan 40 khatam": THE AGENT DRAFTS, THE PHARMACIST CONFIRMS ═══

      The first pharmacy tool that leads to a WRITE, and it does not perform it: the answer carries
      a DRAFT (`payload`) that the desk shows as a card, and the card's one tap calls
      `POST /pharmacy/short-book` as the person who tapped. The plan's rule — `draft_*`, never
      `post_*`; nothing posts without a person — is kept by construction: this function has no
      insert in it.

      Gated on the CONFIRMING act's permission (`pharmacy.dispense.place`), because tools run with the
      asker's permissions: a login that could not note the shortage is not offered a draft of it.
    */
    intent: "draft_short_book_entry",
    permission: "pharmacy.dispense.place",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const said = shortWordsOf(ctx.question).join(" ");
      if (said === "") return { key: "copilot.answer.shortBookNeedName", params: {} };
      const store = await findStoreByCode(ctx.db, OPD_PHARMACY_STORE_CODE);
      /* A drug the counter knows is drafted BY ITEM — the same search the counter's own box uses. */
      const found = store === undefined ? [] : await searchShelfAt(ctx.db, store.id, said.toLowerCase(), new Date());
      const exact = found.filter((f) => f.brandName.toLowerCase() === said.toLowerCase());
      const hit = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
      const itemId = hit?.itemId ?? null;
      const drugName = hit?.brandName ?? said;
      const open = store === undefined ? [] : await ctx.db.select({ id: pharmacyShortBook.id }).from(pharmacyShortBook).where(and(
        eq(pharmacyShortBook.storeResourceId, store.id), isNull(pharmacyShortBook.resolvedAt),
        itemId !== null ? eq(pharmacyShortBook.itemId, itemId)
          : and(isNull(pharmacyShortBook.itemId), sql`lower(${pharmacyShortBook.drugName}) = lower(${drugName})`),
      )).limit(1);
      const alreadyOpen = open.length > 0;
      const payload = { kind: "short_book_draft", itemId, drugName, available: hit?.available ?? null, alreadyOpen };
      return alreadyOpen
        ? { key: "copilot.answer.shortBookAlready", params: { name: drugName }, payload }
        : { key: "copilot.answer.shortBookDraft", params: { name: drugName }, payload };
    },
  },
  /**
   * PARITY P2 — "order karo": what the agent WOULD draft, from the reorder list and the open short
   * book, grouped by each item's last supplier (`purchase-drafts.ts`). Read-only like every tool
   * here: the card links to `/pharmacy/office`, where a person presses "make the drafts", and each
   * draft still needs a submit, somebody else's approval and a send.
   *
   * Gated on `materials.po.raise` — the grant of the people who buy, so the copilot offers an order
   * to exactly the people the office would let make one.
   */
  {
    intent: "draft_purchase_orders",
    permission: "materials.po.raise",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const plan = await planPurchaseDrafts(ctx.db, new Date());
      const lines = plan.groups.reduce((s, g) => s + g.lines.length, 0);
      const payload = {
        kind: "purchase_draft_plan", href: "/pharmacy/office",
        orders: plan.groups.length, lines, unassigned: plan.unassigned.length, unmatched: plan.unmatched.length,
        alreadyDrafted: plan.alreadyDrafted.length,
        vendors: plan.groups.map((g) => ({ name: g.vendorName, lines: g.lines.length, totalPaise: g.totalPaise })),
      };
      if (lines === 0 && plan.unassigned.length === 0) {
        return { key: "copilot.answer.purchaseDraftNothing", params: { drafted: plan.alreadyDrafted.length }, payload };
      }
      return {
        key: "copilot.answer.purchaseDraftPlan",
        params: { orders: plan.groups.length, lines, unassigned: plan.unassigned.length },
        payload,
      };
    },
  },
  /**
   * PARITY P3 — "payment run bana do": what the agent WOULD put on a supplier payment run — every
   * accepted bill due within the week, MSME first (`materials/payments.ts` `planPaymentRun`). Read-only
   * like every tool here: the card links to `/pharmacy/office`, where a person presses "make the
   * draft"; the owner authorises it and somebody other than the owner records it paid.
   *
   * Gated on `materials.payments.prepare` — the copilot offers a run to exactly the people who may
   * prepare one.
   */
  {
    intent: "draft_payment_run",
    permission: "materials.payments.prepare",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const plan = await planPaymentRun(ctx.db, new Date());
      const bills = plan.groups.reduce((s, g) => s + g.bills.length, 0);
      const payload = {
        kind: "payment_run_plan", href: "/pharmacy/office?view=pay", vendors: plan.groups.length, bills, totalPaise: plan.totalPaise,
        blocked: plan.blocked.length, until: plan.until,
        msmeVendors: plan.groups.filter((g) => g.msme).length,
      };
      if (bills === 0) return { key: "copilot.answer.paymentRunNothing", params: { until: plan.until }, payload };
      return {
        key: "copilot.answer.paymentRunPlan",
        params: { vendors: plan.groups.length, bills, amount: (plan.totalPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 }), until: plan.until, blocked: plan.blocked.length },
        payload,
      };
    },
  },
  /**
   * PARITY P4 — "expiry return bana do", "expired maal wapas bhejo": what the agent WOULD put on
   * returns to the suppliers — expired within each vendor's window, near expiry and recalled stock,
   * one return per vendor (`materials/supplier-returns.ts` `planSupplierReturns`) — and what can only
   * be destroyed. Read-only like every tool here: the card opens the office's returns side, where a
   * person presses "make the drafts"; the head approves each and somebody else dispatches it.
   *
   * Gated on `materials.returns.manage` — the copilot offers returns to exactly the people who may
   * draft them.
   */
  {
    intent: "draft_supplier_returns",
    permission: "materials.returns.manage",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const plan = await planSupplierReturns(ctx.db, new Date());
      const batches = plan.groups.reduce((s, g) => s + g.lines.length, 0);
      const payload = {
        kind: "supplier_return_plan", href: "/pharmacy/office?view=returns", vendors: plan.groups.length, batches, taxablePaise: plan.taxablePaise,
        toDestroy: plan.toDestroy.length,
        vendorsList: plan.groups.map((g) => ({ name: g.vendorName, batches: g.lines.length, taxablePaise: g.taxablePaise })),
      };
      if (batches === 0) return { key: "copilot.answer.returnNothing", params: { toDestroy: plan.toDestroy.length }, payload };
      return {
        key: "copilot.answer.returnPlan",
        params: {
          vendors: plan.groups.length, batches, amount: (plan.taxablePaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 }), toDestroy: plan.toDestroy.length,
        },
        payload,
      };
    },
  },
  /**
   * PHARMACY P6 (hygiene) — "duplicate items dikhao": the item-master rows that look like one thing twice
   * (`materials/item-merge.ts` `findDuplicateItems`: the same formulary medicine, or near-identical names
   * over the same composition). Read-only like every tool here: the card opens the office's items side,
   * where a person opens a pair and raises the merge; the medical superintendent approves it.
   *
   * Gated on `materials.items.merge` — the copilot offers the list to exactly the people who may raise one.
   */
  {
    intent: "find_duplicate_items",
    permission: "materials.items.merge",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const { suggestions } = await findDuplicateItems(ctx.db, ctx.actor);
      const sameMedicine = suggestions.filter((x) => x.why === "same_medicine").length;
      const payload = {
        kind: "duplicate_items", href: "/pharmacy/office?view=items", pairs: suggestions.length, sameMedicine,
        first: suggestions.slice(0, 5).map((x) => ({ keep: x.survivor.name, merge: x.merged.name, why: x.why })),
      };
      if (suggestions.length === 0) return { key: "copilot.answer.duplicateItemsNothing", params: {}, payload };
      return { key: "copilot.answer.duplicateItems", params: { pairs: suggestions.length, sameMedicine }, payload };
    },
  },
];
