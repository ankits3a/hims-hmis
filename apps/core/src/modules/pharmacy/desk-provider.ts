import { getPatientSummaries } from "../patients";
import { pendingAuthorisationsFor } from "./authorisations";
import { getDispenseRow } from "./queue";
import type { DeskCard, DeskProvider, DeskRow } from "../../kernel/desk/types";

/**
 * ═══ PD-9 — THE PHARMACY IS WAITING ON YOU ═══
 *
 * A request to authorise is addressed to one doctor, so it appears on that doctor's own desk and
 * nowhere else — filtered on `actor` (whose day), named through `reader` (whose clearance), the desk's
 * own rule. Gated on `opd.consult`, the permission a prescriber holds; a doctor with nothing waiting
 * sees no card at all rather than an empty one.
 */
const BOOK_WORDS: Record<string, string> = {
  allergy: "allergy", interaction: "severe interaction", duplicate: "already prescribed", drug_disease: "ruled out by a diagnosis",
};

/** A row's words, without a colon: the web renders a subtitle through `t()`, which reads `:` as a namespace. */
function subtitleOf(book: string, about: string): string {
  if (book === "allergy" || book === "duplicate") return `${BOOK_WORDS[book]!} · ${about}`;
  if (book === "drug_disease") { const [prefix, moiety] = about.split(":"); return `${moiety ?? about} · ${BOOK_WORDS[book]!} (${prefix ?? ""})`; }
  return BOOK_WORDS[book] ?? book;
}

function ticketLabel(dispenseNo: string | null): string {
  if (dispenseNo === null) return "Rx";
  const m = /^([A-Za-z]+)\d{6}(\d+)$/.exec(dispenseNo);
  return m === null ? dispenseNo : `${m[1]!}-${String(Number(m[2]!))}`;
}

export const pharmacyAuthorisationsDeskProvider: DeskProvider = {
  key: "pharmacy.authorisations",
  permission: "opd.consult",
  load: async (ctx): Promise<DeskCard[]> => {
    const pending = await pendingAuthorisationsFor(ctx.db, ctx.actor);
    if (pending.length === 0) return [];
    const dispenses = new Map(await Promise.all(pending.map(async (a) => [a.id, await getDispenseRow(ctx.db, a.dispenseId)] as const)));
    const summaries = new Map((await getPatientSummaries(ctx.db, ctx.reader, [...dispenses.values()].map((d) => d.patientId))).map((s) => [s.requestedId, s]));
    const rows: DeskRow[] = pending.flatMap((a) => {
      const d = dispenses.get(a.id)!;
      const s = summaries.get(d.patientId);
      if (s === undefined) return [];
      return [{
        id: a.id, badge: ticketLabel(d.dispenseNo), title: s.restricted ? (s.alias ?? s.uhid) : (s.name ?? s.uhid),
        subtitle: subtitleOf(a.book, a.about), action: "Decide", href: `/pharmacy/authorisations/${a.id}`, severity: "hot" as const,
      }];
    });
    return [{ key: "pharmacy.authorisations", band: "now", titleKey: "desk.pharmacy.authorise", rows }];
  },
};
