import { api } from "./api";

/**
 * ═══ THE CO-PILOT'S WIRE — TWO READS AND NO DECISIONS ═══
 *
 * Both routes are advisory. `suggest` sees no patient at all (the doctor's own words matched
 * against the bundle's keywords, server-side, with no model in the path); `regimen` takes an
 * encounter id and reads every dosing input — weight, age, allergies — from that patient's record.
 *
 * **The weight is deliberately NOT a parameter.** A millilitre figure computed from a number this
 * client could set is a dose a bug could choose, so the screen cannot supply one even by accident.
 * The single thing it may assert is `pregnant`, because the hospital records that nowhere and the
 * doctor is the only one who can answer it — and `undefined` is a third state that means UNASKED.
 */
export type WireSyndromeHit = { key: string; name: string; icd10: string | null; score: number; matched: string[] };

export type WireDoseVerdict =
  | { state: "computed"; mg: number; ml: number | null; basis: string }
  | { state: "blocked"; basis: string; safeAlternatives: string[] }
  | { state: "fixed"; basis: string }
  | { state: "advice_only"; basis: string }
  | { state: "needs_review"; basis: string; example: string }
  | { state: "no_weight"; basis: string };

export type WireRxDraft = {
  drug: string; dose: string; route: string; frequency: string;
  durationDays: number | null; instructions: string; noSubstitution: boolean;
};

export type WireRegimenLine = {
  band: "adult" | "pediatric"; seq: number; drugLabel: string; purpose: string | null;
  sig: string; duration: string | null;
  dose: WireDoseVerdict; substitutedFor?: string; substitutionReason?: string;
  rx: WireRxDraft;
};

export type WireCard = {
  kind: "allergy" | "pediatric" | "pregnancy" | "pregnancy_unknown" | "g6pd" | "qtc" | "stewardship";
  severity: "red" | "amber" | "info";
  title: string; detail: string; drugs: string[]; alternatives: string[]; ruleKeys: string[];
};

export type WireRegimen = {
  regimen: {
    syndrome: { key: string; name: string; icd10: string | null };
    band: "adult" | "pediatric";
    lines: WireRegimenLine[];
    appliedConditions: string[];
  };
  cards: WireCard[];
  facts: { weightKg: number | null; ageYears: number | null; allergies: string[]; pregnant: boolean | null };
};

export const suggestSyndromes = (complaint: string): Promise<{ items: WireSyndromeHit[] }> =>
  api("GET", `/opd/cds/suggest?complaint=${encodeURIComponent(complaint)}`);

export const fetchRegimen = (syndromeKey: string, encounterId: string, pregnant?: boolean): Promise<WireRegimen> =>
  api("GET", `/opd/cds/regimen?syndromeKey=${encodeURIComponent(syndromeKey)}&encounterId=${encodeURIComponent(encounterId)}${pregnant === undefined ? "" : `&pregnant=${String(pregnant)}`}`);
