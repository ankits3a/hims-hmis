import { and, asc, eq, like, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { escapeLike } from "../../kernel/search/text";
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

/**
 * PLAN 11h T2 — THE THREE BRANCHES, EXTRACTED SO THERE IS ONE COPY OF THEM.
 *
 * `searchPatients` (the desk route, six screens) and the palette's provider must agree about what
 * "matches" means, forever. Two copies of this if/else would drift the first time one of them
 * learned a fourth branch — §2.54's class, and the palette would quietly find people the desk
 * could not, or the reverse. The RBAC predicates deliberately stay OUT of here: they differ
 * between the two callers (the provider admits break-glass, plan DD3) and a shared function that
 * silently carried a confidentiality rule would be the worse kind of reuse.
 */
export function patientMatchCondition(query: string): SQL {
  if (PHONE_RE.test(query)) {
    const prefix = `${query}%`;
    return or(like(patients.phone, prefix), like(patients.altPhone, prefix))!;
  }
  if (UHID_SHAPE_RE.test(query)) return eq(patients.uhid, query.toUpperCase());
  const prefix = `${escapeLike(query.toLowerCase())}%`;
  return sql`lower(${patients.name}) like ${prefix}`;
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

  conditions.push(patientMatchCondition(query));

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
