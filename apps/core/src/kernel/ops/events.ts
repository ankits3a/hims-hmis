import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import { OPERATING_MODES } from "../db/schema/ops";

// The `ops` module's event catalog (Plan 11c). The house pattern is `kernel/retention/events.ts`:
// one file per kernel concern, and NO PER-RUN NOISE — every name here is appended only when the
// fact it records actually happened.
//
// This file has FOUR SEQUENTIAL OWNERS in this plan and each adds its own named definitions and
// nothing else: T1 `ops.mode_changed` (below) · T2 `ops.config_validated` · T3
// `interface.down` / `interface.restored` · T4 `downtime.kit_generated`.
const OPS = "ops";

/**
 * THE HOSPITAL CHANGED WHAT IT IS DOING, AND SOMEBODY SAID WHY.
 *
 * This is the only record of a mode transition that leaves the database — the
 * `operating_mode_changes` row is the state, this event is the notification — and it is what the
 * `kernel.alerts` consumer turns into a row in front of every owner when the transition touches
 * `downtime` or `degraded` (D4).
 *
 * `note` and `reportId` are NULLABLE rather than optional: a change that carried no note is a
 * fact, and `undefined` would make "no note" indistinguishable from "the writer forgot the
 * field". `reportId` is the `config_validation_reports` row that authorised leaving
 * commissioning — null on every other transition, because no other transition is gated.
 *
 * NO PATIENT IDENTITY, EVER (GC6). A mode change is a hospital-wide fact; the payload carries
 * mode words and a free-text note, the envelope carries no `patientId`, and the alerts consumer
 * fans `alert.raised` from this straight to a browser.
 */
export const modeChanged = defineEvent(
  "ops.mode_changed",
  OPS,
  z.object({
    from: z.enum(OPERATING_MODES),
    to: z.enum(OPERATING_MODES),
    note: z.string().nullable(),
    reportId: z.string().nullable(),
  }),
);

/**
 * D-17's AGGREGATE VERDICT, AND THE ONLY EVENT THE AGGREGATE APPENDS (D5, T2).
 *
 * This is a NEW name in the `ops` catalog rather than a reuse of tariff's `config.validated`, and
 * the reason is a type rather than a preference: that event's `scope` is `z.literal("tariff")`
 * (`modules/tariff/events.ts`), so an aggregate over two validators cannot be expressed in it
 * without WIDENING a shipped module's catalog for a caller that lives outside the module — scope
 * creep by any reading. The tariff script keeps emitting its own event when it is run alone.
 *
 * NOTHING IS APPENDED FOR BILLING, deliberately: billing's catalog is a CLOSED set of exactly
 * twenty D-Events names and config-validation is not one of them
 * (`scripts/validate-billing-config.ts` records the same rule). The billing leg of this run is
 * carried inside the payload below and in the persisted report row; it mints no billing event.
 *
 * THE PAYLOAD IS A NOTIFICATION, NOT THE RECORD. The record is the `config_validation_reports`
 * row (`reportId`), which carries every per-scope error with its detail text; the payload carries
 * the verdict and the counts, because an event that inlined every config error would put a
 * multi-kilobyte blob in a partitioned append-only table once per run.
 *
 * The tariff scope's `ok` here is D5's CONJUNCTION — `report.ok && report.caSigned` — not the
 * validator's own `ok`. An unsigned tariff configuration is not a configuration a hospital may go
 * live on, so it is red at this layer even when every check inside tariff passed.
 *
 * NO PATIENT IDENTITY, EVER (GC6): a configuration verdict is a hospital-wide fact.
 */
export const configValidated = defineEvent(
  "ops.config_validated",
  OPS,
  z.object({
    reportId: z.string().min(1),
    ok: z.boolean(),
    scopes: z
      .array(
        z.object({
          scope: z.enum(["tariff", "billing"]),
          ok: z.boolean(),
          errorCount: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
);
