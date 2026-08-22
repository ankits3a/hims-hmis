import { desc } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { configValidationReports } from "../db/schema";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { validateBillingConfig } from "../../modules/billing/config";
import { validateTariffConfig } from "../../modules/tariff";
import { configValidated } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

// PLAN 11c D5 — ONE D-17 GATE OVER EVERY VALIDATOR, AND IT IS PERSISTED.
//
// Two module validators already shipped, each with its own runner script, and go-live meant
// "somebody ran both and read the output". That is exactly the shape §2.49 calls ornament: a
// check nobody is FORCED to run, whose verdict lives in a terminal that has since been closed.
//
// This file makes the verdict a ROW. `changeOperatingMode` (kernel/ops/mode.ts, T1) refuses to
// leave `commissioning` unless the LATEST row of `config_validation_reports` is ok and younger
// than `VALIDATION_FRESH_HOURS` — so the only way a deployment can claim to be a running hospital
// is through a fresh, persisted, all-green run of the function below.
//
// THE VALIDATORS THEMSELVES ARE CONSUMED, READ-ONLY AND UNMODIFIED. Neither is re-implemented,
// re-queried or second-guessed here (the M1 lesson: a gate that builds its own view of the config
// eventually validates something the engine will never see). This function is a conjunction, a
// persistence and an event — nothing else.

/**
 * The scopes this aggregate covers, IN THE ORDER THE RUNNER PRINTS THEM. Adding a third module
 * validator means adding it here and in `runConfigValidation` — and, deliberately, nowhere else:
 * the persisted column is JSONB and the event's payload is an array, so neither needs a migration
 * nor a catalog change to carry one more scope.
 */
export const VALIDATION_SCOPES = ["tariff", "billing"] as const;
export type ValidationScope = (typeof VALIDATION_SCOPES)[number];

/** The shape both shipped validators already return (`ConfigError` in each module). */
export type ConfigError = { code: string; detail: string };

/**
 * One validator's contribution to the verdict.
 *
 * `caSigned` is `null` for every scope that has no such notion — billing carries its own
 * `ca_signed` column but `validateBillingConfig` deliberately does NOT gate on it, so reporting a
 * value here would invent a criterion the shipped validator does not apply.
 */
export type ScopeResult = {
  scope: ValidationScope;
  ok: boolean;
  caSigned: boolean | null;
  errors: ConfigError[];
};

export type ConfigValidationReport = {
  reportId: string;
  ok: boolean;
  at: Date;
  scopes: ScopeResult[];
  eventId: string;
};

/**
 * THE ONE SYNTHESISED ERROR IN THIS FILE, and it exists so the red is legible.
 *
 * D5's tariff leg is `ok && caSigned`. Without this row a configuration whose every tariff check
 * passed but which no CA has signed would persist as `{ scope: "tariff", ok: false, errors: [] }`
 * — a scope that is red for no stated reason, which is the worst possible thing to hand an
 * operator at 03:00. The code is namespaced to this aggregate (`ops.` prefix) precisely because it
 * is NOT one of `validateTariffConfig`'s own codes and must never be mistaken for one.
 */
export const CA_SIGNATURE_MISSING = "ops.ca_signature_missing";

/**
 * The aggregate runs from a script, from an HTTP route and (one day) from a job — never as a
 * person. A SYSTEM actor is the house shape for that (`validate-tariff-config.ts` uses the same
 * one), and it is fixed here rather than taken as an argument so no caller can attribute a
 * configuration verdict to a human who did not produce it.
 */
const VALIDATION_ACTOR: Actor = { type: "system", id: "validate-config" };

/**
 * The aggregate. Read-only against every module's data; the ONLY writes are its own report row and
 * its own event, and they are ONE transaction (the `changeOperatingMode` precedent — a verdict
 * whose event did not land is a verdict nothing downstream can react to).
 *
 * `now` is injected (GC8) and is passed straight through to `validateTariffConfig`, which resolves
 * the ACTIVE tariff version at that instant. `validateBillingConfig` takes no instant at all — its
 * checks are over a single config row and the service catalog, neither of which is time-versioned.
 * That asymmetry is the shipped validators', not this file's, and folding a fake `at` into billing
 * would be inventing a parameter its author declined to take.
 *
 * NEVER THROWS FOR A CONFIGURATION PROBLEM: both validators accumulate `ConfigError`s and return.
 * A throw out of this function therefore means an infrastructure or programming fault, and it is
 * left to propagate — `scripts/validate-config.ts` prints it and exits non-zero, which is the
 * correct answer to "is this deployment ready?" when the question could not be evaluated.
 */
export async function runConfigValidation(db: Db, now: Date = new Date()): Promise<ConfigValidationReport> {
  const tariff = await validateTariffConfig(db, now);
  const billing = await validateBillingConfig(db);

  // D5's conjunction, written out rather than implied: an UNSIGNED tariff configuration is not a
  // configuration a hospital goes live on, whatever the validator's own `ok` says.
  const tariffErrors: ConfigError[] = [...tariff.errors];
  if (!tariff.caSigned) {
    tariffErrors.push({
      code: CA_SIGNATURE_MISSING,
      detail: "gst_settings.ca_signed is false — the tariff configuration has not been signed off by a CA (D-17)",
    });
  }

  const scopes: ScopeResult[] = [
    { scope: "tariff", ok: tariff.ok && tariff.caSigned, caSigned: tariff.caSigned, errors: tariffErrors },
    { scope: "billing", ok: billing.ok, caSigned: null, errors: billing.errors },
  ];
  const ok = scopes.every((s) => s.ok);

  const reportId = newId();
  const { eventId } = await withTx(db, async (tx) => {
    await persistReport(tx, { id: reportId, ok, scopes, at: now });
    return appendEvent(
      tx,
      configValidated.make({
        actor: VALIDATION_ACTOR,
        occurredAt: now,
        payload: {
          reportId,
          ok,
          // Counts only. The full error text lives in the row this event names — see the
          // definition's own comment on why the payload is a notification and not the record.
          scopes: scopes.map((s) => ({ scope: s.scope, ok: s.ok, errorCount: s.errors.length })),
        },
      }),
    );
  });

  return { reportId, ok, at: now, scopes, eventId };
}


/**
 * The row, and the reason `ok` is denormalised beside the JSONB: D3's guard is one indexed read of
 * the latest row's boolean, never a JSON traversal — the go-live gate must not depend on the shape
 * of a detail column that later plans will extend.
 *
 * `scopes` is stored as the ARRAY above rather than an object keyed by scope name, so the column's
 * shape is exactly the shape this module's own types describe and a fourth scope needs no reader
 * anywhere to learn a new key. Nothing reads this column programmatically today — the guard reads
 * `ok`; the column is for the operator, the screen, and the incident review.
 */
async function persistReport(
  tx: Tx,
  row: { id: string; ok: boolean; scopes: ScopeResult[]; at: Date },
): Promise<void> {
  await tx.insert(configValidationReports).values({
    id: row.id,
    ok: row.ok,
    scopes: row.scopes,
    at: row.at,
  });
}

export type LatestValidationReport = {
  id: string;
  ok: boolean;
  at: Date;
  scopes: ScopeResult[];
};

/**
 * The persisted verdict, for the screens: `GET /ops/config-validation/latest` and the mode desk's
 * gate state both render this.
 *
 * ORDER BY `seq`, NEVER `id` AND NEVER `at` — the same non-monotonic-ULID reason `getOperatingMode`
 * gives, and the same reason D3's guard does it: `newId()` is a plain `ulid()`, so two reports
 * written inside one millisecond sort by coin flip, and `at` is an INJECTED clock value that two
 * callers may legitimately share. THIS FUNCTION IS NOT THE GATE — `mode.ts` reads the row itself
 * and does not call through here, so nothing a screen does can widen what the gate accepts.
 */
export async function getLatestValidationReport(exec: Db | Tx): Promise<LatestValidationReport | null> {
  const rows = await exec
    .select({
      id: configValidationReports.id,
      ok: configValidationReports.ok,
      at: configValidationReports.at,
      scopes: configValidationReports.scopes,
    })
    .from(configValidationReports)
    .orderBy(desc(configValidationReports.seq))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, ok: row.ok, at: row.at, scopes: row.scopes as ScopeResult[] };
}
