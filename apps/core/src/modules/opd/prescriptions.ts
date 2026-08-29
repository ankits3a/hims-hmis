import { and, asc, eq, max } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdEncounters, opdPrescriptions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries, listAllergies } from "../patients";
import { listInteractionsAmong, normalizeDrugName, resolveDrugTexts, resolveMedicines } from "../formulary";
import { checkDuplicateSalt, checkInteractions, matchAllergiesSaltAware } from "./rx-checks";
import { loadOpdConfig } from "./config";
import { requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import type { AdvisedTest } from "./consultation";
import { visibleEncounterFor } from "./read-gate";
import { recordPhiAccess } from "../../kernel/phi/audit";
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

/**
 * A hard warning cleared by a reason, for a kind of hit other than an allergy (DD3).
 *
 * ═══ C5 (independent review): AN OVERRIDE NAMES WHAT IT CLEARS ═══
 *
 * It used to carry `lineIndex` alone, so one override cleared EVERY hard hit on that line —
 * including hits the doctor never saw. The sequence is ordinary, not exotic: the pre-check shows
 * one severe hit on line 2; while the doctor types a reason, another prescriber puts the patient on
 * a second interacting drug; the issue-time re-run (design law 2, working exactly as intended)
 * finds a SECOND severe hit on line 2 — and the single override silently cleared it. One
 * click-through was recorded for two, and the second warning was never shown to anybody.
 *
 * `saltPair` (interactions) and `moiety` (duplicates) are the hit's identity. An override that
 * names neither clears NOTHING: the issue is refused again with the hits attached, which is the
 * fail-safe direction — a doctor sees a warning twice rather than never.
 */
export type RxOverride = {
  lineIndex: number;
  reason: string;
  /** The interacting pair this reason is about, in either order. */
  saltPair?: [string, string];
  /** The repeated moiety this reason is about. */
  moiety?: string;
};

/** Same pair, whichever order either side names it in. */
function samePair(a: readonly [string, string], b: readonly [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

function interactionCovered(hit: InteractionHit, overrides: RxOverride[]): boolean {
  return overrides.some((o) => o.lineIndex === hit.lineIndex
    && o.saltPair !== undefined && samePair(o.saltPair, hit.saltPair));
}

function duplicateCovered(hit: DuplicateHit, overrides: RxOverride[]): boolean {
  return overrides.some((o) => o.lineIndex === hit.lineIndex && o.moiety === hit.moiety);
}

/**
 * The allergy path had the same hole and the field to close it: `AllergyOverride` has always
 * carried `substance`, and the match ignored it. Three kinds, one rule now.
 */
function allergyCovered(match: AllergyMatch, overrides: AllergyOverride[]): boolean {
  return overrides.some((o) => o.lineIndex === match.lineIndex && o.substance === match.substance);
}

/** Soft hits: data the screen shows, never a refusal and never override-gated (DD3). */
export type RxNotice = InteractionHit | DuplicateHit;

export type RxCheckOutcome = {
  allergyMatches: AllergyMatch[];
  interactions: InteractionHit[];
  duplicates: DuplicateHit[];
  /**
   * PLAN 16a T6 — which lines the formulary could not resolve, decided by the SERVER.
   *
   * The consult screen needs this for the coverage-gated hint, and the alternative was for the
   * browser to re-derive it by normalizing drug names against a fetched medicine list — a SECOND
   * normalizer, in a second language, drifting from `normalizeDrugName` silently (§2.54). The
   * side that already knows the answer says so.
   */
  unresolvedLineIndexes: number[];
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
  // ── 1. THE PRIOR ROWS FIRST, so this prescription and the priors resolve through ONE resolver ──
  //
  // C2 (independent review, CRITICAL): the priors used to resolve by TEXT ONLY, while this
  // prescription resolved id-first. A prior line carrying a `medicineId` whose free text is not
  // exactly a brand name — "Warf 5mg OD", which is what a doctor types after picking — therefore
  // resolved to NOTHING, and the check against what the patient is already taking silently did not
  // fire. Same blindness the moment a brand is renamed: every historical line's text stops
  // resolving while its id still would.
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

  const everyLine: RxLine[] = [...lines, ...priorLines.flatMap((row) => row.rx)];
  const idCarrying = everyLine
    .map((line) => (typeof line.medicineId === "string" && line.medicineId !== "" ? line.medicineId : null))
    .filter((id): id is string => id !== null);
  const byId = idCarrying.length > 0 ? await resolveMedicines(db, idCarrying) : new Map<string, ResolvedDrug>();
  const byText = everyLine.length > 0
    ? await resolveDrugTexts(db, everyLine.map((line) => line.drug))
    : new Map<string, ResolvedDrug | null>();

  /**
   * ONE RESOLVER FOR EVERY LINE THIS FUNCTION LOOKS AT — AND IT UNIONS THE TWO ANSWERS.
   *
   * C1 and C2 (independent review, both CRITICAL) are the same defect seen from opposite ends, and
   * the obvious fix for each BREAKS the other:
   *
   *   C1 — a stale `medicineId` used to speak for a line whose text had been typed over, so the
   *        checks reasoned about a drug the prescription does not name.
   *   C2 — priors resolved by TEXT ONLY, so `"Warf 5mg OD"` — a picked line a doctor then annotated
   *        — resolved to nothing and the interaction against it never fired.
   *
   * "Trust the id" loses C1. "Trust the text when they disagree" loses C2, because an annotated
   * pick is EXACTLY a line whose text no longer equals its brand. Choosing either one picks which
   * patient to fail.
   *
   * So neither is dropped: **the moieties are the UNION of what the id resolves to and what the
   * text resolves to.** A check that over-warns costs one reasoned override; a check that misses
   * costs a patient, and every failure mode above is a MISS. Where the two disagree the line might
   * be either drug, and the honest answer is to check both.
   *
   * AND THE LINE IS STORED WITH BOTH, unchanged. An earlier attempt at this fix stripped a
   * disagreeing id before writing the row — which deleted the evidence C2 is about: a doctor who
   * picks "Warf 5" and types "Warf 5mg OD" has annotated a dose, not changed the drug, and the
   * pick is the more reliable of the two facts. What the prescriber SELECTED and what they WROTE
   * are both facts; a disagreement between them is a data-quality signal, never a licence to
   * discard one. The checks read both, the record keeps both.
   */
  const resolutionOf = (line: RxLine): ResolvedDrug | null => {
    const id = typeof line.medicineId === "string" && line.medicineId !== "" ? line.medicineId : null;
    const fromId = id === null ? undefined : byId.get(id);
    const fromText = byText.get(line.drug) ?? null;
    if (fromId === undefined) return fromText;
    if (fromText === null) return fromId;

    const salts = [...fromId.salts];
    for (const salt of fromText.salts) {
      if (!salts.some((s) => s.saltId === salt.saltId)) salts.push(salt);
    }
    const textNamesTheId = fromId.brandName !== null
      && normalizeDrugName(line.drug) === normalizeDrugName(fromId.brandName);
    return {
      // The identity follows the TEXT when the two disagree: it is what the patient will be handed.
      medicineId: textNamesTheId ? fromId.medicineId : fromText.medicineId,
      brandName: textNamesTheId ? fromId.brandName : fromText.brandName,
      // A route disagreement resolves to `systemic`, because `routeSuppresses` only ever SUPPRESSES
      // on `topical` — guessing topical would silence a severe pair on a guess.
      routeClass: fromId.routeClass === "systemic" || fromText.routeClass === "systemic"
        ? "systemic"
        : fromId.routeClass ?? fromText.routeClass,
      salts,
    };
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
  const priors: PriorRx[] = priorLines.map((row) => ({
    prescriptionId: row.id, issuedAt: row.issuedAt,
    lines: row.rx.map((line) => ({ line, resolution: resolutionOf(line) })),
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
    /**
     * A resolution with NO moieties is not a checked line — it is a line about which nothing can be
     * said, and reporting it as covered is how the coverage figure and the safety path came to
     * disagree about the same line in opposite directions (C3). `null` and "resolved to nothing"
     * are the same answer to the only question this list asks.
     */
    unresolvedLineIndexes: checkLines
      .filter((l) => l.resolution === null || l.resolution.salts.length === 0)
      .map((l) => l.lineIndex),
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
  /** Lines the formulary does not know — the coverage-gated hint's input (T6, DD5). */
  unresolvedLineIndexes: number[];
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
    unresolvedLineIndexes: checks.unresolvedLineIndexes,
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
  const unresolved = matches.filter((m) => !allergyCovered(m, overrides));
  if (unresolved.length > 0) {
    throw new OpdError("allergy_conflict", `${unresolved.length} line(s) conflict with an active allergy`, { matches });
  }
  const matchedOverrides = overrides.filter((o) => matches.some((m) => allergyCovered(m, [o])));

  /**
   * DD3 — the two new hard warnings, in `allergy_conflict`'s exact grammar: only SEVERE
   * interactions and only `hard` duplicates gate, each cleared by an override on its line carrying
   * a reason. Everything else leaves as a notice below and gates nothing.
   */
  const severeHits = checks.interactions.filter((h) => h.severity === "severe");
  const hardDuplicates = checks.duplicates.filter((h) => h.hard);
  const interactionOverrides = input.interactionOverrides ?? [];
  const duplicateOverrides = input.duplicateOverrides ?? [];

  const uncoveredInteractions = severeHits.filter((h) => !interactionCovered(h, interactionOverrides));
  if (uncoveredInteractions.length > 0) {
    throw new OpdError(
      "interaction_conflict",
      `${uncoveredInteractions.length} line(s) carry a severe interaction`,
      { hits: severeHits },
    );
  }
  const uncoveredDuplicates = hardDuplicates.filter((h) => !duplicateCovered(h, duplicateOverrides));
  if (uncoveredDuplicates.length > 0) {
    throw new OpdError(
      "duplicate_salt_conflict",
      `${uncoveredDuplicates.length} line(s) repeat a moiety already on this prescription`,
      { hits: hardDuplicates },
    );
  }

  const matchedInteractionOverrides = interactionOverrides.filter((o) => severeHits.some((h) => interactionCovered(h, [o])));
  const matchedDuplicateOverrides = duplicateOverrides.filter((o) => hardDuplicates.some((h) => duplicateCovered(h, [o])));

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
      lines, document, allergyOverrides: matchedOverrides,
      // C4 — the justification for prescribing through a severe interaction is a medico-legal
      // record, not a transient. It used to be validated, counted, and dropped.
      interactionOverrides: matchedInteractionOverrides,
      duplicateOverrides: matchedDuplicateOverrides,
      status: "active", issuedBy: actor.id, issuedAt: now,
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

export async function listPrescriptions(db: Db, actor: Actor, encounterId: string): Promise<PrescriptionRow[]> {
  // PLAN 07a T1 — an encounter id is not a capability. Same empty answer as an unknown encounter.
  const seen = await visibleEncounterFor(db, actor, encounterId);
  if (!seen) return [];
  await recordPhiAccess(db, {
    actor, patientId: seen.encounter.patientId, surface: "opd.prescriptions", encounterId,
    sealed: seen.sealed, reason: seen.breakGlass?.reason ?? null,
  });
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
    /**
     * PLAN 07d T5 / DD4 — the advised tests, printed as ADVICE. They ride the print payload because
     * the printed slip is where a patient reads them and where they take them to the counter — and
     * `advisedAsOf` is the service date rather than a fresh timestamp, so the sheet says which day's
     * prices it is quoting (E-9: the slip carries the as-of date, the counter reprices).
     */
    advisedTests: AdvisedTest[];
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
      // Read back verbatim; `[]` when the doctor advised none, so the renderer needs no null branch.
      advisedTests: Array.isArray(encounter.advisedTests) ? (encounter.advisedTests as AdvisedTest[]) : [],
    },
    vitals: vitals[vitals.length - 1] ?? null, // the LATEST reading — a danger flag never auto-clears (D4)
    lines: row.lines as RxLine[],
    qrPayload: buildRxQrPayload(cfg, { id: row.id, encounterId: row.encounterId, version: row.version }),
    version: row.version,
    issuedAt: row.issuedAt,
  };
}
