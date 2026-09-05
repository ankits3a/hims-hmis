import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 T0 — THE KEY THAT IS MISSING FROM *BOTH* FILES, WHICH PARITY CANNOT SEE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `i18n.test.ts` is thirteen lines and does one thing: it flattens `en.json` and `hi.json` to dotted
 * paths and asserts the two SETS are equal. That catches a key added to one file and forgotten in
 * the other, which is a real defect and worth catching.
 *
 * IT IS COMPLETELY BLIND TO THE DEFECT THAT ACTUALLY HAPPENS. A key present in NEITHER file is in
 * neither set, so the sets still match and the test still passes — while `lib/i18n.ts` sets no
 * `parseMissingKeyHandler` and no `saveMissing`, so i18next's default behaviour takes over and
 * `t("registrationSeat.form.newPatient")` renders THE KEY ITSELF as visible text on the screen. A
 * clerk sees `registrationSeat.form.newPatient` where a heading should be, and every suite is green.
 *
 * ═══ THIS IS THE CLASS THIS LANE KEEPS PAYING FOR ═══
 *
 * FD-11's five look-defects, FD-2's five, FD-24's photo buttons: green suites, wrong screen, found
 * by a person looking at it. `sidebars.test.tsx` already catches ONE instance of it, by asserting
 * that no raw `registrationCounter.[a-zA-Z.]+` substring appears in the rendered rail — a good
 * assertion that only guards the one component somebody thought to guard.
 *
 * This generalises it: every literal `t("ns.key")` in the entire web source, checked against
 * `en.json`. It is the cheapest test in the repository and it converts the most likely silent
 * defect of five new screens into a named failure with a file and a line number.
 *
 * ═══ WHY EN AND NOT BOTH ═══
 *
 * `i18n.test.ts` already proves hi ≡ en key-for-key. Given that, "resolves in en" implies "resolves
 * in hi", and asserting both here would be a second opinion about the same fact — one that could
 * disagree with the parity test and leave a reader wondering which is authoritative. One claim per
 * test: parity is that file's job, existence is this one's.
 */

const SRC = join(__dirname, "..");

/**
 * Literal `t("…")` and `t('…')` calls only.
 *
 * DYNAMIC KEYS ARE DELIBERATELY NOT ATTEMPTED. `t(someVariable)` and `t(\`ns.${x}\`)` cannot be
 * resolved without evaluating the program, and a test that guessed at them would produce false
 * failures that teach people to add exceptions — which is how a guard becomes decoration. Two real
 * generators of dynamic keys exist in this tree (`matchReasonKeys` builds
 * `registrationCounter.find.reason.<lane>`, and the error-code lookups in `materialsErrors` /
 * `otErrors` / `pharmacyErrors`), and they are covered by their own tests against their own
 * enumerations. This test's claim is narrower and completely certain: every key written down as a
 * literal exists.
 */
const T_CALL = /\bt\(\s*["']([a-zA-Z][\w.]*\.[\w.]+)["']/g;

/**
 * The same call, but capturing WHAT FOLLOWS THE KEY — a comma means values were passed, a closing
 * paren means they were not. That one character is the whole of the second test below.
 */
const T_CALL_ARGS = /\bt\(\s*["']([a-zA-Z][\w.]*\.[\w.]+)["']\s*([,)])/g;

/**
 * The same call again, but keeping UP TO 160 CHARACTERS OF WHAT FOLLOWS — enough to see whether the
 * options object mentions `count`, which is the whole of the plural test at the bottom of this file.
 * `T_CALL_ARGS` above cannot serve: it captures one character and stops.
 */
const T_CALL_WITH_ARGS = /\bt\(\s*["']([a-zA-Z][\w.]*\.[\w.]+)["']\s*(?:,([\s\S]{0,160}))?/g;

/** i18next's own interpolation syntax: `{{who}}`, `{{count}}`, `{{ value }}`. */
const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}/;

/**
 * COMMENTS ARE STRIPPED FIRST, AND THE REASON IS A REAL FALSE POSITIVE THIS FOUND.
 *
 * `components/rx-print.tsx` explains, in prose, that the prescription has no signature line — owner
 * decision 2026-08-15 — and the sentence it uses is: *"`t("rx.signature")` does not exist as a
 * key."* It is a comment ABOUT a key's deliberate absence, and the first version of this test read
 * it as a use of the key and reported the file as broken.
 *
 * A guard that fires on documentation is a guard people learn to silence. So the text is stripped
 * of block and line comments before it is scanned, which errs toward missing a key rather than
 * inventing one — the right direction for a test whose whole value is that a failure means something.
 */
function stripComments(text: string): string {
  /*
    BLANKED, NOT DELETED, AND THAT IS NOT A STYLE CHOICE. The failure message carries a LINE NUMBER,
    computed from the match offset — and deleting comment text shifts every offset after it, so the
    first version pointed twenty lines above the call it was complaining about. A reader who follows
    a wrong line number trusts the next message less. Replacing each comment with spaces (keeping
    newlines) leaves every subsequent character at exactly the offset it has in the real file.
  */
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, before: string, comment: string) => before + blank(comment));
}

/**
 * i18next PLURALS ARE NOT MISSING KEYS. `t("lab.collection.tubeCount", { count: n })` resolves to
 * `tubeCount_one` or `tubeCount_other` — the base key is never present and never should be, and the
 * CLDR categories go beyond those two for other languages. Checking for the base alone reported
 * eleven correct call sites across the lab screens and the counter's figures as broken.
 *
 * This is the test's one genuine subtlety, and getting it wrong in the other direction would have
 * been worse: eleven false failures on somebody else's screens is how a new guard gets deleted.
 */
const PLURAL_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many"] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "locales" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function lookup(key: string): unknown {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function resolves(key: string): boolean {
  const node = lookup(key);
  if (node === undefined) {
    /* Not there under its own name — but a plural key never is. */
    return PLURAL_SUFFIXES.some((suffix) => typeof lookup(`${key}${suffix}`) === "string");
  }
  /*
    A key that resolves to an OBJECT is not a usable string — `t("registrationSeat.form")` renders
    "[object Object]" or the key, depending on i18next's mood, and neither is a heading. The leaf
    check is part of the claim, not a refinement of it.
  */
  return typeof node === "string";
}

/**
 * ═══ FD-25 — "1 patient(s)" IS NOT COPY A HOSPITAL SHIPS ═══
 *
 * FOUND BY LOOKING, on a screenshot reading "1 doctor(s) on leave — bookings need moving" and
 * "1 patient(s)". The assertions passed: `toHaveTextContent("1 patient")` is satisfied by
 * "1 patient(s)", so the suite could not tell the difference and neither could the parity test.
 *
 * i18next has real plurals — `key_one` / `key_other`, selected from the `count` OPTION through
 * `Intl.PluralRules`. This repository uses them in 28 base keys / 56 leaves, `_one` and `_other`
 * only, and both `en` and `hi` have exactly those two CLDR categories, so a pair is complete for
 * both languages.
 *
 * ═══ THE FIRST VERSION OF THIS RULE WAS SELF-VACUOUS AND GREEN FOR ITS WHOLE LIFE ═══
 *
 * It read:
 *
 *     leaves(en)
 *       .filter(([, value]) => value.includes("{{count}}"))    <-- the defect
 *       .filter(([, value]) => /\(s\)|\(es\)/.test(value));    <-- the real rule
 *
 * The first filter is the POST-CONDITION of the fix, used as the PRE-CONDITION of the hunt. A
 * developer who writes "(s)" is by definition not using i18next plurals, so they are not passing
 * `count`, so the string interpolates `{{n}}`, `{{total}}`, `{{reversed}}` — or nothing at all
 * ("short line(s)", where the number was rendered as a JSX sibling). Not one of the TWELVE
 * offenders sitting in en.json carried `{{count}}`, so the offender array was empty on every run.
 * The guard could not have fired on anything, ever. Nobody learned that, because the two keys that
 * motivated it were converted by hand in the same change — the test was born green and stayed green
 * while the exact defect it names shipped on nine screens.
 *
 * ═══ AIMED AT THE PROPERTY, NOT AT THE ONE SPELLING THAT HAPPENED TO BE HERE ═══
 *
 * The rule is the hand-spelled plural, in every spelling of it. "(s)" is what this tree contained;
 * a person reaching for the same shortcut also writes "box(es)", "categor(ies)", and the slash
 * forms "patient/s" and "box/es". All of them are one defect — a string that refuses to choose,
 * shown to a clerk who is looking at exactly one thing.
 *
 * WHAT IS DELIBERATELY *NOT* THE RULE: "every `{{count}}` string must be a plural form". That was
 * tried and fired on twenty-three keys of which most were correct — "{{count}} checked in",
 * "{{count}} ahead", "bench {{count}}" have no noun to inflect and read the same at one and at
 * five. A guard with that many false positives is a guard somebody deletes.
 *
 * MEASURED at the moment of widening: 12 offenders in en.json, 0 in hi.json, 2 hardcoded in the web
 * source, and zero false positives in any of the three corpora.
 */
function leaves(obj: unknown, path: string[] = [], out: [string, string][] = []): [string, string][] {
  if (typeof obj === "string") { out.push([path.join("."), obj]); return out; }
  if (typeof obj !== "object" || obj === null) return out;
  for (const [k, v] of Object.entries(obj)) leaves(v, [...path, k], out);
  return out;
}

/** Parenthetical and slash plurals, either case: `patient(s)`, `box(es)`, `categor(ies)`, `patient/s`, `box/es`. */
const MANUAL_PLURAL = /\((?:s|es|ies)\)|\w\/(?:s|es|ies)\b/i;

function manualPlurals(bundle: unknown): [string, string][] {
  return leaves(bundle).filter(([, value]) => MANUAL_PLURAL.test(value));
}

/**
 * ═══ THE LOCALE FILES ARE NOT THE ONLY PLACE A CLERK'S COPY LIVES ═══
 *
 * Two of this defect's live instances never entered a locale file at all: the co-pilot answer on
 * `opd-appointments.tsx` and the registration log line in `desk-one.tsx` are built with template
 * literals. The first of them is on the very screen whose screenshot motivated this rule — clean
 * the locale files alone and that screen still reads "doctor(s) on file". A census scoped to
 * en.json would have reported the class closed while the instance that started it stayed on screen.
 *
 * STRING LITERALS ONLY, AND THAT RESTRICTION IS THE DIFFERENCE BETWEEN A GUARD AND A NUISANCE.
 * Run the pattern over raw file text and it matches `(s) =>` — an arrow-function parameter — in
 * about twenty files, which is exactly the false-positive rate that gets a guard deleted. Confined
 * to quoted and template strings it found the two real sites and nothing else. It cannot see raw
 * JSX text (`<li>short line(s)</li>`), which is a known and accepted narrowing: this errs toward
 * missing one rather than inventing twenty.
 */
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

describe("counted strings use i18next plurals, not a parenthetical", () => {
  /*
    THE GUARD ON THE GUARD (§2.49), and here it is load-bearing rather than decorative.

    The three tests below are ABSENCE assertions — "no hand-spelled plural exists" — and an absence
    cannot be proved by a revert pair on the guard. Once the locales are clean the vacuous predicate
    and the correct one BOTH return [] and BOTH print green; put the `{{count}}` filter back and
    nothing goes red. An absence is proved by ADDING the forbidden thing, which is what this fixture
    does, and it keeps proving it independent of what the locale files contain on any given day.

    Every fixture string here is invisible to the old predicate: not one carries `{{count}}`, which
    is precisely what the old filter demanded. So this case is RED against the rule it replaces and
    GREEN against this one. It is the manufactured revert pair for the guard itself, and the guard
    change must not land without it.
  */
  it("the guard sees a hand-spelled plural that carries no {{count}}", () => {
    expect(manualPlurals({
      paren: { s: "{{n}} patient(s)", es: "1 box(es)", ies: "3 categor(ies)", caps: "2 FILE(S)" },
      slash: "2 patient/s",
      bare: "short line(s)",
      fine: { real: "{{count}} patients", andOr: "open and/or closed", clock: "24/7 pharmacy", none: "one patient" },
    })).toEqual([
      ["paren.s", "{{n}} patient(s)"],
      ["paren.es", "1 box(es)"],
      ["paren.ies", "3 categor(ies)"],
      ["paren.caps", "2 FILE(S)"],
      ["slash", "2 patient/s"],
      ["bare", "short line(s)"],
    ]);
  });

  it("no counted string in en.json spells its plural by hand", () => {
    const offenders = manualPlurals(en);
    expect(offenders, `these hand-spell a plural where i18next has _one/_other:\n${offenders.map(([k, v]) => `${k}  ${v}`).join("\n")}\n`).toEqual([]);
  });

  /*
    hi.json has never carried the parenthetical — the translator never copied the English shape.
    Zero offenders today, so this test is GREEN before this change and GREEN after it: it is forward
    cover against a future translator, and it is evidence of nothing about the fix that added it.
    Said plainly so that nobody counts it as evidence.
  */
  it("no counted string in hi.json spells its plural by hand", () => {
    const offenders = manualPlurals(hi);
    expect(offenders, `these hand-spell a plural where i18next has _one/_other:\n${offenders.map(([k, v]) => `${k}  ${v}`).join("\n")}\n`).toEqual([]);
  });

  it("no hardcoded string in the web source spells its plural by hand", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of stripComments(text).matchAll(STRING_LITERAL)) {
        if (!MANUAL_PLURAL.test(match[0])) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(SRC, file)}:${String(line)}  ${match[0]}`);
      }
    }
    expect(offenders, `these hardcoded strings hand-spell a plural — inflect them in code, or move them into the locale files as _one/_other:\n${offenders.join("\n")}\n`).toHaveLength(0);
  });
});

describe("every t(\"ns.key\") written in the web source resolves in en.json", () => {
  const files = sourceFiles(SRC);

  /*
    THE GUARD ON THE GUARD (§2.49). A walker that silently returns nothing passes forever and
    proves nothing — this repository has been bitten by exactly that shape, which is why
    `caddyfile-parity.test.ts` and `nav-parity.test.ts` both throw rather than return empty. If a
    refactor moves the source tree, this fails loudly instead of quietly approving everything.
  */
  it("found a plausible number of source files and translation calls to check", () => {
    expect(files.length).toBeGreaterThan(50);
    const total = files.reduce((n, f) => n + [...stripComments(readFileSync(f, "utf8")).matchAll(T_CALL)].length, 0);
    expect(total).toBeGreaterThan(500);
  });

  it("resolves every literal key to a string", () => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of stripComments(text).matchAll(T_CALL)) {
        const key = match[1];
        if (key === undefined || resolves(key)) continue;
        /* The line number, because "a key is missing" without one is a grep the reader has to run. */
        const line = text.slice(0, match.index).split("\n").length;
        missing.push(`${relative(SRC, file)}:${String(line)}  t("${key}")`);
      }
    }
    /*
      The message IS the test. A bare `toHaveLength(0)` prints "expected 7 to be 0" and sends the
      reader hunting; this prints the seven keys with the files and lines that write them, which is
      everything needed to fix it.
    */
    expect(missing, `these t() keys are in no locale file, so they render as literal text on screen:\n${missing.join("\n")}\n`).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * A KEY THAT RESOLVES IS NOT YET A SENTENCE — THE INTERPOLATION HALF
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * The test above proves the key EXISTS. It cannot see the other way the same line fails: the key
   * resolves, the string is fine, and the call passes no values — so i18next has nothing to
   * substitute and prints the placeholder. `vitalsBay.rest.go` is "Rest {{minutes}} min" and was
   * called as `t("vitalsBay.rest.go")`, so the button on the vitals bay read, in production, to a
   * nurse, at the moment a patient's blood pressure was elevated:
   *
   *     Rest {{minutes}} min
   *
   * Both locale files were complete and correct. Both parity tests were green. Five suites and
   * forty-five tests covered that screen, and it took a SCREENSHOT to see it — which is the third
   * time this lane has paid for the same lesson.
   *
   * ═══ WHY THE RULE IS EXACTLY THIS NARROW ═══
   *
   * Only calls with NO second argument at all are checked. `t("k", { minutes })` might still pass
   * the wrong variable name, and this test says nothing about that — proving it would need the
   * program evaluated. But `t("k")` against a string containing `{{…}}` is decidable from the text
   * alone and is ALWAYS a defect: there is no argument by which that renders correctly.
   */
  it("passes values to every key whose string interpolates", () => {
    const unfilled: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of stripComments(text).matchAll(T_CALL_ARGS)) {
        const key = match[1];
        if (key === undefined || match[2] !== ")") continue;
        const value = lookup(key);
        if (typeof value !== "string" || !PLACEHOLDER.test(value)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        unfilled.push(`${relative(SRC, file)}:${String(line)}  t("${key}") → "${value}"`);
      }
    }
    expect(unfilled, `these t() calls pass no values to a string that interpolates, so the braces reach the screen:\n${unfilled.join("\n")}\n`).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * A PLURAL KEY THAT IS NOT PASSED `count` IS A MISSING KEY, AND NOTHING ELSE HERE CAN SEE IT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * i18next appends `_one` / `_other` only when `options.count !== undefined`. Call
   * `t("adminUsers.agent.admins", { n })` against a key that exists ONLY as a plural pair and
   * i18next never applies plural resolution at all: it looks up the bare key, finds nothing, and —
   * `lib/i18n.ts` sets no `parseMissingKeyHandler` and no `saveMissing` — returns THE KEY ITSELF.
   * The clerk reads `adminUsers.agent.admins` where a sentence belongs.
   *
   * ═══ WHY THIS FILE'S OTHER THREE TESTS ARE ALL BLIND TO IT ═══
   *
   *   · `resolves every literal key` passes, because `resolves()` accepts the `_one` suffix (line
   *     125) without ever asking whether the CALL supplies a count.
   *   · `passes values to every key whose string interpolates` skips it, because that test only
   *     looks at calls with NO arguments — and this one has arguments, just the wrong ones.
   *   · the parenthetical rule above reads locale text and never looks at code.
   *
   * And there is a sharper edge: converting a key to a plural pair REMOVES it from the
   * interpolation test's reach, because that test's `lookup(key)` returns undefined for a
   * plural-only key. So remediating a "(s)" string without this test in place trades one guard for
   * none — the converted keys lose the cover they had and gain nothing.
   *
   * That is how the fix for a bad string ships something worse than the string: FD-11's
   * `vitalsBay.rest.go` read "Rest {{minutes}} min" to a nurse over an elevated blood pressure, with
   * both locale files complete, both parity tests green, and forty-five tests on that screen.
   */
  it("passes count to every key that exists only as a plural", () => {
    const wrong: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of stripComments(text).matchAll(T_CALL_WITH_ARGS)) {
        const key = match[1];
        if (key === undefined) continue;
        if (lookup(key) !== undefined) continue;
        if (!PLURAL_SUFFIXES.some((suffix) => typeof lookup(`${key}${suffix}`) === "string")) continue;
        if (/\bcount\b/.test(match[2] ?? "")) continue;
        const line = text.slice(0, match.index).split("\n").length;
        wrong.push(`${relative(SRC, file)}:${String(line)}  t("${key}") — plural key, no count passed`);
      }
    }
    expect(wrong, `these keys exist only as _one/_other, so i18next needs a count option — without it the key itself reaches the screen:\n${wrong.join("\n")}\n`).toHaveLength(0);
  });
});
