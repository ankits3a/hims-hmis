import { and, desc, eq, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { cdsDoctorLearningResets, opdComplaintTermUsage, opdDoctors, opdEncounterDiagnoses, opdEncounters } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { learningReset } from "./events";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ WHAT THE SYSTEM HAS LEARNED ABOUT ME — AND RESET (decision 0050, plan §6 + P4, #615) ═══
 *
 * Owner, 2026-10-07: "each doctor be able to see and reset what the system has learned about them."
 *
 * "Learned" is only what a personal ranking reads TODAY — nothing the system does not yet use is
 * shown as if it were (P1 learning from `cds_rx_lines` is held, so medicines are not listed here):
 *
 *   complaints  `opd_complaint_term_usage`, the doctor's row — `suggestComplaints`' "mine"
 *   diagnoses   the doctor's own diagnoses — the phone's most-used list (`consult/my-diagnoses`)
 *   tests       tests the doctor advised per diagnosis — `testsForDiagnosis`' "mine"
 *   findings    the doctor's own examination and treatment words — `myTerms`
 *   hidden      the doctor's crosses — `hiddenSuggestions`
 *
 * A reset writes a WATERMARK per surface; nothing is deleted. The doctor's own level ignores
 * evidence from before it; the hospital's counts (and every log) keep it, without a name. The
 * complaint counter has no per-use time, so its reset also snapshots the doctor's count per term
 * (`complaint_baseline`) and "mine" is the count above that snapshot.
 */

export const LEARNED_SURFACES = ["complaints", "diagnoses", "tests", "findings", "hidden"] as const;
export type LearnedSurface = (typeof LEARNED_SURFACES)[number];

/** The watermark for one surface, by the doctor's user id. Null when never reset. */
export async function resetAtForUser(db: Db | Tx, userId: string, surface: LearnedSurface): Promise<Date | null> {
  const [row] = await db.select({ at: cdsDoctorLearningResets.resetAt }).from(cdsDoctorLearningResets)
    .where(and(eq(cdsDoctorLearningResets.userId, userId), eq(cdsDoctorLearningResets.surface, surface)));
  return row?.at ?? null;
}

/** The same, by the OPD doctor id the ranking reads carry. */
export async function resetAtForDoctor(db: Db | Tx, doctorId: string, surface: LearnedSurface): Promise<Date | null> {
  const [row] = await db.select({ at: cdsDoctorLearningResets.resetAt }).from(cdsDoctorLearningResets)
    .innerJoin(opdDoctors, eq(opdDoctors.userId, cdsDoctorLearningResets.userId))
    .where(and(eq(opdDoctors.id, doctorId), eq(cdsDoctorLearningResets.surface, surface)));
  return row?.at ?? null;
}

/** The doctor's complaint counts at the last reset, per lower-cased term ({} when never reset). */
export async function complaintBaseline(db: Db | Tx, doctorId: string): Promise<Record<string, number>> {
  const [row] = await db.select({ base: cdsDoctorLearningResets.complaintBaseline }).from(cdsDoctorLearningResets)
    .innerJoin(opdDoctors, eq(opdDoctors.userId, cdsDoctorLearningResets.userId))
    .where(and(eq(opdDoctors.id, doctorId), eq(cdsDoctorLearningResets.surface, "complaints")));
  return row?.base ?? {};
}

/** A timestamp bound for raw SQL: `-infinity` when there is no watermark, so the filter is a no-op. */
export const sinceSql = (at: Date | null) => (at === null ? sql`'-infinity'::timestamptz` : sql`${at.toISOString()}::timestamptz`);

/**
 * What THIS doctor has diagnosed most — the phone's most-used list (`consult/my-diagnoses`) — counting
 * only visits after the doctor's "diagnoses" watermark (a visit's time = consult completed, else started).
 * With no watermark every visit counts, as before the reset existed.
 */
export async function myDiagnoses(db: Db, doctorId: string, limit: number): Promise<{ text: string; icd10Code: string | null; uses: number }[]> {
  const at = await resetAtForDoctor(db, doctorId, "diagnoses");
  const uses = sql<number>`count(*)::int`;
  const rows = await db
    .select({ text: opdEncounterDiagnoses.text, icd10Code: opdEncounterDiagnoses.icd10Code, uses })
    .from(opdEncounterDiagnoses)
    .innerJoin(opdEncounters, eq(opdEncounters.id, opdEncounterDiagnoses.encounterId))
    .where(and(eq(opdEncounters.doctorId, doctorId),
      at === null ? undefined : sql`coalesce(${opdEncounters.consultCompletedAt}, ${opdEncounters.consultStartedAt}) >= ${at.toISOString()}::timestamptz`))
    .groupBy(opdEncounterDiagnoses.text, opdEncounterDiagnoses.icd10Code)
    .orderBy(desc(uses), opdEncounterDiagnoses.text)
    .limit(limit);
  return rows.map((r) => ({ text: r.text, icd10Code: r.icd10Code, uses: Number(r.uses) }));
}

export type LearnedAboutMe = {
  since: Record<LearnedSurface, string | null>;
  complaints: { term: string; uses: number }[];
  diagnoses: { text: string; icd10Code: string | null; uses: number }[];
  tests: { diagnosis: string; name: string; uses: number }[];
  findings: { field: "exam_general" | "exam_systemic" | "exam_local" | "treatment"; term: string; uses: number }[];
  hidden: { kind: string; contextKey: string | null; itemKey: string }[];
};

const TOP = 10;

/**
 * The calling doctor's own learned patterns, each since that surface's watermark. Counts and items
 * only — no patient, no visit, no price (decision 0058). `hidden` is passed in by the caller
 * (`hiddenSuggestions`, which honours the watermark itself) to keep one definition of "hidden".
 */
export async function learnedAboutMe(
  db: Db, doctor: { id: string; userId: string }, hidden: LearnedAboutMe["hidden"],
): Promise<LearnedAboutMe> {
  const rows = await db.select({ surface: cdsDoctorLearningResets.surface, at: cdsDoctorLearningResets.resetAt, base: cdsDoctorLearningResets.complaintBaseline })
    .from(cdsDoctorLearningResets).where(eq(cdsDoctorLearningResets.userId, doctor.userId));
  const at = (s: LearnedSurface): Date | null => rows.find((r) => r.surface === s)?.at ?? null;
  const base = rows.find((r) => r.surface === "complaints")?.base ?? {};

  const usage = await db.select({ term: opdComplaintTermUsage.term, uses: opdComplaintTermUsage.uses })
    .from(opdComplaintTermUsage).where(eq(opdComplaintTermUsage.doctorId, doctor.id));
  const complaints = usage.map((u) => ({ term: u.term, uses: u.uses - (base[u.term] ?? 0) }))
    .filter((u) => u.uses > 0)
    .sort((a, b) => b.uses - a.uses || a.term.localeCompare(b.term))
    .slice(0, TOP);


  const tests = await db.execute(sql`
    select coalesce(d.icd10_code, lower(d.text)) as diagnosis, max(t->>'name') as name, count(distinct e.id)::int as uses
      from opd_encounters e
      join opd_encounter_diagnoses d on d.encounter_id = e.id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(e.advised_tests) = 'array' then e.advised_tests else '[]'::jsonb end) as t
     where e.doctor_id = ${doctor.id} and e.consult_completed_at is not null
       and e.consult_completed_at >= ${sinceSql(at("tests"))}
       and t->>'serviceId' is not null
     group by coalesce(d.icd10_code, lower(d.text)), t->>'serviceId'
     order by uses desc, name asc
     limit ${TOP}`);

  const findings = await db.execute(sql`
    select field, term, count(*)::int as uses from (
      select 'treatment' as field, x.term as term
        from opd_encounters e
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.treatment) = 'array' then e.treatment else '[]'::jsonb end) as x(term)
       where e.doctor_id = ${doctor.id} and e.consult_completed_at is not null and e.consult_completed_at >= ${sinceSql(at("findings"))}
      union all
      select 'exam_' || (f->>'group'), f->>'text'
        from opd_encounters e
        cross join lateral jsonb_array_elements(case when jsonb_typeof(e.examination) = 'array' then e.examination else '[]'::jsonb end) as f
       where e.doctor_id = ${doctor.id} and e.consult_completed_at is not null and e.consult_completed_at >= ${sinceSql(at("findings"))}
         and f->>'group' in ('general', 'systemic', 'local')
    ) w
    where term is not null and term <> ''
    group by field, term
    order by uses desc, term asc
    limit ${TOP}`);

  const iso = (s: LearnedSurface): string | null => at(s)?.toISOString() ?? null;
  return {
    since: { complaints: iso("complaints"), diagnoses: iso("diagnoses"), tests: iso("tests"), findings: iso("findings"), hidden: iso("hidden") },
    complaints,
    diagnoses: await myDiagnoses(db, doctor.id, TOP),
    tests: (tests.rows as Record<string, unknown>[]).map((r) => ({ diagnosis: String(r["diagnosis"]), name: String(r["name"] ?? ""), uses: Number(r["uses"]) })),
    findings: (findings.rows as Record<string, unknown>[]).map((r) => ({ field: String(r["field"]) as LearnedAboutMe["findings"][number]["field"], term: String(r["term"]), uses: Number(r["uses"]) })),
    hidden,
  };
}

/**
 * RESET — the caller's own watermark, now, on the surfaces named. Nothing is deleted; one audit event
 * (`suggestions.learning_reset`) names the doctor and the surfaces. A person only; the actor IS the doctor.
 */
export async function resetLearning(
  db: Db, actor: Actor, doctor: { id: string; userId: string }, surfaces: readonly LearnedSurface[], now: Date = new Date(),
): Promise<{ resetAt: string; surfaces: LearnedSurface[] }> {
  if (actor.type !== "user" || actor.id !== doctor.userId) throw new OpdError("user_actor_required", "a doctor resets their own learning only");
  const wanted = LEARNED_SURFACES.filter((s) => surfaces.includes(s));
  if (wanted.length === 0) throw new OpdError("invalid_config", "name at least one surface to reset");
  await db.transaction(async (tx) => {
    for (const surface of wanted) {
      let baseline: Record<string, number> = {};
      if (surface === "complaints") {
        const usage = await tx.select({ term: opdComplaintTermUsage.term, uses: opdComplaintTermUsage.uses })
          .from(opdComplaintTermUsage).where(eq(opdComplaintTermUsage.doctorId, doctor.id));
        baseline = Object.fromEntries(usage.map((u) => [u.term, u.uses]));
      }
      await tx.insert(cdsDoctorLearningResets).values({ userId: doctor.userId, surface, resetAt: now, complaintBaseline: baseline })
        .onConflictDoUpdate({ target: [cdsDoctorLearningResets.userId, cdsDoctorLearningResets.surface], set: { resetAt: now, complaintBaseline: baseline } });
    }
    await appendEvent(tx, learningReset.make({ actor, payload: { doctorId: doctor.id, surfaces: wanted, resetAt: now.toISOString() } }));
  });
  return { resetAt: now.toISOString(), surfaces: wanted };
}
