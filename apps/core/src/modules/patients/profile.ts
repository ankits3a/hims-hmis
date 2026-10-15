import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { patients } from "../../kernel/db/schema";
import { getPatient, listMergedLoserIds, resolvePatientId } from "./registration";
import type { PatientRow } from "./registration";
import { listAllergies } from "./allergies";
import { visitSummaries } from "./merge";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #657 — THE PATIENT PROFILE'S OWN READ (`GET /patients/:id/profile`) ═══
 *
 * Board: `docs/design/2026-09-29-patient-profile/` ("Not built (needs server)"). Two shapes:
 *
 *   · `full` — exactly what `GET /patients/:id` answers (the same `getPatient` decision, so the
 *     same sealed gate and break-glass road), plus "patient since · N visits": the registration
 *     instant is on the row, the count is `visitSummaries`' count (non-abandoned encounters) summed
 *     over the record and every record merged into it, the way the timeline walks the chain.
 *
 *   · `restricted` — a SEALED record the reader may not open (no `patients.confidential.read`, no
 *     live break-glass). Owner ruling 28-Sep-2026, as the board draws it: "Staff see the alias, the
 *     UHID, age and allergies. The name, contact and address open only through break-glass by the
 *     Medical Superintendent." So the wire carries the alias as the name and nothing else of the
 *     person: no legal name, no mobile, no address, no date of birth (age only), no guardians. The
 *     active allergies travel with it because they are the one safety fact the board shows.
 *
 * `getPatient` is NOT changed (every module calls it as the confidentiality decision). This file
 * asks it first and only then, for a user actor it refused, looks at whether the record is a
 * sealed one. An agent actor is refused exactly as before; a non-sealed id that `getPatient`
 * refused cannot exist, and answers null (404) like an absent one.
 */

export type ProfileVisits = { count: number; lastVisitOn: string | null };

export type RestrictedProfilePatient = {
  id: string;
  uhid: string;
  /** The alias is the name. A sealed row with no alias (pre-constraint) answers null; the screen draws "Restricted record". */
  alias: string | null;
  isConfidential: true;
  administrativeGender: string;
  /** Whole years; null when there is no date of birth. Under one year, `ageMonths` carries it instead. */
  ageYears: number | null;
  ageMonths: number | null;
  /** "Messages to family: sealed" on the board. A flag, not a fact about the person. */
  sensitiveContext: boolean;
  status: string;
};

export type ProfileAllergy = { id: string; substance: string; reaction: string | null; severity: string | null };

export type PatientProfile =
  | {
    view: "full";
    patient: PatientRow;
    resolvedFrom: string | null;
    breakGlass: { id: string; reason: string } | null;
    visits: ProfileVisits;
  }
  | {
    view: "restricted";
    patient: RestrictedProfilePatient;
    resolvedFrom: string | null;
    allergies: ProfileAllergy[];
  };

const IST_OFFSET_MS = 330 * 60_000;

/** Age on the hospital's (IST) calendar: whole years, and whole months under one year. */
export function ageOnIstCalendar(dob: Date | null, now: Date): { years: number | null; months: number | null } {
  if (dob === null) return { years: null, months: null };
  const today = new Date(now.getTime() + IST_OFFSET_MS);
  const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
  let months = (y - dob.getUTCFullYear()) * 12 + (m - dob.getUTCMonth());
  if (d < dob.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  return { years, months: years === 0 ? months : null };
}

/** Non-abandoned visits of the record and of every record merged into it (`visitSummaries`' rule). */
export async function profileVisits(db: Db, canonicalId: string): Promise<ProfileVisits> {
  const ids = [canonicalId, ...await listMergedLoserIds(db, canonicalId)];
  const rows = await visitSummaries(db, ids);
  let count = 0;
  let lastVisitOn: string | null = null;
  for (const r of rows) {
    count += r.visits;
    if (r.lastVisitOn !== null && (lastVisitOn === null || r.lastVisitOn > lastVisitOn)) lastVisitOn = r.lastVisitOn;
  }
  return { count, lastVisitOn };
}

export async function patientProfile(db: Db, actor: Actor, patientId: string, now: Date = new Date()): Promise<PatientProfile | null> {
  const found = await getPatient(db, actor, patientId);
  if (found) {
    return { view: "full", ...found, visits: await profileVisits(db, found.patient.id) };
  }
  // Only a signed-in person gets the alias view; an agent credential is refused as before.
  if (actor.type !== "user") return null;
  const canonical = await resolvePatientId(db, patientId);
  if (canonical === null) return null;
  const row = (await db.select().from(patients).where(eq(patients.id, canonical)))[0];
  if (!row || !row.isConfidential) return null;
  const age = ageOnIstCalendar(row.dob, now);
  const allergies = (await listAllergies(db, row.id))
    .filter((a) => a.status === "active")
    .map((a) => ({ id: a.id, substance: a.substance, reaction: a.reaction, severity: a.severity }));
  return {
    view: "restricted",
    resolvedFrom: canonical === patientId ? null : patientId,
    patient: {
      id: row.id,
      uhid: row.uhid,
      alias: row.alias !== null && row.alias.trim() !== "" ? row.alias : null,
      isConfidential: true,
      administrativeGender: row.administrativeGender,
      ageYears: age.years,
      ageMonths: age.months,
      sensitiveContext: row.sensitiveContext,
      status: row.status,
    },
    allergies,
  };
}
