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
 * `changeId` IS THE `operating_mode_changes` ROW THIS EVENT ANNOUNCES (11d D6, closing a finding
 * 11c routed forward). `changeOperatingMode` mints it and inserts the row in the SAME transaction
 * as this append, so the id is never a promise about a row that might not exist. It is here
 * because without it a consumer can only refer to the change by its MODE WORD — which names a
 * state, not a fact, and cannot be deep-linked to the history the reader actually wants. A payload
 * that cannot identify its own row only gets more expensive to widen as consumers accumulate.
 *
 * NO PATIENT IDENTITY, EVER (GC6). A mode change is a hospital-wide fact; the payload carries an
 * id, mode words and a free-text note, the envelope carries no `patientId`, and the alerts
 * consumer fans `alert.raised` from this straight to a browser.
 */
export const modeChanged = defineEvent(
  "ops.mode_changed",
  OPS,
  z.object({
    // OPTIONAL, DELIBERATELY, AND NOT BECAUSE THE FIELD IS OPTIONAL FOR NEW EVENTS — it is always
    // written (see `changeOperatingMode`, which mints the id and appends the event in ONE
    // transaction). It is optional because THIS SCHEMA IS ALSO APPLIED TO ROWS THAT WERE APPENDED
    // BEFORE THE FIELD EXISTED. 11d T3 shipped it REQUIRED with no default and no version bump,
    // and 11d's discovery review measured the cost: every pre-11d `ops.mode_changed` row failed
    // `handleModeChanged`'s parse, burned five attempts and 30s of backoff, BLOCKED its consumer's
    // whole in-order stream, and dead-lettered — 0 alerts raised, `status=parked`, `attempts=5`.
    //
    // The loss was silent BY CONSTRUCTION: `consumer.poisoned` has no subscriber, dead letters are
    // read only by the retention sweep that deletes them, and a cycle that parks an event is a
    // SUCCESSFUL run to the scheduler's staleness rules. The sharpest arming path is not a deploy
    // but a NEW consumer, whose cursor starts at 0 and replays every historical mode change.
    //
    // A schema change to an APPENDED, IMMUTABLE event stream is a change to history, not to a
    // message contract: widening a required field is the only cheap direction, and the consumer
    // carries the fallback.
    changeId: z.string().min(1).optional(),
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

/**
 * PAPER WITH NUMBERS ON IT WAS HANDED TO A DESK (D7, T4, Book V13/V14).
 *
 * Appended by `generateDowntimeKit` inside the same transaction as the counter advance, the kit
 * row and every range row. It is the only trace of a generation that leaves the database, and it
 * exists so that an incident review can answer "who reserved which serials, and when" without
 * reading two tables.
 *
 * THE PAYLOAD CARRIES THE PER-KIND BLOCKS, NOT THE PER-DESK RANGES, and the bound is the reason.
 * `configValidated` above records the rule this follows: the payload is a NOTIFICATION and the
 * record is the row. A kit for twenty desks holds sixty range rows, and inlining them would put a
 * list that grows with the hospital into a partitioned append-only table; the three blocks below
 * are capped at the number of form kinds — three, forever, until a drill demands a fourth — and
 * they are the numbers a reconciliation actually starts from. The desk-by-desk carve-up is
 * `downtime_kit_ranges`, one join away.
 *
 * `formKind` is a plain string rather than a `z.enum` over `DOWNTIME_FORM_KINDS`: the constant
 * lives in `downtime-kit.ts`, which imports THIS file for the definition below, and naming it here
 * would make the two files import each other — the same cycle `OPERATING_MODES` is kept in
 * `db/schema/ops.ts` to avoid (see `modeChanged`). The enum is enforced where the value is
 * produced, and `downtime-kit.test.ts` asserts the appended payload against the constant.
 *
 * NO PATIENT IDENTITY, EVER (GC6): a kit is issued to a DESK. The forms are blank when they are
 * reserved — there is not a patient in the world associated with one yet.
 */
export const kitGenerated = defineEvent(
  "downtime.kit_generated",
  OPS,
  z.object({
    kitId: z.string().min(1),
    note: z.string().nullable(),
    deskCount: z.number().int().positive(),
    totalForms: z.number().int().positive(),
    blocks: z
      .array(
        z.object({
          formKind: z.string().min(1),
          startSerial: z.number().int().positive(),
          endSerial: z.number().int().positive(),
          count: z.number().int().positive(),
        }),
      )
      .min(1),
  }),
);
