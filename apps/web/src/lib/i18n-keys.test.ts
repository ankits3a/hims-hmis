import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";

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
 * i18next has real plurals — `key_one` / `key_other` — and this repository already uses them in
 * eleven places. The parenthetical is what a developer writes when they are thinking about the
 * string and not about the person reading it, and once one ships the next one is easier.
 *
 * So the rule becomes mechanical: a value carrying `{{count}}` must be a plural form. That is the
 * whole check, and it is cheap because i18next's own naming makes it decidable.
 */
function leaves(obj: unknown, path: string[] = [], out: [string, string][] = []): [string, string][] {
  if (typeof obj === "string") { out.push([path.join("."), obj]); return out; }
  if (typeof obj !== "object" || obj === null) return out;
  for (const [k, v] of Object.entries(obj)) leaves(v, [...path, k], out);
  return out;
}

describe("counted strings use i18next plurals, not a parenthetical", () => {
  /*
    ONLY THE PARENTHETICAL, AND THAT IS DELIBERATE. A first version also required every `{{count}}`
    string to BE a plural form, and it fired on twenty-three keys of which most were correct —
    "{{count}} checked in", "{{count}} ahead", "bench {{count}}" have no noun to inflect and read
    the same at one and at five. A guard with that many false positives is a guard somebody deletes,
    which is the rule this file already states about plurals and comments.
  */
  it("no string interpolating {{count}} spells its plural as (s)", () => {
    const offenders = leaves(en)
      .filter(([, value]) => value.includes("{{count}}"))
      .filter(([, value]) => /\(s\)|\(es\)/.test(value));
    expect(offenders, `these say "(s)" where i18next has _one/_other:\n${offenders.map(([k, v]) => `${k}  ${v}`).join("\n")}\n`).toEqual([]);
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
});
