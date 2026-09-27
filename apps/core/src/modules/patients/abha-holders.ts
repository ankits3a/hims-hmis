import { and, eq, ne, sql } from "drizzle-orm";
import { patients } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { PatientError } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { PatientRow } from "./registration";

/**
 * ═══ ABDM S1 — ONE ABHA, ONE PATIENT (FT case TAGGING_UNIQUEPATIENTID_UNIQUEABHANUMBER) ═══
 *
 * NHA's M1 workbook: "ABHA Number should be validated in the database if already exists before
 * creating a new patient id" — one ABHA ↔ one UHID, for new and existing patients alike. An ABHA is a
 * national identifier; two hospital records carrying one number are two people to every lookup that
 * follows, and the second one's records would be linked to the first one's ABHA at the network.
 *
 * TWO LAYERS, as everywhere a rule must not have a gap:
 *
 *   · THE DATABASE — `patients_abha_number_ux` / `patients_abha_address_ux` (schema/patients.ts):
 *     partial unique indexes over the NORMALISED number (its digits) and the lower-cased address,
 *     over ACTIVE rows. A merged (frozen) record is not a patient anyone links to, and it keeps the
 *     ABHA it had, so a merge winner can still be verified with its loser's ABHA; the unmerge that
 *     would put two active holders back is refused here (`merge.ts`).
 *   · THIS CHECK, FIRST — so the refusal can say WHO holds it. The index cannot: a 23505 names a
 *     constraint, not a patient.
 *
 * THE UHID IS NAMED ONLY TO SOMEONE WHO MAY SEE IT: the actor holds `patients.read` and the holder is
 * not a sealed record they cannot open. Otherwise the refusal says "another patient record" and
 * nothing more — a duplicate check must not become a way to learn who holds a number.
 */
export type AbhaHolder = { patientId: string; uhid: string; isConfidential: boolean };

const digits = (v: string): string => v.replace(/\D/g, "");

/** The ACTIVE patient (other than `excludePatientId`) holding this ABHA number or address, if any. */
export async function findAbhaHolder(
  db: Db | Tx,
  input: { abhaNumber?: string | null; abhaAddress?: string | null },
  excludePatientId: string | null,
): Promise<AbhaHolder | null> {
  const number = input.abhaNumber === null || input.abhaNumber === undefined ? "" : digits(input.abhaNumber);
  const address = (input.abhaAddress ?? "").trim().toLowerCase();
  const probes = [
    number === "" ? null : sql`regexp_replace(${patients.abhaNumber}, '[^0-9]', '', 'g') = ${number}`,
    address === "" ? null : sql`lower(btrim(${patients.abhaAddress})) = ${address}`,
  ].filter((p): p is NonNullable<typeof p> => p !== null);
  if (probes.length === 0) return null;
  const rows = await db
    .select({ id: patients.id, uhid: patients.uhid, isConfidential: patients.isConfidential })
    .from(patients)
    .where(and(
      eq(patients.status, "active"),
      excludePatientId === null ? undefined : ne(patients.id, excludePatientId),
      sql`(${sql.join(probes, sql` or `)})`,
    ))
    .limit(1);
  const r = rows[0];
  return r === undefined ? null : { patientId: r.id, uhid: r.uhid, isConfidential: r.isConfidential };
}

/** The holder's UHID if `actor` may see it, else null. */
export async function holderUhidVisibleTo(db: Db | Tx, actor: Actor | null, holder: AbhaHolder): Promise<string | null> {
  if (actor === null || actor.type !== "user") return null;
  const d = db as unknown as Db; // hasPermission only reads; a Tx reads fine (updatePatient's cast)
  if (!(await hasPermission(d, actor.id, "patients.read", "hospital"))) return null;
  if (holder.isConfidential && !(await hasPermission(d, actor.id, "patients.confidential.read", "hospital"))) return null;
  return holder.uhid;
}

/** The refusal, with `detail.uhid` only when the actor may see it. */
export async function abhaAlreadyLinked(db: Db | Tx, actor: Actor | null, holder: AbhaHolder): Promise<PatientError> {
  const uhid = await holderUhidVisibleTo(db, actor, holder);
  return new PatientError(
    "abha_already_linked",
    uhid === null
      ? "abha_already_linked: this ABHA is already linked to another patient record"
      : `abha_already_linked: this ABHA is already linked to UHID ${uhid}`,
    { uhid },
  );
}

/** Refuse when another active patient holds this ABHA. */
export async function assertAbhaFree(
  db: Db | Tx, actor: Actor | null,
  input: { abhaNumber?: string | null; abhaAddress?: string | null }, excludePatientId: string | null,
): Promise<void> {
  const holder = await findAbhaHolder(db, input, excludePatientId);
  if (holder !== null) throw await abhaAlreadyLinked(db, actor, holder);
}

/** A race the pre-check lost: the index said no. Mapped to the same code, without a UHID. */
export function isAbhaUniqueViolation(e: unknown): boolean {
  const pick = (x: unknown): { code?: unknown; constraint?: unknown } =>
    (typeof x === "object" && x !== null ? (x as { code?: unknown; constraint?: unknown }) : {});
  for (const c of [pick(e), pick((e as { cause?: unknown } | null)?.cause)]) {
    if (c.code === "23505" && (c.constraint === "patients_abha_number_ux" || c.constraint === "patients_abha_address_ux")) return true;
  }
  return false;
}

export function abhaRaceError(): PatientError {
  return new PatientError("abha_already_linked", "abha_already_linked: this ABHA is already linked to another patient record", { uhid: null });
}

export type { PatientRow };
