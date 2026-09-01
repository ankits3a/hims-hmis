import type { AdjustmentSource } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T2 / D3 — HOW A SOURCE THAT LIVES IN ANOTHER MODULE REACHES THE CONTEST.
 *
 * The mirror of `registerFeeStatusHook`, pointed at pricing instead of at settlement, and it
 * exists because of a MEASURED dependency direction rather than a preference:
 *
 *     partners/accrual.ts:13    import type { InvoiceAccrualView } from "../billing";
 *     partners/consumer.ts:7    import { … } from "../billing";
 *
 * `partners` already depends on `billing`. Importing `referralSource` the other way would close
 * that into a cycle, so the referral source is REGISTERED rather than imported: `partners.module.ts`
 * hands billing a resolver at module construction exactly as `opd.module.ts` hands it a settle hook,
 * and `composeBenefits` calls whatever is registered without learning what a counterparty is.
 *
 * Membership is deliberately NOT moved onto this seam. `billing → membership` is a one-way edge
 * with no cycle to break, Plan 09's `composeBenefits` reads `ResolvedInstruments` for the WRITE half
 * (entitlement movements and coupon redemptions ride the invoice's own transaction), and rewriting a
 * working money path to look symmetrical would be a refactor this phase did not earn.
 *
 * ═══ THE RESOLVER IS IMPURE AND THE SOURCE IT RETURNS IS NOT ═══
 *
 * A provider may read the database — it runs ONCE per draft, before the transaction, in the same
 * place `loadPricingContext` already runs. What it returns is a pure, synchronous `AdjustmentSource`,
 * because `propose` is called per line inside the engine and `modules/tariff` stays byte-untouched.
 * A provider returning `null` contributes nothing: no source, no candidate, no empty array that
 * would put a name on a bill it has no claim to.
 *
 * Keyed and idempotent under re-registration, for the settle registry's own reason: a second Nest
 * testing module in one process must not double-register.
 */
export type BenefitSourceArgs = {
  /** The code printed on a partner's referral slip, as the counter presented it. */
  attributionCode: string | undefined;
  /** The subject the draft is priced for, when there is one. */
  patientId: string | null;
  /** The engine's instant. A provider must resolve against this, never against a clock. */
  at: Date;
};

export type BenefitSourceProvider = (db: Db, args: BenefitSourceArgs) => Promise<AdjustmentSource | null>;

const providers = new Map<string, BenefitSourceProvider>();

export function registerBenefitSourceProvider(key: string, provider: BenefitSourceProvider): () => void {
  providers.set(key, provider);
  return () => {
    providers.delete(key);
  };
}

/**
 * Every registered provider's source, in registration order, with the refusals dropped.
 *
 * Order matters and is documented where it is consumed: `runContest` sorts candidates by amount and
 * uses `ctx.sources`' index for EXACT ties only. Registered sources are appended AFTER membership
 * and coupon, so on a tie a benefit the patient bought beats one a channel partner brought.
 */
export async function resolveRegisteredSources(db: Db, args: BenefitSourceArgs): Promise<AdjustmentSource[]> {
  const out: AdjustmentSource[] = [];
  for (const provider of providers.values()) {
    const source = await provider(db, args);
    if (source !== null) out.push(source);
  }
  return out;
}
