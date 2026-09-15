import { rulesOf } from "./knowledge";
import type { BuiltRegimen, PatientFacts } from "./regimen";

/**
 * ═══ "AUTOMATICALLY HIGHLIGHT THE DANGERS" (owner, 2026-09-14) ═══
 *
 * *"I wanted the OS to be ready to automatically highlight dangers of the medicine if the patient
 * is a child, pregnant or has an allergy."* Three of those are decidable from the record and one is
 * not, and the difference is the whole design of this file.
 *
 *   · CHILD    — the weight is on the vitals chart. Decidable.
 *   · ALLERGY  — the allergy list is on the patient record. Decidable, and already acted on by
 *                `regimen.ts`, which removes the drug. The card here reports what was removed.
 *   · PREGNANT — **this hospital records it nowhere.** There is no pregnancy column on the
 *                encounter, the patient or the vitals chart; measured, not assumed. So the co-pilot
 *                does not decide it: for a woman of childbearing age with no answer on file it
 *                RAISES THE QUESTION, and the teratogen rules fire only once a human has answered.
 *                An unasked question is the failure mode that reaches a foetus; a guessed answer is
 *                the one that reaches it faster.
 *
 * Every card names the rule that produced it, so a doctor can see WHY and disagree with it.
 */
export type Card = {
  kind: "allergy" | "pediatric" | "pregnancy" | "pregnancy_unknown" | "g6pd" | "qtc" | "stewardship";
  severity: "red" | "amber" | "info";
  title: string;
  detail: string;
  /** The drug lines this card is about, by label, so the screen can point at them. */
  drugs: string[];
  /** What the bundle offers instead, when it offers anything. */
  alternatives: string[];
  /** The bundle's own rule id — a card with no provenance is an opinion. */
  ruleKeys: string[];
};

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/** A rule's subject matches a drug label when they share a word of five letters or more. */
function hits(subject: unknown, label: string): boolean {
  const want = tokens(String(subject ?? ""));
  if (want.length === 0) return false;
  const have = tokens(label);
  return want.some((t) => have.includes(t));
}

/**
 * CHILDBEARING AGE IS A WINDOW, NOT A GUESS ABOUT ANYONE. 12 to 50 is deliberately wide: the cost
 * of asking a question that turns out not to apply is ten seconds, and the cost of not asking is a
 * first-trimester teratogen. Sex is read from the record; where it is unknown the question is still
 * asked, because "unknown" is not "no".
 */
function mayBePregnant(p: PatientFacts, sex: string | null): boolean {
  if (p.pregnant) return false; // already answered yes — the real rules fire instead
  if (sex !== null && sex.toLowerCase().startsWith("m")) return false;
  return p.ageYears === null || (p.ageYears >= 12 && p.ageYears <= 50);
}

export function cardsFor(r: BuiltRegimen, p: PatientFacts, sex: string | null): Card[] {
  const cards: Card[] = [];
  const labels = r.lines.map((l) => l.drugLabel);

  // ── allergy: report what the regimen already removed, never merely "consider" ────────────────
  const blocked = r.lines.filter((l) => l.dose.state === "blocked");
  const swapped = r.lines.filter((l) => l.substitutedFor !== undefined);
  if (blocked.length > 0 || swapped.length > 0) {
    cards.push({
      kind: "allergy", severity: "red",
      title: `Allergy on file — ${blocked.length + swapped.length} line(s) changed`,
      detail: [
        ...swapped.map((l) => `${l.substitutedFor!} → ${l.drugLabel}`),
        ...blocked.map((l) => `${l.drugLabel} removed — no substitute in the bundle`),
      ].join("; "),
      drugs: [...swapped.map((l) => l.substitutedFor!), ...blocked.map((l) => l.drugLabel)],
      alternatives: blocked.flatMap((l) => (l.dose as { safeAlternatives?: string[] }).safeAlternatives ?? []),
      ruleKeys: r.appliedConditions,
    });
  }

  // ── child: the dose questions, surfaced together rather than one per line ────────────────────
  if (r.band === "pediatric") {
    const noWeight = r.lines.filter((l) => l.dose.state === "no_weight");
    const review = r.lines.filter((l) => l.dose.state === "needs_review" && l.substitutedFor === undefined);
    if (noWeight.length > 0) {
      cards.push({
        kind: "pediatric", severity: "red", title: "No weight on file — paediatric doses cannot be computed",
        detail: "Record the child's weight at the vitals bay; these lines are weight-based and will not be calculated without it.",
        drugs: noWeight.map((l) => l.drugLabel), alternatives: [], ruleKeys: ["WEIGHT"],
      });
    }
    if (review.length > 0) {
      cards.push({
        kind: "pediatric", severity: "amber", title: `${review.length} paediatric dose(s) await clinical review`,
        detail: "The bundle gives these as a worked example for a 14 kg child, not as a mg/kg rate. The example is shown; no dose has been calculated.",
        drugs: review.map((l) => l.drugLabel), alternatives: [], ruleKeys: ["DERIVED_UNREVIEWED"],
      });
    }
  }

  // ── pregnancy: the answered case, and the unasked one ────────────────────────────────────────
  const pregRules = rulesOf("pregnancy_trimester_rules");
  if (p.pregnant) {
    for (const rule of pregRules) {
      const affected = labels.filter((l) => hits(rule.subject, l));
      if (affected.length > 0) {
        cards.push({
          kind: "pregnancy", severity: "red",
          title: `Pregnancy — ${String(rule.subject)} (${String((rule.payload as { stage?: string }).stage ?? "")})`,
          detail: rule.message ?? "", drugs: affected, alternatives: asList(rule.action), ruleKeys: [rule.ruleKey],
        });
      }
    }
  } else if (mayBePregnant(p, sex)) {
    const risky = labels.filter((l) => pregRules.some((rule) => hits(rule.subject, l)));
    cards.push({
      kind: "pregnancy_unknown", severity: risky.length > 0 ? "red" : "info",
      title: "Is she pregnant?",
      detail: risky.length > 0
        ? "This hospital records no pregnancy status, and this regimen contains a drug the bundle flags in pregnancy. Confirm before prescribing."
        : "This hospital records no pregnancy status. Nothing in this regimen is flagged, but the question is unanswered.",
      drugs: risky, alternatives: [],
      /*
        THE PROVENANCE OF THE QUIET CASE IS OUR OWN GAP, not a rule in the bundle — so it says so,
        rather than carrying nothing. A card with an empty provenance is an assertion the doctor
        cannot trace, and the invariant that every card names its source is worth more than the
        tidiness of leaving this one blank.
      */
      ruleKeys: risky.length > 0 ? pregRules.map((x) => x.ruleKey) : ["NO_PREGNANCY_FIELD"],
    });
  }

  // ── G6PD: never on file either, so it is a question attached to the drugs that care ──────────
  const g6pd = rulesOf("g6pd_rules").filter((rule) => labels.some((l) => hits(rule.subject, l)));
  if (g6pd.length > 0) {
    cards.push({
      kind: "g6pd", severity: "amber", title: "G6PD status unknown — haemolysis risk",
      detail: g6pd.map((x) => `${String(x.subject)}: ${x.message ?? ""}`).join(" "),
      drugs: g6pd.flatMap((rule) => labels.filter((l) => hits(rule.subject, l))),
      alternatives: g6pd.flatMap((x) => asList(x.action)), ruleKeys: g6pd.map((x) => x.ruleKey),
    });
  }

  // ── QTc: CredibleMeds points, summed across the regimen (the owner's "risk meter") ───────────
  const qt = rulesOf("qtc_rules").filter((rule) => labels.some((l) => hits(rule.subject, l)));
  if (qt.length > 0) {
    const points = qt.reduce((n, x) => n + Number((x.payload as { points?: number }).points ?? 0), 0);
    cards.push({
      kind: "qtc", severity: points >= 5 ? "red" : "amber",
      title: `Cumulative QTc risk — ${points} point(s)`,
      detail: qt.map((x) => `${String(x.subject)} (${String((x.payload as { points?: number }).points ?? 0)}): ${x.message ?? ""}`).join(" "),
      drugs: qt.flatMap((rule) => labels.filter((l) => hits(rule.subject, l))),
      alternatives: [], ruleKeys: qt.map((x) => x.ruleKey),
    });
  }

  // ── stewardship: WHO AWaRe tier and the empirical day cap ────────────────────────────────────
  const amsp = rulesOf("amsp_rules").filter((rule) => labels.some((l) => hits(rule.subject, l)));
  for (const rule of amsp) {
    const pay = rule.payload as { category?: string; max_days?: number; micro_order?: string };
    cards.push({
      kind: "stewardship", severity: pay.category === "Access" ? "info" : "amber",
      title: `AWaRe ${pay.category ?? "?"} — ${String(rule.subject)}`,
      detail: `Empirical cap ${String(pay.max_days ?? "?")} days. Culture before starting: ${pay.micro_order ?? "?"}.`,
      drugs: labels.filter((l) => hits(rule.subject, l)),
      alternatives: asList(rule.action), ruleKeys: [rule.ruleKey],
    });
  }

  return cards;
}
