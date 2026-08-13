import { and, asc, eq, like, or, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { PatientError } from "./uhid";
import type { Db } from "../../kernel/db/client";

export type PatientSearchResult = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  sex: string;
  dob: Date | null;
  isConfidential: boolean;
  hasPhoto: boolean;
};

const PHONE_RE = /^\d{3,14}$/;
const UHID_SHAPE_RE = /^[A-Za-z]{2,5}-\d{8}-\d$/; // shape, not validity: a typo'd check digit must still be searchable

/** Escape LIKE metacharacters so user text is always literal. Postgres default escape is backslash. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Phone-first patient search (§11.1 entry lanes; §15 <300 ms budget — CI-enforced by
 * test/perf-patient-search.test.ts). Prefix-only by design: every branch is served by a
 * text_pattern_ops btree index; substring/fuzzy search arrives with MRD (pg_trgm), not here.
 */
export async function searchPatients(
  db: Db,
  actor: Actor,
  q: string,
  limit = 20,
): Promise<PatientSearchResult[]> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "search is a desk surface — user actors only");
  }
  const query = q.trim();
  if (query.length < 2) return [];
  const cap = Math.min(Math.max(limit, 1), 50);

  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const conditions = [eq(patients.status, "active")];
  if (!canSeeConfidential) conditions.push(eq(patients.isConfidential, false));

  if (PHONE_RE.test(query)) {
    const prefix = `${query}%`;
    conditions.push(or(like(patients.phone, prefix), like(patients.altPhone, prefix))!);
  } else if (UHID_SHAPE_RE.test(query)) {
    conditions.push(eq(patients.uhid, query.toUpperCase()));
  } else {
    const prefix = `${escapeLike(query.toLowerCase())}%`;
    conditions.push(sql`lower(${patients.name}) like ${prefix}`);
  }

  const rows = await db
    .select({
      id: patients.id,
      uhid: patients.uhid,
      name: patients.name,
      phone: patients.phone,
      sex: patients.sex,
      dob: patients.dob,
      isConfidential: patients.isConfidential,
      photoPatientId: patientPhotos.patientId, // ONLY the id column — bytes never load here
    })
    .from(patients)
    .leftJoin(patientPhotos, eq(patientPhotos.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(asc(patients.name)) // D-37: ordering never touches the confidential flag
    .limit(cap);

  return rows.map((r) => ({
    id: r.id,
    uhid: r.uhid,
    name: r.name,
    phone: r.phone,
    sex: r.sex,
    dob: r.dob,
    isConfidential: r.isConfidential,
    hasPhoto: r.photoPatientId !== null,
  }));
}
