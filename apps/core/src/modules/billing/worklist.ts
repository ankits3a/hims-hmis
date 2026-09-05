import { and, asc, eq, inArray } from "drizzle-orm";
import { opdEncounters, opdQueueEntries, opdQueueSessions, patients } from "../../kernel/db/schema";
import { encounterFeeStatuses } from "./fee-status";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName } from "../patients";
import { hasPermission } from "../../kernel/auth/permissions";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ FD-8 — THE CASHIER HAD NO DOOR INTO THEIR OWN SCREEN ═══
 *
 * Measured before this was written, and it is the reason it exists. EVERY route a `cashier` may call
 * is keyed on an id they must already hold — `/billing/visits/:encounterId/fee-quote`,
 * `/billing/patients/:patientId/dues`, `/billing/invoices/:id`. And the role holds **no
 * `patients.read`**, so the patient picker `/billing` renders today answers 403 for the very person
 * the screen is for. The only working entry was a deep link from the OPD desk (`?encounterId=`) —
 * i.e. somebody else's screen handing the cashier a URL.
 *
 * So user 3 could not start their own day. This is the door: **who is waiting to pay, right now.**
 *
 * ═══ A WORKLIST, NOT A SEARCH — AND THAT IS THE PRIVACY DESIGN, NOT A LIMITATION ═══
 *
 * The obvious repair is to grant the cashier `patients.read` and reuse the picker. That is worse: it
 * opens the whole patient book — ten thousand people — to a desk whose job is to take money from the
 * handful in front of it. This answers a much narrower question, and the narrowness is what makes it
 * safe to answer: *of today's visits, which still owe money?* A patient who is not being billed today
 * never appears, and the cashier still cannot look anybody up.
 *
 * `isConfidential` travels so the seat can mark the row; it is NOT the access control. A confidential
 * patient who owes money must still be billable — refusing would send them to a desk that cannot take
 * their payment — so the row appears, marked, exactly as the counter's duplicate list does.
 */
export type CollectionRow = {
  encounterId: string;
  visitNo: string;
  patientId: string;
  patientName: string;
  uhid: string;
  isConfidential: boolean;
  /** The number on the slip the patient is holding — the cashier's only reliable handle. */
  tokenNo: number | null;
  departmentId: string | null;
  doctorId: string | null;
  serviceDate: string;
};

/**
 * Today's unsettled visits, oldest first.
 *
 * `unsettled` ONLY: `free` (a review visit), `settled` and `credit` are all finished as far as this
 * desk is concerned, and listing them would put people in the queue who have nothing to pay — the
 * cashier would call a patient who has already left. `encounterFeeStatuses` is the single source of
 * that judgement, shared with the OPD desk's own stamp, so the two screens cannot disagree about who
 * owes money.
 */
export async function collectionWorklist(
  db: Db,
  actor: Actor,
  serviceDate: string,
): Promise<CollectionRow[]> {
  const encounters = await db
    .select({
      id: opdEncounters.id,
      visitNo: opdEncounters.visitNo,
      patientId: opdEncounters.patientId,
      visitType: opdEncounters.visitType,
      departmentId: opdEncounters.departmentId,
      doctorId: opdEncounters.doctorId,
      serviceDate: opdEncounters.serviceDate,
    })
    .from(opdEncounters)
    .where(and(eq(opdEncounters.serviceDate, serviceDate), eq(opdEncounters.type, "opd")))
    .orderBy(asc(opdEncounters.visitNo));
  if (encounters.length === 0) return [];

  const statuses = await encounterFeeStatuses(db, encounters);
  const owing = encounters.filter((e) => statuses.get(e.id) === "unsettled");
  if (owing.length === 0) return [];

  const people = await db
    .select({
      id: patients.id, name: patients.name, uhid: patients.uhid,
      /* `alias` travels because `displayName` needs it — a sealed row renders the alias, not the name. */
      alias: patients.alias,
      isConfidential: patients.isConfidential,
    })
    .from(patients)
    .where(inArray(patients.id, [...new Set(owing.map((e) => e.patientId))]));
  const byId = new Map(people.map((p) => [p.id, p] as const));

  /*
   * The token, read off the queue entry rather than stored twice. A visit that never joined a queue
   * (bill-first, before the join) has none — `null` rather than a guess, because a cashier calling a
   * token number that is not on the patient's slip is worse than calling their name.
   */
  const entries = await db
    .select({ encounterId: opdQueueEntries.encounterId, tokenNo: opdQueueEntries.tokenNo })
    .from(opdQueueEntries)
    .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
    .where(inArray(opdQueueEntries.encounterId, owing.map((e) => e.id)));
  const tokenOf = new Map(entries.map((e) => [e.encounterId, e.tokenNo] as const));

  /*
    ═══ FD-23 CLOSE REVIEW — THIS READ IS LOGGED, BECAUSE IT IS THE ONE OF ITS CLASS THAT WAS NOT ═══

    The rows below carry a NAME, a UHID and `isConfidential` for every patient who owes money today.
    The header two screens up argues at length that the narrowness is what makes that safe to
    answer — and it does — but narrow is not the same as unrecorded. `opd/continuity.ts`,
    `radiology/read.ts`, `radiology/mwl.ts` and `aerb/dose.ts` all write one row per patient for
    reads of exactly this shape; this one took an `Actor` it never used and left `phi_access_log`
    empty, so *"who looked at this patient's record"* returned nothing for the whole billing floor.

    ONE ROW PER DISTINCT PATIENT, like the imaging worklist and for its stated reason: a twenty-row
    list that leaves one audit row looks complete and answers nineteen questions wrong.
    `recordPhiAccess` never throws (its own header) and the table is pruned at
    `PHI_ACCESS_RETAIN_DAYS`, so the volume is bounded.
  */
  /*
    ═══ CLOSE PASS 2, CRITICAL — THE SEAL, WHICH THIS READER ANNOUNCED AND THEN BROKE ═══

    `byId` selects straight from `patients`, and the row below carried `patientName: person.name` —
    the LEGAL name — beside `isConfidential: true`. The row correctly declared the patient sealed and
    then disclosed the exact thing the seal withholds, to every holder of `billing.invoice.read`.
    Nobody in the model holds `patients.confidential.read`; it is granted to ZERO roles.

    Not a product question: the patients module already decided how a confidential name is rendered
    to somebody who may not see it, and this reader simply never asked it. `canSee` is resolved ONCE
    for the actor rather than per row — it is a hospital-scope permission, and a per-row lookup would
    be N queries for one answer.

    THE PATIENT STAYS ON THE LIST. Removing them would be the wrong fix: a sealed patient must still
    be billable, which is the whole reason this route answers for one. What changes is the name a
    cashier reads off the screen.

    And this is the road pass 1's coverages fix was written against — that finding reasoned a cashier
    obtains a sealed id HERE. True, and incomplete: the same route was already handing over the name,
    so gating the coverages read while this printed it was a seal with a hole one level up.

    `sealed` on the audit row for the same reason it was added to reprint and coverages: it defaults
    to false, so these disclosures were logged as ordinary reads and "who read sealed records"
    answered no one.
  */
  const canSeeConfidential = actor.type === "user"
    && await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const reason = `billing collection worklist ${serviceDate}, ${String(owing.length)} rows`;
  for (const patientId of new Set(owing.map((e) => e.patientId))) {
    await recordPhiAccess(db, {
      actor, patientId, surface: "billing.collection_worklist", reason,
      sealed: byId.get(patientId)?.isConfidential ?? false,
    });
  }

  return owing.flatMap((e): CollectionRow[] => {
    const person = byId.get(e.patientId);
    if (person === undefined) return [];
    return [{
      encounterId: e.id,
      visitNo: e.visitNo,
      patientId: e.patientId,
      patientName: displayName(person, canSeeConfidential),
      uhid: person.uhid,
      isConfidential: person.isConfidential,
      tokenNo: tokenOf.get(e.id) ?? null,
      departmentId: e.departmentId,
      doctorId: e.doctorId,
      serviceDate: e.serviceDate,
    }];
  });
}
