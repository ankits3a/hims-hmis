import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdSectionRecords } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { assertLeaseFor, requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visibleEncounterFor } from "./read-gate";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

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
} as const;
export type SectionKey = keyof typeof SECTION_DEFS;
export const SECTION_KEYS = Object.keys(SECTION_DEFS) as SectionKey[];

/** The department default, by department CODE (the stable one printed on slips). A code with no entry is the base screen. */
export const PROFILES: Record<string, { key: string; sections: SectionKey[] }> = {
  OPH: { key: "ophthalmology", sections: ["eye.vision", "eye.iop", "eye.slit_lamp", "eye.glasses_rx"] },
};

export type SectionRecordView = {
  sectionKey: SectionKey; sectionVersion: number; body: unknown; authorId: string; at: string; recordId: string;
};
export type VisitSections = {
  /** null — this department's consult has no engine sections (the base screen, unchanged). */
  profile: string | null;
  sections: { key: SectionKey; version: number; kind: string }[];
  records: Partial<Record<SectionKey, SectionRecordView>>;
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
  return {
    profile: profile?.key ?? null,
    sections: (profile?.sections ?? []).map((key) => ({ key, version: SECTION_DEFS[key].version, kind: SECTION_DEFS[key].kind })),
    records: await liveRecords(db, encounterId),
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
  return withTx(db, async (tx) => {
    const [current] = await tx.select({ id: opdSectionRecords.id }).from(opdSectionRecords)
      .where(and(
        eq(opdSectionRecords.encounterId, encounterId), eq(opdSectionRecords.sectionKey, key),
        sql`not exists (select 1 from opd_section_records s where s.supersedes_id = ${opdSectionRecords.id})`,
      ));
    const id = newId();
    try {
      await tx.insert(opdSectionRecords).values({
        id, encounterId, patientId: enc.patientId, sectionKey: key, sectionVersion: def.version,
        body: parsed.data as Record<string, unknown>, source: "typed", authorId: actor.id, at: now,
        supersedesId: current?.id ?? null,
      });
    } catch (e) {
      // The two partial unique indexes: a concurrent save got there first. Re-read and retry is the caller's move.
      if (String((e as { code?: unknown }).code ?? "") === "23505") throw new OpdError("encounter_state_conflict", "this section was saved concurrently; reload it");
      throw e;
    }
    return { sectionKey: key, sectionVersion: def.version, body: parsed.data, authorId: actor.id, at: now.toISOString(), recordId: id };
  });
}
