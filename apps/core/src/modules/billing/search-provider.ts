import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SearchHit } from "@hmis/contracts";
import { invoices } from "../../kernel/db/schema";
import { prefixMatch } from "../../kernel/search/text";
import { getPatientSummaries, searchPatients, visiblePatientIds } from "../patients";
import type { SearchProvider, SearchProviderCtx, SearchProviderResult } from "../../kernel/search/types";

/**
 * PLAN 11h T4 — invoices, by document number or by the patient they belong to. ROUTINE tier.
 *
 * TWO RULES THIS PROVIDER DOES NOT GET TO INVENT.
 *
 * (1) Patient confidentiality: an invoice carries a `patient_id`, so ALL THREE paths go through
 * the patients module — `searchPatients` to resolve who matched, `visiblePatientIds` to gate a
 * chip, and `getPatientSummaries` to label a row. The chip path was MISSING that gate until the
 * phase's independent review (CRITICAL 1): an id read from one screen was a capability to read
 * invoices on another. A sealed patient now yields no visible id on any lane.
 *
 * (2) Money: `netPayablePaise` is carried through as an INTEGER and formatted by the web layer's
 * `fmtPaise`, the one formatter the invoice print and the counter already share. A provider that
 * did its own rupee arithmetic — even a divide by 100 — would be a second money implementation in
 * the codebase, and money has exactly one (§15, Plan 06).
 */
export const invoiceSearchProvider: SearchProvider = {
  key: "billing.invoice",
  entity: "invoice",
  permission: "billing.invoice.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    const patientChip = ctx.query.chips.find((c) => c.entity === "patient")?.id;
    if (text.length < 2 && patientChip === undefined) return { hits: [], total: 0 };

    const conditions = [];
    if (patientChip !== undefined) {
      // A PATIENT ID IS NOT A CAPABILITY (close, CRITICAL 1). The chip lane is gated exactly as
      // the text lane is: a sealed patient yields no visible id, and therefore no invoices and no
      // count.
      const visible = await visiblePatientIds(ctx.db, ctx.actor, [patientChip]);
      if (visible.length === 0) return { hits: [], total: 0 };
      conditions.push(eq(invoices.patientId, visible[0]!));
      if (text.length >= 2) conditions.push(prefixMatch(invoices.invoiceNo, text));
    } else {
      // No chip: the text is EITHER an invoice number OR a patient. Both lanes are tried and
      // OR-ed, because a desk holding a printed bill and a desk holding a person are the same
      // desk thirty seconds apart, and asking which one they meant is a worse product.
      const patientIds = (await searchPatients(ctx.db, ctx.actor, text, Math.max(ctx.limit * 2, 10))).map((p) => p.id);
      const byNumber = prefixMatch(invoices.invoiceNo, text);
      conditions.push(
        patientIds.length === 0 ? byNumber : sql`(${byNumber} or ${inArray(invoices.patientId, patientIds)})`,
      );
    }
    const where = and(...conditions);

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({
          id: invoices.id,
          invoiceNo: invoices.invoiceNo,
          patientId: invoices.patientId,
          netPayablePaise: invoices.netPayablePaise,
          serviceDay: invoices.serviceDay,
          creditExtended: invoices.creditExtended,
        })
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.seq)) // arrival order — ULIDs cannot carry it (§3.26)
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(invoices).where(where),
    ]);

    const summaries = await getPatientSummaries(ctx.db, ctx.actor, rows.map((r) => r.patientId));
    const labelById = new Map(
      summaries.map((s) => [s.requestedId, s.restricted ? (s.alias ?? "Restricted record") : (s.name ?? "—")] as const),
    );

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "invoice",
        id: r.id,
        title: r.invoiceNo,
        subtitle: `${labelById.get(r.patientId) ?? "—"} · ${r.serviceDay}`,
        // paise, unformatted and unrounded: the web layer owns rupee rendering.
        meta: { netPayablePaise: String(r.netPayablePaise), ...(r.creditExtended ? { credit: "yes" } : {}) },
        href: "/billing/dues",
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};
