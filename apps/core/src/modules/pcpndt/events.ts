import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 18a T2 / §4.2 — the PCPNDT module's one event, and its payload is the design.
 *
 * ═══ IT CARRIES NO PATIENT FIELD. NOT AN ID, NOT A NAME, NOT A GESTATION ═══
 *
 * Every other event in this repository that concerns a patient carries `patientId`, and the
 * envelope even has a first-class field for it. **This one deliberately does not**, and the reason
 * is the sealed class the register belongs to: `pcpndt.form_f_recorded` exists so 18a-ii can
 * compile a monthly RETURN — a count of forms per machine per month — and a return needs a serial,
 * a machine and a date. It does not need to know who was scanned.
 *
 * An event that carried the patient would put "this woman had an obstetric ultrasound on this date"
 * into the event stream, into every projection built from it, and into every log line that dumps a
 * payload. That is precisely the disclosure the Act's own confidentiality provisions exist to
 * prevent, and the register's readers already have a narrower, permissioned, PHI-logged path to the
 * form itself (`formFForStudy`).
 *
 * `studyId` is here because a return reconciles against the scans that happened; it is an opaque
 * module reference, and resolving it to a person requires a permission this event grants nobody.
 */
const MODULE = "pcpndt";

export const formFRecorded = defineEvent("pcpndt.form_f_recorded", MODULE, z.object({
  formFId: z.string().min(1),
  serialNo: z.number().int().positive(),
  serialYear: z.number().int(),
  machineId: z.string().min(1),
  studyId: z.string().min(1),
}));

/** Every event this module declares, for the catalogue parity test. */
export const PCPNDT_EVENTS = [formFRecorded] as const;
