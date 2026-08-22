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
