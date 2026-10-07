/**
 * PHONE CONSULT (decision 0048, owner 2026-10-07) — the reading rules of the doctor's phone
 * consultation: what a visit's draft is, how it becomes the bodies the consultation routes already
 * take, what a warning needs before a line may be issued, and how much of a spoken note the doctor
 * changed. PURE: no imports, no I/O — the phone reads this file by path (metro.config.js), and the
 * web may too. It decides nothing clinical: every check is the server's, at pre-check and again at
 * issue.
 */

/** Where a line came from. Stored on the issued line for audit; no check reads it, no print shows it. */
export type LineSource = "typed" | "voice" | "search" | "set" | "repeat";
export type ConsultLine = {
  /** Absent on a draft saved before this field existed, and on a line a computer typed. */
  source?: LineSource | null;
  drug: string; dose: string; frequency: string; durationDays: number | null;
  food: "before" | "after" | null; instructions: string; route: string; medicineId: string | null;
  /** Shown beside a line that came from "Repeat last" or a set and was then changed, or was added new. */
  mark?: "changed" | "new" | null; was?: string | null;
};
export type ConsultTest = { serviceId: string; code: string; name: string; pricePaise: number };
export type ConsultDx = { text: string; icd10Code: string | null };
export type ConsultDraft = {
  v: 1; encounterId: string;
  complaints: string[]; notes: string;
  diagnoses: ConsultDx[];
  lines: ConsultLine[];
  tests: ConsultTest[];
  adviceChips: string[]; adviceText: string; adviceLang: "en" | "hi";
  /** "Review after N days" — printed advice. The free follow-up window is `followUpSend`, the hospital's own rule. */
  reviewDays: number | null; followUpSend: number | null;
  /** Tests were ordered and the patient returns today with the reports — the visit then waits, it does not close. */
  returnToday?: boolean;
  /** Reasons the doctor typed for hard warnings, by `warningKey`. */
  reasons: Record<string, string>;
  /** Where the lines came from, for the card's corner: a set's name, or "repeat:<date>". */
  from: string | null;
  updatedAt: number;
};

export const DOSES = ["½", "1 tab", "2 tab", "5 ml", "10 ml"] as const;
export const FREQUENCIES = ["OD", "BD", "TDS", "QID", "HS", "SOS"] as const;
export const DAY_CHOICES = [3, 5, 7, 10, 15, 30] as const;
export const REVIEW_CHOICES = [3, 5, 7, 15, 30] as const;
export const MAX_LINES = 30;
export const MAX_TESTS = 20;
export const MAX_DIAGNOSES = 12;

export function emptyDraft(encounterId: string, now: number): ConsultDraft {
  return {
    v: 1, encounterId, complaints: [], notes: "", diagnoses: [], lines: [], tests: [],
    adviceChips: [], adviceText: "", adviceLang: "en", reviewDays: null, followUpSend: null, reasons: {}, from: null, updatedAt: now,
  };
}

/** A draft read back from the phone's store. Anything that is not this build's shape is not a draft. */
export function parseDraft(raw: string | null, encounterId: string): ConsultDraft | null {
  if (raw === null) return null;
  try {
    const d = JSON.parse(raw) as Partial<ConsultDraft>;
    if (d.v !== 1 || d.encounterId !== encounterId || !Array.isArray(d.lines) || !Array.isArray(d.tests) || !Array.isArray(d.diagnoses)) return null;
    return { ...emptyDraft(encounterId, typeof d.updatedAt === "number" ? d.updatedAt : 0), ...d } as ConsultDraft;
  } catch {
    return null;
  }
}

export function isEmptyDraft(d: ConsultDraft): boolean {
  return d.complaints.length === 0 && d.notes.trim() === "" && d.diagnoses.length === 0 && d.lines.length === 0
    && d.tests.length === 0 && d.adviceChips.length === 0 && d.adviceText.trim() === "" && d.reviewDays === null;
}

/** One line as the card and the pharmacy read it: "Paracetamol 500 mg · 1 tab · TDS · 5 days". */
export function lineText(l: ConsultLine, days: (n: number) => string): string {
  return [l.drug, l.dose, l.frequency, l.durationDays === null ? null : days(l.durationDays)].filter((x) => x !== null && x !== "").join(" · ");
}
export function lineSub(l: ConsultLine, food: { before: string; after: string }): string {
  return [l.food === null ? null : food[l.food], l.instructions.trim() === "" ? null : l.instructions.trim()].filter((x) => x !== null).join(" · ");
}

/** A line is complete when the issue route would take it: a drug, a dose and a frequency (the route defaults). */
export function lineComplete(l: ConsultLine): boolean {
  return l.drug.trim() !== "" && l.dose.trim() !== "" && l.frequency.trim() !== "";
}

/** The line as `POST /opd/visits/:id/prescriptions` and the pre-check take it. */
export function wireLine(l: ConsultLine, food: { before: string; after: string }): {
  drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; noSubstitution: boolean; medicineId?: string; source?: LineSource;
} {
  const ins = lineSub(l, food);
  return {
    drug: l.drug.trim(), dose: l.dose.trim(), route: l.route.trim() === "" ? "oral" : l.route.trim(), frequency: l.frequency.trim(),
    durationDays: l.durationDays, instructions: ins === "" ? null : ins, noSubstitution: false,
    ...(l.medicineId === null ? {} : { medicineId: l.medicineId }),
    ...(l.source === undefined || l.source === null ? {} : { source: l.source }),
  };
}

/** The advice as it prints: the chips, the typed line, and the review — one sentence each. */
export function adviceOf(d: ConsultDraft, review: (n: number) => string): string | null {
  const parts = [...d.adviceChips, d.adviceText.trim(), d.reviewDays === null ? "" : review(d.reviewDays)].map((p) => p.trim()).filter((p) => p !== "");
  return parts.length === 0 ? null : parts.map((p) => (/[.!?।]$/.test(p) ? p : `${p}.`)).join(" ");
}

/**
 * The note body (`PUT /opd/visits/:id/consult/note`, and the completion's `note`). `rxDraft` is
 * always NAMED: while the lines are unissued they ride as the visit's own draft rows (so the
 * computer shows them too), and the completion sends `null` after the issue — which is exactly
 * what tells the server nothing was left behind.
 */
export function noteBody(d: ConsultDraft, review: (n: number) => string, food: { before: string; after: string }, rx: "draft" | "issued"): Record<string, unknown> {
  return {
    chiefComplaint: d.complaints.length === 0 ? null : d.complaints.join(", "),
    doctorNote: d.notes.trim() === "" ? null : d.notes.trim(),
    diagnoses: d.diagnoses.length === 0 ? null : d.diagnoses.map((x) => ({ text: x.text, icd10Code: x.icd10Code })),
    advice: adviceOf(d, review),
    advisedTests: d.tests.length === 0 ? null : d.tests.map((t) => ({ serviceId: t.serviceId, code: t.code, name: t.name, pricePaise: t.pricePaise })),
    rxDraft: rx === "issued" ? null : d.lines.map((l) => {
      const w = wireLine(l, food);
      return { drug: w.drug, dose: w.dose, route: w.route, frequency: w.frequency, durationDays: w.durationDays, instructions: w.instructions ?? "", noSubstitution: false, ...(l.medicineId === null ? {} : { medicineId: l.medicineId }) };
    }),
  };
}

// ——— warnings: the server's pre-check, read for the line it is about ———

export type WirePrecheck = {
  allergyMatches: { lineIndex: number; substance: string }[];
  interactions: { severity: "severe" | "moderate"; lineIndex: number; saltPair: [string, string]; note: string; against: { scope: string; lineIndex?: number } }[];
  duplicates: { moiety: string; lineIndex: number; hard: boolean; drugClass?: string; with?: string }[];
  drugDisease: { severity: "severe" | "moderate"; lineIndex: number; moiety: string; icd10Prefix: string; icd10Title: string; diagnosis: { text: string } }[];
  notices?: unknown[];
};
export type LineWarning =
  | { kind: "allergy"; hard: true; lineIndex: number; key: string; substance: string }
  | { kind: "interaction"; hard: boolean; lineIndex: number; key: string; saltPair: [string, string]; note: string }
  | { kind: "duplicate"; hard: boolean; lineIndex: number; key: string; moiety: string; drugClass: string | null }
  | { kind: "disease"; hard: boolean; lineIndex: number; key: string; moiety: string; icd10Prefix: string; title: string };

/** A warning's identity: the line's DRUG and what the warning is about — so a reason typed for it survives a re-check and does not attach to another line. */
export function warningsOf(p: WirePrecheck | null, lines: readonly ConsultLine[]): LineWarning[] {
  if (p === null) return [];
  const drug = (i: number): string => (lines[i]?.drug ?? "").trim().toLowerCase();
  const out: LineWarning[] = [];
  for (const a of p.allergyMatches) out.push({ kind: "allergy", hard: true, lineIndex: a.lineIndex, key: `allergy|${drug(a.lineIndex)}|${a.substance.toLowerCase()}`, substance: a.substance });
  for (const h of p.interactions) {
    const pair = [...h.saltPair].sort() as [string, string];
    out.push({ kind: "interaction", hard: h.severity === "severe", lineIndex: h.lineIndex, key: `interaction|${drug(h.lineIndex)}|${pair.join("+").toLowerCase()}`, saltPair: h.saltPair, note: h.note });
  }
  for (const h of p.duplicates) out.push({ kind: "duplicate", hard: h.hard, lineIndex: h.lineIndex, key: `duplicate|${drug(h.lineIndex)}|${h.moiety.toLowerCase()}`, moiety: h.moiety, drugClass: h.drugClass ?? null });
  for (const h of p.drugDisease) out.push({ kind: "disease", hard: h.severity === "severe", lineIndex: h.lineIndex, key: `disease|${drug(h.lineIndex)}|${h.moiety.toLowerCase()}|${h.icd10Prefix}`, moiety: h.moiety, icd10Prefix: h.icd10Prefix, title: h.icd10Title });
  // One card per identity: the same pair can be reported from both of its lines.
  const seen = new Set<string>();
  return out.filter((w) => (seen.has(`${w.lineIndex}|${w.key}`) ? false : (seen.add(`${w.lineIndex}|${w.key}`), true)));
}

export const MIN_REASON = 3;
/** Hard warnings still without a reason — the issue button names how many, and does not send. */
export function unanswered(warnings: readonly LineWarning[], reasons: Readonly<Record<string, string>>): LineWarning[] {
  return warnings.filter((w) => w.hard && (reasons[w.key] ?? "").trim().length < MIN_REASON);
}

/** The override arrays of the issue body, from the reasons typed. Only for warnings the server still reports. */
export function overridesOf(warnings: readonly LineWarning[], reasons: Readonly<Record<string, string>>): {
  overrides?: { lineIndex: number; substance: string; reason: string }[];
  interactionOverrides?: { lineIndex: number; reason: string; saltPair: [string, string] }[];
  duplicateOverrides?: { lineIndex: number; reason: string; moiety: string }[];
  drugDiseaseOverrides?: { lineIndex: number; reason: string; moiety: string; icd10Prefix: string }[];
} {
  const r = (w: LineWarning): string => (reasons[w.key] ?? "").trim();
  const hard = warnings.filter((w) => w.hard && r(w).length >= MIN_REASON);
  const a = hard.filter((w): w is Extract<LineWarning, { kind: "allergy" }> => w.kind === "allergy").map((w) => ({ lineIndex: w.lineIndex, substance: w.substance, reason: r(w) }));
  const i = hard.filter((w): w is Extract<LineWarning, { kind: "interaction" }> => w.kind === "interaction").map((w) => ({ lineIndex: w.lineIndex, reason: r(w), saltPair: w.saltPair }));
  const u = hard.filter((w): w is Extract<LineWarning, { kind: "duplicate" }> => w.kind === "duplicate").map((w) => ({ lineIndex: w.lineIndex, reason: r(w), moiety: w.moiety }));
  const dd = hard.filter((w): w is Extract<LineWarning, { kind: "disease" }> => w.kind === "disease").map((w) => ({ lineIndex: w.lineIndex, reason: r(w), moiety: w.moiety, icd10Prefix: w.icd10Prefix }));
  return {
    ...(a.length > 0 ? { overrides: a } : {}), ...(i.length > 0 ? { interactionOverrides: i } : {}),
    ...(u.length > 0 ? { duplicateOverrides: u } : {}), ...(dd.length > 0 ? { drugDiseaseOverrides: dd } : {}),
  };
}

// ——— repeat last, and sets ———

export type WireLastLine = { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; medicineId?: string | null };

function foodOf(instructions: string | null): { food: "before" | "after" | null; rest: string } {
  const s = (instructions ?? "").trim();
  if (/^before (food|breakfast|meals?)\b/i.test(s) || /^खाने से पहले/.test(s)) return { food: "before", rest: s.replace(/^(before (food|breakfast|meals?)|खाने से पहले)\s*[·,.-]?\s*/i, "") };
  if (/^after (food|meals?)\b/i.test(s) || /^खाने के बाद/.test(s)) return { food: "after", rest: s.replace(/^(after (food|meals?)|खाने के बाद)\s*[·,.-]?\s*/i, "") };
  return { food: null, rest: s };
}

export function linesFrom(lines: readonly WireLastLine[], source: LineSource | null = null): ConsultLine[] {
  return lines.slice(0, MAX_LINES).map((l) => {
    const f = foodOf(l.instructions);
    return { drug: l.drug, dose: l.dose, frequency: l.frequency, durationDays: l.durationDays, food: f.food, instructions: f.rest, route: l.route, medicineId: l.medicineId ?? null, mark: null, was: null, source };
  });
}

/** "Repeat last": the last prescription's lines, on an otherwise untouched draft. Every one is checked again today. */
export function repeatLast(d: ConsultDraft, last: { serviceDate: string; lines: readonly WireLastLine[] }, now: number): ConsultDraft {
  return { ...d, lines: linesFrom(last.lines, "repeat"), from: `repeat:${last.serviceDate}`, reasons: {}, updatedAt: now };
}

export type WireSetBody = {
  lines: { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; medicineId?: string | null }[];
  tests: { serviceId: string; code: string; name: string }[]; advice: string | null; reviewDays: number | null;
};

/** A set FILLS the visit: its lines after the ones already there (a drug already on the visit is not added twice), its tests, its advice. */
export function applySet(d: ConsultDraft, name: string, body: WireSetBody, priceOf: (serviceId: string) => number, now: number): ConsultDraft {
  const have = new Set(d.lines.map((l) => l.drug.trim().toLowerCase()));
  const add = linesFrom(body.lines, "set").filter((l) => !have.has(l.drug.trim().toLowerCase()));
  const tests = [...d.tests, ...body.tests.filter((t) => !d.tests.some((x) => x.serviceId === t.serviceId)).map((t) => ({ ...t, pricePaise: priceOf(t.serviceId) }))].slice(0, MAX_TESTS);
  const advice = (body.advice ?? "").trim();
  return {
    ...d, lines: [...d.lines, ...add].slice(0, MAX_LINES), tests,
    adviceText: advice === "" || d.adviceText.includes(advice) ? d.adviceText : [d.adviceText.trim(), advice].filter((x) => x !== "").join(" "),
    reviewDays: d.reviewDays ?? body.reviewDays, from: name, updatedAt: now,
  };
}

/** The draft as a set body — what "Save as a set" stores. No patient is in it: lines, tests, advice, review. */
export function setBodyOf(d: ConsultDraft, food: { before: string; after: string }): WireSetBody {
  return {
    lines: d.lines.filter(lineComplete).slice(0, 12).map((l) => {
      const w = wireLine(l, food);
      return { drug: w.drug, dose: w.dose, route: w.route, frequency: w.frequency, durationDays: w.durationDays, instructions: w.instructions, ...(l.medicineId === null ? {} : { medicineId: l.medicineId }) };
    }),
    tests: d.tests.slice(0, 12).map((t) => ({ serviceId: t.serviceId, code: t.code, name: t.name })),
    advice: [...d.adviceChips, d.adviceText.trim()].filter((x) => x !== "").join(". ") || null,
    reviewDays: d.reviewDays,
  };
}

/**
 * What became of what was offered, for the meter: a line picked from search or taken from a spoken
 * note is an ACCEPTED suggestion; a line typed by hand is MANUAL. Sets and repeats are the doctor's
 * own earlier writing and are not counted. Kinds and counts only — never a name.
 */
export function lineSignals(lines: readonly ConsultLine[]): { kind: "medicine"; source: LineSource; outcome: "accepted" | "manual" }[] {
  const out: { kind: "medicine"; source: LineSource; outcome: "accepted" | "manual" }[] = [];
  for (const l of lines) {
    if (l.source === "search" || l.source === "voice") out.push({ kind: "medicine", source: l.source, outcome: "accepted" });
    else if (l.source === "typed") out.push({ kind: "medicine", source: "typed", outcome: "manual" });
  }
  return out;
}

/** Changing a line that came from a set or a repeat marks it, and remembers what it was. */
export function changeLine(d: ConsultDraft, index: number, next: ConsultLine, days: (n: number) => string, now: number): ConsultDraft {
  const was = d.lines[index];
  if (was === undefined) return d;
  const fromElsewhere = d.from !== null;
  const before = lineText(was, days);
  const marked: ConsultLine = fromElsewhere && lineText(next, days) !== before && was.mark !== "new"
    ? { ...next, mark: "changed", was: was.was ?? before } : { ...next, mark: was.mark ?? null, was: was.was ?? null };
  return { ...d, lines: d.lines.map((l, i) => (i === index ? marked : l)), updatedAt: now };
}
export function addLine(d: ConsultDraft, line: ConsultLine, now: number): ConsultDraft {
  if (d.lines.length >= MAX_LINES) return d;
  return { ...d, lines: [...d.lines, { ...line, mark: d.from !== null ? "new" : null, was: null }], updatedAt: now };
}

// ——— the spoken note ———

/**
 * How many characters the doctor changed between what was heard and what they kept — an edit
 * distance, bounded (two rows, and a note is a few hundred characters). This number, and never the
 * words, is what the voice meter stores.
 */
export function changedChars(heard: string, kept: string): number {
  const a = heard.slice(0, 2000);
  const b = kept.slice(0, 2000);
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** What the queue says for a few seconds after the issue: counts, never a medicine's name. */
export function issuedCounts(d: ConsultDraft): { medicines: number; tests: number; reviewDays: number | null } {
  return { medicines: d.lines.length, tests: d.tests.length, reviewDays: d.reviewDays };
}
