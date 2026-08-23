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

/**
 * A DEVICE THE HOSPITAL RELIES ON HAS GONE QUIET (D6, T3, Book V9).
 *
 * Appended by `sweepInterfaceHeartbeats` when an ACTIVE interface that was `up` has not been seen
 * for longer than ITS OWN `stale_after_ms` — per device, never a global constant, because a label
 * printer and a lab analyser do not go quiet on the same schedule.
 *
 * A REGISTERED-BUT-NEVER-SEEN INTERFACE NEVER PRODUCES THIS EVENT (Book V10). `last_seen_at` is
 * NULL for such a row and `unknown` is a distinct state from `down`: there is nothing to lose, and
 * the event would be noise on every deployment that ever registered a device it has not plugged in
 * yet. So `lastSeenAt` below is NON-NULLABLE — an `interface.down` that could not name when the
 * device was last alive would be an event about a device this sweep must never have touched.
 *
 * THE NAME BREAKS THE `verb_past` GRAMMAR AND IS KEPT VERBATIM ANYWAY. `interface.down` is spec
 * §11.14's own name (D6 records the deviation); `defineEvent`'s `NAME_RE` enforces dotted lowercase
 * segments, not tense, so design law wins and nothing throws. Its partner below is `restored`,
 * which does read as a past participle — the pair is deliberately asymmetric because the SPEC's
 * pair is.
 *
 * NO PATIENT IDENTITY, EVER (GC6): a device's liveness is a hospital-wide fact.
 */
export const interfaceDown = defineEvent(
  "interface.down",
  OPS,
  z.object({
    interfaceId: z.string().min(1),
    kind: z.string().min(1), // printer | scanner | other
    name: z.string().min(1),
    /** ISO instant — the last heartbeat this device ever sent. Never null: see the header. */
    lastSeenAt: z.string().min(1),
    /** The row's OWN window, carried so the alert can say what it was measured against. */
    staleAfterMs: z.number().int().positive(),
  }),
);

/**
 * THE DEVICE IS BACK (D6, T3, Book V11).
 *
 * Appended by `recordHeartbeat` ONLY on the `down → up` edge. `unknown → up` — the first heartbeat
 * a freshly-registered device ever sends — is SILENT, because nothing was ever wrong and an event
 * per commissioned printer is exactly the per-run noise `kernel/retention/events.ts`'s header
 * refuses. `up → up`, the ordinary case that happens every 60 s per device forever, appends
 * nothing at all for the same reason.
 *
 * `downSince` is the `last_seen_at` the row carried while it was down — the instant the outage is
 * measured FROM. It is nullable because a row can be `down` with no prior sighting only if
 * something outside this file put it there; the sweep never can (see `interfaceDown`).
 */
export const interfaceRestored = defineEvent(
  "interface.restored",
  OPS,
  z.object({
    interfaceId: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    /** ISO instant of the heartbeat that restored it — the injected `now`, never the wall clock. */
    seenAt: z.string().min(1),
    downSince: z.string().nullable(),
  }),
);
