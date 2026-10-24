import { sql } from "drizzle-orm";
import { draftCrkEntry } from "./crk-formulary";
import { FormularyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { InferenceClient } from "../../kernel/inference/types";
import type { DraftSourceInput } from "./crk-formulary";

/**
 * ═══ #883 — THE DRAFTING BATCH: STOCKED GENERICS, ONE DRAFT EACH, NOTHING PUBLISHED ═══
 *
 * Picks the stocked generics that have no CRK entry yet (name order, 20 a run by default, never more than 50) and
 * drafts each through the #618 drafter, so every rule of that drafter holds: sourced statements only, no dose, the
 * source texts masked and checked before they leave, tokens on the row. A draft is a PENDING entry that waits on the
 * Pharmacology worklist; this job never signs and never publishes. A generic with no usable source is reported and
 * the model is not asked about it. One failed draft is reported and the batch goes on.
 */

export const CRK_BATCH_DEFAULT = 20;
export const CRK_BATCH_MAX = 50;

export type BatchGeneric = { genericId: string; sctid: string; name: string; substances: string[] };

/** Stocked generics (a stocked item through a formulary medicine) with no CRK entry, in name order. */
export async function stockedGenericsToDraft(db: Db, limit: number = CRK_BATCH_DEFAULT): Promise<BatchGeneric[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), CRK_BATCH_MAX);
  const rows = (await db.execute(sql`
    select g.id as "genericId", g.sctid, g.name,
           coalesce((select array_agg(s.name order by s.name) from formulary_generic_substances gs
                       join formulary_substances s on s.id = gs.substance_id where gs.generic_id = g.id), '{}') as substances
      from formulary_generics g
     where exists (select 1 from formulary_medicines m join items i on i.formulary_medicine_id = m.id where m.generic_sctid = g.sctid)
       and not exists (select 1 from formulary_crk_entries e where e.generic_id = g.id)
     order by g.name, g.sctid
     limit ${n}
  `)).rows as BatchGeneric[];
  return rows.map((r) => ({ ...r, substances: [...r.substances] }));
}

export type BatchOutcome = {
  sctid: string; name: string; status: "drafted" | "no_source" | "failed";
  sources: { ref: string; kind: string; title: string }[];
  statements?: number; dropped?: number; usage?: { inputTokens: number; outputTokens: number } | null; error?: string;
};

export async function runCrkDraftBatch(
  db: Db,
  actor: Actor,
  opts: {
    limit?: number;
    model: { client: InferenceClient | null; id: string | null };
    sourcesFor: (g: BatchGeneric) => Promise<DraftSourceInput[]>;
    onOutcome?: (o: BatchOutcome) => void;
  },
): Promise<BatchOutcome[]> {
  if (opts.model.client === null || opts.model.id === null) {
    throw new FormularyError("model_not_configured", "no drafting model is configured; the batch fetched and wrote nothing");
  }
  const out: BatchOutcome[] = [];
  for (const g of await stockedGenericsToDraft(db, opts.limit ?? CRK_BATCH_DEFAULT)) {
    let o: BatchOutcome;
    try {
      const sources = await opts.sourcesFor(g);
      const listed = sources.map((s) => ({ ref: s.ref, kind: s.kind, title: s.title }));
      if (sources.length === 0) {
        o = { sctid: g.sctid, name: g.name, status: "no_source", sources: [] };
      } else {
        try {
          const r = await draftCrkEntry(db, actor, { genericSctid: g.sctid, sources }, opts.model);
          o = { sctid: g.sctid, name: g.name, status: "drafted", sources: listed, statements: r.statements, dropped: r.dropped, usage: r.usage };
        } catch (e) {
          o = { sctid: g.sctid, name: g.name, status: "failed", sources: listed, error: e instanceof FormularyError ? e.code : e instanceof Error ? e.name : "draft_failed" };
        }
      }
    } catch {
      o = { sctid: g.sctid, name: g.name, status: "failed", sources: [], error: "fetch_failed" };
    }
    out.push(o);
    opts.onOutcome?.(o);
  }
  return out;
}

export type Price = { inputPerMillionUsd: number; outputPerMillionUsd: number };
export type CostReport = {
  drafts: { name: string; inputTokens: number; outputTokens: number; usd: number }[];
  total: { drafts: number; inputTokens: number; outputTokens: number; usd: number };
  average: { inputTokens: number; outputTokens: number; usd: number };
  projected: { drafts: number; usd: number };
};

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Tokens and US dollars per draft and in total at list prices, and the cost of `projectTo` drafts at the average. Pure. */
export function crkCostReport(
  drafted: readonly { name: string; usage?: { inputTokens: number; outputTokens: number } | null }[],
  price: Price,
  projectTo = 300,
): CostReport {
  const drafts = drafted.map((d) => {
    const inputTokens = d.usage?.inputTokens ?? 0;
    const outputTokens = d.usage?.outputTokens ?? 0;
    return { name: d.name, inputTokens, outputTokens, usd: round6((inputTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1e6) };
  });
  const sum = (f: (d: (typeof drafts)[number]) => number): number => drafts.reduce((n, d) => n + f(d), 0);
  const total = { drafts: drafts.length, inputTokens: sum((d) => d.inputTokens), outputTokens: sum((d) => d.outputTokens), usd: round6(sum((d) => d.usd)) };
  const k = Math.max(drafts.length, 1);
  const average = { inputTokens: total.inputTokens / k, outputTokens: total.outputTokens / k, usd: total.usd / k };
  return { drafts, total, average, projected: { drafts: projectTo, usd: round6(average.usd * projectTo) } };
}
