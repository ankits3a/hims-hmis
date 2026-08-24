import { and, asc, eq, or, sql } from "drizzle-orm";
import type { SearchHit } from "@hmis/contracts";
import { services } from "../../kernel/db/schema";
import { wordPrefixMatch } from "../../kernel/search/text";
import type { SearchProvider, SearchProviderCtx, SearchProviderResult } from "../../kernel/search/types";

/**
 * PLAN 11h T4 — services, by code or name. ROUTINE tier.
 *
 * NO PRICE IS RETURNED, and that is deliberate rather than unfinished. A service's price is not a
 * property of the service: it comes from the ACTIVE tariff version, and it is further moved by
 * adjustment rules, regulated-price ceilings (C-3's min(tariff, MRP, ceiling)) and the payer. A
 * number rendered in a palette row would be a fourth pricing path with none of that machinery
 * behind it, and a desk would quote it. The palette says what a service IS; the billing counter
 * says what it COSTS, priced once by `priceInvoiceLines`.
 */
export const serviceSearchProvider: SearchProvider = {
  key: "tariff.service",
  entity: "service",
  permission: "tariff.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    if (text.length < 2) return { hits: [], total: 0 };

    const where = and(
      eq(services.active, true),
      or(wordPrefixMatch(services.name, text), wordPrefixMatch(services.code, text)),
    );

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({ id: services.id, code: services.code, name: services.name, category: services.category, regulated: services.regulated })
        .from(services)
        .where(where)
        .orderBy(asc(services.name))
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(services).where(where),
    ]);

    return {
      hits: rows.map((r): SearchHit => ({
        entity: "service",
        id: r.id,
        title: r.name,
        subtitle: `${r.code} · ${r.category}`,
        ...(r.regulated ? { meta: { regulated: "yes" } } : {}),
      })),
      total: counted[0]?.n ?? 0,
    };
  },
};
