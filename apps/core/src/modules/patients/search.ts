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
  administrativeGender: string; // T4/DD4 — search is a display surface
  dob: Date | null;
  isConfidential: boolean;
  hasPhoto: boolean;
  /**
   * RC-1 T4 / D6 — WHY this row matched: the lanes that fired, per row, from the SAME SQL
   * fragments the predicate is built of (never a JS re-derivation that could drift). The seat
   * renders them as reason chips — "same mobile", never a confidence percentage (design ruling).
   */
  matchedOn: MatchLane[];
};

export type MatchLane = "uhid" | "mobile" | "name";

const PHONE_RE = /^\d{3,14}$/;

/**
 * UHID LANES — the 2026-08-25 format (`<PREFIX><7-digit serial><check digit>`, e.g. `U12345013`).
 *
 * Both regexes match SHAPE, not validity: a typo'd check digit must still be searchable, because
 * the desk that mistyped one digit is exactly the desk that needs the search to say "no such
 * patient" rather than to silently fall through to a name search that finds nobody either way.
 */
const UHID_FULL_RE = /^[A-Za-z]{1,5}\d{8}$/;
const UHID_PREFIXED_PARTIAL_RE = /^[A-Za-z]{1,5}(\d{4,7})$/;

/**
 * THE PARTIAL LANE EXISTS BECAUSE THE LEADING DIGITS ARE DEAD WEIGHT FOR A DECADE.
 *
 * The serial floor (1,234,501) means every patient the hospital registers before its 55,000th
 * shares the leading `U123`, and every one before its 655,000th shares `U12`. Three to four of
 * the nine characters therefore carry ZERO information at the search box, every single lookup —
 * which would have quietly undone the keystroke saving the format change was made to win.
 * Four digits is the floor: fewer is not a lookup, it is a listing.
 */
const UHID_PARTIAL_MIN = 4;
const UHID_DIGITS = 8; // 7-digit serial + 1 check digit

/**
 * Substring, NOT prefix — the one predicate in patient search that pays for a leading wildcard,
 * and it is served by `patients_uhid_trgm_idx` (migration 0024) rather than by a btree.
 *
 * Two different partials arrive at a desk and a prefix match would serve only one of them: the
 * last few characters read aloud off a card or a token slip, and the LEADING serial digits copied
 * out of a report or an older system that never carried the check digit. Anchoring either end
 * loses the other half of the desk.
 *
 * `digits` is guaranteed digits-only by the callers' regexes, so it carries no LIKE metacharacter
 * and needs no `escapeLike`.
 */
function uhidContains(digits: string): SQL {
  return sql`${patients.uhid} like ${`%${digits}%`}`;
}

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
  const lanes = patientMatchLanes(query);
  return lanes.length === 1 ? lanes[0]!.condition : or(...lanes.map((l) => l.condition))!;
}

/**
 * RC-1 T4 / D6 — the SAME branches, decomposed per LANE so a caller can also ask which lane a
 * ROW matched (each lane's fragment doubles as a boolean select column in `searchPatients`).
 * `patientMatchCondition` above is their OR, so the desk, the palette and the reason chips can
 * never disagree — one copy, three readers.
 */
export function patientMatchLanes(query: string): { lane: MatchLane; condition: SQL }[] {
  /**
   * Separators are punctuation ON AN ID, never data: a desk reading a card aloud types
   * "U 1234 5013" as readily as "U12345013", and the old hyphenated format trained everyone's
   * fingers for a year. Only the ID lanes below look at the compacted form — the NAME lanes keep
   * the raw query, because "Anne-Marie" is a name with a hyphen in it and compacting it would
   * hide her.
   */
  const compact = query.replace(/[\s-]/g, "");

  if (UHID_FULL_RE.test(compact)) return [{ lane: "uhid", condition: eq(patients.uhid, compact.toUpperCase()) }];

  const prefixed = UHID_PREFIXED_PARTIAL_RE.exec(compact);
  if (prefixed) return [{ lane: "uhid", condition: uhidContains(prefixed[1]!) }];

  if (PHONE_RE.test(compact)) {
    const prefix = `${compact}%`;
    const phone = or(like(patients.phone, prefix), like(patients.altPhone, prefix))!;
    /**
     * A BARE DIGIT RUN IS AMBIGUOUS AND IS THEREFORE TRIED AS BOTH.
     *
     * A phone is a phone (the Plan 05 split, kept) — but a desk that types `12345013` off a card
     * without the leading `U` means a UHID, and routing that to the phone lane alone returned
     * nothing at all. Both lanes OR together instead of one guessing: the caller caps results and
     * the picker renders name, photo and UHID before anyone can act, so a superset costs a glance
     * and the alternative cost the lookup entirely. Digit runs longer than a UHID's eight skip the
     * UHID lane because no substring of an 8-digit body can be nine digits long.
     */
    if (compact.length >= UHID_PARTIAL_MIN && compact.length <= UHID_DIGITS) {
      return [{ lane: "mobile", condition: phone }, { lane: "uhid", condition: uhidContains(compact) }];
    }
    return [{ lane: "mobile", condition: phone }];
  }
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
  if (folded === rawLower) return [{ lane: "name", condition: sql`lower(${patients.name}) like ${foldedPrefix}` }];
  const rawPrefix = `${escapeLike(rawLower)}%`;
  return [{ lane: "name", condition: sql`(lower(${patients.name}) like ${foldedPrefix} or lower(${patients.name}) like ${rawPrefix})` }];
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
 * test/perf-patient-search.test.ts). The phone and name lanes stay PREFIX-only, each served by a
 * text_pattern_ops btree index. The two exceptions both earned their leading wildcard and both
 * carry a GIN index to pay for it: name similarity (Plan 11h, `patients_name_trgm_idx`) and the
 * partial-UHID lane (2026-08-25 format change, `patients_uhid_trgm_idx`).
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

  // RC-1 T4 / D6 — the lanes, once: their OR is the WHERE, and each fragment is ALSO selected as
  // a boolean column, so "why did this row match" is answered by the very SQL that matched it.
  const lanes = patientMatchLanes(query);
  conditions.push(lanes.length === 1 ? lanes[0]!.condition : or(...lanes.map((l) => l.condition))!);
  const laneFor = (lane: MatchLane): SQL<boolean> => {
    const found = lanes.find((l) => l.lane === lane);
    return found === undefined ? sql<boolean>`false` : sql<boolean>`(${found.condition})`;
  };

  const rows = await db
    .select({
      id: patients.id,
      uhid: patients.uhid,
      name: patients.name,
      phone: patients.phone,
      administrativeGender: patients.administrativeGender,
      dob: patients.dob,
      isConfidential: patients.isConfidential,
      photoPatientId: patientPhotos.patientId, // ONLY the id column — bytes never load here
      mUhid: laneFor("uhid"),
      mMobile: laneFor("mobile"),
      mName: laneFor("name"),
    })
    .from(patients)
    .leftJoin(patientPhotos, eq(patientPhotos.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(asc(patients.name)) // D-37: ordering never touches the confidential flag
    .limit(cap);

  return rows.map((r) => {
    const matchedOn: MatchLane[] = [];
    if (r.mUhid) matchedOn.push("uhid");
    if (r.mMobile) matchedOn.push("mobile");
    if (r.mName) matchedOn.push("name");
    return {
      id: r.id,
      uhid: r.uhid,
      name: r.name,
      phone: r.phone,
      administrativeGender: r.administrativeGender,
      dob: r.dob,
      isConfidential: r.isConfidential,
      hasPhoto: r.photoPatientId !== null,
      matchedOn,
    };
  });
}
