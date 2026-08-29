import { desc, eq, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { regulatedPrices, services } from "../../kernel/db/schema";
import { assertPaise } from "./money";
import { TariffError } from "./errors";
import { loadPricingContext } from "./context";
import type { Db, Tx } from "../../kernel/db/client";

export type ServiceRow = typeof services.$inferSelect;

export type ServiceInput = { code: string; name: string; category: string; regulated?: boolean };

/** Pre-checked by code inside the tx; the unique index (services_code_ux) is the race backstop —
 * a raw 23505 escaping this pre-check is acceptable and expected under concurrent creation. */
export async function createService(tx: Tx, actor: Actor, input: ServiceInput): Promise<{ serviceId: string }> {
  const existing = await tx.select({ id: services.id }).from(services).where(eq(services.code, input.code));
  if (existing.length > 0) {
    throw new TariffError("duplicate_service_code", `service code ${input.code} already exists`);
  }

  const serviceId = newId();
  await tx.insert(services).values({
    id: serviceId,
    code: input.code,
    name: input.name,
    category: input.category,
    regulated: input.regulated ?? false,
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  return { serviceId };
}

const SERVICE_PATCHABLE = ["code", "name", "category", "regulated", "active"] as const;

export async function updateService(
  tx: Tx,
  actor: Actor,
  serviceId: string,
  patch: Partial<ServiceInput> & { active?: boolean },
): Promise<void> {
  const rows = await tx.select({ id: services.id }).from(services).where(eq(services.id, serviceId));
  if (rows.length === 0) throw new TariffError("unknown_service", `unknown service ${serviceId}`);

  const set: Record<string, unknown> = {};
  for (const field of SERVICE_PATCHABLE) {
    if (field in patch) set[field] = (patch as Record<string, unknown>)[field];
  }
  if (Object.keys(set).length === 0) return;

  await tx
    .update(services)
    .set({ ...set, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(services.id, serviceId));
}

export async function listServices(db: Db, opts?: { activeOnly?: boolean }): Promise<ServiceRow[]> {
  if (opts?.activeOnly) {
    return db.select().from(services).where(eq(services.active, true));
  }
  return db.select().from(services);
}

/** APPEND-ONLY (C-3 / §3.12 spirit): a gazette revision is a new effective-dated row, never an
 * UPDATE against regulated_prices — the change-control trail is the row history itself. */
export async function appendRegulatedPrice(
  tx: Tx,
  actor: Actor,
  input: {
    serviceId: string;
    mrpPaise?: number | null;
    ceilingPaise?: number | null;
    effectiveFrom: Date;
    gazetteRef?: string;
  },
): Promise<{ id: string }> {
  const hasMrp = input.mrpPaise !== undefined && input.mrpPaise !== null;
  const hasCeiling = input.ceilingPaise !== undefined && input.ceilingPaise !== null;
  if (!hasMrp && !hasCeiling) {
    throw new TariffError("regulated_bounds_missing", "at least one of mrpPaise/ceilingPaise is required");
  }
  if (hasMrp) assertPaise(input.mrpPaise as number, "mrpPaise");
  if (hasCeiling) assertPaise(input.ceilingPaise as number, "ceilingPaise");

  const id = newId();
  await tx.insert(regulatedPrices).values({
    id,
    serviceId: input.serviceId,
    mrpPaise: input.mrpPaise ?? null,
    ceilingPaise: input.ceilingPaise ?? null,
    effectiveFrom: input.effectiveFrom,
    gazetteRef: input.gazetteRef ?? null,
    createdBy: actor.id,
  });
  return { id };
}

/** One select ordered by (effectiveFrom desc, seq desc), reduced to the first (= latest) row per
 * service among rows with effectiveFrom <= at (boundary: equal is included, D5/services.test.ts).
 * Same-date rows resolve by `seq` — the database-side insertion order (audit A1); ids are NOT
 * insertion-ordered (ulid() is non-monotonic), so the append-only correction path resolves to the
 * correction deterministically only because seq, not id, breaks the tie (stress-test C2). */
export async function resolveRegulatedPrices(
  db: Db,
  at: Date,
): Promise<Record<string, { mrpPaise: number | null; ceilingPaise: number | null }>> {
  const rows = await db
    .select()
    .from(regulatedPrices)
    .where(lte(regulatedPrices.effectiveFrom, at))
    .orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.seq));

  const result: Record<string, { mrpPaise: number | null; ceilingPaise: number | null }> = {};
  for (const row of rows) {
    if (row.serviceId in result) continue;
    result[row.serviceId] = { mrpPaise: row.mrpPaise, ceilingPaise: row.ceilingPaise };
  }
  return result;
}

export type RegulatedPriceRow = typeof regulatedPrices.$inferSelect;

/** Full row history for ONE service, newest first; same-date rows resolve last-inserted-first by
 * `seq`, the database-side insertion order (audit A1 — ids are NOT insertion-ordered) — the same
 * total order resolveRegulatedPrices uses (C2). The accessor the gate report §5.2 carried
 * forward: the controller's list route sits behind it now. */
export async function listRegulatedPrices(db: Db, serviceId: string): Promise<RegulatedPriceRow[]> {
  return db
    .select()
    .from(regulatedPrices)
    .where(eq(regulatedPrices.serviceId, serviceId))
    .orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.seq));
}

/**
 * PLAN 07d T5 / DD4 — **THE PRICE LIST: WHAT A SERVICE COSTS TODAY, AS A READ.**
 *
 * A doctor advising an ultrasound should be able to tell the patient what it costs, and the price
 * is the patient's first question. `GET /tariff/services` returns the CATALOGUE and carries no
 * price; `POST /billing/invoices/preview` prices anything but is gated on `billing.invoice.issue`,
 * which a doctor does not hold and should not — pricing a draft invoice is the counter's act.
 *
 * So this is the read in between: the ACTIVE tariff version's price for every active service, on
 * `tariff.read`, computing nothing. It is deliberately NOT a quotation engine — no discounts, no
 * GST, no regulated clamp, no patient. Those are `priceInvoiceLines`'s job and they need a payer, a
 * patient and an encounter. What a printed slip needs is the list price and the day it was read on,
 * which is what E-9 means by "the slip carries the as-of date and the counter reprices".
 *
 * A hospital with no activated tariff version has no prices to publish, and this returns an empty
 * list rather than raising: on day one that is the true answer, and an error would make an unusable
 * screen out of a merely empty one.
 */
export type PriceListRow = {
  serviceId: string;
  code: string;
  name: string;
  category: string;
  pricePaise: number;
};

export async function listPriceList(db: Db, at: Date = new Date()): Promise<PriceListRow[]> {
  let ctx;
  try {
    ctx = await loadPricingContext(db, { at });
  } catch {
    return [];
  }
  const rows: PriceListRow[] = [];
  for (const [serviceId, pricePaise] of Object.entries(ctx.tariff.items)) {
    const info = ctx.services[serviceId];
    if (info === undefined || !info.active) continue;
    rows.push({ serviceId, code: info.code, name: info.name, category: info.category, pricePaise });
  }
  return rows.sort((a, b) => (a.name < b.name ? -1 : 1));
}
