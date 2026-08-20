import { Module, OnModuleInit } from "@nestjs/common";
import { registerConsultStartGuard } from "../opd";
import { BillingController } from "./billing.controller";
import { BILLING_FEE_GATE_KEY, feeGate } from "./gate";
import type { ConsultStartGuard } from "../opd";

/**
 * The pay-before-consult guard AS REGISTERED (D8), with one documented pass-through.
 *
 * `feeGate` converts EVERY `BillingError` into a not-ok verdict — deliberately, because a billing
 * exception raised inside an OPD route would surface as a 500 (gate.ts, self-review 5). But
 * `loadBillingConfig` throws `billing_not_configured` when the `billing_config` row is absent, so
 * registering `feeGate` raw makes a deployment that has not run `seed:billing` refuse EVERY
 * consultation — measured, not predicted: with the raw registration, five shipped tests across
 * `test/opd.e2e.test.ts` and `test/opd-lifecycle.e2e.test.ts` went from green to refused.
 *
 * D-17's own rule is that a missing config row hard-fails every billing WRITE. A consultation is
 * not a billing write, and an unconfigured hospital has no fee policy to enforce, so that ONE code
 * passes through. Every other verdict — `fee_unsettled` included — is returned verbatim: this
 * never relaxes the gate for a configured hospital, which is what `billing.e2e.test.ts` pins from
 * both sides (refused while unpaid AND configured; allowed while unconfigured).
 *
 * It lives here rather than in `gate.ts` because `gate.ts` is outside this task's Files list.
 */
const registeredFeeGate: ConsultStartGuard = async (db, encounter) => {
  const verdict = await feeGate(db, encounter);
  if (!verdict.ok && verdict.code === "billing_not_configured") return { ok: true };
  return verdict;
};

/**
 * The billing module. Controller only for HTTP (AuthGuard/PermissionGuard are global APP_GUARDs
 * from AuthModule — order load-bearing, Plan 02), plus the ONE piece of wiring this plan owes
 * OPD: registering the pay-before-consult guard.
 *
 * The registration is dependency-INVERTED: OPD owns the keyed registry and the thrown
 * `consult_gate_refused`; billing hands it a verdict function and never imports OPD internals.
 * `registerConsultStartGuard` is keyed, so a second module init (a second jest testing module in
 * one worker) REPLACES rather than double-registers.
 */
@Module({ controllers: [BillingController] })
export class BillingModule implements OnModuleInit {
  onModuleInit(): void {
    registerConsultStartGuard(BILLING_FEE_GATE_KEY, registeredFeeGate);
  }
}
