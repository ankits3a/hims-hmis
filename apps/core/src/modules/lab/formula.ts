import { LabError } from "./errors";

/**
 * PLAN 17a T3 / DD3 — THE FORMULA EVALUATOR, AND IT IS A PARSER RATHER THAN AN INTERPRETER OF
 * SOMEBODY ELSE'S LANGUAGE.
 *
 * ═══ WHY THIS IS HAND-WRITTEN AND NOT `eval` OR `new Function` ═══
 *
 * A formula is CATALOGUE DATA. It is typed by whoever curates the range book, it is stored in a
 * column, and it is evaluated on a server that holds every patient record in the hospital.
 * `new Function("TC - HDL - TG/5")` works beautifully and also runs `process.exit(1)`,
 * `require('fs')` and anything else a catalogue row happens to contain — so the shortest correct
 * implementation of this file is the one that must not be used. **T3 A9's mutant is exactly that
 * fallback, and its discriminating input is a formula that executes.**
 *
 * The grammar is four operators, numbers, parentheses and sibling analyte CODES. Nothing else
 * parses; anything else is `catalogue_invalid` at UPSERT, which is where a bad formula should be
 * refused — at the moment a human typed it, not at 03:00 with a patient's lipid panel waiting.
 *
 *     expr    := term (('+' | '-') term)*
 *     term    := factor (('*' | '/') factor)*
 *     factor  := NUMBER | CODE | '(' expr ')' | '-' factor
 *     guard   := expr ('<' | '<=' | '>' | '>=') expr
 *
 * ═══ AND WHY A FAILED GUARD YIELDS TEXT, NEVER A NUMBER (DD3, T3 A3) ═══
 *
 * Friedewald LDL is invalid above a triglyceride of 400 mg/dL — the equation stops describing the
 * patient. A lab that printed the number anyway would print a plausible, wrong LDL on a report a
 * cardiologist will act on. So a failed guard returns `'not calculable (TG ≥ 400)'` as TEXT, with
 * the guard NAMED, and `lab_results`' one-value CHECK stores it in `value_text` where no arithmetic
 * can reach it. **The wrong number this engine can produce is silent and clinical; a guard that
 * yields text is the only honest failure.**
 */

type Token = { kind: "num"; value: number } | { kind: "code"; name: string } | { kind: "op"; op: string };

const OPS = new Set(["+", "-", "*", "/", "(", ")", "<", ">", "<=", ">="]);

/**
 * THE LEXER REFUSES BY DEFAULT. Every character is either part of a number, part of a code, an
 * operator, or whitespace — and the `else` throws. A lexer that SKIPPED what it did not recognise
 * would silently evaluate `TC - HDL; drop table` as `TC - HDL`, which is worse than refusing,
 * because it would appear to work.
 */
function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") { i += 1; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && ((src[j]! >= "0" && src[j]! <= "9") || src[j] === ".")) j += 1;
      const value = Number(src.slice(i, j));
      if (!Number.isFinite(value)) {
        throw new LabError("catalogue_invalid", `formula: "${src.slice(i, j)}" is not a number`);
      }
      out.push({ kind: "num", value });
      i = j;
      continue;
    }
    // A CODE is what `lab_analytes.code` holds: letters, digits and underscores, starting with a
    // letter. It is looked up in the sibling map at evaluation time and never resolved from scope.
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      out.push({ kind: "code", name: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS.has(two)) { out.push({ kind: "op", op: two }); i += 2; continue; }
    if (OPS.has(c)) { out.push({ kind: "op", op: c }); i += 1; continue; }
    throw new LabError("catalogue_invalid", `formula: unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

/** A sibling's value, or `undefined` when that analyte has no result on this specimen. */
export type Siblings = Readonly<Record<string, number | undefined>>;

/** Thrown INTERNALLY when a code has no sibling value — caught by `evaluateFormula`, never escapes. */
class MissingSibling extends Error {
  constructor(readonly code: string) { super(`missing ${code}`); }
}

function parse(tokens: Token[], siblings: Siblings | null): { value: number; pos: number } {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (op: string): boolean => {
    const t = peek();
    if (t?.kind === "op" && t.op === op) { pos += 1; return true; }
    return false;
  };

  function factor(): number {
    if (eat("-")) return -factor();
    const t = peek();
    if (t === undefined) throw new LabError("catalogue_invalid", "formula: unexpected end of expression");
    if (t.kind === "num") { pos += 1; return t.value; }
    if (t.kind === "code") {
      pos += 1;
      // A VALIDATION pass has no siblings and only needs the shape to be legal, so it substitutes 1.
      if (siblings === null) return 1;
      const v = siblings[t.name];
      if (v === undefined) throw new MissingSibling(t.name);
      return v;
    }
    if (t.op === "(") {
      pos += 1;
      const v = expr();
      if (!eat(")")) throw new LabError("catalogue_invalid", "formula: unbalanced parenthesis");
      return v;
    }
    throw new LabError("catalogue_invalid", `formula: unexpected ${JSON.stringify(t.op)}`);
  }

  function term(): number {
    let v = factor();
    for (;;) {
      if (eat("*")) { v *= factor(); continue; }
      if (eat("/")) {
        const d = factor();
        // Division by zero is `Infinity` in JavaScript and would print as a result. It is a
        // refusal, and it is the LAB's refusal rather than the parser's: a catalogue whose formula
        // divides by an analyte that can legitimately be zero is a catalogue defect.
        if (d === 0) throw new LabError("catalogue_invalid", "formula: division by zero");
        v /= d;
        continue;
      }
      return v;
    }
  }

  function expr(): number {
    let v = term();
    for (;;) {
      if (eat("+")) { v += term(); continue; }
      if (eat("-")) { v -= term(); continue; }
      return v;
    }
  }

  const value = expr();
  return { value, pos };
}

/** Parses and evaluates, and REFUSES trailing junk — `TC - HDL)` must not evaluate to `TC - HDL`. */
function run(src: string, siblings: Siblings | null): number {
  const tokens = lex(src);
  if (tokens.length === 0) throw new LabError("catalogue_invalid", "formula: empty");
  const { value, pos } = parse(tokens, siblings);
  if (pos !== tokens.length) {
    throw new LabError("catalogue_invalid", `formula: unexpected trailing input at token ${String(pos)}`);
  }
  return value;
}

/**
 * THE GUARD — a comparison between two expressions, e.g. `TG < 400`. It is a SEPARATE grammar from
 * the formula on purpose: a guard that could be an arbitrary expression would let a catalogue row
 * write `TG` and have it read as "truthy", which is a precondition nobody can review.
 */
function runGuard(src: string, siblings: Siblings | null): boolean {
  const tokens = lex(src);
  const idx = tokens.findIndex((t) => t.kind === "op" && [">", "<", ">=", "<="].includes(t.op));
  if (idx < 0) {
    throw new LabError("catalogue_invalid", `formula_guard: "${src}" has no comparison`);
  }
  const op = (tokens[idx] as { kind: "op"; op: string }).op;
  // An empty side lands on `formula: empty` from `run`, which is the right refusal for `< 400`.
  const left = run(srcOf(tokens.slice(0, idx)), siblings);
  const right = run(srcOf(tokens.slice(idx + 1)), siblings);
  switch (op) {
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    default: return left >= right;
  }
}

/** Re-renders a token slice so the two sides of a guard can go back through the one parser. */
function srcOf(tokens: Token[]): string {
  return tokens.map((t) => (t.kind === "num" ? String(t.value) : t.kind === "code" ? t.name : t.op)).join(" ");
}

export type FormulaOutcome =
  | { computed: true; value: number }
  | { computed: false; reason: string };

/**
 * EVALUATE ONE FORMULA ANALYTE OVER ITS SIBLINGS ON THE SAME SPECIMEN.
 *
 * **`siblings` is the same specimen's results and nothing else (T3 A4).** A formula that reached
 * across specimens would compute an LDL from this morning's cholesterol and last week's
 * triglyceride — two different patients' worth of physiology in one number, printed as though it
 * were measured. The caller builds the map; this function cannot widen it.
 *
 * Every failure is a REASON, never a throw and never a number: a missing sibling, a failed guard
 * and a malformed formula all end as `value_text` on the result row.
 */
export function evaluateFormula(
  analyte: { code: string; formula: string | null; formulaGuard: string | null },
  siblings: Siblings,
): FormulaOutcome {
  if (analyte.formula === null) {
    return { computed: false, reason: "not calculable (no formula)" };
  }
  try {
    if (analyte.formulaGuard !== null) {
      let guardHolds: boolean;
      try {
        guardHolds = runGuard(analyte.formulaGuard, siblings);
      } catch (e) {
        if (e instanceof MissingSibling) {
          return { computed: false, reason: `not calculable (${e.code} missing)` };
        }
        throw e;
      }
      // THE GUARD NAMES ITSELF IN THE REASON. "not calculable" alone tells a clinician nothing;
      // "not calculable (TG >= 400)" tells them the triglyceride is why and that it is expected.
      if (!guardHolds) {
        return { computed: false, reason: `not calculable (${analyte.formulaGuard.trim()})` };
      }
    }
    const value = run(analyte.formula, siblings);
    if (!Number.isFinite(value)) return { computed: false, reason: "not calculable" };
    return { computed: true, value };
  } catch (e) {
    if (e instanceof MissingSibling) {
      return { computed: false, reason: `not calculable (${e.code} missing)` };
    }
    throw e;
  }
}

/**
 * VALIDATE A FORMULA AT UPSERT — the moment a human typed it, which is the only moment refusing it
 * is cheap. Substitutes 1 for every code, so it checks SHAPE and not arithmetic.
 *
 * It throws `catalogue_invalid` rather than returning false, because `upsertAnalyte`'s caller is a
 * curator at a screen and the message is the whole value of the refusal.
 */
export function assertFormulaParses(formula: string, guard: string | null): void {
  run(formula, null);
  if (guard !== null) runGuard(guard, null);
}

/**
 * ═══ EVERY ANALYTE CODE AN EXPRESSION AND ITS GUARD NAME ═══
 *
 * The grammar has no functions and no keywords, so every bare identifier in it is an analyte code —
 * which is what makes a regex the honest reading rather than a shortcut past the parser.
 *
 * It lives HERE, beside the tokenizer whose character class it mirrors, because there were two
 * copies of it by 17-E T7: `results.ts` used one to decide whether a formula could be computed and
 * `verify.ts` needed one to decide whether it could be signed. Two readings of "what does this
 * expression depend on" that could drift is #130's shape — a rule added to one of two near-duplicate
 * functions leaves a hole with no error anywhere — and the hole here would be a derived value signed
 * over an input nobody had chosen.
 */
export function formulaInputCodes(formula: string | null, guard: string | null): string[] {
  const text = `${formula ?? ""} ${guard ?? ""}`;
  return [...new Set(text.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [])];
}
