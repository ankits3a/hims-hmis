import { eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { patients } from "../../kernel/db/schema/patients";
import {
  pcpndtFormF, pcpndtRegisteredMachines, pcpndtRegisteredPersons,
} from "../../kernel/db/schema/pcpndt";
import { PcpndtError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18a T6 / A6 — **THE ONE READER OF THE REGISTER, AND IT SHOWS THE REAL NAME.**
 *
 * ═══ J1's SPLIT, AND THIS IS THE SIDE THAT DOES NOT USE THE ALIAS ═══
 *
 * Every other surface in this hospital renders a confidential patient through `displayName`: a
 * staff nurse's own pelvic ultrasound is aliased on the worklist, on the console, on the board and
 * in the OT's lists, and Plan 15 F20 exists to make sure of it.
 *
 * **A Form F is the exception, and it is not a lapse.** The form is a STATUTORY DECLARATION under
 * §5 of the PCPNDT Act, made by a named doctor about a named woman on a named machine. A
 * declaration bearing a pseudonym is a FALSE declaration — the criminal offence is the paperwork
 * being wrong, and "we anonymise our records" is not a defence available to the hospital. So this
 * reader goes to `patients.name` directly and never through the alias path.
 *
 * **A6's mutant is routing this through `displayName`**, and it is the natural mistake precisely
 * because the alias path is right everywhere else in the building. T9 A3 pins the other half — the
 * radiology worklist for the SAME patient shows the alias — so the two assertions together are the
 * split rather than either alone.
 *
 * ═══ WHAT MAKES THAT SAFE RATHER THAN A LEAK ═══
 *
 * Three things, and all three are in this file:
 *
 *   · `pcpndt.form_f.read` is required, and it is held by four roles rather than by everyone who
 *     can open a worklist;
 *   · the read is LOGGED to the `pcpndt.form_f` PHI surface on every call, so "who looked at this
 *     woman's Form F" has an answer;
 *   · there is NO LIST. This reader takes a study id and returns one form. `manifest.ts` states the
 *     reason: *"a list of Form F rows is a list of pregnant women by name, and the one thing this
 *     register must not become is a searchable surface."* The inspection persona that legitimately
 *     needs the register as a book is 18a-ii's, with its own permission and its own certified print.
 */

const READ = "pcpndt.form_f.read";

export type FormFView = {
  formFId: string;
  serialNo: number;
  serialYear: number;
  status: string;
  applicability: string;
  indicationCode: string;
  gestationWeeks: number | null;
  sections: unknown;
  declaration: unknown;
  referral: unknown;
  resultSummary: string | null;
  signedBy: string | null;
  signedAt: Date | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  /** THE REAL NAME. See the header — a statutory declaration with an alias on it is a false one. */
  patientName: string;
  patientUhid: string;
  /** So a screen can say "this is the statutory record" rather than silently differing from the worklist. */
  patientIsConfidential: boolean;
  machine: { id: string; make: string; model: string; serial: string };
  person: { id: string; userId: string; qualification: string };
};

/**
 * The register's only reader. Returns `null` for a study with no form rather than throwing: "is
 * there a form for this scan" is a legitimate question with a legitimate negative answer, and T7's
 * `assertFormFRecorded` is the one that refuses.
 *
 * **The PHI row is written for an accepted read that returns nothing as well.** Somebody asked
 * about this woman's statutory record; that they found no form does not make the enquiry invisible.
 */
export async function formFForStudy(
  db: Db, actor: Actor, studyId: string,
): Promise<FormFView | null> {
  if (actor.type !== "user") {
    throw new PcpndtError("person_not_registered", "the PCPNDT register is read by staff, not by automation");
  }
  if (!(await hasPermission(db, actor.id, READ, "hospital"))) {
    throw new PcpndtError("person_not_registered", `${actor.id} does not hold ${READ}`, { permission: READ });
  }

  const rows = await db
    .select({
      form: pcpndtFormF,
      patientName: patients.name,
      patientUhid: patients.uhid,
      patientIsConfidential: patients.isConfidential,
      machine: pcpndtRegisteredMachines,
      person: pcpndtRegisteredPersons,
    })
    .from(pcpndtFormF)
    .innerJoin(patients, eq(patients.id, pcpndtFormF.patientId))
    .innerJoin(pcpndtRegisteredMachines, eq(pcpndtRegisteredMachines.id, pcpndtFormF.machineId))
    .innerJoin(pcpndtRegisteredPersons, eq(pcpndtRegisteredPersons.id, pcpndtFormF.personId))
    .where(eq(pcpndtFormF.studyId, studyId))
    .limit(1);

  const row = rows[0];
  await recordPhiAccess(db, {
    actor,
    patientId: row?.form.patientId ?? "unknown",
    surface: "pcpndt.form_f",
    reason: `Form F for study ${studyId}`,
  });
  if (!row) return null;

  return {
    formFId: row.form.id,
    serialNo: row.form.serialNo,
    serialYear: row.form.serialYear,
    status: row.form.status,
    applicability: row.form.applicability,
    indicationCode: row.form.indicationCode,
    gestationWeeks: row.form.gestationWeeks,
    sections: row.form.sections,
    declaration: row.form.declaration,
    referral: row.form.referral,
    resultSummary: row.form.resultSummary,
    signedBy: row.form.signedBy,
    signedAt: row.form.signedAt,
    verifiedBy: row.form.verifiedBy,
    verifiedAt: row.form.verifiedAt,
    patientName: row.patientName,
    patientUhid: row.patientUhid,
    patientIsConfidential: row.patientIsConfidential,
    machine: {
      id: row.machine.id, make: row.machine.make, model: row.machine.model, serial: row.machine.serial,
    },
    person: {
      id: row.person.id, userId: row.person.userId, qualification: row.person.qualification,
    },
  };
}

/** `Tx`-typed convenience for a caller already inside a transaction. Same rules, same log. */
export async function formFForStudyTx(tx: Tx, actor: Actor, studyId: string): Promise<FormFView | null> {
  return await formFForStudy(tx as unknown as Db, actor, studyId);
}
