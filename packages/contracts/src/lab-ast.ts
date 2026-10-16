/**
 * OWNER 2026-10-12 — THE ANTIBIOTIC SENSITIVITY TABLE on a culture report in the lab's QUICK chain
 * (spec `SPEC-lab-ast-table-2026-10-12.md`). One row per antibiotic: S / I / R and an optional MIC
 * in µg/mL. The technician picks a panel (CLSI M100 2025 groups, as Indian labs use them) and its
 * antibiotics fill the table; antibiotics can be added from the combined list or typed free.
 *
 * **IMPORTS NOTHING.** The web and the phone app import this file by relative path, and the phone's
 * CI installs only its own packages: no zod here. The server's body schema lives in core.
 */

export type AstResult = "S" | "I" | "R";
/** One stored row: an antibiotic code from `AST_ANTIBIOTICS` or a free name (≤ 60 characters). */
export type AstRow = { antibiotic: string; result: AstResult; mic: string | null };
/** The rows of one culture test of the report. */
export type AstBlock = { serviceId: string; rows: AstRow[] };

export const AST_MAX_ROWS = 40;
export const AST_NAME_MAX = 60;

/** Only the C&S orderables carry a table (fungal culture has no AST). */
export const isCultureCode = (testCode: string): boolean => testCode.startsWith("CS_");

/** Urine-only drugs are offered only on a urine culture. */
const URINE_ONLY = new Set(["NIT", "FOS"]);
const isUrine = (testCode: string): boolean => testCode === "CS_URINE";

/** Antibiotic codes (WHONET-style abbreviations) and the name printed on the report. */
export const AST_ANTIBIOTICS: Readonly<Record<string, string>> = {
  AMP: "Ampicillin",
  AMC: "Amoxicillin-clavulanate",
  SAM: "Ampicillin-sulbactam",
  CZO: "Cefazolin",
  CXM: "Cefuroxime",
  FOX: "Cefoxitin (MRSA screen)",
  CTX: "Cefotaxime",
  CRO: "Ceftriaxone",
  CAZ: "Ceftazidime",
  FEP: "Cefepime",
  CSL: "Cefoperazone-sulbactam",
  TZP: "Piperacillin-tazobactam",
  ETP: "Ertapenem",
  IPM: "Imipenem",
  MEM: "Meropenem",
  AMK: "Amikacin",
  GEN: "Gentamicin",
  GEH: "High-level gentamicin",
  TOB: "Tobramycin",
  CIP: "Ciprofloxacin",
  LVX: "Levofloxacin",
  SXT: "Trimethoprim-sulfamethoxazole",
  NIT: "Nitrofurantoin",
  FOS: "Fosfomycin",
  COL: "Colistin",
  PLB: "Polymyxin B",
  TGC: "Tigecycline",
  MNO: "Minocycline",
  PEN: "Penicillin",
  OXA: "Oxacillin",
  ERY: "Erythromycin",
  CLI: "Clindamycin",
  TCY: "Tetracycline",
  DOX: "Doxycycline",
  LNZ: "Linezolid",
  VAN: "Vancomycin",
  TEC: "Teicoplanin",
  DAP: "Daptomycin",
  RIF: "Rifampicin",
  CHL: "Chloramphenicol",
};

export type AstPanelId = "ent_urine" | "ent_other" | "pse_aci" | "staph_ent" | "strep";
export type AstPanel = { id: AstPanelId; label: string; codes: readonly string[] };

const ENT_URINE = ["AMP", "AMC", "CZO", "CXM", "CRO", "FEP", "TZP", "ETP", "MEM", "AMK", "GEN", "CIP", "LVX", "SXT", "NIT", "FOS", "COL"];

export const AST_PANELS: readonly AstPanel[] = [
  { id: "ent_urine", label: "Enterobacterales – urine", codes: ENT_URINE },
  {
    id: "ent_other", label: "Enterobacterales – other",
    codes: [...ENT_URINE.filter((c) => c !== "NIT" && c !== "FOS" && c !== "CZO"), "CSL", "TGC", "IPM"],
  },
  {
    id: "pse_aci", label: "Pseudomonas / Acinetobacter",
    codes: ["CAZ", "FEP", "TZP", "CSL", "IPM", "MEM", "AMK", "GEN", "TOB", "CIP", "LVX", "COL", "PLB", "MNO", "SAM"],
  },
  {
    id: "staph_ent", label: "Staphylococcus / Enterococcus",
    codes: ["PEN", "FOX", "OXA", "AMP", "ERY", "CLI", "GEN", "GEH", "CIP", "LVX", "SXT", "TCY", "DOX", "LNZ", "VAN", "TEC", "DAP", "RIF", "NIT"],
  },
  { id: "strep", label: "Streptococcus", codes: ["PEN", "AMP", "CRO", "CTX", "ERY", "CLI", "LVX", "VAN", "LNZ", "TCY", "CHL"] },
];

/** A panel's antibiotics for this test: the urine-only drugs drop off any culture but urine. */
export function panelCodes(panelId: AstPanelId, testCode: string): string[] {
  const panel = AST_PANELS.find((p) => p.id === panelId);
  if (panel === undefined) return [];
  return panel.codes.filter((c) => isUrine(testCode) || !URINE_ONLY.has(c));
}

/** The combined list "Add antibiotic" offers on this test. */
export function antibioticsFor(testCode: string): string[] {
  return Object.keys(AST_ANTIBIOTICS).filter((c) => isUrine(testCode) || !URINE_ONLY.has(c));
}

/**
 * Fill a panel: its antibiotics in the panel's order, keeping whatever was already marked; marked rows
 * the panel does not hold stay at the end; blank rows of an earlier panel go (a wrong pick undoes itself).
 */
export function fillPanel(rows: readonly AstDraftRow[], panelId: AstPanelId, testCode: string): AstDraftRow[] {
  const marked = rows.filter((r) => (r.result ?? "") !== "" || (r.mic ?? "") !== "");
  const byKey = new Map(marked.map((r) => [r.antibiotic.toLowerCase(), r]));
  const codes = panelCodes(panelId, testCode);
  const inPanel = new Set(codes.map((c) => c.toLowerCase()));
  return [
    ...codes.map((c) => byKey.get(c.toLowerCase()) ?? { antibiotic: c, result: "", mic: null }),
    ...marked.filter((r) => !inPanel.has(r.antibiotic.toLowerCase())),
  ];
}

/**
 * What a screen sends: one table per culture test of the report, its rows with a result (blank rows
 * never leave the screen), and no rows at all when the organism line reads "No growth" / "Sterile".
 */
export function astForSave(
  tests: readonly { serviceId: string; code: string }[], rowsByService: Readonly<Record<string, readonly AstDraftRow[]>>, organism: string,
): { serviceId: string; rows: AstDraftRow[] }[] {
  const sterile = isNoGrowth(organism);
  return tests.filter((x) => isCultureCode(x.code)).map((x) => ({
    serviceId: x.serviceId, rows: sterile ? [] : (rowsByService[x.serviceId] ?? []).filter((r) => (r.result ?? "") !== ""),
  }));
}

/** The printed name: the panel's name for a code, else the free name as typed. */
export const astName = (antibiotic: string): string => AST_ANTIBIOTICS[antibiotic] ?? antibiotic;

export const AST_RESULT_WORD: Readonly<Record<AstResult, string>> = { S: "Sensitive", I: "Intermediate", R: "Resistant" };

/** "No growth" / "Sterile" (any case, any words after) needs no table. */
export function isNoGrowth(organism: string | null | undefined): boolean {
  const s = (organism ?? "").trim().toLowerCase();
  return s.startsWith("no growth") || s.startsWith("sterile");
}

/** A MIC is a plain decimal number: "0.5", "16". Never "≤0.25", ">32" or "0.5 µg/mL". */
export const isMic = (s: string): boolean => /^(\d+(\.\d+)?|\.\d+)$/.test(s);

/** A row as a screen or the wire may hold it, before the blank ones drop. */
export type AstDraftRow = { antibiotic: string; result: string | null; mic: string | null };

export type AstRowProblem = { index: number; antibiotic: string; reason: "result" | "mic" | "name" | "duplicate" | "too_many" };

/**
 * THE ONE RULE both ends apply: a row with no result is dropped (never stored, never printed); a
 * result is S, I or R; a MIC is blank or a plain number; a name is 1–60 characters, once per test;
 * at most 40 rows. Returns the clean rows, or the first problem with its row number (1-based).
 */
export function cleanAstRows(rows: readonly AstDraftRow[]): { ok: true; rows: AstRow[] } | { ok: false; problem: AstRowProblem } {
  const out: AstRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const result = (r.result ?? "").trim();
    const antibiotic = r.antibiotic.trim();
    if (result === "") continue;
    if (result !== "S" && result !== "I" && result !== "R") return { ok: false, problem: { index: i + 1, antibiotic, reason: "result" } };
    if (antibiotic === "" || antibiotic.length > AST_NAME_MAX) return { ok: false, problem: { index: i + 1, antibiotic, reason: "name" } };
    const key = antibiotic.toLowerCase();
    if (seen.has(key)) return { ok: false, problem: { index: i + 1, antibiotic, reason: "duplicate" } };
    seen.add(key);
    const mic = (r.mic ?? "").trim();
    if (mic !== "" && !isMic(mic)) return { ok: false, problem: { index: i + 1, antibiotic, reason: "mic" } };
    out.push({ antibiotic, result, mic: mic === "" ? null : mic });
  }
  if (out.length > AST_MAX_ROWS) return { ok: false, problem: { index: AST_MAX_ROWS + 1, antibiotic: out[AST_MAX_ROWS]!.antibiotic, reason: "too_many" } };
  return { ok: true, rows: out };
}

/** The refusal in words, naming the row — the server's 400 message and the screens' own check. */
export function astProblemText(p: AstRowProblem): string {
  const who = `Antibiotic row ${String(p.index)}${p.antibiotic !== "" ? ` (${astName(p.antibiotic)})` : ""}`;
  switch (p.reason) {
    case "result": return `${who}: the result must be S, I or R`;
    case "mic": return `${who}: the MIC must be a plain number, e.g. 0.5`;
    case "name": return `${who}: the antibiotic name must be 1–${String(AST_NAME_MAX)} characters`;
    case "duplicate": return `${who}: this antibiotic is already in the table`;
    case "too_many": return `At most ${String(AST_MAX_ROWS)} antibiotics per culture`;
  }
}

/**
 * #703 — a table as one line of text, Resistant first: "Resistant: Ampicillin, Ciprofloxacin · Sensitive: Meropenem".
 * Full lab mode stores it as the `MIC_AST` result's text value, so a reader that knows only text still reads the gist.
 */
export function astSummary(rows: readonly AstRow[]): string {
  const order: readonly AstResult[] = ["R", "I", "S"];
  return order
    .map((r) => [r, rows.filter((x) => x.result === r).map((x) => astName(x.antibiotic))] as const)
    .filter(([, names]) => names.length > 0)
    .map(([r, names]) => `${AST_RESULT_WORD[r]}: ${names.join(", ")}`)
    .join(" · ");
}
