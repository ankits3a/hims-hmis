import { and, asc, eq, max } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdEncounters, opdPrescriptions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries, listAllergies } from "../patients";
import { loadOpdConfig } from "./config";
import { requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import { prescriptionIssued, rxQrSignatureFailed } from "./events";
import { getDoctor } from "./masters";
import { toFhirBundle } from "./fhir";
import { ageYearsAt } from "./time";
import type { Letterhead } from "./config";
import type { PrescriptionRow, VitalsRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

export type { RxLine } from "./fhir"; // one definition, in the pure document core

/** A doctor's reasoned decision to prescribe THROUGH an allergy — the S10 "override rate with reasons" numerator. */
export type AllergyOverride = { lineIndex: number; substance: string; reason: string };
export type AllergyMatch = { lineIndex: number; substance: string };

/** How short an override reason may be before it stops being a reason. */
const MIN_OVERRIDE_REASON = 3;

/**
 * §6 allergy hard-warning, pure. Matching is case-insensitive and works in BOTH directions: an allergy to
 * "sulfa" must catch "Sulfamethoxazole", and an allergy recorded as "Penicillin G" must catch a line that
 * simply says "penicillin". Free-text on both sides is the reality until a formulary lands (stage 2), so
 * this is deliberately generous — a false warning costs one reasoned override, a miss costs a patient.
 */
export function matchAllergies(lines: { drug: string }[], activeSubstances: string[]): AllergyMatch[] {
  const substances = activeSubstances
    .map((raw) => ({ raw, key: raw.trim().toLowerCase() }))
    .filter((s) => s.key !== "");
  const matches: AllergyMatch[] = [];
  lines.forEach((line, lineIndex) => {
    const drug = line.drug.trim().toLowerCase();
    if (drug === "") return;
    for (const substance of substances) {
      if (drug.includes(substance.key) || substance.key.includes(drug)) {
        matches.push({ lineIndex, substance: substance.raw });
      }
    }
  });
  return matches;
}

export const RX_QR_PREFIX = "rx1";

/** e-Rx payload: rx1.<prescriptionId>.<encounterId>.<version>.<sig> — HMAC under the existing SECRET_KEY. */
export function buildRxQrPayload(cfg: AppConfig, p: { id: string; encounterId: string; version: number }): string {
  const body = `${RX_QR_PREFIX}.${p.id}.${p.encounterId}.${p.version}`;
  return `${body}.${hmacSign(cfg.secretKey, body)}`;
}

export type IssuePrescriptionInput = { lines: RxLine[]; overrides?: AllergyOverride[] };
export type IssuedPrescription = { prescriptionId: string; version: number; qrPayload: string; allergyOverrideCount: number };

/**
 * D5: one versioned prescription per issue; a re-issue supersedes its predecessor so exactly one row per
 * encounter is ever `active`. Version allocation runs under a FOR UPDATE of the ENCOUNTER row — a row this
 * function never writes (§3.28) — so two doctors' devices submitting at once serialize into 1 and 2 rather
 * than colliding on the (encounter_id, version) unique index.
 */
export async function issuePrescription(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string, input: IssuePrescriptionInput, now: Date = new Date(),
): Promise<IssuedPrescription> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, encounter);
  if (encounter.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `a prescription is issued in consultation, not ${encounter.status}`);
  }

  const lines = input.lines;
  if (lines.length === 0) throw new OpdError("empty_prescription", "a prescription needs at least one line");
  for (const line of lines) {
    if (line.drug.trim() === "" || line.dose.trim() === "" || line.frequency.trim() === "" || line.route.trim() === "") {
      throw new OpdError("empty_prescription", "every line needs a drug, a dose, a frequency and a route");
    }
  }

  // Allergies come from the patients module's read helper — the OPD module reads no patient table (spec §4).
  const active = (await listAllergies(db, encounter.patientId)).filter((a) => a.status === "active");
  const matches = matchAllergies(lines, active.map((a) => a.substance));
  const overrides = input.overrides ?? [];
  const unresolved = matches.filter((m) => !overrides.some((o) => o.lineIndex === m.lineIndex));
  if (unresolved.length > 0) {
    throw new OpdError("allergy_conflict", `${unresolved.length} line(s) conflict with an active allergy`, { matches });
  }
  const matchedOverrides = overrides.filter((o) => matches.some((m) => m.lineIndex === o.lineIndex));
  for (const override of matchedOverrides) {
    if (override.reason.trim().length < MIN_OVERRIDE_REASON) {
      throw new OpdError("override_reason_required", "an allergy override records WHY (the S10 safety-alert KPI)");
    }
  }

  return withTx(db, async (tx) => {
    // The version serializer: this select is the only reason the encounter row is touched here.
    await tx.select({ id: opdEncounters.id }).from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update");
    const highest = await tx
      .select({ version: max(opdPrescriptions.version) })
      .from(opdPrescriptions)
      .where(eq(opdPrescriptions.encounterId, encounterId));
    const version = (highest[0]?.version ?? 0) + 1;

    await tx
      .update(opdPrescriptions)
      .set({ status: "superseded" })
      .where(and(eq(opdPrescriptions.encounterId, encounterId), eq(opdPrescriptions.status, "active")));

    const prescriptionId = newId();
    const document = toFhirBundle({
      prescriptionId, version, encounterId, patientId: encounter.patientId, doctorId: doctor.id,
      issuedAt: now, diagnosis: encounter.diagnosis, icd10Code: encounter.icd10Code, lines,
    });
    await tx.insert(opdPrescriptions).values({
      id: prescriptionId, encounterId, patientId: encounter.patientId, doctorId: doctor.id, version,
      lines, document, allergyOverrides: matchedOverrides, status: "active", issuedBy: actor.id, issuedAt: now,
    });
    await appendEvent(tx, prescriptionIssued.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        prescriptionId, encounterId, patientId: encounter.patientId, doctorId: doctor.id,
        version, lineCount: lines.length, allergyOverrideCount: matchedOverrides.length,
      },
    }));
    return {
      prescriptionId, version,
      qrPayload: buildRxQrPayload(cfg, { id: prescriptionId, encounterId, version }),
      allergyOverrideCount: matchedOverrides.length,
    };
  });
}

export async function listPrescriptions(db: Db, encounterId: string): Promise<PrescriptionRow[]> {
  return db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, encounterId)).orderBy(asc(opdPrescriptions.version));
}

export type RxVerifyReason = "malformed" | "invalid_signature" | "stale_version" | "unknown_prescription";
export type RxVerifyResult =
  | {
    ok: true;
    prescription: { id: string; version: number; issuedAt: Date; lines: RxLine[] };
    patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean };
    doctor: { displayName: string; registrationNo: string | null };
  }
  | { ok: false; reason: RxVerifyReason };

/**
 * Pharmacy-side scan of a printed e-Rx (the qr.ts pattern). It NEVER throws on a failure path — the caller is
 * an HTTP 200 either way — but every failure is an auditable fact, appended as qr.signature_failed (module
 * "opd") in its OWN transaction. A forged payload's embedded id is not trusted, so no patient is attributed
 * to it; a superseded version is ours to attribute.
 */
export async function verifyPrescriptionQr(db: Db, cfg: AppConfig, actor: Actor, payload: string): Promise<RxVerifyResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "scanners are desk surfaces — user actors only");

  const fail = async (reason: RxVerifyReason, patientId?: string): Promise<RxVerifyResult> => {
    await withTx(db, (tx) =>
      appendEvent(tx, rxQrSignatureFailed.make({
        actor, patientId,
        payload: { reason, payloadPrefix: payload.slice(0, 32), ...(patientId !== undefined ? { patientId } : {}) },
      })));
    return { ok: false, reason };
  };

  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== RX_QR_PREFIX || !/^\d+$/.test(parts[3]!)) return fail("malformed");
  const [prefix, id, encounterId, versionPart, sig] = parts as [string, string, string, string, string];
  const body = `${prefix}.${id}.${encounterId}.${versionPart}`;
  if (!hmacVerify(cfg.secretKey, body, sig)) return fail("invalid_signature");

  const rows = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, id));
  const row = rows[0];
  if (!row) return fail("unknown_prescription"); // the signature is ours but the row is not: nothing to attribute
  if (row.version !== Number(versionPart) || row.encounterId !== encounterId || row.status !== "active") {
    return fail("stale_version", row.patientId); // a re-issue retired this card
  }

  const [summary] = await getPatientSummaries(db, actor, [row.patientId]);
  const doctor = await getDoctor(db, row.doctorId);
  return {
    ok: true,
    prescription: { id: row.id, version: row.version, issuedAt: row.issuedAt, lines: row.lines as RxLine[] },
    patient: { uhid: summary!.uhid, name: summary!.name, alias: summary!.alias, restricted: summary!.restricted },
    doctor: { displayName: doctor!.displayName, registrationNo: doctor!.registrationNo },
  };
}

export type RxPrintData = {
  letterhead: Letterhead;
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean; ageYears: number | null; sex: string };
  doctor: { displayName: string; registrationNo: string | null; departmentName: string | null };
  encounter: {
    id: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null;
    advice: string | null; followUpDays: number | null; chiefComplaint: string | null;
  };
  vitals: VitalsRow | null;
  lines: RxLine[];
  qrPayload: string;
  version: number;
  issuedAt: Date;
};

/**
 * Everything the printed e-Rx needs, in one read. The letterhead is config data (owner decision), and there is
 * deliberately NO signature line: the signed QR is the authentication (owner decision 2026-08-15).
 */
export async function getPrescriptionPrint(db: Db, cfg: AppConfig, actor: Actor, prescriptionId: string): Promise<RxPrintData> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "the print surface is a desk surface");
  const rows = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, prescriptionId));
  const row = rows[0];
  if (!row) throw new OpdError("unknown_prescription", `unknown prescription ${prescriptionId}`);
  const encounter = (await getEncounter(db, row.encounterId))!;
  const opdCfg = await loadOpdConfig(db);

  const [summary] = await getPatientSummaries(db, actor, [row.patientId]);
  const doctor = await getDoctor(db, row.doctorId);
  const department = encounter.departmentId === null
    ? null
    : (await db.select().from(opdDepartments).where(eq(opdDepartments.id, encounter.departmentId)))[0] ?? null;
  const vitals = await db
    .select().from(opdVitals).where(eq(opdVitals.encounterId, encounter.id))
    .orderBy(asc(opdVitals.recordedAt));

  return {
    letterhead: opdCfg.letterhead,
    patient: {
      uhid: summary!.uhid, name: summary!.name, alias: summary!.alias, restricted: summary!.restricted,
      ageYears: summary!.dob === null ? null : ageYearsAt(summary!.dob, row.issuedAt), sex: summary!.sex,
    },
    doctor: { displayName: doctor!.displayName, registrationNo: doctor!.registrationNo, departmentName: department?.name ?? null },
    encounter: {
      id: encounter.id, serviceDate: encounter.serviceDate, diagnosis: encounter.diagnosis, icd10Code: encounter.icd10Code,
      advice: encounter.advice, followUpDays: encounter.followUpDays, chiefComplaint: encounter.chiefComplaint,
    },
    vitals: vitals[vitals.length - 1] ?? null, // the LATEST reading — a danger flag never auto-clears (D4)
    lines: row.lines as RxLine[],
    qrPayload: buildRxQrPayload(cfg, { id: row.id, encounterId: row.encounterId, version: row.version }),
    version: row.version,
    issuedAt: row.issuedAt,
  };
}
