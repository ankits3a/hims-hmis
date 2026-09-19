import { inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { patients, users } from "../db/schema";
import { recordPhiAccess } from "../phi/audit";
/*
  The patients module's own read helper, through its index — `kernel/printing/render.ts` is the
  precedent for the kernel asking `modules/patients` rather than re-deciding a sealed patient's name.
  No cycle: `modules/patients` reaches `./requests`, `./worklist` and `./types`, never this file,
  which only the controller imports.
*/
import { getPatientSummaries } from "../../modules/patients";
import type { Db } from "../db/client";
import type { ApprovalRow } from "./worklist";

/**
 * The patient an approval is about, AS THIS READER MAY SEE THEM.
 *
 * `getPatientSummaries` decides the name: a sealed (§14) patient read by somebody without
 * `patients.confidential.read` arrives `restricted`, with `name: null` and the alias — the legal
 * name never leaves the server for that reader. `id`/`uhid` are the CANONICAL record's: a merged
 * loser resolves to the record that survived.
 */
export type ApprovalPatient = {
  id: string;
  uhid: string;
  name: string | null;
  alias: string | null;
  restricted: boolean;
};

export type ApprovalListItem = ApprovalRow & {
  /** `users.full_name` of the requester; null only for an id no user row answers to. */
  requesterName: string | null;
  decidedByName: string | null;
  /** Null when the request names no patient, or names an id the patients table does not hold. */
  patient: ApprovalPatient | null;
};

/**
 * ═══ APPROVALS-UX — THE INBOX SAYS WHO, NOT WHICH ID ═══
 *
 * The approvals row carries `requesterId`, `decidedBy` and `patientId` as ids, and the inbox used to
 * print them that way: an owner deciding a refund saw a ULID where the patient should be and no
 * name for the person asking. This names them, in ONE query per kind for the whole page.
 *
 * THE PATIENT READ IS LOGGED, one `approvals.worklist` row per distinct canonical patient — the
 * `billing/worklist.ts` rule for a list that names patients, carrying `sealed` so "who read sealed
 * records" can be answered. `recordPhiAccess` never throws, so a logging failure never costs the
 * approver their queue.
 */
export async function withPeople(
  db: Db,
  actor: Actor,
  rows: readonly ApprovalRow[],
  reason: string,
): Promise<ApprovalListItem[]> {
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.flatMap((r) => [r.requesterId, r.decidedBy]).filter((v): v is string => v !== null))];
  const named = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds));
  const nameOf = new Map(named.map((u) => [u.id, u.fullName] as const));

  const patientIds = [...new Set(rows.map((r) => r.patientId).filter((v): v is string => v !== null))];
  const summaries = await getPatientSummaries(db, actor, patientIds);
  const summaryOf = new Map(summaries.map((s) => [s.requestedId, s] as const));

  const canonical = [...new Set(summaries.map((s) => s.id))];
  if (canonical.length > 0) {
    // `restricted` is about THIS reader; `sealed` is about the record, so it is read separately.
    const flags = await db
      .select({ id: patients.id, isConfidential: patients.isConfidential })
      .from(patients)
      .where(inArray(patients.id, canonical));
    const sealedOf = new Map(flags.map((f) => [f.id, f.isConfidential] as const));
    for (const patientId of canonical) {
      await recordPhiAccess(db, {
        actor, patientId, surface: "approvals.worklist", reason, sealed: sealedOf.get(patientId) ?? false,
      });
    }
  }

  return rows.map((r) => {
    const s = r.patientId === null ? undefined : summaryOf.get(r.patientId);
    return {
      ...r,
      requesterName: nameOf.get(r.requesterId) ?? null,
      decidedByName: r.decidedBy === null ? null : (nameOf.get(r.decidedBy) ?? null),
      patient: s === undefined
        ? null
        : { id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted },
    };
  });
}
