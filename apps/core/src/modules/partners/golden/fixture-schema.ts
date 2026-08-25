import { z } from "zod";
import type { InvoiceAccrualView } from "../../billing";

/**
 * PLAN 09 T6'S GOLDEN HARNESS — DD12's arithmetic, hand-computed, one fixture per money path.
 *
 * It is a THIRD harness rather than an extension of Plan 06's or of T2's, and the reason is the
 * same one T2 wrote down: `modules/tariff/fixture-schema.ts` is inside the directory DD2 freezes,
 * and `modules/membership/golden/` prices a `PricedLine` through `priceInvoiceLines`, which is a
 * different subject entirely. What is COPIED is the discipline, and all of it:
 *
 *   - `workings: z.string().min(20)` — a fixture that does not SHOW its arithmetic fails to PARSE.
 *     It is the only mechanism this project has found that stops a golden file quietly becoming a
 *     snapshot of whatever the code happened to do on the day it was written.
 *   - the manifest is pinned by NAME and the directory is asserted to contain nothing else, so
 *     neither a renamed fixture nor a `.JSON` straggler can hide (`golden.test.ts`).
 *   - the expectation is a FULL deep-equal of every number `accrualBasis` returns, never a partial
 *     match on the one number the author was thinking about.
 *
 * ═══ WHY THE SUBJECT IS `accrualBasis` AND NOT THE WRITER ═══
 *
 * DD12 is arithmetic over an `InvoiceAccrualView` and a set of terms. Both are plain data, so the
 * whole base is testable with no database, no clock and no partner — which is what lets a fixture
 * carry the SPIKE'S OWN COUNTER-EXAMPLE (`p03`) with the exact numbers the spike measured
 * (45 000 correct against the refuted first version's 63 543) rather than an approximation of them
 * reachable through `seedBillingBase`'s fixed prices. The writer's behaviour — the lock, the
 * idempotency, the escrow state — is asserted against real invoices in `accrual.test.ts`.
 *
 * ═══ EVERY VALUE IN EVERY FIXTURE WAS INVENTED HERE (DD3 / owner ruling O-9) ═══
 *
 * The out-of-git partner book may not be transcribed into a tracked file and a fixture is a tracked
 * file. Each fixture tests a CLASS — a part payment, a credit note on an eligible line, a
 * proportional refund, an entered-in-error mark — with rates, categories and identifiers written
 * fresh in this repository. A class does not care which invented rate carries it.
 */
const paise = z.number().int().nonnegative();
const signedPaise = z.number().int();
const workings = z.string().min(20); // a fixture without real arithmetic shown FAILS to parse
const iso = z.string().datetime();

const viewLine = z.object({
  lineId: z.string().min(1),
  category: z.string().min(1),
  taxableBasePaise: paise,
  creditedBasePaise: paise,
});

const viewSchema = z.object({
  invoiceId: z.string().min(1),
  issuedAt: iso,
  enteredInError: z.boolean(),
  netPayablePaise: paise,
  creditedPaise: paise,
  allocatedPaise: paise,
  refundedPaise: paise,
  lines: z.array(viewLine),
});

const termsSchema = z.object({
  payableRateBps: z.number().int().nonnegative().max(10_000),
  eligibleCategories: z.array(z.string().min(1)),
});

export const fixtureSchema = z.object({
  name: z.string().min(1),
  specRefs: z.array(z.string()).min(1),
  terms: termsSchema,
  view: viewSchema,
  /** Σ of the rows already appended for this subject — what makes the expectation a DELTA. */
  priorPaise: signedPaise,
  expected: z.object({
    workings,
    eligibleBasePaise: paise,
    settleablePaise: paise,
    collectedPaise: paise,
    targetBasePaise: paise,
    targetPaise: paise,
    /** `targetPaise − priorPaise`, stated rather than derived, so a fixture can be read alone. */
    deltaPaise: signedPaise,
  }),
});

export type GoldenAccrualFixture = z.infer<typeof fixtureSchema>;

/** The view a fixture describes, with its one timestamp rehydrated — what DD19 hands the consumer. */
export function viewFromFixture(view: z.infer<typeof viewSchema>): InvoiceAccrualView {
  return { ...view, issuedAt: new Date(view.issuedAt) };
}
