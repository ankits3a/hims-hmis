import { and, asc, eq, inArray, max } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { prescriberPrint } from "../roster";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdEncounters, opdPrescriptions, opdVitals, outsideTests, users } from "../../kernel/db/schema";
import { getPatientSummaries, listAllergies } from "../patients";
import {
  listDrugDiseaseFor, listInteractionsAmong, normalizeDrugName, resolveDrugTexts, resolveMedicines,
  unreviewedSaltIds,
} from "../formulary";
import {
  checkDrugDisease, checkDuplicateClass, checkDuplicateSalt, checkInteractions, matchAllergiesSaltAware,
} from "./rx-checks";
import { listCodedDiagnoses } from "./diagnosis-history";
import { loadOpdConfig } from "./config";
import { refuseIfClosedOnPaper, refuseTeleBeforeSpoke, requireTreatingDoctor } from "./consultation";
import { hasPermission } from "../../kernel/auth/permissions";
import { getEncounter, visitDiagnoses } from "./encounters";
import { OpdError } from "./errors";
import type { AdvisedTest } from "./consultation";
import { visibleEncounterFor } from "./read-gate";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { prescriptionIssued, rxQrSignatureFailed } from "./events";
import { getDoctor } from "./masters";
import { normaliseRxLine, toFhirBundle } from "./fhir";
import { writeCdsRxLines } from "./cds-rx-lines";
import { ageYearsAt } from "./time";
import type { Letterhead } from "./config";
import type { PrescriptionRow, VisitDiagnosis, VitalsRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { DrugDiseaseAlternative } from "../formulary";
import type { DrugDiseaseHit, DuplicateHit, InteractionHit, PriorRx, RxCheckLine } from "./rx-checks";
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
  /**
   * P24 — the diagnosis rule this reason is about. `moiety` says which drug; this says which
   * ruling, because `N18` and `N18.4` are two different decisions about one disease and a reason
   * typed for one is not a reason for the other.
   */
  icd10Prefix?: string;
};

/** Same pair, whichever order either side names it in. */
function samePair(a: readonly [string, string], b: readonly [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

function drugDiseaseCovered(hit: DrugDiseaseHit, overrides: RxOverride[]): boolean {
  return overrides.some((o) => o.lineIndex === hit.lineIndex
    && o.moiety === hit.moiety && o.icd10Prefix === hit.icd10Prefix);
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
  /** P24 — what the patient's own coded diagnosis forbids. Severe gates; moderate is a notice. */
  drugDisease: DrugDiseaseHit[];
  /**
   * PLAN 16a T6 — which lines the formulary could not resolve, decided by the SERVER.
   *
   * The consult screen needs this for the coverage-gated hint, and the alternative was for the
   * browser to re-derive it by normalizing drug names against a fetched medicine list — a SECOND
   * normalizer, in a second language, drifting from `normalizeDrugName` silently (§2.54). The
   * side that already knows the answer says so.
   */
  unresolvedLineIndexes: number[];
  /**
   * FORMULARY PHASE 3 — which lines the checks could see only IN PART, decided by the server.
   *
   * A resolved line with a component no pharmacist has reviewed: a national release entry with no
   * drug class and no interaction pairs. The checks ran, and for that component they could find
   * nothing whatever the truth is. Such a line used to come back exactly like a fully checked one.
   * The doctor's picker already says "not yet reviewed by pharmacy". The check now says the same
   * thing about the same products, because both ask `formulary`'s one predicate.
   *
   * It gates nothing (phase doc §3.4: the doctor is told, not asked), and it is disjoint from
   * `unresolvedLineIndexes`: a line with no moieties has no component to be unreviewed.
   */
  unreviewedLineIndexes: number[];
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
    // P22 — the class the doctor PICKED, which the text alone does not carry to the check.
    allergenClass: a.allergenClass,
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
  /**
   * P24 — the fourth axis. Only THIS prescription's moieties are asked about, not the priors':
   * the doctor can act on the line they are writing, and an alert about a drug issued last month
   * is a different screen (a review card), not a thing to raise while somebody is prescribing.
   */
  const diagnoses = await listCodedDiagnoses(db, patientId);
  const drugDiseaseRules = await listDrugDiseaseFor(
    db,
    checkLines.flatMap((l) => l.resolution?.salts.map((s) => s.saltId) ?? []),
    diagnoses.map((d) => d.code),
  );
  const unreviewed = await unreviewedSaltIds(
    db, checkLines.flatMap((l) => l.resolution?.salts.map((s) => s.saltId) ?? []),
  );

  return {
    allergyMatches: matchAllergiesSaltAware(checkLines, allergies),
    interactions: checkInteractions(checkLines, priors, pairs, now),
    // P23 — class duplicates are always soft, so they reach the notices and gate nothing.
    duplicates: [...checkDuplicateSalt(checkLines, priors, now), ...checkDuplicateClass(checkLines, priors, now)],
    drugDisease: checkDrugDisease(checkLines, diagnoses, drugDiseaseRules, now),
    /**
     * A resolution with NO moieties is not a checked line — it is a line about which nothing can be
     * said, and reporting it as covered is how the coverage figure and the safety path came to
     * disagree about the same line in opposite directions (C3). `null` and "resolved to nothing"
     * are the same answer to the only question this list asks.
     */
    unresolvedLineIndexes: checkLines
      .filter((l) => l.resolution === null || l.resolution.salts.length === 0)
      .map((l) => l.lineIndex),
    unreviewedLineIndexes: checkLines
      .filter((l) => l.resolution?.salts.some((s) => unreviewed.has(s.saltId)) === true)
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
  /**
   * P24 — kept as its OWN list and deliberately NOT folded into `notices`. `RxNotice` is a union
   * the browser discriminates with `"severity" in hit` (`apps/web/src/lib/opd-api.ts`), and a
   * drug-disease hit carries a severity too: adding it to that union would make every one of them
   * render as an interaction. Severe ones gate; moderate ones the screen shows beside the notices.
   */
  drugDisease: DrugDiseaseHit[];
  notices: RxNotice[];
  /** Lines the formulary does not know — the coverage-gated hint's input (T6, DD5). */
  unresolvedLineIndexes: number[];
  /** Lines with a component no pharmacist has reviewed (`RxCheckOutcome`). */
  unreviewedLineIndexes: number[];
};

/**
 * ═══ D6 — AN OFFER IS RE-CHECKED AGAINST THIS PATIENT BEFORE IT IS SHOWN ═══
 *
 * The book contradicts itself, on purpose and correctly. Its heart-failure rule offers CARVEDILOL;
 * its asthma rule forbids carvedilol. Both are right — carvedilol is a cornerstone of heart failure
 * and a danger in asthma — and a patient with both diseases is an ordinary OPD patient. A one-tap
 * switch that rendered the column verbatim would hand that patient a critical contraindication with
 * one tap, which is worse than offering nothing at all.
 *
 * So every offer is run through the SAME engine, with the offending line replaced by the offer, and
 * an offer that raises a hard warning of its own is not shown. Where every offer falls, the alert
 * keeps its clinical line and shows no button — which is the honest outcome, not a failure.
 *
 * It costs one check run per distinct offered moiety, cached and capped. That cost is paid on the
 * PRECHECK only: the issue path gates, and a gate does not need to suggest anything.
 */
const MAX_OFFERS_VETTED = 6;

async function vetOffers(
  db: Db, patientId: string, lines: RxLine[], hits: DrugDiseaseHit[], now: Date,
  opts: { excludeEncounterId?: string },
): Promise<DrugDiseaseHit[]> {
  const verdict = new Map<string, boolean>();
  let vetted = 0;

  const survives = async (hit: DrugDiseaseHit, offer: DrugDiseaseAlternative): Promise<boolean> => {
    const key = `${String(hit.lineIndex)}|${offer.moiety}`;
    const cached = verdict.get(key);
    if (cached !== undefined) return cached;
    if (vetted >= MAX_OFFERS_VETTED) return false;
    vetted += 1;

    const swapped = lines.map((line, i) => i !== hit.lineIndex
      ? line
      // The offer names a MOIETY, so the id of the drug being replaced must go with the text; a
      // stale medicineId would have the engine check the drug we are trying to get rid of.
      : { ...line, drug: offer.moiety, medicineId: undefined });
    const after = await runRxChecks(db, patientId, swapped, now, opts);
    const clean = after.allergyMatches.every((m) => m.lineIndex !== hit.lineIndex)
      && after.interactions.every((h) => h.lineIndex !== hit.lineIndex || h.severity !== "severe")
      && after.duplicates.every((h) => h.lineIndex !== hit.lineIndex || !h.hard)
      && after.drugDisease.every((h) => h.lineIndex !== hit.lineIndex || h.severity !== "severe");
    verdict.set(key, clean);
    return clean;
  };

  const vettedHits: DrugDiseaseHit[] = [];
  for (const hit of hits) {
    const kept: DrugDiseaseAlternative[] = [];
    for (const offer of hit.alternatives) {
      if (await survives(hit, offer)) kept.push(offer);
    }
    vettedHits.push({ ...hit, alternatives: kept });
  }
  return vettedHits;
}

/**
 * The pre-check route's function. It authorises exactly as the issue path does — the same
 * encounter lookup and the same treating-doctor check — because the answer describes what this
 * patient is taking, and "it only reads" has never been a reason to skip an authorisation.
 *
 * It deliberately does NOT require `in_consultation`: a doctor reviewing a draft before starting
 * the consultation gets the same warnings, and nothing is written either way.
 */
export async function precheckPrescription(
  db: Db, actor: Actor, encounterId: string, sent: RxLine[], now: Date = new Date(),
): Promise<RxPrecheckResult> {
  // The same normalisation the issue path applies, so the pre-check judges the line it will store.
  const lines = sent.map(normaliseRxLine);
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, encounter);
  const checks = await runRxChecks(db, encounter.patientId, lines, now, { excludeEncounterId: encounterId });
  const drugDisease = await vetOffers(
    db, encounter.patientId, lines, checks.drugDisease, now, { excludeEncounterId: encounterId },
  );
  return {
    allergyMatches: checks.allergyMatches,
    interactions: checks.interactions,
    drugDisease,
    duplicates: checks.duplicates,
    unresolvedLineIndexes: checks.unresolvedLineIndexes,
    unreviewedLineIndexes: checks.unreviewedLineIndexes,
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
  drugDiseaseOverrides?: RxOverride[];
};
export type IssuedPrescription = {
  prescriptionId: string; version: number; qrPayload: string; allergyOverrideCount: number;
  interactionOverrideCount: number; duplicateOverrideCount: number;
  /** Moderate interactions, vs-prior duplicates and route-differing duplicates. Data, never a gate. */
  notices: RxNotice[];
  /**
   * Lines the checks could see only in part (`RxCheckOutcome`). Returned here as well as by the
   * pre-check, because the consult screen shows the pre-check only when a hard warning pauses the
   * issue, and otherwise this response is the doctor's only answer.
   */
  unreviewedLineIndexes: number[];
};

/**
 * D5: one versioned prescription per issue; a re-issue supersedes its predecessor so exactly one row per
 * encounter is ever `active`. Version allocation runs under a FOR UPDATE of the ENCOUNTER row — a row this
 * function never writes (§3.28) — so two doctors' devices submitting at once serialize into 1 and 2 rather
 * than colliding on the (encounter_id, version) unique index.
 */
/**
 * ═══ FD-31 — WHO IS ALLOWED TO OPERATE THE KEYBOARD (OWNER RULING 2026-09-12) ═══
 *
 * Owner, on a hospital that cannot staff an assistant for every doctor: *"the staff outside the
 * doctor room types the medicine prescribed by the doctor … however, the pharmacist will cross
 * confirm the prescription slip … before generating the medicine bill."*
 *
 * `"doctor"` is the shipped road and every existing caller takes it: `requireTreatingDoctor` refuses
 * any actor without an `opd_doctors` profile for THIS encounter.
 *
 * `"paper_slip"` is the OPD Order Desk typing a prescription the doctor already signed in pen. THE
 * PRESCRIBER DOES NOT CHANGE — `doctorId` is still resolved from the ENCOUNTER, so the doctor of
 * record is the one the patient actually saw and no clerk can name a different one. What changes is
 * `transcribedBy`, which marks the row for everything downstream, and the control moves to the
 * pharmacy: `billDispense` refuses a transcribed dispense until a pharmacist has cross-confirmed
 * the slip. The paper the doctor signed remains the legal instrument; this is its transcription.
 *
 * THE PERMISSION IS ASSERTED HERE AND NOT ONLY AT THE ROUTE — the `walk-in.ts` precedent, whose
 * comment says why: a decorator writes one metadata key, so a second `@RequirePermission` silently
 * replaces the first, and an authority this consequential should not rest on a decorator nobody
 * re-reads. A caller that reaches this function with `"paper_slip"` and without the grant is
 * refused here, whatever the route did.
 */
/**
 * ═══ 2026-09-30 — `"pharmacy_paper"`: THE PHARMACIST ENTERS A PAPER PRESCRIPTION AT THE DESK ═══
 *
 * Owner, at the live counter: a registered patient arrives with a hospital doctor's PAPER
 * prescription and nobody typed it in. The pharmacist types it — the FD-31 transcription with the
 * pharmacist at the keyboard (`transcribedBy` is the pharmacist, so the desk's slip cross-confirm
 * still applies). Differences from `"paper_slip"`, each deliberate:
 *   - the grant is `pharmacy.dispense.place` (asserted here, the same reason as above);
 *   - the prescriber is the hospital doctor WRITTEN ON THE PAPER (`opts.doctorId`), defaulting to the
 *     visit's doctor — the pharmacist is reading a signed paper, not choosing a doctor;
 *   - the visit's state is not asked (the doctor who writes on paper never moved it in the system),
 *     but a visit that already carries an ACTIVE prescription is refused: this door never
 *     supersedes the doctor's own e-prescription;
 *   - NO override is accepted from this door: every hard warning refuses.
 */
export type PrescriptionAuthority = "doctor" | "paper_slip" | "pharmacy_paper";

export async function issuePrescription(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string, input: IssuePrescriptionInput, now: Date = new Date(),
  authority: PrescriptionAuthority = "doctor",
  opts: {
    doctorId?: string; outsidePrescriber?: OutsidePrescriber;
    /**
     * Owner ruling 2026-10-06 — set ONLY by `transcribePaper` (`paper-consult.ts`), which has already
     * checked the day, the doctor and the seat's grants. It lets the paper road issue for a visit the
     * doctor saw on paper and never opened on a screen, in whatever state that left it. The older
     * `…/prescription-draft/transcribe` route does not pass it and keeps its in-consultation rule.
     */
    paperStates?: boolean;
    /**
     * Set ONLY by `correctPaperPrescription`: the treating doctor correcting (or clearing a held line
     * on) a visit that carries paper work and is already closed. `requireTreatingDoctor` still runs.
     */
    paperCorrection?: boolean;
  } = {},
): Promise<IssuedPrescription> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  let transcribedBy: string | null = null;
  let doctor;
  if (authority === "pharmacy_paper") {
    if (actor.type !== "user") throw new OpdError("user_actor_required", "a transcription is a user action");
    if (!(await hasPermission(db, actor.id, "pharmacy.dispense.place", "hospital"))) {
      throw new OpdError("transcription_not_permitted", "this account may not enter a paper prescription at the pharmacy");
    }
    transcribedBy = actor.id;
    if (opts.outsidePrescriber !== undefined) {
      // 2026-09-30 — an OUTSIDE doctor's paper: no hospital prescriber; the row records who wrote it.
      if (opts.doctorId !== undefined) throw new OpdError("not_a_doctor", "a paper prescription names a hospital doctor OR an outside doctor, not both");
      if (opts.outsidePrescriber.name.trim() === "") throw new OpdError("not_a_doctor", "an outside prescription names its doctor");
      doctor = null;
    } else {
      const doctorId = opts.doctorId ?? encounter.doctorId;
      if (doctorId === null) throw new OpdError("not_a_doctor", `encounter ${encounter.id} names no doctor`);
      const signing = await getDoctor(db, doctorId);
      if (!signing) throw new OpdError("unknown_doctor", `unknown doctor ${doctorId}`);
      if (!signing.active) throw new OpdError("doctor_inactive", `doctor ${doctorId} is inactive`);
      doctor = signing;
    }
    if (input.overrides?.length || input.interactionOverrides?.length || input.duplicateOverrides?.length || input.drugDiseaseOverrides?.length) {
      throw new OpdError("override_reason_required", "a paper prescription entered at the pharmacy carries no override");
    }
  } else if (authority === "paper_slip") {
    if (actor.type !== "user") throw new OpdError("user_actor_required", "a transcription is a user action");
    if (!(await hasPermission(db, actor.id, "opd.prescription.transcribe", "hospital"))) {
      throw new OpdError("transcription_not_permitted", "this account may not type a prescription from a paper slip");
    }
    if (encounter.doctorId === null) {
      throw new OpdError("not_a_doctor", `encounter ${encounter.id} names no doctor to transcribe for`);
    }
    const signing = await getDoctor(db, encounter.doctorId);
    if (!signing) throw new OpdError("unknown_doctor", `unknown doctor ${encounter.doctorId}`);
    doctor = signing;
    transcribedBy = actor.id;
    /*
      Owner ruling 2026-10-06 — A SCRIBE CLEARS NO WARNING. Clearing an allergy conflict, a severe
      interaction, a repeated salt or a contraindication is a clinical judgement with a reason
      recorded against the prescriber. The desk typed the paper; it did not make that judgement, so
      an override arriving on this road is refused and the line waits for the doctor.
    */
    if (input.overrides?.length || input.interactionOverrides?.length || input.duplicateOverrides?.length || input.drugDiseaseOverrides?.length) {
      throw new OpdError("override_reason_required", "a prescription typed from paper carries no override — the line is held for the doctor");
    }
  } else {
    doctor = await requireTreatingDoctor(db, actor, encounter);
  }
  /*
    WHEN A PRESCRIPTION MAY BE ISSUED. In consultation, as always. And (owner ruling 2026-10-06) on a
    visit the doctor saw ON PAPER: the treating doctor may correct what the desk typed after the
    visit was closed (`paperCorrection`), and the paper road itself (`paperStates`) may issue in any
    state but abandoned.
  */
  if (authority === "doctor" && opts.paperCorrection !== true) refuseIfClosedOnPaper(encounter);
  const stateOk = authority === "pharmacy_paper"
    || encounter.status === "in_consultation"
    || (authority === "doctor" && opts.paperCorrection === true && encounter.status === "completed")
    || (authority === "paper_slip" && opts.paperStates === true && encounter.status !== "abandoned");
  if (!stateOk) {
    throw new OpdError("encounter_state_conflict", `a prescription is issued in consultation, not ${encounter.status}`);
  }
  // Owner 2026-10-09 — a tele-call's prescription is the doctor's only after they have spoken to the patient.
  if (authority === "doctor") refuseTeleBeforeSpoke(encounter);

  // A tapered line's frequency and duration are the SERVER's, written from its steps before the
  // "every line needs a frequency" check below — so the checks, the stored row and the FHIR
  // document all read the same normalised line. A draft issues through here too.
  const lines = input.lines.map(normaliseRxLine);
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

  /**
   * P24 — the fourth hard warning, in the same grammar. Only a SEVERE drug-disease hit gates, and
   * `checkDrugDisease` has already downgraded anything resting on a diagnosis over a year old, so
   * a stale code can raise a notice here but can never refuse a prescription.
   */
  const severeDrugDisease = checks.drugDisease.filter((h) => h.severity === "severe");
  const drugDiseaseOverrides = input.drugDiseaseOverrides ?? [];
  const uncoveredDrugDisease = severeDrugDisease.filter((h) => !drugDiseaseCovered(h, drugDiseaseOverrides));
  if (uncoveredDrugDisease.length > 0) {
    throw new OpdError(
      "drug_disease_conflict",
      `${uncoveredDrugDisease.length} line(s) are contraindicated by a diagnosis this patient carries`,
      // NOT `hits`: the three older refusals put interaction and duplicate hits under that name and
      // the browser filters them with `isInteractionHit`, which a drug-disease hit would fool.
      { diseaseHits: severeDrugDisease },
    );
  }

  const matchedInteractionOverrides = interactionOverrides.filter((o) => severeHits.some((h) => interactionCovered(h, [o])));
  const matchedDuplicateOverrides = duplicateOverrides.filter((o) => hardDuplicates.some((h) => duplicateCovered(h, [o])));
  const matchedDrugDiseaseOverrides = drugDiseaseOverrides.filter((o) => severeDrugDisease.some((h) => drugDiseaseCovered(h, [o])));

  // ONE reason gate for all FOUR kinds, reusing the shipped constant and the shipped code (DD3).
  for (const override of [
    ...matchedOverrides, ...matchedInteractionOverrides, ...matchedDuplicateOverrides,
    ...matchedDrugDiseaseOverrides,
  ]) {
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
    if (authority === "pharmacy_paper") {
      const active = await tx.select({ id: opdPrescriptions.id }).from(opdPrescriptions)
        .where(and(eq(opdPrescriptions.encounterId, encounterId), eq(opdPrescriptions.status, "active")));
      if (active.length > 0) {
        throw new OpdError("encounter_state_conflict", `visit ${encounter.visitNo} already carries the doctor's prescription — dispense that one`);
      }
    }

    await tx
      .update(opdPrescriptions)
      .set({ status: "superseded" })
      .where(and(eq(opdPrescriptions.encounterId, encounterId), eq(opdPrescriptions.status, "active")));

    const prescriptionId = newId();
    /* The Condition carries the PRIMARY code (`encounter.icd10Code`), so its eye is that row's eye. */
    const primary = (await visitDiagnoses(tx, encounterId)).find((d) => d.icd10Code !== null && d.icd10Code === encounter.icd10Code);
    const outside = opts.outsidePrescriber;
    const document = toFhirBundle({
      prescriptionId, version, encounterId, patientId: encounter.patientId, doctorId: doctor?.id ?? null,
      outsidePrescriber: outside === undefined ? undefined : { name: outside.name.trim(), registrationNo: outside.registrationNo },
      issuedAt: now, diagnosis: encounter.diagnosis, icd10Code: encounter.icd10Code, laterality: primary?.laterality ?? null, lines,
    });
    await tx.insert(opdPrescriptions).values({
      id: prescriptionId, encounterId, patientId: encounter.patientId, doctorId: doctor?.id ?? null, version,
      ...(outside === undefined ? {} : {
        outsidePrescriberName: outside.name.trim(), outsidePrescriberRegNo: outside.registrationNo, outsidePrescriberAddress: outside.address,
      }),
      lines, document, allergyOverrides: matchedOverrides,
      // C4 — the justification for prescribing through a severe interaction is a medico-legal
      // record, not a transient. It used to be validated, counted, and dropped.
      interactionOverrides: matchedInteractionOverrides,
      duplicateOverrides: matchedDuplicateOverrides,
      drugDiseaseOverrides: matchedDrugDiseaseOverrides,
      status: "active", issuedBy: actor.id, transcribedBy, issuedAt: now,
    });
    /* Decision 0050, P0 — the countable copy, in this transaction: what was issued is what is learned from. */
    await writeCdsRxLines(tx, {
      prescriptionId, encounterId, doctorId: doctor?.id ?? null, lines,
      overrides: [...matchedOverrides, ...matchedInteractionOverrides, ...matchedDuplicateOverrides, ...matchedDrugDiseaseOverrides],
      transcribed: transcribedBy !== null, issuedAt: now,
    });
    await appendEvent(tx, prescriptionIssued.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        prescriptionId, encounterId, patientId: encounter.patientId, doctorId: doctor?.id ?? null,
        version, lineCount: lines.length, allergyOverrideCount: matchedOverrides.length,
        interactionOverrideCount: matchedInteractionOverrides.length,
        duplicateOverrideCount: matchedDuplicateOverrides.length,
        unreviewedLineIndexes: checks.unreviewedLineIndexes,
      },
    }));
    return {
      prescriptionId, version,
      qrPayload: buildRxQrPayload(cfg, { id: prescriptionId, encounterId, version }),
      allergyOverrideCount: matchedOverrides.length,
      interactionOverrideCount: matchedInteractionOverrides.length,
      duplicateOverrideCount: matchedDuplicateOverrides.length,
      notices,
      unreviewedLineIndexes: checks.unreviewedLineIndexes,
    };
  });
}

/**
 * 2026-09-30 — the pharmacy's ONE door into issuing: a paper prescription the pharmacist types at the
 * desk (`"pharmacy_paper"` above). Exported narrowly so no other module gains the doctor's road.
 */
export type OutsidePrescriber = { name: string; registrationNo: string | null; address: string | null };

export async function issuePharmacyPaperPrescription(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string,
  input: { lines: RxLine[]; doctorId?: string; outsidePrescriber?: OutsidePrescriber }, now: Date = new Date(),
): Promise<IssuedPrescription> {
  return issuePrescription(db, actor, cfg, encounterId, { lines: input.lines }, now, "pharmacy_paper", {
    ...(input.doctorId === undefined ? {} : { doctorId: input.doctorId }),
    ...(input.outsidePrescriber === undefined ? {} : { outsidePrescriber: input.outsidePrescriber }),
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

/**
 * PLAN 16c T0a — ONE prescription by id, for the dispensing counter.
 *
 * The id arrives from a scanned `rx1…` payload or a queued dispense row and is not a capability
 * (07a T1): the row is found first, then its ENCOUNTER is put through the same read gate
 * `listPrescriptions` walks, and an unknown id and an invisible patient give the same `null`. The
 * read is a PHI access and is logged on the prescriptions surface (`PhiSurface` is a closed kernel
 * union; a pharmacy-specific surface is a kernel edit this task does not make).
 */
export async function getPrescription(db: Db, actor: Actor, prescriptionId: string): Promise<PrescriptionRow | null> {
  const rows = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, prescriptionId)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const seen = await visibleEncounterFor(db, actor, row.encounterId);
  if (!seen) return null;
  await recordPhiAccess(db, {
    actor, patientId: seen.encounter.patientId, surface: "opd.prescriptions", encounterId: row.encounterId,
    sealed: seen.sealed, reason: seen.breakGlass?.reason ?? null,
  });
  return row;
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
  // 2026-09-30 — an OUTSIDE doctor's paper prescription names its prescriber on the row itself.
  const doctor = row.doctorId === null
    ? { displayName: `${row.outsidePrescriberName ?? "outside prescriber"} (outside)`, registrationNo: row.outsidePrescriberRegNo }
    : await getDoctor(db, row.doctorId);
  return {
    ok: true,
    prescription: { id: row.id, version: row.version, issuedAt: row.issuedAt, lines: row.lines as RxLine[] },
    patient: { uhid: summary!.uhid, name: summary!.name, alias: summary!.alias, restricted: summary!.restricted },
    doctor: { displayName: doctor!.displayName, registrationNo: doctor!.registrationNo },
  };
}

export type RxPrintData = {
  letterhead: Letterhead;
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean; ageYears: number | null; administrativeGender: string };
  /**
   * Never the name (owner 2026-09-06, 2026-09-28, 2026-10-04). Owner 2026-10-04: `unitNumber` is the
   * prescriber's unit that day ("Unit I") or — Guest Faculty and (DECIDED) anyone in no unit — their
   * Doctor ID; `deptRegn` is the DEPARTMENT registration number: that day's unit head's council number
   * (`prescriberPrint`), null (prints blank) when there is no unit or no number on file.
   */
  doctor: { unitNumber: string; deptRegn: string | null; departmentName: string | null };
  encounter: {
    id: string; visitNo: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null;
    advice: string | null; followUpDays: number | null; chiefComplaint: string | null;
    /**
     * Owner 2026-10-09 — this prescription came out of a TELE-CALL. The sheet prints one boxed line
     * under the doctor's lines — "Tele-consultation · patient not examined" — because whoever reads
     * it (a pharmacist, another doctor, a relative) must know nobody examined the patient. False on
     * every in-person visit, where nothing extra is printed.
     */
    tele: boolean;
    /**
     * PLAN 07d T5 / DD4 — the advised tests, printed as ADVICE. They ride the print payload because
     * the printed slip is where a patient reads them and where they take them to the counter — and
     * `advisedAsOf` is the service date rather than a fresh timestamp, so the sheet says which day's
     * prices it is quoting (E-9: the slip carries the as-of date, the counter reprices).
     */
    advisedTests: AdvisedTest[];
    /**
     * Decision 0065 (owner 2026-10-10) — which of `advisedTests` the hospital does NOT do: the outside
     * catalogue's `outside` rows. The sheet prints them under "Tests to be done outside", with no price.
     */
    outsideTestIds: string[];
    /**
     * The coded rows, each with its eye (board "Ophthal"). `diagnosis`/`icd10Code` above are the
     * display string and the PRIMARY code, and neither can say which eye each tag is — so a print
     * that names the eye renders from these, and one without any eye is unchanged.
     */
    diagnoses: VisitDiagnosis[];
  };
  vitals: VitalsRow | null;
  lines: RxLine[];
  qrPayload: string;
  version: number;
  issuedAt: Date;
  /**
   * Owner ruling 2026-10-06 — who TYPED this prescription from the doctor's paper, or null when the
   * doctor keyed it. A print of a transcription must not pass for a doctor-signed e-prescription:
   * the renderer says "typed from the doctor's paper prescription by <name>" and that the signed
   * paper is the original. A staff NAME, never the doctor's (the 2026-09-06 ruling is about the
   * prescriber; this is the desk that held the keyboard).
   */
  transcribedByName: string | null;
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

  // 2026-09-30 — an OUTSIDE doctor's paper prescription is his own paper; the hospital prints none for it.
  if (row.doctorId === null) throw new OpdError("unknown_prescription", `prescription ${prescriptionId} is an outside doctor's paper — the hospital prints no prescription for it`);
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
      /**
       * PLAN 22c-A T4/DD4 — the e-Rx prints ADMINISTRATIVE GENDER. A prescription is a document,
       * and a document says who the person is rather than what their reference ranges are.
       *
       * `ageYears` beside it is already computed as-of-ISSUE (`row.issuedAt`), and has been since
       * this function was written — spike S4 measured it. `name` and this field are still read
       * from the LIVE summary, so one document currently renders two different as-of dates: the
       * Medanta failure (`01-MEDANTA-TEARDOWN.md` P1) in miniature, in our own tree. kernel-D T6
       * owns closing that with `resolveIdentityAt`; this task's job was only to make sure the
       * value being printed is the right COLUMN when it does.
       */
      ageYears: summary!.dob === null ? null : ageYearsAt(summary!.dob, row.issuedAt),
      administrativeGender: summary!.administrativeGender,
    },
    /*
      THE PRESCRIBER IS THE DOCTOR ID — owner rulings 2026-09-06 ("As a medical Institution with
      college, there's no need of mentioning Dr. Name and their registration number. Only Dr. ID is
      required.") and 2026-09-28 ("Prescription print: Doctor ID only"). The name and the council
      number are not on this payload at all, so no renderer can print them by accident. (The QR
      VERIFY answer still names the doctor: it is the pharmacist's check, not the patient's paper.)
    */
    doctor: await (async () => {
      const p = await prescriberPrint(db, { userId: doctor!.userId, code: doctor!.code }, { istDate: encounter.serviceDate, opdDepartmentId: encounter.departmentId });
      return { unitNumber: p.unitNumber, deptRegn: p.deptRegn, departmentName: department?.name ?? null };
    })(),
    encounter: {
      id: encounter.id, visitNo: encounter.visitNo, serviceDate: encounter.serviceDate, diagnosis: encounter.diagnosis, icd10Code: encounter.icd10Code,
      advice: encounter.advice, followUpDays: encounter.followUpDays, chiefComplaint: encounter.chiefComplaint,
      tele: encounter.consultMode === "tele",
      // Read back verbatim; `[]` when the doctor advised none, so the renderer needs no null branch.
      advisedTests: Array.isArray(encounter.advisedTests) ? (encounter.advisedTests as AdvisedTest[]) : [],
      outsideTestIds: await outsideAmong(db, Array.isArray(encounter.advisedTests) ? (encounter.advisedTests as AdvisedTest[]) : []),
      diagnoses: await visitDiagnoses(db, encounter.id),
    },
    vitals: vitals[vitals.length - 1] ?? null, // the LATEST reading — a danger flag never auto-clears (D4)
    lines: row.lines as RxLine[],
    qrPayload: buildRxQrPayload(cfg, { id: row.id, encounterId: row.encounterId, version: row.version }),
    version: row.version,
    issuedAt: row.issuedAt,
    transcribedByName: row.transcribedBy === null ? null
      : (await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, row.transcribedBy)))[0]?.fullName ?? "the desk",
  };
}

/** Decision 0065 — the advised tests the outside catalogue says are done outside the hospital. */
async function outsideAmong(db: Db, advised: readonly AdvisedTest[]): Promise<string[]> {
  if (advised.length === 0) return [];
  const rows = await db.select({ serviceId: outsideTests.serviceId }).from(outsideTests)
    .where(and(inArray(outsideTests.serviceId, advised.map((a) => a.serviceId)), eq(outsideTests.site, "outside"), eq(outsideTests.active, true)));
  return rows.map((r) => r.serviceId);
}
