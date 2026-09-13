import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { patients } from "../../kernel/db/schema";
import { getPatient } from "./registration";
import { PatientError } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-34 — THE FAMILY A SHARED MOBILE MAKES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-13: *"assume the patient Ankit has listed his phone number with us 9041463343.
 * Now, when another patient Sunil lists the same phone number … Ankit's details … must show Sunil
 * as a linked patient. In the same way Sunil profile should show Ankit as a linked family patient."*
 *
 * ═══ THE NUMBER WAS ALREADY HERE, AND EVERY READER OF IT SAID THE SAME UNKIND THING ═══
 *
 * A shared mobile is used three times in this module and all three treat it as a RISK: the search
 * lane finds a person by it, `nearMatches` warns the counter with it, and the desk renders "same
 * mobile" as a duplicate chip. All three are correct and none of them says the true thing — in
 * India one number is a household, not a person (the project brief's own words: *"model phone →
 * household → patients, never phone → patient"*), and a desk that is only ever warned about the
 * coincidence is never TOLD about the family.
 *
 * ═══ DERIVED, NEVER STORED — AND THAT IS WHAT MAKES THE OWNER'S SECOND SENTENCE FREE ═══
 *
 * There is no household table and this does not build one: `households` + `members`, with access
 * classes, adult consent and silent revocation, is Plan 22c-B T1d and it is hard-gated on the
 * patient app's consent model. A stored edge written here would be a second authority on a fact
 * `patients.phone` already carries, and it would go stale the first time a number is corrected on
 * one side — the record would keep asserting a family that the phone book no longer supports.
 *
 * Deriving it makes the symmetry the owner asked for TRUE BY CONSTRUCTION rather than by a
 * bookkeeping job someone can forget to run: there is one predicate, both sides evaluate it, and
 * neither side can be the one that was not updated.
 *
 * ═══ WHAT THIS DELIBERATELY IS NOT ═══
 *
 *   · NOT a relationship. It says "these records share a contact number", never "wife" or "son" —
 *     the system has not been told that and inventing it on a screen is how a clerk ends up
 *     addressing a woman as somebody's daughter-in-law at a counter. `patient_guardians` is where
 *     a DECLARED relationship lives, and it remains the only one.
 *   · NOT a merge suggestion. `nearMatches` owns duplicate suspicion and says so in its own words;
 *     two people on one number are the NORMAL case here, not a defect to be reconciled away.
 *   · NOT a consent grant. Nothing here lets one family member's record be acted on from another's.
 */

/**
 * The render cap. A clerk who types the hospital's own landline, a tout's number or a village PCO
 * into fifty records makes a "family" of fifty, and drawing all of them beside a patient's name is
 * both useless and a disclosure. `total` below is what tells the desk it is looking at a number
 * that is not a household at all.
 */
export const LINKED_CAP = 20;

export type LinkedPatientRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  administrativeGender: string;
  dob: Date | null;
  isConfidential: boolean;
  registeredOn: Date;
  /** WHICH of the subject's numbers this person is reachable on — a family may share two. */
  sharedOn: string[];
};

export type LinkedPatients = {
  /** The subject's own numbers, which are the whole of the link's evidence. */
  numbers: string[];
  items: LinkedPatientRow[];
  /** How many share a number in total — `items` is capped at `LINKED_CAP`, this is not. */
  total: number;
};

const EMPTY: LinkedPatients = { numbers: [], items: [], total: 0 };

/**
 * `patients.phone` is validated at the HTTP boundary as a bare 10-digit Indian mobile
 * (`/^[6-9]\d{9}$/`, `patients.controller.ts`) and stored exactly as typed, so equality is the
 * whole of the match — there is no normalisation layer here to disagree with the one at the door.
 */
export async function linkedPatients(db: Db, actor: Actor, patientId: string): Promise<LinkedPatients> {
  /*
    A DESK SURFACE, USER ACTORS ONLY — `searchPatients` draws this line and this one matters more.
    A patient actor reaching a household through a derived link would hand whoever holds the phone
    every record registered against it, with nobody having consented to anything; that is precisely
    the disclosure 22c-B's access classes exist to mediate, and it must not be reachable before them.
  */
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "linked patients is a desk surface — user actors only");
  }

  /*
    THROUGH `getPatient`, WHICH DOES BOTH JOBS — it follows the merge chain AND enforces the §14
    seal. `listPatientCoverages` learned this at its close review as a CRITICAL: it resolved the id
    and then selected straight from the table, and the seal was open on the surface whose own
    comment said it was closed. An EMPTY ENVELOPE rather than a throw, for the same reason that
    reader gives: a sealed subject must be indistinguishable from a patient who shares no number.
  */
  const found = await getPatient(db, actor, patientId);
  if (found === null) return EMPTY;
  const subject = found.patient;

  const numbers = [subject.phone, subject.altPhone].filter(
    (n): n is string => typeof n === "string" && n.trim() !== "",
  );
  if (numbers.length === 0) return EMPTY; // D-34: a phoneless patient is a designed path, not a gap

  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const conditions = [
    /*
      `status = 'active'` is doing TWO jobs and both are load-bearing: a merged loser is the same
      human as its winner, so listing it would tell the desk this family has one more person in it
      than it does — and the winner is in the list already, under the name the hospital settled on.
    */
    eq(patients.status, "active"),
    ne(patients.id, subject.id), // nobody is their own family member
    or(inArray(patients.phone, numbers), inArray(patients.altPhone, numbers))!,
  ];
  /*
    THE SEAL, AND THE COUNT IS INSIDE IT. A family list is the easiest place in this system to
    defeat a confidentiality flag — the sealed record itself refuses, and a link from their
    brother's record would hand over the name anyway. `count(*) over ()` runs over the SAME filtered
    set, so "three share this number, you may see two" is never said either: a total that counted
    the hidden row would leak exactly what the seal exists to withhold, one step more quietly.
  */
  if (!canSeeConfidential) conditions.push(eq(patients.isConfidential, false));

  const rows = await db
    .select({
      id: patients.id,
      uhid: patients.uhid,
      name: patients.name,
      phone: patients.phone,
      altPhone: patients.altPhone,
      administrativeGender: patients.administrativeGender,
      dob: patients.dob,
      isConfidential: patients.isConfidential,
      registeredOn: patients.createdAt,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(patients)
    .where(and(...conditions))
    // UHID breaks the tie: two "Sunil Kumar"s on one number are the ordinary case here, and a list
    // whose order changes between two reads of the same record is a list a clerk stops trusting.
    .orderBy(asc(patients.name), asc(patients.uhid))
    .limit(LINKED_CAP);

  if (rows.length === 0) return { numbers, items: [], total: 0 };

  /*
    ONE ROW PER READ, AGAINST THE SUBJECT, ON ITS OWN SURFACE. `patient.coverage`'s reasoning
    applied again: "a clerk opened a record" and "a clerk pulled this person's household off the
    back of it" are different disclosures, and the reason is the only thing this log is ever asked
    about. A read that found nobody writes nothing — a refusal is not a disclosure.
  */
  await recordPhiAccess(db, {
    actor,
    patientId: subject.id,
    surface: "patient.linked",
    sealed: subject.isConfidential,
    reason: `household read — ${String(rows.length)} of ${String(rows[0]!.total)} sharing this number`,
  });

  return {
    numbers,
    total: rows[0]!.total,
    items: rows.map((r) => ({
      id: r.id,
      uhid: r.uhid,
      name: r.name,
      phone: r.phone,
      altPhone: r.altPhone,
      administrativeGender: r.administrativeGender,
      dob: r.dob,
      isConfidential: r.isConfidential,
      registeredOn: r.registeredOn,
      // The subject's numbers this person carries, in the subject's own order (primary, then alt).
      sharedOn: numbers.filter((n) => n === r.phone || n === r.altPhone),
    })),
  };
}
