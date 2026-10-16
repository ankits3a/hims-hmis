import { and, eq, sql } from "drizzle-orm";
import { patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { patientUpdated } from "./events";
import { PatientError } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

/**
 * ER lane 4 (#811, spec SPEC-emergency §3.8) — THE ONE WRITER OF `death_kind = 'brought_dead'`.
 *
 * A body brought to the ER dead is a death the hospital did not see: it issues no MCCD (police inquest and post-mortem
 * decide the cause), so the 2026-09-29 ruling's "no death without its certificate number" cannot be met and does not
 * apply — it governs deaths after arrival. This seam marks the record deceased WITHOUT a certificate number and names the
 * kind, so the record says why the number is absent; the notifications gateway's deceased stop holds from this moment.
 *
 * Reached by no route: the emergency module's `record_brought_dead` calls it, in its own transaction, under the row lock,
 * only on an `active` record not already marked deceased. It appends `patient.updated` with the field diff, as every
 * patient-master change does.
 */
export async function recordBroughtDeadDeath(tx: Tx, actor: Actor, patientId: string, diedAt: Date): Promise<void> {
  const current = (await tx.select().from(patients).where(eq(patients.id, patientId)).for("update"))[0];
  if (current === undefined) throw new PatientError("patient_not_found", "no patient with that id");
  if (current.status !== "active") throw new PatientError("patient_not_active", "a merged record is frozen");
  if (current.deceasedAt !== null) return;
  await tx.update(patients)
    .set({ deceasedAt: diedAt, deathKind: "brought_dead", updatedBy: actor.id, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")));
  await appendEvent(tx, patientUpdated.make({
    actor, patientId, payload: {
      patientId, changes: [
        { field: "deceasedAt", from: null, to: diedAt.toISOString() },
        { field: "deathKind", from: null, to: "brought_dead" },
      ],
    },
  }));
}

/**
 * ER lane 5 (#812) — A DEATH IN THE ER (after arrival). 0018's rule holds: the death is recorded WITH its MCCD number
 * (`death_certificate_no`). The one exception the ER is allowed: a medico-legal case already intimated to the police,
 * whose cause the post-mortem decides — recorded with the `medico_legal` death kind and no number; the number is added
 * later through the ordinary amendment. The emergency module decides which applies; this seam writes it.
 */
export async function recordErDeath(
  tx: Tx, actor: Actor, patientId: string, diedAt: Date, cert: { mccdNo: string } | { medicoLegal: true },
): Promise<void> {
  const current = (await tx.select().from(patients).where(eq(patients.id, patientId)).for("update"))[0];
  if (current === undefined) throw new PatientError("patient_not_found", "no patient with that id");
  if (current.status !== "active") throw new PatientError("patient_not_active", "a merged record is frozen");
  if (current.deceasedAt !== null) return;
  const set = "mccdNo" in cert ? { deathCertificateNo: cert.mccdNo, deathKind: null } : { deathCertificateNo: null, deathKind: "medico_legal" };
  await tx.update(patients)
    .set({ deceasedAt: diedAt, ...set, updatedBy: actor.id, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")));
  await appendEvent(tx, patientUpdated.make({
    actor, patientId, payload: {
      patientId, changes: [
        { field: "deceasedAt", from: null, to: diedAt.toISOString() },
        "mccdNo" in cert ? { field: "deathCertificateNo", from: null, to: cert.mccdNo } : { field: "deathKind", from: null, to: "medico_legal" },
      ],
    },
  }));
}
