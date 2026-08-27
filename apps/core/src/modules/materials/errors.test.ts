import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MaterialsError, materialsHttpStatus } from "./errors";
import type { MaterialsErrorCode } from "./errors";

/**
 * PLAN 14 CLOSE, REVIEW FINDING M8 — **THE FILE `errors.ts` PROMISED AND NOBODY WROTE.**
 *
 * `errors.ts` said, in its header, *"Both directions are asserted by `errors.test.ts` at T8, when
 * every thrower exists."* There was no `errors.test.ts`. The sentence was written at T2, read by
 * every later task and by the reviewer of the task meant to write it, and believed by all of them —
 * which is the failure mode worth naming: **a claim about the test suite, made in the file the test
 * was supposed to protect, is indistinguishable from the test until somebody goes looking.**
 *
 * Behind it the union had drifted in BOTH directions at once:
 *
 *   · five declared codes had ZERO throw sites (`batch_required`, `expiry_required`, `expired`,
 *     `mrp_below_cost`, `mrp_above_ceiling`) — every one of them a `qc.ts` `RuleCode`, a DIFFERENT
 *     union recorded on a GRN line as a verdict and never thrown as an error;
 *   · `not_in_transit` was declared for `receiveStock`, made unreachable there by a ternary whose
 *     true branch sat inside a guard that excluded it, and BORROWED by `postGrn` to mean "gate QC
 *     has not run" — the exact practice `errors.ts` forbids two paragraphs above the promise.
 *
 * ═══ WHY THIS TEST READS SOURCE TEXT INSTEAD OF EXERCISING THE CODE ═══
 *
 * The property is *"every declared code has a reachable thrower and every thrower is declared"*,
 * and it is a property of the MODULE, not of any one call. A behavioural suite proves it only for
 * the paths it happens to walk — which is precisely how five codes stayed in the union for nine
 * tasks. Scanning the source is the only form that fails when a code is added with no thrower, or a
 * thrower is added with no code, without anybody remembering to come here.
 *
 * The `billing-purity.test.ts` and `guardrails.test.ts` precedent, both of which read source as
 * text for a property no fixture can express. TypeScript already guarantees direction 2 at compile
 * time for LITERAL arguments; the scan is what catches the direction TypeScript cannot see.
 */

const MODULE_DIR = __dirname;
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const LOCALES = resolve(REPO_ROOT, "apps", "web", "src", "locales");

/**
 * ═══ COMMENTS ARE STRIPPED BEFORE ANYTHING IS PARSED, AND BOTH DIRECTIONS NEEDED IT ═══
 *
 * This test was written without this step and failed twice on its own prose, which is worth
 * recording because the failures were opposite and both were the scanner's fault, not the code's:
 *
 *   · **A false NEGATIVE.** `declaredCodes` ended the union at the first `;`. A docstring inside
 *     the union — *"The item was found; it is the unit in the request that is wrong"* — cut the
 *     list at eight of twenty-four codes, and direction 1 ("no orphans") then passed VACUOUSLY on a
 *     list it had truncated. A scan that under-reports fails GREEN, which is the dangerous way.
 *   · **A false POSITIVE.** The `not_in_transit` guard searched `transfers.ts` for the string, and
 *     found it in the comment that explains why the code was REMOVED. The better the explanation,
 *     the louder the false alarm.
 *
 * This module documents itself heavily on purpose, so prose is the majority of most of these files
 * — a source scan here is parsing prose unless it says otherwise. It says otherwise.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** Every shipped `.ts` in the module — tests excluded, since a test may name any code it likes. */
function shippedSources(): { file: string; text: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((file) => ({ file, text: stripComments(readFileSync(resolve(MODULE_DIR, file), "utf8")) }));
}

/**
 * The union, read off `errors.ts` itself.
 *
 * Parsed from the SOURCE rather than duplicated as an array here, because a hand-maintained copy of
 * the union in its own test is the §2.54 defect — two copies of one fact, and the copy that drifts
 * is always the one nothing checks.
 */
function declaredCodes(): string[] {
  const text = stripComments(readFileSync(resolve(MODULE_DIR, "errors.ts"), "utf8"));
  const union = text.split("export type MaterialsErrorCode =")[1] ?? "";
  const body = union.split(";")[0] ?? "";
  const codes = [...body.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
  // A truncated parse must fail LOUDLY rather than vacuously satisfy every filter below it.
  expect(codes.length).toBeGreaterThan(20);
  return codes;
}

/**
 * Throw sites, matched across line breaks.
 *
 * **The `[\s\S]*?` is load-bearing and it is finding F8's lesson in miniature.** House style breaks
 * a long `new MaterialsError(` over three lines, so a single-line regex reports ZERO throwers for a
 * code thrown four times — and a scan that under-reports would make this test PASS while the union
 * rotted, which is worse than not having it.
 */
function throwSites(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { file, text } of shippedSources()) {
    if (file === "errors.ts") continue;
    for (const m of text.matchAll(/new MaterialsError\(\s*"([a-z_]+)"/g)) {
      const code = m[1] as string;
      const set = found.get(code) ?? new Set<string>();
      set.add(file);
      found.set(code, set);
    }
  }
  return found;
}

describe("the materials error union (Plan 14 CLOSE, M8)", () => {
  it("direction 1: every DECLARED code has at least one throw site in shipped module source", () => {
    const thrown = throwSites();
    const orphans = declaredCodes().filter((c) => !thrown.has(c));
    /**
     * The message names the two ways an orphan happens, because both have now been seen in this
     * module and they need opposite fixes: a code that belongs to `qc.ts`'s `RuleCode` union was
     * transcribed here by mistake (remove it), or a refusal was designed and never implemented
     * (write the thrower). Guessing wrong turns a missing feature into a deleted one.
     */
    expect({ orphans }).toEqual({ orphans: [] });
  });

  it("direction 2: every THROWN code is declared in the union", () => {
    const declared = new Set(declaredCodes());
    const undeclared = [...throwSites().keys()].filter((c) => !declared.has(c));
    expect({ undeclared }).toEqual({ undeclared: [] });
  });

  /**
   * The one the reviewer actually caught, pinned so it cannot come back by a different name.
   *
   * `qc.ts` owns `RuleCode` — a GRN line's VERDICT, written to `grn_lines.reject_reason` and
   * rendered by the screen. Five of its members were also declared as thrown errors. The two unions
   * may legitimately OVERLAP (`batch_frozen` and `agreement_missing` are genuinely both: a rule the
   * gate applies AND a refusal the ledger raises), so this is not a no-overlap assertion — it is
   * the sharper one that a member of both unions must actually be thrown somewhere.
   */
  it("a RuleCode may also be an error code — but only if something THROWS it", () => {
    const ruleCodeText = readFileSync(resolve(MODULE_DIR, "qc.ts"), "utf8");
    const union = ruleCodeText.split("export type RuleCode =")[1]?.split(";")[0] ?? "";
    const ruleCodes = new Set([...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1] as string));
    const declared = declaredCodes();
    const thrown = throwSites();

    const inBoth = declared.filter((c) => ruleCodes.has(c));
    expect(inBoth.sort()).toEqual(["agreement_missing", "batch_frozen"]);
    for (const c of inBoth) expect({ code: c, thrownIn: [...(thrown.get(c) ?? [])] }).not.toEqual({ code: c, thrownIn: [] });

    // And the five M8 removed are gone: RuleCodes only, never error codes.
    for (const c of ["batch_required", "expiry_required", "expired", "mrp_below_cost", "mrp_above_ceiling"]) {
      expect({ code: c, declaredAsError: declared.includes(c), isRuleCode: ruleCodes.has(c) })
        .toEqual({ code: c, declaredAsError: false, isRuleCode: true });
    }
  });

  /**
   * `not_in_transit` is gone, and the guard is written against the STRING rather than the type so
   * that re-adding it — which is the tempting fix for a future wrong-status refusal — has to
   * confront this test and its reason rather than sliding past a typecheck.
   */
  it("`not_in_transit` is not resurrected: `receiveStock` could never throw it and `postGrn` borrowed it", () => {
    expect(declaredCodes()).not.toContain("not_in_transit");
    const byFile = new Map(shippedSources().map((f) => [f.file, f.text]));
    // CODE only: the comment in `transfers.ts` that explains the removal names the string, and must.
    expect(byFile.get("transfers.ts")).not.toContain("not_in_transit");
    // `postGrn` now says what it means.
    expect(byFile.get("grn.ts")).toContain('"qc_not_run"');
  });

  it("NOTHING in the union answers 5xx — the Plan 09 / Plan 13 / M1 lesson, asserted", () => {
    const statuses = declaredCodes().map((c) => materialsHttpStatus(c as MaterialsErrorCode));
    expect(statuses.every((s) => s >= 400 && s < 500)).toBe(true);
    expect([...new Set(statuses)].sort()).toEqual([404, 409]);
  });

  /**
   * m8 — `unknown_uom` is the one `unknown_*` that is NOT a 404, and the asymmetry is deliberate
   * enough to pin. Every other `unknown_*` names a row the caller addressed and we could not find.
   * `unknown_uom` means the item WAS found and the unit in the request body is wrong.
   */
  it("m8: `unknown_uom` answers 409, and every other `unknown_*` answers 404", () => {
    expect(materialsHttpStatus("unknown_uom")).toBe(409);
    const others = declaredCodes().filter((c) => c.startsWith("unknown_") && c !== "unknown_uom");
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect({ c, s: materialsHttpStatus(c as MaterialsErrorCode) }).toEqual({ c, s: 404 });
  });

  /**
   * m6 — a code with no locale key reaches a Hindi storekeeper as an English sentence.
   *
   * This lives HERE rather than in `apps/web` on purpose: the union is authored in this directory,
   * so the test that fails when it grows must be in this directory too. A parity test on the web
   * side would only fail after somebody thought to look.
   */
  it("m6: every declared code has a sentence in BOTH locales", () => {
    const en = JSON.parse(readFileSync(resolve(LOCALES, "en.json"), "utf8")) as Record<string, Record<string, string>>;
    const hi = JSON.parse(readFileSync(resolve(LOCALES, "hi.json"), "utf8")) as Record<string, Record<string, string>>;
    const codes = declaredCodes();
    expect({ missingEn: codes.filter((c) => en.materialsErrors?.[c] === undefined) }).toEqual({ missingEn: [] });
    expect({ missingHi: codes.filter((c) => hi.materialsErrors?.[c] === undefined) }).toEqual({ missingHi: [] });
    // No key without a code either — a stale sentence for a code that no longer exists is dead
    // weight a translator will keep maintaining.
    expect(Object.keys(en.materialsErrors ?? {}).filter((k) => !codes.includes(k))).toEqual([]);
    // And the Hindi is actually Hindi, not a copy of the English (the parity test cannot see this).
    const same = codes.filter((c) => en.materialsErrors?.[c] === hi.materialsErrors?.[c]);
    expect({ untranslated: same }).toEqual({ untranslated: [] });
  });

  it("a MaterialsError carries its code, its message and its detail unchanged", () => {
    const e = new MaterialsError("insufficient_stock", "not enough", { available: 3 });
    expect({ name: e.name, code: e.code, message: e.message, detail: e.detail })
      .toEqual({ name: "MaterialsError", code: "insufficient_stock", message: "not enough", detail: { available: 3 } });
    // The message defaults to the code rather than to an empty string.
    expect(new MaterialsError("negative_stock").message).toBe("negative_stock");
  });
});
