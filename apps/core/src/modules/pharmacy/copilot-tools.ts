import { asc, eq } from "drizzle-orm";
import { pharmacyDispenses } from "../../kernel/db/schema";
import { findStoreByCode, sellableBatchesByItem } from "../materials";
import { getPatientSummaries } from "../patients";
import { OPD_PHARMACY_STORE_CODE, istDateOf } from "./config";
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
];
