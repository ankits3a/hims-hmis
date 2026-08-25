import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { escapeLike } from "../../kernel/search/text";
import { normalizeForSearch } from "../../kernel/search/normalize";
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
  /**
   * PLAN 11h T7, CORRECTED AT CLOSE (independent reviewer, MAJOR 4) — BOTH SPELLINGS ARE TRIED.
   *
   * T7 folded the query and matched the folded form ALONE, which quietly BROKE a case that had
   * worked since Plan 05: a patient stored in Devanagari (`आशा देवी` — `name` has no script
   * restriction and the app ships a full Hindi locale) was found by typing `आशा` before T7 and was
   * unreachable after it, because the query folded to `asha` while the column still held
   * Devanagari. The fuzzy fallback could not save it either: Latin trigrams against Devanagari
   * ones score ~0. That regression rode `patientMatchCondition`, which the desk route shares — so
   * it was six screens, not just the palette.
   *
   * Matching the folded form OR the raw one keeps what T7 added (a Devanagari query finding a
   * Latin record) without removing what already worked (a Devanagari query finding a Devanagari
   * record). The phone and UHID branches above stay untouched: a digit string and a document
   * number are not names.
   */
  const folded = normalizeForSearch(query);
  const rawLower = query.trim().toLowerCase();
  const foldedPrefix = `${escapeLike(folded)}%`;
  if (folded === rawLower) return sql`lower(${patients.name}) like ${foldedPrefix}`;
  const rawPrefix = `${escapeLike(rawLower)}%`;
  return sql`(lower(${patients.name}) like ${foldedPrefix} or lower(${patients.name}) like ${rawPrefix})`;
}

/**
 * PLAN 11h CLOSE (independent reviewer, CRITICAL 1) — WHICH OF THESE IDS MAY THIS CALLER SEE?
 *
 * A PATIENT ID IS NOT A CAPABILITY. T3 and T4 gated their TEXT lanes by resolving names through
 * `searchPatients`, which seals confidential records — and then took a `@patient:<id>` chip
 * VERBATIM, with no gate at all. A cashier holding `billing.invoice.read` and not
 * `patients.confidential.read` could therefore read a confidential patient's invoice numbers,
 * amounts, service days and exact invoice COUNT by passing an id they had legitimately seen before
 * the record was flagged; the OPD half leaked appointment dates, doctor, department and status the
 * same way. Both providers carried a comment claiming the opposite, which is how it survived
 * review by their author.
 *
 * This is the one gate both lanes now share. It lives here, in the module that owns the rule, for
 * the same reason `searchPatients` does: a confidentiality check written a second time is a
 * confidentiality check that will drift.
 */
export async function visiblePatientIds(db: Db, actor: Actor, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  if (actor.type !== "user") throw new PatientError("user_actor_required", "search is a desk surface — user actors only");
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const rows = await db
    .select({ id: patients.id, isConfidential: patients.isConfidential })
    .from(patients)
    .where(and(inArray(patients.id, ids), eq(patients.status, "active")));
  return rows.filter((r) => canSeeConfidential || !r.isConfidential).map((r) => r.id);
}

/**
 * PLAN 11h T7 — THE APPROXIMATE BRANCH, used only when the exact one found nobody.
 *
 * `pg_trgm` similarity over the GIN index migration 0021 creates. The threshold is a deliberate
 * constant rather than a tunable: at 0.3 "Aasha" finds "Asha" and "Bina" does not find "Meena",
 * which is the trade a desk wants — a few extra rows beats a confident empty result. Raising it
 * hides real people; lowering it turns the palette into a random name generator.
 *
 * IT IS NEVER THE FIRST BRANCH. An exact prefix hit is what the desk asked for, it is served by a
 * btree index, and burying it among approximate matches would make the common case worse to serve
 * the rare one.
 */
export const TRIGRAM_THRESHOLD = 0.3;

/**
 * IT USES `%`, NOT `similarity(...) > t`, AND THE DIFFERENCE IS THE WHOLE INDEX.
 *
 * MEASURED (T7, `test/perf-search.test.ts`): `similarity(lower(name), $1) > 0.3` plans as a
 * **Seq Scan** over every row. `pg_trgm`'s GIN index serves the `%` OPERATOR; the function form is
 * not indexable, and Postgres silently reads the whole table instead — the exact failure migration
 * 0021's comment warns about, where the query still returns correct rows and nothing complains
 * until a desk waits four seconds at 200,000 patients.
 *
 * Both terms are present on purpose. `%` is what the index can serve, and it honours the server's
 * `pg_trgm.similarity_threshold` GUC; the explicit `similarity(...)` pins OUR threshold so the
 * behaviour does not drift with a server setting. The effective bar is therefore
 * `max(GUC, TRIGRAM_THRESHOLD)`, and a test asserts the GUC sits at its 0.3 default so the two
 * coincide — if somebody raises it, that test says so rather than patients quietly going missing.
 */
export function patientFuzzyCondition(query: string): SQL {
  const folded = normalizeForSearch(query);
  return sql`lower(${patients.name}) % ${folded} and similarity(lower(${patients.name}), ${folded}) > ${TRIGRAM_THRESHOLD}`;
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
