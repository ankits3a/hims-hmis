import { and, asc, eq, max } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdEncounters, opdPrescriptions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries, listAllergies } from "../patients";
import { listInteractionsAmong, resolveDrugTexts, resolveMedicines } from "../formulary";
import { checkDuplicateSalt, checkInteractions, matchAllergiesSaltAware } from "./rx-checks";
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
import type { DuplicateHit, InteractionHit, PriorRx, RxCheckLine } from "./rx-checks";
import type { ResolvedDrug } from "../formulary";
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
  return matchAllergiesSaltAware(
    lines.map((line, lineIndex) => ({ lineIndex, drug: line.drug, resolution: null })),
    activeSubstances.map((substance) => ({ substance, resolution: null })),
  );
}

export const RX_QR_PREFIX = "rx1";

/** e-Rx payload: rx1.<prescriptionId>.<encounterId>.<version>.<sig> — HMAC under the existing SECRET_KEY. */
export function buildRxQrPayload(cfg: AppConfig, p: { id: string; encounterId: string; version: number }): string {
  const body = `${RX_QR_PREFIX}.${p.id}.${p.encounterId}.${p.version}`;
  return `${body}.${hmacSign(cfg.secretKey, body)}`;
}

/** A hard warning cleared by a reason, for a kind of hit other than an allergy (DD3). */
export type RxOverride = { lineIndex: number; reason: string };

/** Soft hits: data the screen shows, never a refusal and never override-gated (DD3). */
export type RxNotice = InteractionHit | DuplicateHit;

export type RxCheckOutcome = {
  allergyMatches: AllergyMatch[];
  interactions: InteractionHit[];
  duplicates: DuplicateHit[];
};

/**
 * PLAN 16a T5 — THE ONE READ BLOCK BOTH CALL SITES USE.
 *
 * `issuePrescription` runs it at issue time (design law 2) and the pre-check route runs it while
 * the doctor is still typing. They must not be two implementations: a pre-check that disagreed with
 * the refusal would teach doctors that the warnings are noise, which is the exact failure the whole
 * override-with-reason machinery exists to avoid.
 *
 * IT STAYS OUTSIDE THE TRANSACTION, deliberately (§2's note): the shipped allergy read is already
 * here, and moving these reads inside `withTx` would lengthen the version-serializer's lock window
 * for every prescription in the hospital to buy nothing — the checks are re-run on every issue
 * regardless, so a race between the check and the write is caught by the next issue, not lost.
 *
 * `excludeEncounterId` IS NOT AN OPTIMISATION. A re-issue supersedes its own previous version
 * inside the transaction below, but that row is still `active` while these reads run — so without
 * this exclusion, correcting a typo on a prescription would warn the doctor that the patient is
 * already taking everything on it, against itself. (CLOSE F14.)
 */
export async function runRxChecks(
  db: Db,
  patientId: string,
  lines: RxLine[],
  now: Date,
  opts: { excludeEncounterId?: string } = {},
): Promise<RxCheckOutcome> {
  // ── 1. resolve THIS prescription's lines ──
  const idCarrying = lines
    .map((line) => (typeof line.medicineId === "string" && line.medicineId !== "" ? line.medicineId : null))
    .filter((id): id is string => id !== null);
  const byId = idCarrying.length > 0 ? await resolveMedicines(db, idCarrying) : new Map<string, ResolvedDrug>();

  // A line whose stored `medicineId` no longer resolves (withdrawn, deactivated) falls back to its
  // TEXT rather than to nothing: the text path is exact too, so this can only restore protection,
  // never invent it. Spec §1.2's "demotes the line to unresolved" is honoured for the id itself.
  const needText = lines.filter((line) => {
    const id = typeof line.medicineId === "string" ? line.medicineId : null;
    return id === null || id === "" || !byId.has(id);
  });
  const byText = needText.length > 0
    ? await resolveDrugTexts(db, needText.map((line) => line.drug))
    : new Map<string, ResolvedDrug | null>();

  const resolutionOf = (line: RxLine): ResolvedDrug | null => {
    const id = typeof line.medicineId === "string" ? line.medicineId : null;
    if (id !== null && id !== "") {
      const resolved = byId.get(id);
      if (resolved !== undefined) return resolved;
    }
    return byText.get(line.drug) ?? null;
  };
  const checkLines: RxCheckLine[] = lines.map((line, lineIndex) => ({
    lineIndex, drug: line.drug, resolution: resolutionOf(line),
  }));

  // ── 2. the allergy register, through the patients module's read helper (spec §4) ──
  const active = (await listAllergies(db, patientId)).filter((a) => a.status === "active");
  const substances = active.map((a) => a.substance);
  const substanceResolutions = substances.length > 0
    ? await resolveDrugTexts(db, substances)
    : new Map<string, ResolvedDrug | null>();
  const allergies = active.map((a) => ({
    substance: a.substance, resolution: substanceResolutions.get(a.substance) ?? null,
  }));

  // ── 3. what the patient is already taking (DD4: resolved LIVE, against today's formulary) ──
  const priorRows = await db
    .select({
      id: opdPrescriptions.id, encounterId: opdPrescriptions.encounterId,
      issuedAt: opdPrescriptions.issuedAt, lines: opdPrescriptions.lines,
    })
    .from(opdPrescriptions)
    .where(and(eq(opdPrescriptions.patientId, patientId), eq(opdPrescriptions.status, "active")));
  const priorLines = priorRows
    .filter((row) => row.encounterId !== opts.excludeEncounterId)
    .map((row) => ({ ...row, rx: row.lines as RxLine[] }));
  const priorTexts = priorLines.flatMap((row) => row.rx.map((line) => line.drug));
  const priorResolutions = priorTexts.length > 0
    ? await resolveDrugTexts(db, priorTexts)
    : new Map<string, ResolvedDrug | null>();
  const priors: PriorRx[] = priorLines.map((row) => ({
    prescriptionId: row.id, issuedAt: row.issuedAt,
    lines: row.rx.map((line) => ({ line, resolution: priorResolutions.get(line.drug) ?? null })),
  }));

  // ── 4. the pairs that could possibly apply, and then the three checks ──
  const saltIds = [
    ...checkLines.flatMap((l) => l.resolution?.salts.map((s) => s.saltId) ?? []),
    ...priors.flatMap((p) => p.lines.flatMap((l) => l.resolution?.salts.map((s) => s.saltId) ?? [])),
  ];
  const pairs = await listInteractionsAmong(db, saltIds);

  return {
    allergyMatches: matchAllergiesSaltAware(checkLines, allergies),
    interactions: checkInteractions(checkLines, priors, pairs, now),
    duplicates: checkDuplicateSalt(checkLines, priors, now),
  };
}

/**
 * What the consult screen gets BEFORE it submits: every hit, split the way the screen has to render
 * it. `hard` is what will refuse the issue without an override; `notices` is what it shows quietly.
 */
export type RxPrecheckResult = {
  allergyMatches: AllergyMatch[];
  interactions: InteractionHit[];
  duplicates: DuplicateHit[];
  notices: RxNotice[];
};

/**
 * The pre-check route's function. It authorises exactly as the issue path does — the same
 * encounter lookup and the same treating-doctor check — because the answer describes what this
 * patient is taking, and "it only reads" has never been a reason to skip an authorisation.
 *
 * It deliberately does NOT require `in_consultation`: a doctor reviewing a draft before starting
 * the consultation gets the same warnings, and nothing is written either way.
 */
export async function precheckPrescription(
  db: Db, actor: Actor, encounterId: string, lines: RxLine[], now: Date = new Date(),
): Promise<RxPrecheckResult> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, encounter);
  const checks = await runRxChecks(db, encounter.patientId, lines, now, { excludeEncounterId: encounterId });
  return {
    allergyMatches: checks.allergyMatches,
    interactions: checks.interactions,
    duplicates: checks.duplicates,
    notices: [
      ...checks.interactions.filter((h) => h.severity !== "severe"),
      ...checks.duplicates.filter((h) => !h.hard),
    ],
  };
}

export type IssuePrescriptionInput = {
  lines: RxLine[];
  overrides?: AllergyOverride[];
  /** DD3 — the same grammar as `overrides`, one array per hard-warning kind. */
  interactionOverrides?: RxOverride[];
  duplicateOverrides?: RxOverride[];
};
export type IssuedPrescription = {
  prescriptionId: string; version: number; qrPayload: string; allergyOverrideCount: number;
  interactionOverrideCount: number; duplicateOverrideCount: number;
  /** Moderate interactions, vs-prior duplicates and route-differing duplicates. Data, never a gate. */
  notices: RxNotice[];
};

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

  /**
   * THE CHECKS RUN HERE, at issue time, in the same read block the allergy read has always been in
   * (design law 2 and §2's note). `excludeEncounterId` keeps a re-issue from warning against the
   * version it is about to supersede (F14).
   */
  const checks = await runRxChecks(db, encounter.patientId, lines, now, { excludeEncounterId: encounterId });

  const matches = checks.allergyMatches;
  const overrides = input.overrides ?? [];
  const unresolved = matches.filter((m) => !overrides.some((o) => o.lineIndex === m.lineIndex));
  if (unresolved.length > 0) {
    throw new OpdError("allergy_conflict", `${unresolved.length} line(s) conflict with an active allergy`, { matches });
  }
  const matchedOverrides = overrides.filter((o) => matches.some((m) => m.lineIndex === o.lineIndex));

  /**
   * DD3 — the two new hard warnings, in `allergy_conflict`'s exact grammar: only SEVERE
   * interactions and only `hard` duplicates gate, each cleared by an override on its line carrying
   * a reason. Everything else leaves as a notice below and gates nothing.
   */
  const severeHits = checks.interactions.filter((h) => h.severity === "severe");
  const hardDuplicates = checks.duplicates.filter((h) => h.hard);
  const interactionOverrides = input.interactionOverrides ?? [];
  const duplicateOverrides = input.duplicateOverrides ?? [];

  const uncoveredInteractions = severeHits.filter((h) => !interactionOverrides.some((o) => o.lineIndex === h.lineIndex));
  if (uncoveredInteractions.length > 0) {
    throw new OpdError(
      "interaction_conflict",
      `${uncoveredInteractions.length} line(s) carry a severe interaction`,
      { hits: severeHits },
    );
  }
  const uncoveredDuplicates = hardDuplicates.filter((h) => !duplicateOverrides.some((o) => o.lineIndex === h.lineIndex));
  if (uncoveredDuplicates.length > 0) {
    throw new OpdError(
      "duplicate_salt_conflict",
      `${uncoveredDuplicates.length} line(s) repeat a moiety already on this prescription`,
      { hits: hardDuplicates },
    );
  }

  const matchedInteractionOverrides = interactionOverrides.filter((o) => severeHits.some((h) => h.lineIndex === o.lineIndex));
  const matchedDuplicateOverrides = duplicateOverrides.filter((o) => hardDuplicates.some((h) => h.lineIndex === o.lineIndex));

  // ONE reason gate for all three kinds, reusing the shipped constant and the shipped code (DD3).
  for (const override of [...matchedOverrides, ...matchedInteractionOverrides, ...matchedDuplicateOverrides]) {
    if (override.reason.trim().length < MIN_OVERRIDE_REASON) {
      throw new OpdError("override_reason_required", "an override records WHY (the S10 safety-alert KPI)");
    }
  }

  /** Soft: moderate interactions, and duplicates that are vs-prior or across route classes. */
  const notices: RxNotice[] = [
    ...checks.interactions.filter((h) => h.severity !== "severe"),
    ...checks.duplicates.filter((h) => !h.hard),
  ];

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
        interactionOverrideCount: matchedInteractionOverrides.length,
        duplicateOverrideCount: matchedDuplicateOverrides.length,
      },
    }));
    return {
      prescriptionId, version,
      qrPayload: buildRxQrPayload(cfg, { id: prescriptionId, encounterId, version }),
      allergyOverrideCount: matchedOverrides.length,
      interactionOverrideCount: matchedInteractionOverrides.length,
      duplicateOverrideCount: matchedDuplicateOverrides.length,
      notices,
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
    id: string; visitNo: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null;
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
      id: encounter.id, visitNo: encounter.visitNo, serviceDate: encounter.serviceDate, diagnosis: encounter.diagnosis, icd10Code: encounter.icd10Code,
      advice: encounter.advice, followUpDays: encounter.followUpDays, chiefComplaint: encounter.chiefComplaint,
    },
    vitals: vitals[vitals.length - 1] ?? null, // the LATEST reading — a danger flag never auto-clears (D4)
    lines: row.lines as RxLine[],
    qrPayload: buildRxQrPayload(cfg, { id: row.id, encounterId: row.encounterId, version: row.version }),
    version: row.version,
    issuedAt: row.issuedAt,
  };
}
