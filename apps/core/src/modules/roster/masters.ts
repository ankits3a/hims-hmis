import { eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { opdDepartments, orgDepartments, roles, rosterPositions } from "../../kernel/db/schema";
import type { OrgDepartmentKind } from "../../kernel/db/schema/org";
import type { RosterCadre } from "../../kernel/db/schema/roster";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PHASE R (R1) — **THE TWO MASTER LISTS, AND THE SEEDS THAT PUT THEM THERE.**
 *
 * Both are `onConflictDoNothing` and both are re-runnable: a deploy runs `seed:roster` every time
 * and an existing row is never overwritten, because by the time a second deploy happens a human has
 * edited some of these (a department renamed, a position deactivated) and a seed that "corrected"
 * them would be a seed that silently undid somebody's decision. The `seed:opd` posture, same reason.
 */

/* ═══════════════════════════════ DEPARTMENTS ═══════════════════════════════ */

export type OrgDepartmentSeed = {
  readonly code: string;
  readonly name: string;
  readonly kind: OrgDepartmentKind;
  readonly admitting: boolean;
  /** The `opd_departments.code` this department runs the clinic of, when it runs one. */
  readonly opdCode?: string;
};

/**
 * THE HOSPITAL, AS AN ORGANISATION. Twelve of these are the OPD's own twelve, linked by code; the
 * rest are the departments that roster people and never give out a token.
 *
 * ═══ RESPIRATORY MEDICINE IS HERE AND IT IS NOT IN THE PLAN'S LIST — a kickoff finding ═══
 *
 * Plan §0 rules the unit establishment is `5/5/3/3/4/2/2/1/1` **plus Respiratory Medicine as its own
 * one-unit department** (owner RU-1), which is 27 units — and R3 seeds 27 units *"one per department
 * per §0"*. The plan's §2.1 department list names eleven non-OPD departments and Respiratory Medicine
 * is not among them, so R3 would have had 26 departments to hang 27 units on. Added here, where the
 * masters are, rather than discovered by R3 with a migration already written. (20-U §2 records why it
 * is easy to miss: UG-MSR 2023's final table has no Respiratory row at all — its faculty are counted
 * under Medicine, FAQ Q8 — and the unit is nonetheless real and sanctioned.)
 */
export const ORG_DEPARTMENTS: readonly OrgDepartmentSeed[] = [
  // ── the twelve that run an OPD clinic (modules/opd/config.ts DEFAULT_DEPARTMENTS) ──
  { code: "MED", name: "General Medicine", kind: "clinical", admitting: true, opdCode: "MED" },
  { code: "SUR", name: "General Surgery", kind: "clinical", admitting: true, opdCode: "SUR" },
  { code: "PED", name: "Paediatrics", kind: "clinical", admitting: true, opdCode: "PED" },
  { code: "OBG", name: "Obstetrics & Gynaecology", kind: "clinical", admitting: true, opdCode: "OBG" },
  { code: "ORT", name: "Orthopaedics", kind: "clinical", admitting: true, opdCode: "ORT" },
  { code: "ENT", name: "ENT", kind: "clinical", admitting: true, opdCode: "ENT" },
  { code: "OPH", name: "Ophthalmology", kind: "clinical", admitting: true, opdCode: "OPH" },
  { code: "DER", name: "Dermatology", kind: "clinical", admitting: false, opdCode: "DER" },
  { code: "PSY", name: "Psychiatry", kind: "clinical", admitting: true, opdCode: "PSY" },
  { code: "CAR", name: "Cardiology", kind: "clinical", admitting: true, opdCode: "CAR" },
  { code: "DEN", name: "Dental", kind: "clinical", admitting: false, opdCode: "DEN" },
  { code: "PHY", name: "Physiotherapy", kind: "support", admitting: false, opdCode: "PHY" },

  // ── the sanctioned unit-bearing department with no clinic row of its own (see the note above) ──
  { code: "RESP", name: "Respiratory Medicine", kind: "clinical", admitting: true },

  // ── clinical, and never a token: the theatre and the emergency room ──
  { code: "ANAE", name: "Anaesthesiology", kind: "clinical", admitting: false },
  { code: "CAS", name: "Casualty", kind: "clinical", admitting: true },

  // ── para-clinical: NMC's own word, and the division the returns are filed in ──
  { code: "RAD", name: "Radiodiagnosis", kind: "para_clinical", admitting: false },
  { code: "PATH", name: "Pathology", kind: "para_clinical", admitting: false },
  { code: "MICR", name: "Microbiology", kind: "para_clinical", admitting: false },
  { code: "BIOC", name: "Biochemistry", kind: "para_clinical", admitting: false },
  { code: "COMM", name: "Community Medicine", kind: "para_clinical", admitting: false },
  { code: "FMT", name: "Forensic Medicine", kind: "para_clinical", admitting: false },

  // ── the rest of the payroll, every one of which is rostered ──
  { code: "NURS", name: "Nursing", kind: "nursing", admitting: false },
  { code: "PHAR", name: "Pharmacy", kind: "support", admitting: false },
  { code: "ADMN", name: "Administration", kind: "admin", admitting: false },
];

/* ═══════════════════════════════ POSITIONS ═══════════════════════════════ */

export type RosterPositionSeed = {
  readonly key: string;
  readonly label: string;
  readonly cadre: RosterCadre;
  readonly ladderRank: number;
  /** The RBAC role a person must already hold. NULL where this software has no such role yet. */
  readonly eligibleRoleKey: string | null;
  readonly defaultMode: "presence" | "call";
  readonly maxPresenceHours: number;
  readonly countsTowardRequirements?: boolean;
};

/**
 * WHAT THIS HOSPITAL ROSTERS PEOPLE AS. Seventeen, exactly the plan's §2.1 list.
 *
 * ═══ THE NULLS ARE NOT OVERSIGHTS ═══
 *
 * `intern` has no eligible role because a CRMI intern is *pre-registration*: they are not a
 * registered medical practitioner and this software's `doctor` role is. The three nursing positions
 * have none because there is no general `nurse` role in the model yet — `ot_nurse` and
 * `recovery_nurse` are two theatre seats, not a cadre — and inventing one here would be
 * `kernel/auth` work, which this plan freezes (§5). Phase N seeds them with their rows.
 *
 * ═══ `intern` IS THE ONE THAT DOES NOT COUNT ═══
 *
 * UG-MSR's unit floor is *"at least two Junior Residents or postgraduates / M.O.s"*. An intern is
 * neither, so an intern in the slot leaves the hole open: `counts_toward_requirements` is false, and
 * that is the fact V16 (a supernumerary slot never satisfies a requirement) is tested against.
 */
export const ROSTER_POSITIONS: readonly RosterPositionSeed[] = [
  { key: "intern", label: "Intern", cadre: "intern", ladderRank: 1, eligibleRoleKey: null, defaultMode: "presence", maxPresenceHours: 24, countsTowardRequirements: false },
  { key: "ward_jr", label: "Ward junior resident", cadre: "junior_resident", ladderRank: 2, eligibleRoleKey: "doctor", defaultMode: "presence", maxPresenceHours: 24 },
  { key: "night_jr_pool", label: "Night junior resident (department pool)", cadre: "junior_resident", ladderRank: 2, eligibleRoleKey: "doctor", defaultMode: "presence", maxPresenceHours: 12 },
  { key: "casualty_mo", label: "Casualty medical officer", cadre: "medical_officer", ladderRank: 2, eligibleRoleKey: "doctor", defaultMode: "presence", maxPresenceHours: 12 },
  { key: "blood_bank_mo", label: "Blood bank medical officer", cadre: "medical_officer", ladderRank: 2, eligibleRoleKey: "doctor", defaultMode: "call", maxPresenceHours: 12 },
  { key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3, eligibleRoleKey: "doctor", defaultMode: "presence", maxPresenceHours: 24 },
  { key: "night_sr_pool", label: "Night senior resident (department pool)", cadre: "senior_resident", ladderRank: 3, eligibleRoleKey: "doctor", defaultMode: "presence", maxPresenceHours: 12 },
  { key: "duty_manager", label: "Duty manager", cadre: "admin", ladderRank: 3, eligibleRoleKey: "duty_manager", defaultMode: "presence", maxPresenceHours: 12 },
  { key: "radiologist_on_call", label: "Radiologist on call", cadre: "faculty", ladderRank: 3, eligibleRoleKey: "radiologist", defaultMode: "call", maxPresenceHours: 12 },
  { key: "pathologist_on_call", label: "Pathologist on call", cadre: "faculty", ladderRank: 3, eligibleRoleKey: "pathologist", defaultMode: "call", maxPresenceHours: 12 },
  { key: "anaesthetist_on_call", label: "Anaesthetist on call", cadre: "faculty", ladderRank: 3, eligibleRoleKey: "anaesthetist", defaultMode: "call", maxPresenceHours: 24 },
  { key: "faculty_on_call", label: "Faculty on call", cadre: "faculty", ladderRank: 4, eligibleRoleKey: "doctor", defaultMode: "call", maxPresenceHours: 12 },
  { key: "unit_head", label: "Unit head", cadre: "faculty", ladderRank: 5, eligibleRoleKey: "doctor", defaultMode: "call", maxPresenceHours: 12 },
  { key: "pharmacist_counter", label: "Pharmacist at the counter", cadre: "pharmacist", ladderRank: 1, eligibleRoleKey: "pharmacy", defaultMode: "presence", maxPresenceHours: 12 },
  { key: "staff_nurse", label: "Staff nurse", cadre: "nurse", ladderRank: 1, eligibleRoleKey: null, defaultMode: "presence", maxPresenceHours: 12 },
  { key: "ward_incharge", label: "Ward in-charge", cadre: "nurse", ladderRank: 2, eligibleRoleKey: null, defaultMode: "presence", maxPresenceHours: 12 },
  { key: "night_nursing_supervisor", label: "Night nursing supervisor", cadre: "nurse", ladderRank: 3, eligibleRoleKey: null, defaultMode: "presence", maxPresenceHours: 12 },
];

/* ═══════════════════════════════ THE SEEDS ═══════════════════════════════ */

export type SeedCount = { readonly added: number; readonly present: number };

/**
 * Links each seeded department to its OPD clinic BY CODE, resolved at seed time — the ids are ULIDs
 * minted by whoever ran `seed:opd`, so a hard-coded link would be wrong on every install but the
 * one it was written on. A missing OPD row is not an error: the link is optional and `standup:check`
 * is where an unlinked clinic is reported.
 */
export async function seedOrgDepartments(exec: Db | Tx, by = "seed"): Promise<SeedCount> {
  const clinics = await (exec as Db).select({ id: opdDepartments.id, code: opdDepartments.code }).from(opdDepartments);
  const byCode = new Map(clinics.map((c) => [c.code.toUpperCase(), c.id]));

  let added = 0;
  for (const d of ORG_DEPARTMENTS) {
    const inserted = await (exec as Db)
      .insert(orgDepartments)
      .values({
        id: newId(),
        code: d.code,
        name: d.name,
        kind: d.kind,
        admitting: d.admitting,
        opdDepartmentId: d.opdCode === undefined ? null : byCode.get(d.opdCode.toUpperCase()) ?? null,
        createdBy: by,
        updatedBy: by,
      })
      .onConflictDoNothing()
      .returning({ id: orgDepartments.id });
    added += inserted.length;
  }
  return { added, present: ORG_DEPARTMENTS.length - added };
}

/**
 * Refuses BEFORE the first write when a referenced RBAC role is missing, rather than letting the
 * foreign key fail somewhere in the middle of seventeen inserts and leaving the list half seeded.
 * The message names `seed:roles` because that is the fix, every time.
 */
export async function seedRosterPositions(exec: Db | Tx, by = "seed"): Promise<SeedCount> {
  const wanted = [...new Set(ROSTER_POSITIONS.map((p) => p.eligibleRoleKey).filter((k): k is string => k !== null))];
  const found = await (exec as Db).select({ key: roles.key }).from(roles).where(inArray(roles.key, wanted));
  const missing = wanted.filter((k) => !found.some((r) => r.key === k));
  if (missing.length > 0) {
    throw new Error(
      `roster positions name ${missing.length} role(s) that do not exist: ${missing.join(", ")} — run \`pnpm --filter @hmis/core seed:roles\` first`,
    );
  }

  let added = 0;
  for (const p of ROSTER_POSITIONS) {
    const inserted = await (exec as Db)
      .insert(rosterPositions)
      .values({
        key: p.key,
        label: p.label,
        cadre: p.cadre,
        ladderRank: p.ladderRank,
        eligibleRoleKey: p.eligibleRoleKey,
        defaultMode: p.defaultMode,
        maxPresenceHours: p.maxPresenceHours,
        countsTowardRequirements: p.countsTowardRequirements ?? true,
        createdBy: by,
        updatedBy: by,
      })
      .onConflictDoNothing()
      .returning({ key: rosterPositions.key });
    added += inserted.length;
  }
  return { added, present: ROSTER_POSITIONS.length - added };
}

/* ═══════════════════════════════ READS ═══════════════════════════════ */

export type OrgDepartmentRow = typeof orgDepartments.$inferSelect;

export async function listOrgDepartments(
  exec: Db | Tx, opts: { activeOnly?: boolean } = {},
): Promise<OrgDepartmentRow[]> {
  const rows = await (exec as Db).select().from(orgDepartments).orderBy(orgDepartments.code);
  return opts.activeOnly === true ? rows.filter((r) => r.active) : rows;
}

export async function orgDepartmentByCode(exec: Db | Tx, code: string): Promise<OrgDepartmentRow | undefined> {
  const [row] = await (exec as Db).select().from(orgDepartments).where(eq(orgDepartments.code, code)).limit(1);
  return row;
}

export type RosterPositionRow = typeof rosterPositions.$inferSelect;

export async function listRosterPositions(
  exec: Db | Tx, opts: { activeOnly?: boolean } = {},
): Promise<RosterPositionRow[]> {
  const rows = await (exec as Db)
    .select().from(rosterPositions)
    .orderBy(rosterPositions.ladderRank, rosterPositions.key);
  return opts.activeOnly === true ? rows.filter((r) => r.active) : rows;
}

/** How many master rows exist, for the census — one query, no rows pulled back. */
export async function rosterMasterCounts(exec: Db | Tx): Promise<{ departments: number; positions: number }> {
  const [d] = await (exec as Db).select({ n: sql<number>`count(*)::int` }).from(orgDepartments);
  const [p] = await (exec as Db).select({ n: sql<number>`count(*)::int` }).from(rosterPositions);
  return { departments: d?.n ?? 0, positions: p?.n ?? 0 };
}
