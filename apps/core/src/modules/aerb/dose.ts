import { and, desc, eq, gte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { DOSE_SOURCES, doseRegister } from "../../kernel/db/schema/aerb";
import { patients } from "../../kernel/db/schema/patients";
import { resources } from "../../kernel/db/schema/resources";
import { AerbError } from "./errors";
import { DOSE_QUANTITIES } from "./units";
import type { DoseQuantity } from "./units";
import type { DoseSource } from "../../kernel/db/schema/aerb";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T3 — **THE PATIENT DOSE REGISTER.**
 *
 * ═══ ITS SOURCES WRITE IT; IT READS NOTHING OF THEIRS (D5) ═══
 *
 * `recordDose` is called from inside the source's own transaction — radiology's `recordAcquired`
 * today, the cath lab's (63) and radiation oncology's (64) tomorrow. It takes the facts and the DRL
 * comparison the caller already made, because the caller is the one holding the published reference
 * levels; this module never joins `imaging_studies`, which is what keeps `aerb` installable without
 * a department.
 *
 * ═══ THE COMPARISON IS STORED, NOT RECOMPUTED ═══
 *
 * A DRL republished next year must not retroactively change what a scan in March was compared
 * against — the argument `imaging_studies.ionising` already makes for itself in 18a. So the
 * quantity, the level and the verdict are written with the row, all three or none, and a CHECK
 * enforces that they travel together.
 *
 * ═══ THIS IS PHI, AND IT IS THE ONLY SURFACE IN THIS MODULE THAT IS (D7) ═══
 *
 * Licences are about machines and QA is about machines; a dose register is a list of patients and
 * what was done to them. `aerb.dose_register` is its own `PhiSurface`, `aerb.doses.read` is its own
 * permission, and every read logs one row per patient DISCLOSED — the F42 shape, never one row for
 * an N-patient page.
 */

const DOSES_READ = "aerb.doses.read";

export interface RecordDoseInput {
  source: DoseSource;
  sourceRef: string;
  patientId: string;
  deviceResourceId?: string | null;
  modality: string;
  procedureCode: string;
  doseCtdivol?: string | number | null;
  doseDlp?: string | number | null;
  doseDap?: string | number | null;
  fluoroSeconds?: number | null;
  doseManual?: boolean;
  /** All three or none — the caller's comparison, stored as a fact. */
  drl?: { quantity: DoseQuantity; value: string | number; over: boolean } | null;
  occurredAt: Date;
}

const num = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

/**
 * Writes one register row. **Called inside the SOURCE's transaction**, so a dose that was recorded
 * and an examination that was not cannot exist separately.
 *
 * It takes no permission of its own: the authority to record a dose is the authority to perform the
 * examination, which the caller has already checked at its own door (`radiology.acquire`). A second
 * permission here would mean a radiographer could acquire a study the register then refused to
 * account for — the worst of both.
 */
export async function recordDose(
  tx: Tx, actor: Actor, input: RecordDoseInput,
): Promise<{ doseRecordId: string }> {
  if (!(DOSE_SOURCES as readonly string[]).includes(input.source)) {
    throw new AerbError("invalid_validity", `"${input.source}" is not a dose source`);
  }
  if (input.drl != null && !(DOSE_QUANTITIES as readonly string[]).includes(input.drl.quantity)) {
    throw new AerbError("invalid_validity", `"${input.drl.quantity}" is not a dose quantity`);
  }

  const doseRecordId = newId();
  await tx.insert(doseRegister).values({
    id: doseRecordId,
    source: input.source,
    sourceRef: input.sourceRef,
    patientId: input.patientId,
    deviceResourceId: input.deviceResourceId ?? null,
    modality: input.modality,
    procedureCode: input.procedureCode,
    doseCtdivol: num(input.doseCtdivol),
    doseDlp: num(input.doseDlp),
    doseDap: num(input.doseDap),
    fluoroSeconds: input.fluoroSeconds ?? null,
    doseManual: input.doseManual ?? false,
    drlQuantity: input.drl?.quantity ?? null,
    drlValue: input.drl === null || input.drl === undefined ? null : num(input.drl.value),
    overDrl: input.drl?.over ?? null,
    occurredAt: input.occurredAt,
    recordedBy: actor.id,
  });
  return { doseRecordId };
}

export interface DoseRegisterRow {
  id: string;
  source: string;
  sourceRef: string;
  patientId: string;
  patientName: string;
  uhid: string;
  deviceCode: string | null;
  modality: string;
  procedureCode: string;
  doseCtdivol: string | null;
  doseDlp: string | null;
  doseDap: string | null;
  fluoroSeconds: number | null;
  doseManual: boolean;
  drlQuantity: string | null;
  drlValue: string | null;
  overDrl: boolean | null;
  occurredAt: string;
}

async function assertMayReadDoses(db: Db, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, DOSES_READ, "hospital"))) {
    throw new AerbError("not_appointed", `${actor.id} does not hold ${DOSES_READ}`, { permission: DOSES_READ });
  }
}

/**
 * The register as a book, newest first. **One PHI row per patient DISCLOSED** — 18a's F42 found the
 * worklist logging a single row for an N-patient disclosure, and 18b's A3 found it logging rows for
 * patients it had WITHHELD. Both mistakes are avoidable here by logging over exactly the rows that
 * are returned, after they are returned.
 */
export async function doseRegisterRows(
  db: Db, actor: Actor, opts: { from?: string; to?: string; overDrlOnly?: boolean; limit?: number } = {},
): Promise<DoseRegisterRow[]> {
  await assertMayReadDoses(db, actor);
  const where = [
    ...(opts.from === undefined ? [] : [sql`${doseRegister.occurredAt} >= ${opts.from}::timestamptz`]),
    ...(opts.to === undefined ? [] : [sql`${doseRegister.occurredAt} < (${opts.to}::date + 1)::timestamptz`]),
    ...(opts.overDrlOnly === true ? [eq(doseRegister.overDrl, true)] : []),
  ];
  const rows = await db.select({
    id: doseRegister.id,
    source: doseRegister.source,
    sourceRef: doseRegister.sourceRef,
    patientId: doseRegister.patientId,
    patientName: patients.name,
    uhid: patients.uhid,
    deviceCode: resources.code,
    modality: doseRegister.modality,
    procedureCode: doseRegister.procedureCode,
    doseCtdivol: doseRegister.doseCtdivol,
    doseDlp: doseRegister.doseDlp,
    doseDap: doseRegister.doseDap,
    fluoroSeconds: doseRegister.fluoroSeconds,
    doseManual: doseRegister.doseManual,
    drlQuantity: doseRegister.drlQuantity,
    drlValue: doseRegister.drlValue,
    overDrl: doseRegister.overDrl,
    occurredAt: doseRegister.occurredAt,
  })
    .from(doseRegister)
    .innerJoin(patients, eq(patients.id, doseRegister.patientId))
    .leftJoin(resources, eq(resources.id, doseRegister.deviceResourceId))
    .where(where.length === 0 ? sql`true` : and(...where))
    .orderBy(desc(doseRegister.occurredAt))
    .limit(opts.limit ?? 200);

  const out = rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
  const reason = `AERB dose register${opts.overDrlOnly === true ? ", over-DRL only" : ""}, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "aerb.dose_register", reason });
  }
  return out;
}

export interface CumulativeDose {
  patientId: string;
  months: number;
  studyCount: number;
  /** Summed per quantity. `null` where the window carried no row with that quantity at all. */
  totalDlp: string | null;
  totalDap: string | null;
  totalFluoroSeconds: number | null;
  /** How many of those examinations exceeded their published DRL. */
  overDrlCount: number;
  /** Newest first, for the nudge's "last one was…" line. */
  lastOccurredAt: string | null;
}

/**
 * D8 / O4 — **the twelve-month cumulative, and it NUDGES rather than blocks.**
 *
 * The brainstorm's O4 is the young patient with six CTs in a year, and its ruling is explicit:
 * *"surfaces to radiologist at protocolling; nudge, not block."* So this returns numbers and the
 * screen shows a line. There is no refusal anywhere in this file, and a phase that adds one must
 * say so in its own document — a system that silently refused the seventh CT would be making a
 * clinical decision that belongs to the radiologist holding the referral.
 *
 * It logs ONE PHI row: this is one patient, and the reader asked about them by name.
 */
export async function patientCumulativeDose(
  db: Db, actor: Actor, patientId: string, opts: { months?: number; now?: Date } = {},
): Promise<CumulativeDose> {
  await assertMayReadDoses(db, actor);
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - months);

  const rows = await db.select({
    count: sql<number>`count(*)::int`,
    totalDlp: sql<string | null>`sum(${doseRegister.doseDlp})`,
    totalDap: sql<string | null>`sum(${doseRegister.doseDap})`,
    totalFluoro: sql<number | null>`sum(${doseRegister.fluoroSeconds})::int`,
    overDrl: sql<number>`count(*) filter (where ${doseRegister.overDrl} = true)::int`,
    last: sql<Date | null>`max(${doseRegister.occurredAt})`,
  })
    .from(doseRegister)
    .where(and(eq(doseRegister.patientId, patientId), gte(doseRegister.occurredAt, from)));

  const r = rows[0];
  await recordPhiAccess(db, {
    actor, patientId, surface: "aerb.dose_register",
    reason: `cumulative dose, ${String(months)} months`,
  });
  return {
    patientId,
    months,
    studyCount: r?.count ?? 0,
    totalDlp: r?.totalDlp ?? null,
    totalDap: r?.totalDap ?? null,
    totalFluoroSeconds: r?.totalFluoro ?? null,
    overDrlCount: r?.overDrl ?? 0,
    lastOccurredAt: r?.last === null || r?.last === undefined ? null : new Date(r.last).toISOString(),
  };
}
