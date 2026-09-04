import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 18c T1 — the AERB module's events. `entity.verb_past`, module carried separately.
 *
 * ═══ NO PAYLOAD HERE CARRIES A PATIENT, AND ONE OF THEM CARRIES A WORKER ═══
 *
 * The licence events concern EQUIPMENT and are safe by construction. `radiation.dose_limit_warning`
 * (T4) is the one to think about: it names a `userId`, because a dose-limit warning is *about* a
 * person and a consumer that could not tell you whose badge it was would be useless to an RSO. It
 * carries the reading and the period and nothing else — no patient, no procedure, no roster.
 * Occupational dose is the worker's own health data and the register behind this event is
 * permissioned; the event exists so an RSO's screen can raise the row, not so a log can.
 */
const MODULE = "aerb";
const id = z.string().min(1);

/** A machine's paper is on file. T5's calendar and the register screen both read the table; this
 *  event exists so an audit trail of WHO filed WHAT survives a later correction of the row. */
export const aerbLicenceFiled = defineEvent("aerb.licence_filed", MODULE, z.object({
  licenceId: id,
  deviceResourceId: id,
  licenceType: z.string().min(1),
  licenceNo: z.string().min(1),
  validFrom: z.string().min(1),
  validTo: z.string().min(1),
}));

/** Suspended, restored or surrendered — the transitions an inspector asks to be shown. */
export const aerbLicenceStatusChanged = defineEvent("aerb.licence_status_changed", MODULE, z.object({
  licenceId: id,
  deviceResourceId: id,
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().nullable(),
}));

/** Every event this module declares, for the catalogue parity test. */
export const AERB_EVENTS = [aerbLicenceFiled, aerbLicenceStatusChanged] as const;
