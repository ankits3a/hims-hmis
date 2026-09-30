import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { imagingSafetyScreenings, imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { resources } from "../../kernel/db/schema/resources";
import { roleAssignments, users } from "../../kernel/db/schema/auth";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName, guardiansWithAuthority, listAllergies } from "../patients";
import { latestVerifiedCreatinine } from "../lab";
import { lastActiveVitals } from "../opd";
import { ageInYearsOn } from "./applicability";
import { contrastAdministrationsFor } from "./contrast";
import { contrastReactionsFor } from "./reactions";
import {
  IV_HYDRATION_INSTRUCTION, METFORMIN_NOTE, assessEgfr,
} from "./egfr";
import {
  IMAGING_TERMINAL_GATE_STATES, NEVER_OVERRIDABLE_KINDS, NEVER_WAIVABLE_KINDS, RENAL_CREATININE_CEILING_UMOL_L,
  RENAL_VALIDITY_DAYS_ADMITTED, RENAL_VALIDITY_DAYS_OPD, isContrastAllergen, studyGates,
} from "./gates";
import { gateOverrideRequests } from "./override-requests";
import { clearanceOf } from "./read";
import { RadiologyError } from "./errors";
import { requireStudyType } from "./study-types";
import type { EgfrAssessment } from "./egfr";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ImagingGateKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18-S RS5 T3 — **THE PREP & SAFETY BAY's two reads: the bay's list, and the patient in hand.**
 *
 * ═══ ROOM GATES AND PREP GATES (plan Gap 4) — A UI ROUTING RULE, THE GATE MODEL UNCHANGED ═══
 *
 * The approved board closes `identity_two_factor` and `laterality_confirm` at the CONSOLE — the
 * wristband is checked and the side asked with the patient on the table — and every other gate in
 * the bay. The code still treats all ten alike (anyone holding `radiology.gates.satisfy` may clear
 * any of them); this file only says which is which, so the bay lists a study while a PREP gate is
 * open and shows the two room gates as "closed at the console".
 *
 * ═══ WHAT THE BAY READS, AND FROM WHERE ═══
 *
 *   · allergies — `patients`' `listAllergies`, the same book `prior_contrast_reaction` reads;
 *   · weight — the latest active OPD vitals (`opd`'s `lastActiveVitals`), for the contrast volume;
 *   · creatinine — the lab's latest SIGNED serum creatinine (`lab`'s `latestVerifiedCreatinine`),
 *     with the eGFR computed here by the same `assessEgfr` the gate uses, so the number the nurse
 *     reads and the lane the gate takes cannot disagree;
 *   · LMP — only from this study's own pregnancy gate evidence; nothing else in the building
 *     records one;
 *   · guardians — `guardiansWithAuthority`, for a guardian-signed contrast consent;
 *   · staff — the imaging department's people (radiologists, radiographers, radiology nurses) for
 *     the chaperone and "which radiologist decided" pickers. Ids, names and roles only.
 *
 * One PHI row per patient per read, under the surfaces the other imaging reads use.
 */

/** Closed at the console with the patient on the table (the board's rule). */
export const ROOM_GATE_KINDS: readonly ImagingGateKind[] = ["identity_two_factor", "laterality_confirm"];

export const isRoomGate = (kind: string): boolean => (ROOM_GATE_KINDS as readonly string[]).includes(kind);

const isTerminal = (state: string): boolean => (IMAGING_TERMINAL_GATE_STATES as readonly string[]).includes(state);

/** The roles whose holders appear in the bay's pickers. */
export const IMAGING_STAFF_ROLES = ["radiologist", "radiographer", "radiology_nurse"] as const;

export type PrepBayRow = {
  studyId: string; accessionNo: string; priority: string; studyTypeCode: string;
  scheduledAt: Date | null; checkedInAt: Date | null; deviceCode: string | null;
  patientId: string; patientName: string; restricted: boolean;
  /** Open gates the bay closes. */
  openPrep: string[];
  /** Open gates the console closes (identity, side) — shown, never acted on here. */
  openRoom: string[];
  /** Open prep gates the radiologist has been asked to override and has not answered. */
  asked: string[];
};

/**
 * Checked-in studies with at least one open PREP gate, STAT first, then urgent, then by slot. A study
 * whose only open gates are the room's is not the bay's — it goes to the room.
 */
export async function prepBayList(db: Db, actor: Actor): Promise<PrepBayRow[]> {
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo, priority: imagingStudies.priority,
      studyTypeCode: imagingStudies.studyTypeCode, scheduledAt: imagingStudies.scheduledAt,
      checkedInAt: imagingStudies.checkedInAt, deviceCode: resources.code, patientId: imagingStudies.patientId,
      restricted: orderItems.restricted, name: patients.name, alias: patients.alias,
      isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(resources, eq(resources.id, imagingStudies.deviceResourceId))
    .where(eq(imagingStudies.status, "checked_in"))
    .orderBy(
      sql`case when ${imagingStudies.priority} = 'stat' then 0 when ${imagingStudies.priority} = 'urgent' then 1 else 2 end`,
      asc(imagingStudies.scheduledAt),
    )
    .limit(200);
  if (rows.length === 0) return [];

  const gates = await db.execute(sql`
    select g.study_id as "studyId", g.id as "gateId", g.kind as "kind", w.current_state as "state"
      from imaging_safety_screenings g
      join workflow_instances w on w.id = g.workflow_instance_id
     where g.study_id in (${sql.join(rows.map((r) => sql`${r.studyId}`), sql`, `)})
  `);
  const gateRows = gates.rows as { studyId: string; gateId: string; kind: string; state: string }[];
  const askedGateIds = new Set((await db.execute(sql`
    select subject_id as "gateId" from approvals
     where type_key = 'imaging_gate_override' and subject_type = 'imaging_gate' and status = 'pending'
       and subject_id in (${sql.join(gateRows.map((g) => sql`${g.gateId}`), sql`, `)})
  `)).rows.map((r) => (r as { gateId: string }).gateId));

  const out: PrepBayRow[] = [];
  for (const r of rows) {
    const mine = gateRows.filter((g) => g.studyId === r.studyId && !isTerminal(g.state));
    const openPrep = mine.filter((g) => !isRoomGate(g.kind)).map((g) => g.kind).sort();
    if (openPrep.length === 0) continue;
    out.push({
      studyId: r.studyId, accessionNo: r.accessionNo, priority: r.priority, studyTypeCode: r.studyTypeCode,
      scheduledAt: r.scheduledAt, checkedInAt: r.checkedInAt, deviceCode: r.deviceCode, patientId: r.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
      restricted: r.restricted, openPrep,
      openRoom: mine.filter((g) => isRoomGate(g.kind)).map((g) => g.kind).sort(),
      asked: mine.filter((g) => askedGateIds.has(g.gateId)).map((g) => g.kind).sort(),
    });
  }
  const reason = `imaging prep bay, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return out;
}

export type PrepGate = {
  id: string; kind: string; state: string; waivable: boolean;
  room: boolean; neverWaive: boolean; neverOverride: boolean;
  evidence: unknown; satisfiedAt: Date | null; override: unknown;
  asked: { approvalId: string; note: string | null; requestedAt: Date; requesterName: string | null } | null;
};

export type PrepStudyView = {
  study: {
    studyId: string; accessionNo: string; status: string; priority: string; studyTypeCode: string;
    studyTypeName: string; modality: string; ionising: boolean; contrastOption: string;
    laterality: string; lateralityApplicable: boolean; encounterNo: string;
    scheduledAt: Date | null; deviceCode: string | null; formFRequired: boolean;
  };
  patient: {
    id: string; name: string; uhid: string; sex: string; dob: string | null; ageYears: number | null;
  };
  allergies: { substance: string; severity: string | null; reaction: string | null; contrast: boolean }[];
  weight: { kg: number; recordedAt: Date } | null;
  kidney: {
    creatinine: { resultId: string; umolL: number; reported: { value: string; unit: string | null }; sampledAt: Date } | null;
    egfr: EgfrAssessment | null;
    validDays: number;
    ceilingUmolL: number;
    hydrationInstruction: string;
    metforminNote: string;
  };
  lmpDate: string | null;
  gates: PrepGate[];
  guardians: { guardianId: string; name: string; relationship: string; consents: boolean }[];
  staff: { id: string; name: string; roles: string[] }[];
  contrast: {
    administrations: Awaited<ReturnType<typeof contrastAdministrationsFor>>;
    reactions: Awaited<ReturnType<typeof contrastReactionsFor>>;
  };
};

/** The patient in hand. `null` for an unknown study (the controller answers 404). */
export async function prepStudyView(
  db: Db, actor: Actor, studyId: string, now: Date = new Date(),
): Promise<PrepStudyView> {
  const clearance = await clearanceOf(db, actor);
  const row = (await db.select({
    study: imagingStudies, deviceCode: resources.code,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    uhid: patients.uhid, sex: patients.sex, dob: patients.dob,
  })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(resources, eq(resources.id, imagingStudies.deviceResourceId))
    .where(eq(imagingStudies.id, studyId)))[0];
  if (!row) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  const s = row.study;
  const type = await requireStudyType(db, s.studyTypeCode);

  await recordPhiAccess(db, {
    actor, patientId: s.patientId, surface: "imaging.study", encounterId: s.encounterNo,
    reason: `imaging prep bay for ${s.accessionNo}`,
  });

  const ageYears = row.dob === null ? null : ageInYearsOn(row.dob, now);
  const allergies = (await listAllergies(db, s.patientId)).filter((a) => a.status === "active");
  const vitals = await lastActiveVitals(db, s.patientId);
  const crea = await latestVerifiedCreatinine(db, s.patientId);

  const gateList = await studyGates(db, studyId);
  const detail = gateList.length === 0 ? [] : await db.select({
    id: imagingSafetyScreenings.id, evidence: imagingSafetyScreenings.evidence,
    satisfiedAt: imagingSafetyScreenings.satisfiedAt, override: imagingSafetyScreenings.override,
  }).from(imagingSafetyScreenings).where(inArray(imagingSafetyScreenings.id, gateList.map((g) => g.id)));
  const detailOf = new Map(detail.map((d) => [d.id, d] as const));
  const pending = await gateOverrideRequests(db, actor, { studyId });
  const gates: PrepGate[] = gateList.map((g) => {
    const d = detailOf.get(g.id);
    const ask = pending.find((p) => p.kind === g.kind);
    return {
      id: g.id, kind: g.kind, state: g.state, waivable: g.waivable, room: isRoomGate(g.kind),
      neverWaive: (NEVER_WAIVABLE_KINDS as readonly string[]).includes(g.kind),
      neverOverride: (NEVER_OVERRIDABLE_KINDS as readonly string[]).includes(g.kind),
      evidence: d?.evidence ?? null, satisfiedAt: d?.satisfiedAt ?? null, override: d?.override ?? null,
      asked: ask === undefined ? null : {
        approvalId: ask.approvalId, note: ask.note, requestedAt: ask.requestedAt, requesterName: ask.requesterName,
      },
    };
  });
  const pregnancyEvidence = gates.find((g) => g.kind === "pregnancy_screen")?.evidence as { lmpDate?: string } | null | undefined;

  const guardians = (await guardiansWithAuthority(db, s.patientId, now)).map((g) => ({
    guardianId: g.guardianId, name: g.name, relationship: g.relationship, consents: g.authority.consents,
  }));

  const staffRows = await db.select({ id: users.id, name: users.fullName, role: roleAssignments.roleKey, active: users.active })
    .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(inArray(roleAssignments.roleKey, [...IMAGING_STAFF_ROLES])));
  const staffMap = new Map<string, { id: string; name: string; roles: string[] }>();
  for (const r of staffRows) {
    if (r.active === false) continue;
    const e = staffMap.get(r.id) ?? { id: r.id, name: r.name, roles: [] };
    if (!e.roles.includes(r.role)) e.roles.push(r.role);
    staffMap.set(r.id, e);
  }

  return {
    study: {
      studyId: s.id, accessionNo: s.accessionNo, status: s.status, priority: s.priority,
      studyTypeCode: s.studyTypeCode, studyTypeName: type.name, modality: type.modality,
      ionising: type.ionising, contrastOption: type.contrast_option, laterality: s.laterality,
      lateralityApplicable: type.laterality_applicable, encounterNo: s.encounterNo,
      scheduledAt: s.scheduledAt, deviceCode: row.deviceCode, formFRequired: s.formFRequired,
    },
    patient: {
      id: s.patientId,
      name: displayName({ name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential),
      uhid: row.uhid, sex: row.sex, dob: row.dob === null ? null : row.dob.toISOString().slice(0, 10), ageYears,
    },
    allergies: allergies.map((a) => ({
      substance: a.substance, severity: a.severity, reaction: a.reaction, contrast: isContrastAllergen(a.substance),
    })),
    weight: vitals?.weightKg == null ? null : { kg: vitals.weightKg, recordedAt: vitals.recordedAt },
    kidney: {
      creatinine: crea === null ? null : {
        resultId: crea.resultId, umolL: crea.valueUmolL, reported: crea.reported, sampledAt: crea.sampledAt,
      },
      egfr: crea === null ? null : assessEgfr(crea.valueUmolL, { sex: row.sex, ageYears }),
      validDays: s.encounterNo.startsWith("V") ? RENAL_VALIDITY_DAYS_OPD : RENAL_VALIDITY_DAYS_ADMITTED,
      ceilingUmolL: RENAL_CREATININE_CEILING_UMOL_L,
      hydrationInstruction: IV_HYDRATION_INSTRUCTION,
      metforminNote: METFORMIN_NOTE,
    },
    lmpDate: pregnancyEvidence?.lmpDate ?? null,
    gates,
    guardians,
    staff: [...staffMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    contrast: {
      administrations: await contrastAdministrationsFor(db, studyId),
      reactions: await contrastReactionsFor(db, studyId),
    },
  };
}
