import type { Db, Tx } from "../db/client";

/**
 * ═══ THE ENCOUNTER RESOLVER REGISTRY — LIFTED TO THE KERNEL BY PLAN 17 PHASE 0 T3 ═══
 *
 * **It lived in `modules/billing/invoices.ts` and had exactly one consumer.** The order envelope is
 * the second: `orders.encounter_no` is an episode NUMBER (DD8), so `placeOrder` must resolve the
 * same `V…`/`D…` letters billing already resolves — and a KERNEL seam cannot import a module. The
 * choice was to lift the registry or to grow a second one, and a second registry is §2.54's
 * mechanism with a patient's identity as the fact that drifts: two maps, two sets of registered
 * prefixes, and an order that resolves to a different patient than the invoice for the same visit.
 *
 * Everything below is MOVED, not rewritten, and the header it arrived with is preserved because its
 * reasoning is still the reasoning.
 *
 * ═══ WHAT STAYED IN BILLING, AND WHY IT HAD TO ═══
 *
 * `resolveEncounter` — billing's private wrapper — did NOT move, and this is the one place the
 * plan document's "moved verbatim" could not be taken literally (finding F1). It calls
 * `getEncounter` from `../opd`: **a fallback to OPD's reader for any id that matches no registered
 * prefix**, which exists because every shipped billing caller passes a bare `opd_encounters` id and
 * several tests pass ids that are not episode numbers at all. Moving that here would give the
 * kernel a dependency on `modules/opd` and defeat the exact inversion this registry provides.
 *
 * So the kernel owns the MAP and the MATCHING (`resolveEncounterByPrefix`); billing keeps its
 * wrapper, its `undefined` case and its OPD fallback, and its three exported names are unchanged.
 *
 * `placeOrder` deliberately does NOT inherit that fallback: the envelope stores an episode NUMBER,
 * and a bare `opd_encounters` row id is not one. An order whose `encounter_no` matches no prefix is
 * refused `unknown_encounter`.
 *
 * ═══ IT DISPATCHES ON THE ENCOUNTER NUMBER'S LETTER, WHICH IS WHY THE LETTER EXISTS ═══
 *
 * `series.ts` reserves one prefix per document type — `V` for a visit, `D` for a day-care encounter
 * (Plan 15 DD2). A resolver registers under a prefix and owns every encounter number that starts
 * with it. **A day-care case numbered `V…` would be resolved by OPD, which has never heard of it**,
 * which is the reason DD2 took its own letter rather than borrowing one.
 *
 * The KEYED-MAP shape is `registerConsultStartGuard`'s, transcribed with its reasoning:
 * re-registering under the same prefix REPLACES, which keeps it idempotent across the jest testing
 * modules that share one worker. An array would double-register and the second resolver would never
 * be reached.
 *
 * **Nothing here imports a module.** OPD registers `V` from `opd.module.ts` and the OT registers
 * `D` from `ot.module.ts`; this file knows only that a resolver returns a patient and an intended
 * payer.
 */
export type EncounterResolver = (
  db: Db,
  encounterId: string,
) => Promise<{ patientId: string; intendedPayer: string } | null>;

const encounterResolvers = new Map<string, EncounterResolver>();

/** Registers (or replaces) the resolver for an episode-number prefix; returns the unregister fn. */
export function registerEncounterResolver(prefix: string, resolver: EncounterResolver): () => void {
  encounterResolvers.set(prefix, resolver);
  return () => {
    encounterResolvers.delete(prefix);
  };
}

/** The registered prefixes, for the parity test that pins which modules have claimed one. */
export function registeredEncounterPrefixes(): string[] {
  return [...encounterResolvers.keys()].sort();
}

/**
 * What the prefix match found. The three cases are kept DISTINCT rather than collapsed into
 * `null`, because the two callers answer them differently and collapsing them is how billing would
 * lose its OPD fallback:
 *
 *   · `matched: false` — no registered prefix owns this string. Billing falls back to OPD's reader;
 *     `placeOrder` refuses `unknown_encounter`.
 *   · `matched: true, resolved: null` — a prefix owns it and its module says there is no such
 *     encounter. BOTH callers refuse. There is nothing to fall back to: the module that owns the
 *     letter has answered.
 *   · `matched: true, resolved: {…}` — the answer.
 */
export type EncounterResolution =
  | { matched: false }
  | { matched: true; resolved: { patientId: string; intendedPayer: string } | null };

/**
 * LONGEST PREFIX FIRST. `EPISODE_SERIES` carries one multi-letter prefix (`GRN`), so a
 * shortest-first match would let a future `G` resolver swallow every `GRN…` number. The series
 * file's own header records that trap; this loop is the one place either caller could spring it.
 *
 * `exec` is `Db | Tx` and the resolver is called with it cast to `Db` — the `displayNameFor`
 * precedent, and it is load-bearing rather than cosmetic here: `placeOrder` resolves the encounter
 * INSIDE the placement transaction, so a signature that only admitted `Db` would force the one read
 * that must be consistent with the insert to happen outside it.
 */
export async function resolveEncounterByPrefix(
  exec: Db | Tx,
  encounterId: string,
): Promise<EncounterResolution> {
  for (const prefix of [...encounterResolvers.keys()].sort((a, b) => b.length - a.length)) {
    if (!encounterId.startsWith(prefix)) continue;
    const resolved = await encounterResolvers.get(prefix)!(exec as Db, encounterId);
    return { matched: true, resolved };
  }
  return { matched: false };
}
