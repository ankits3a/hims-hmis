import { and, asc, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdSectionRecords, opdVitals, patients } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { assertLeaseFor, requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visibleEncounterFor } from "./read-gate";
import {
  ageYmd, growthIndicators, immunisationBody, immunisationStatus, mergeImmunisation, pickWeight,
} from "./paeds";
import { IAP_2023_SOURCE } from "./paeds-data/iap-2023-schedule";
import { istDate } from "./time";
import type { AgeYmd, DoseView, GivenDose, ImmunisationRecord, IndicatorResult, Measure, VitalsWeightRow } from "./paeds";
import type { Sex } from "./paeds-data/lms";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE CONSULT ENGINE, FIRST SLICE: SECTIONS AS DATA, CHOSEN BY THE DEPARTMENT (01-CONSULT-ENGINE.md §3, §6.1) ═══
 *
 * A SECTION is a key, a version, a kind and a body schema. A PROFILE is the ordered list of sections
 * a department's consult adds to the base screen. The visit record is `opd_section_records`,
 * append-only, each row stamped with the section version it was filled under (D1, D7).
 *
 * ═══ D19 (DECIDED 2026-09-24, planner) — THE ENGINE STARTS WITH OPHTHALMOLOGY, NOT WITH GENERAL MEDICINE ═══
 *
 * D6 said to re-platform general medicine first and add no specialty until it was proved equal. That
 * puts the doctor's LIVE screen on a new store before anything is gained, and holds the owner's first
 * specialty (ophthalmology, §1) behind it. This slice instead ADDS sections that general medicine
 * does not have, for the departments whose profile names them, and leaves every existing section
 * exactly where it is. D6's own safety rule — the existing consult keeps working throughout — is
 * kept more strictly this way, not less. General medicine moves onto the engine in a later slice.
 *
 * Definitions live in CODE for this slice, versioned by hand: raising a version is a reviewed change,
 * and an old row keeps its own version. The admin's layout builder (board `Profiles`) is a later
 * slice and will move profiles into a table without changing this record's shape.
 */

const EYE = z.string().trim().max(60);
const perEye = z.object({ od: EYE.default(""), os: EYE.default("") }).default({ od: "", os: "" });
const perEyeLong = z.object({ od: z.string().trim().max(160).default(""), os: z.string().trim().max(160).default("") }).default({ od: "", os: "" });

/** The vision tests the optometrist or the doctor records, each eye. Values are the clinic's notation (6/9, N6, CF 1 m…). */
export const VISION_ROWS = ["vaUnaided", "vaGlasses", "vaPinhole", "near", "colour", "autoRefraction", "currentGlasses"] as const;
/** The slit-lamp structures in the order the examination runs, then the fundus. */
export const SLIT_LAMP_ROWS = ["lids", "conjunctiva", "cornea", "anteriorChamber", "iris", "pupil", "lens", "fundus"] as const;
export const IOP_METHODS = ["NCT", "GAT", "iCare", "Tonopen", "Digital"] as const;

/** A lens power in dioptres, in the quarter steps a trial set carries. */
const power = (min: number, max: number) => z.number().min(min).max(max).refine((n) => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9, "a power moves in 0.25 D steps").nullable().default(null);
const lensEye = z.object({
  sph: power(-30, 30), cyl: power(-10, 10),
  axis: z.number().int().min(1).max(180).nullable().default(null),
  add: power(0, 4),
}).refine((e) => e.cyl === null || e.cyl === 0 || e.axis !== null, { message: "a cylinder needs its axis", path: ["axis"] });

/** Who gave the history — a child's history comes from a parent (§6.2). */
export const INFORMANT_RELATIONS = ["mother", "father", "both_parents", "grandparent", "guardian", "self", "other"] as const;
export const DELIVERY_MODES = ["normal_vaginal", "assisted_vaginal", "lscs_elective", "lscs_emergency"] as const;
/** The four developmental domains a paediatric OPD records, each achieved for age or delayed. */
export const MILESTONE_DOMAINS = ["grossMotor", "fineMotor", "language", "social"] as const;
export const FEEDING_MODES = [
  "exclusive_breast", "breast_and_formula", "formula", "complementary_with_breast", "complementary_no_breast", "family_diet",
] as const;
const milestone = z.object({
  status: z.enum(["achieved", "delayed"]).nullable().default(null),
  note: z.string().trim().max(160).default(""),
}).default({ status: null, note: "" });

export const SECTION_DEFS = {
  "eye.vision": {
    version: 1, kind: "eye-grid",
    body: z.object(Object.fromEntries(VISION_ROWS.map((r) => [r, perEye])) as Record<(typeof VISION_ROWS)[number], typeof perEye>),
  },
  "eye.iop": {
    version: 1, kind: "eye-grid",
    body: z.object({
      method: z.enum(IOP_METHODS).nullable().default(null),
      od: z.number().min(0).max(80).nullable().default(null),
      os: z.number().min(0).max(80).nullable().default(null),
    }),
  },
  "eye.slit_lamp": {
    version: 1, kind: "eye-grid",
    body: z.object(Object.fromEntries(SLIT_LAMP_ROWS.map((r) => [r, perEyeLong])) as Record<(typeof SLIT_LAMP_ROWS)[number], typeof perEyeLong>),
  },
  "eye.glasses_rx": {
    version: 1, kind: "lens-grid",
    body: z.object({
      od: lensEye.default({ sph: null, cyl: null, axis: null, add: null }),
      os: lensEye.default({ sph: null, cyl: null, axis: null, add: null }),
      use: z.enum(["distance", "near", "bifocal", "progressive"]).nullable().default(null),
      note: z.string().trim().max(200).default(""),
    }),
  },
  // ——— PAEDIATRICS (§6.2; board `Departments`: "Child screen: age in Y-M-D, growth, vaccines") ———
  "paeds.informant": {
    version: 1, kind: "form",
    body: z.object({
      relation: z.enum(INFORMANT_RELATIONS).nullable().default(null),
      name: z.string().trim().max(80).default(""),
      note: z.string().trim().max(200).default(""),
    }),
  },
  "paeds.growth": {
    version: 1, kind: "growth",
    body: z.object({
      lengthCm: z.number().min(30).max(220).nullable().default(null),
      /** WHO charts lying LENGTH under 2 years and standing HEIGHT from 2; the 0.7 cm between them is applied on read. */
      measure: z.enum(["length", "height"]).nullable().default(null),
      headCircCm: z.number().min(20).max(70).nullable().default(null),
      note: z.string().trim().max(200).default(""),
    }).refine((b) => b.lengthCm === null || b.measure !== null, { message: "say whether the child was measured lying (length) or standing (height)", path: ["measure"] }),
  },
  "paeds.immunisation": { version: 1, kind: "immunisation", body: immunisationBody },
  "paeds.birth": {
    version: 1, kind: "form",
    body: z.object({
      gestationWeeks: z.number().int().min(22).max(44).nullable().default(null),
      birthWeightKg: z.number().min(0.3).max(6.5).nullable().default(null),
      delivery: z.enum(DELIVERY_MODES).nullable().default(null),
      nicu: z.enum(["no", "yes"]).nullable().default(null),
      nicuDays: z.number().int().min(0).max(365).nullable().default(null),
      note: z.string().trim().max(300).default(""),
    }),
  },
  "paeds.milestones": {
    version: 1, kind: "form",
    body: z.object({
      ...(Object.fromEntries(MILESTONE_DOMAINS.map((d) => [d, milestone])) as Record<(typeof MILESTONE_DOMAINS)[number], typeof milestone>),
      note: z.string().trim().max(300).default(""),
    }),
  },
  "paeds.feeding": {
    version: 1, kind: "form",
    body: z.object({
      mode: z.enum(FEEDING_MODES).nullable().default(null),
      complementaryFromMonths: z.number().int().min(0).max(24).nullable().default(null),
      note: z.string().trim().max(300).default(""),
    }),
  },
} as const;
export type SectionKey = keyof typeof SECTION_DEFS;
export const SECTION_KEYS = Object.keys(SECTION_DEFS) as SectionKey[];

/** The department default, by department CODE (the stable one printed on slips). A code with no entry is the base screen. */
export const PROFILES: Record<string, { key: string; sections: SectionKey[] }> = {
  OPH: { key: "ophthalmology", sections: ["eye.vision", "eye.iop", "eye.slit_lamp", "eye.glasses_rx"] },
  PED: { key: "paediatrics", sections: ["paeds.informant", "paeds.growth", "paeds.immunisation", "paeds.birth", "paeds.milestones", "paeds.feeding"] },
};

export type SectionRecordView = {
  sectionKey: SectionKey; sectionVersion: number; body: unknown; authorId: string; at: string; recordId: string;
};
export type VisitSections = {
  /** null — this department's consult has no engine sections (the base screen, unchanged). */
  profile: string | null;
  sections: { key: SectionKey; version: number; kind: string }[];
  records: Partial<Record<SectionKey, SectionRecordView>>;
  /** Present on a paediatric visit only: what the Child tab computes from the child's record. */
  paeds?: PaedsView;
};

export type PaedsView = {
  dob: string | null;
  dobEstimated: boolean;
  /** The WHO standards chart boys and girls; any other recorded sex is charted by neither. */
  sex: Sex | null;
  age: AgeYmd | null;
  /** 18 years or older: no growth chart applies (D2). */
  adult: boolean;
  /** The weight on record — today's vitals, else the last measured one, flagged not today. */
  weight: { kg: number; recordedAt: string; today: boolean; daysAgo: number } | null;
  lengthSource: "section" | "vitals" | null;
  growth: IndicatorResult[];
  /** Null without a date of birth: a timetable counts from it. */
  immunisation: { source: string; today: string; doses: DoseView[] } | null;
};

export async function profileForDepartment(db: Db, departmentId: string | null): Promise<(typeof PROFILES)[string] | null> {
  if (departmentId === null) return null;
  const [d] = await db.select({ code: opdDepartments.code }).from(opdDepartments).where(eq(opdDepartments.id, departmentId));
  return d === undefined ? null : PROFILES[d.code] ?? null;
}

/** The CURRENT row of each section: the one no other row supersedes. */
async function liveRecords(db: Db, encounterId: string): Promise<Partial<Record<SectionKey, SectionRecordView>>> {
  const superseded = db.select({ id: opdSectionRecords.supersedesId }).from(opdSectionRecords)
    .where(and(eq(opdSectionRecords.encounterId, encounterId), sql`${opdSectionRecords.supersedesId} is not null`));
  const rows = await db.select().from(opdSectionRecords)
    .where(and(eq(opdSectionRecords.encounterId, encounterId), notInArray(opdSectionRecords.id, superseded)))
    .orderBy(asc(opdSectionRecords.at));
  const out: Partial<Record<SectionKey, SectionRecordView>> = {};
  for (const r of rows) {
    if (!(r.sectionKey in SECTION_DEFS)) continue;
    out[r.sectionKey as SectionKey] = {
      sectionKey: r.sectionKey as SectionKey, sectionVersion: r.sectionVersion, body: r.body,
      authorId: r.authorId, at: r.at.toISOString(), recordId: r.id,
    };
  }
  return out;
}

/**
 * One section's row on one visit: the exact `recordId` when given (a print names the version it
 * queued), else the CURRENT row — the one nothing supersedes. `undefined` when there is none, or
 * when the id is not this visit's row for this section.
 */
export async function sectionRecord(
  db: Db, encounterId: string, sectionKey: SectionKey, recordId: string | null = null,
): Promise<{ id: string; patientId: string; sectionVersion: number; body: unknown } | undefined> {
  const [row] = await db
    .select({ id: opdSectionRecords.id, patientId: opdSectionRecords.patientId, sectionVersion: opdSectionRecords.sectionVersion, body: opdSectionRecords.body })
    .from(opdSectionRecords)
    .where(and(
      eq(opdSectionRecords.encounterId, encounterId), eq(opdSectionRecords.sectionKey, sectionKey),
      recordId === null
        ? sql`not exists (select 1 from opd_section_records s where s.supersedes_id = ${opdSectionRecords.id})`
        : eq(opdSectionRecords.id, recordId),
    ));
  return row;
}

/**
 * The engine sections this visit's consult shows, and what has been recorded in them. Visibility is
 * the consult's own (`visibleEncounterFor`: sealed patients, break-glass); the read is PHI-logged.
 */
export async function visitSections(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<VisitSections> {
  const visible = await visibleEncounterFor(db, actor, encounterId);
  if (visible === null) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const profile = await profileForDepartment(db, visible.encounter.departmentId);
  await recordPhiAccess(db, {
    actor, patientId: visible.encounter.patientId, surface: "opd.sections", encounterId,
    sealed: visible.sealed, reason: visible.breakGlass?.reason ?? null, now,
  });
  const records = await liveRecords(db, encounterId);
  const out: VisitSections = {
    profile: profile?.key ?? null,
    sections: (profile?.sections ?? []).map((key) => ({ key, version: SECTION_DEFS[key].version, kind: SECTION_DEFS[key].kind })),
    records,
  };
  if (profile?.key === "paediatrics") out.paeds = await paedsView(db, visible.encounter.patientId, encounterId, records, now);
  return out;
}

/** The CURRENT `paeds.immunisation` row of each of the patient's visits (one per visit), with the day it was written. */
async function immunisationRows(db: Db | Tx, patientId: string): Promise<{ encounterId: string; at: Date; body: ImmunisationRecord }[]> {
  const rows = await db.select({ encounterId: opdSectionRecords.encounterId, at: opdSectionRecords.at, body: opdSectionRecords.body })
    .from(opdSectionRecords)
    .where(and(
      eq(opdSectionRecords.patientId, patientId), eq(opdSectionRecords.sectionKey, "paeds.immunisation"),
      sql`not exists (select 1 from opd_section_records s where s.supersedes_id = ${opdSectionRecords.id})`,
    ));
  return rows.map((r) => ({ encounterId: r.encounterId, at: r.at, body: immunisationBody.parse(r.body) as ImmunisationRecord }));
}

/** Every dose on record for the child: given on a visit here (today's or an earlier one's), or earlier by the card. */
function givenDoses(rows: Awaited<ReturnType<typeof immunisationRows>>, encounterId: string | null): GivenDose[] {
  const out: GivenDose[] = [];
  for (const r of rows) {
    const on = istDate(r.at);
    for (const g of r.body.givenToday) if (g.errorReason === null) out.push({ dose: g.dose, on, where: r.encounterId === encounterId ? "today" : "here" });
    for (const e of r.body.earlier) out.push({ dose: e.dose, on: e.on, where: "earlier" });
  }
  return out;
}

/**
 * THE CHILD TAB'S READ (§6.2). The patient's date of birth and sex, the vitals the desk recorded
 * (today's weight; the last measured one, flagged, when today has none), the Child tab's own
 * length and head circumference, and every visit's immunisation record.
 */
async function paedsView(
  db: Db, patientId: string, encounterId: string, records: Partial<Record<SectionKey, SectionRecordView>>, now: Date,
): Promise<PaedsView> {
  const [pt] = await db.select({ dob: patients.dob, dobEstimated: patients.dobEstimated, gender: patients.administrativeGender })
    .from(patients).where(eq(patients.id, patientId));
  const dob = pt?.dob ?? null;
  const sex: Sex | null = pt?.gender === "male" ? "boy" : pt?.gender === "female" ? "girl" : null;
  const age = dob === null ? null : ageYmd(dob, now);
  const vitals: VitalsWeightRow[] = (await db.select({
    encounterId: opdVitals.encounterId, weightKg: opdVitals.weightKg, heightCm: opdVitals.heightCm,
    carriedForward: opdVitals.carriedForward, recordedAt: opdVitals.recordedAt,
  }).from(opdVitals)
    .where(and(eq(opdVitals.patientId, patientId), eq(opdVitals.status, "active"), isNotNull(opdVitals.weightKg)))
    .orderBy(desc(opdVitals.recordedAt)).limit(20))
    .map((v) => ({ ...v, carriedForward: Array.isArray(v.carriedForward) ? (v.carriedForward as string[]) : [] }));
  const picked = pickWeight(vitals, encounterId, now);
  const growthBody = records["paeds.growth"]?.body as { lengthCm: number | null; measure: Measure | null; headCircCm: number | null } | undefined;
  const sectionLength = growthBody?.lengthCm ?? null;
  const lengthCm = sectionLength ?? picked.heightTodayCm;
  const ageDays = age?.totalDays ?? 0;
  const weightAgeDays = picked.weight === null || dob === null ? 0 : ageYmd(dob, new Date(picked.weight.recordedAt)).totalDays;
  const growth = age === null ? [] : growthIndicators({
    sex, ageDays, dobEstimated: pt?.dobEstimated ?? false,
    weight: picked.weight === null ? null : { kg: picked.weight.kg, ageDays: weightAgeDays, today: picked.weight.today },
    lengthCm,
    // A desk height carries no method: under 2 years it is taken as the length the WHO charts, from 2 the height.
    measure: sectionLength !== null ? (growthBody?.measure ?? null) : null,
    headCircCm: growthBody?.headCircCm ?? null,
  });
  const today = istDate(now);
  return {
    dob: dob === null ? null : dob.toISOString().slice(0, 10), dobEstimated: pt?.dobEstimated ?? false, sex, age,
    adult: age !== null && age.years >= 18,
    weight: picked.weight,
    lengthSource: sectionLength !== null ? "section" : picked.heightTodayCm !== null ? "vitals" : null,
    growth,
    immunisation: dob === null ? null : {
      source: IAP_2023_SOURCE, today,
      doses: immunisationStatus(dob.toISOString().slice(0, 10), today, givenDoses(await immunisationRows(db, patientId), encounterId)),
    },
  };
}

/**
 * Save one section of one visit: a NEW row that supersedes the current one (D7). The consult note's
 * own guards — the treating doctor, an open consultation, the edit lease (D17) — and the section must
 * be one this visit's profile shows, so a general-medicine visit cannot collect an eye grid by URL.
 */
export async function saveVisitSection(
  db: Db, actor: Actor, encounterId: string, sectionKey: string, input: { body: unknown; leaseToken?: string | null },
  now: Date = new Date(),
): Promise<SectionRecordView> {
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, enc);
  if (enc.status !== "in_consultation") throw new OpdError("encounter_state_conflict", `a section is recorded in_consultation, not ${enc.status}`);
  assertLeaseFor(enc, input.leaseToken ?? undefined, now);
  const profile = await profileForDepartment(db, enc.departmentId);
  if (profile === null || !(profile.sections as string[]).includes(sectionKey)) {
    throw new OpdError("section_not_in_profile", `section ${sectionKey} is not on this department's consult`);
  }
  const key = sectionKey as SectionKey;
  const def = SECTION_DEFS[key];
  const parsed = (def.body as z.ZodTypeAny).safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new OpdError("invalid_section_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  let body = parsed.data as Record<string, unknown>;
  return withTx(db, async (tx) => {
    const [current] = await tx.select({ id: opdSectionRecords.id, body: opdSectionRecords.body }).from(opdSectionRecords)
      .where(and(
        eq(opdSectionRecords.encounterId, encounterId), eq(opdSectionRecords.sectionKey, key),
        sql`not exists (select 1 from opd_section_records s where s.supersedes_id = ${opdSectionRecords.id})`,
      ));
    if (key === "paeds.immunisation") {
      // "Given today" is append-only (paeds.ts `mergeImmunisation`), and a dose on the child's other visits is not given twice.
      const others = (await immunisationRows(tx, enc.patientId)).filter((r) => r.encounterId !== encounterId);
      const elsewhere = new Set(givenDoses(others, null).map((g) => g.dose));
      body = mergeImmunisation(current === undefined ? null : (immunisationBody.parse(current.body) as ImmunisationRecord), input.body as never, elsewhere, newId);
    }
    const id = newId();
    try {
      await tx.insert(opdSectionRecords).values({
        id, encounterId, patientId: enc.patientId, sectionKey: key, sectionVersion: def.version,
        body, source: "typed", authorId: actor.id, at: now,
        supersedesId: current?.id ?? null,
      });
    } catch (e) {
      // The two partial unique indexes: a concurrent save got there first. Re-read and retry is the caller's move.
      if (String((e as { code?: unknown }).code ?? "") === "23505") throw new OpdError("encounter_state_conflict", "this section was saved concurrently; reload it");
      throw e;
    }
    return { sectionKey: key, sectionVersion: def.version, body, authorId: actor.id, at: now.toISOString(), recordId: id };
  });
}
