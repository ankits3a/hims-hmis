import { and, asc, eq, sql } from "drizzle-orm";
import type { SearchHit } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { patients } from "../../kernel/db/schema";
import { patientMatchCondition } from "./search";
import type { SearchProvider, SearchProviderCtx, SearchProviderResult } from "../../kernel/search/types";

/**
 * PLAN 11h T2 / DD3 — THE PATIENTS PROVIDER, AND THE SEALED CLASS.
 *
 * ═══ SEALED ═══
 * A confidential record is excluded BY THE `WHERE` CLAUSE for a caller without
 * `patients.confidential.read`. Not filtered from the rows afterwards, not hidden by the UI, and —
 * the half that is easy to get wrong — NOT COUNTED EITHER. `total` comes from the SAME predicate
 * that produced the hits, so nobody learns that a confidential Sharma exists by watching a count
 * say 3 while two rows render. Ordering is `name ASC` over the surviving rows, so the answer is
 * identical to the same query against a database in which the row does not exist. That
 * equivalence IS the assertion (D-37, generalised).
 *
 * ═══ THE VISIBILITY RULE IS COPIED, NOT INVENTED — and the first draft of this file got it wrong ═══
 * `getPatientSummaries` (registration.ts) is the shipped confidential gate, and `listDues`
 * (receipts.ts) and the recon summaries follow it: **a restricted row renders its ALIAS and never
 * its name**, while uhid/sex/dob are returned regardless because the staff physically serving the
 * patient need them (§14). This provider follows that rule exactly.
 *
 * It also does NOT honour break-glass, and that absence is deliberate. Break-glass is wired into
 * ONE place — `PermissionGuard`, via `breakGlassBypass` on a route, keyed to that request's
 * `patientId` (guards.ts). No query-level read path consults it, `getPatientSummaries` included.
 * An earlier draft of this provider let a HOSPITAL-WIDE grant widen search; that would have made
 * the palette the only surface in the system where break-glass reveals records nothing else
 * reveals — a privilege escalation introduced by a convenience feature. Whether a break-glass
 * holder should be able to FIND a confidential patient is a real operational question (ED,
 * unconscious VIP), and it is the owner's open D6 ruling, not a search provider's to answer.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 * No department scoping, so no RESTRICTED hits: patient records carry no scope in this schema, and
 * inventing one here would be a data model written in a search provider. `SearchHit.restricted` is
 * unused by THIS provider and used by entities that do carry scope.
 */
export const patientSearchProvider: SearchProvider = {
  key: "patients.patient",
  entity: "patient",
  permission: "patients.read",

  async run(ctx: SearchProviderCtx): Promise<SearchProviderResult> {
    const text = ctx.query.text.trim();
    if (text.length < 2) return { hits: [], total: 0 };

    const canSeeConfidential = await hasPermission(ctx.db, ctx.actor.id, "patients.confidential.read", "hospital");

    const conditions = [eq(patients.status, "active"), patientMatchCondition(text)];
    if (!canSeeConfidential) conditions.push(eq(patients.isConfidential, false));
    const where = and(...conditions);

    const [rows, counted] = await Promise.all([
      ctx.db
        .select({
          id: patients.id,
          uhid: patients.uhid,
          name: patients.name,
          alias: patients.alias,
          phone: patients.phone,
          sex: patients.sex,
          dob: patients.dob,
          isConfidential: patients.isConfidential,
        })
        .from(patients)
        .where(where)
        .orderBy(asc(patients.name)) // never touches the confidential flag (D-37)
        .limit(ctx.limit),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(patients).where(where),
    ]);

    return { hits: rows.map((r) => toHit(r, canSeeConfidential)), total: counted[0]?.n ?? 0 };
  },
};

type Row = {
  id: string; uhid: string; name: string; alias: string | null; phone: string | null;
  sex: string; dob: Date | null; isConfidential: boolean;
};

/**
 * A LIST ROW IS NOT A RECORD (plan DD8's redaction rule).
 *
 * The phone is masked to its last four digits HERE, because a registration or billing counter
 * screen faces the patient queue — a palette printing ten full mobile numbers at eye level is a
 * data leak with no attacker in it. The full number is on the patient's own page, behind a click
 * that T5 audits.
 *
 * A confidential row reaching this function has already passed the permission gate — only a holder
 * of `patients.confidential.read` can see one at all — so today it renders its NAME. The alias
 * branch below is therefore unreachable BY CONSTRUCTION, and it is written anyway: it is one line
 * mirroring `getPatientSummaries`, and the day the D6 ruling lets a non-holder see a confidential
 * row, its absence would be a name leak rather than a missing feature.
 */
function toHit(r: Row, canSeeConfidential: boolean): SearchHit {
  const meta: Record<string, string> = { uhid: r.uhid, sex: r.sex };
  if (r.phone !== null) meta.phone = `•••••• ${r.phone.slice(-4)}`;
  if (r.dob !== null) meta.age = `${ageYears(r.dob)}y`;
  // EXACTLY `getPatientSummaries`' `restricted` computation, and the same consequence: a
  // restricted row renders its alias and never its name. Unreachable today — a non-holder never
  // receives a confidential row at all (sealed, above) — and correct on the day D6 changes that.
  const restricted = r.isConfidential && !canSeeConfidential;
  const label = restricted ? (r.alias ?? "Restricted record") : r.name;
  return {
    entity: "patient",
    id: r.id,
    title: label,
    // Age and the last four are the DISAMBIGUATORS: two "Ramesh Kumar" of different ages are a
    // patient-safety problem at the desk, not a cosmetic one.
    subtitle: `${r.uhid} · ${r.sex}${r.dob === null ? "" : ` · ${ageYears(r.dob)}y`}`,
    meta,
    href: `/patients/${r.id}`,
  };
}

function ageYears(dob: Date): number {
  const ms = Date.now() - dob.getTime();
  return Math.max(0, Math.floor(ms / (365.2425 * 24 * 60 * 60 * 1000)));
}
