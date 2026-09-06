import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — A SERVER REFUSAL WITH NO STRING IS A REFUSAL IN THE WRONG LANGUAGE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `pharmacyErrorText(e, t)` looks the code up in `en.pharmacyErrors` and, when it is missing, FALLS
 * BACK TO THE SERVER'S OWN `message`. That fallback is good engineering — a counter must never show
 * a blank where a reason belongs — and it is exactly why the gap is silent: the screen renders a
 * complete, sensible, ENGLISH sentence, so nothing looks broken to anybody reading English.
 *
 * ═══ WHAT IT ACTUALLY COST ═══
 *
 * Five of the thirty-two codes had no string, and they were not obscure ones. `short_stock`,
 * `batch_expired`, `fefo_override_unavailable`, `invoice_not_settled` and `identity_mismatch` are
 * the five commonest refusals at a dispensing counter. So a Hindi-speaking pharmacist got Hindi for
 * the twenty-seven that rarely fire and English for the five they meet every day — including
 * `batch_expired`, which is the guard that stops expired medicine reaching a patient.
 *
 * Found by the pharmacy lane, reported rather than fixed because the locale files are contended.
 *
 * ═══ THE MIRROR OF `i18n-keys.test.ts`, AND WHY BOTH ARE NEEDED ═══
 *
 * That file walks the CLIENT's `t("ns.key")` calls and asserts each resolves — it catches a key the
 * UI asks for and nobody wrote. This is the other direction: a string the SERVER can demand and
 * nobody wrote. Neither test can see the other's defect, because the two gaps are on opposite sides
 * of the wire, and the locale parity test sees neither.
 *
 * ═══ WHY IT READS THE CORE SOURCE ═══
 *
 * The list of codes is the server's, and copying it here would create the second copy that drifts —
 * the whole failure this test exists to prevent, one level up. Reading the file as text is the
 * technique `caddyfile-parity.test.ts` and `nav-parity.test.ts` already use in the other direction,
 * and it throws rather than returning empty when the parse finds nothing (§2.49).
 */
const ERRORS_TS = join(__dirname, "../../../core/src/modules/pharmacy/errors.ts");

function pharmacyErrorCodes(): string[] {
  const source = readFileSync(ERRORS_TS, "utf8");
  const block = /export const PHARMACY_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(source);
  if (block === null) {
    throw new Error(`could not find PHARMACY_ERROR_CODES in ${ERRORS_TS} — the parser, not the model, is out of date`);
  }
  /* Comments are stripped so a `// ── pick, bill, hand over ──` divider is not read as a code. */
  const body = block[1]!.replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("every pharmacy refusal the server can throw has a string a pharmacist can read", () => {
  const codes = pharmacyErrorCodes();

  it("found the code list, and it is not empty", () => {
    /* The guard on the guard: a parser that silently matches nothing passes forever. */
    expect(codes.length).toBeGreaterThan(20);
    expect(codes).toContain("batch_expired");
  });

  it("has a locale string for every one of them", () => {
    const strings = en.pharmacyErrors as Record<string, string>;
    const missing = codes.filter((code) => typeof strings[code] !== "string");
    /*
      The message names the codes, because "3 missing" sends the reader to diff two lists by hand
      and the whole point of this test is that nobody was looking at either.
    */
    expect(missing, `these pharmacy refusals fall back to the server's English at the counter:\n${missing.join("\n")}\n`).toEqual([]);
  });

  /**
   * The other direction, and it is not symmetry for its own sake: a `pharmacyErrors` entry for a
   * code the server cannot throw is a translated sentence nobody will ever see, which costs a
   * translator's time and makes the namespace look more complete than it is.
   */
  it("has no string for a refusal the server cannot make", () => {
    const orphans = Object.keys(en.pharmacyErrors).filter((key) => !codes.includes(key));
    expect(orphans, `these locale strings answer no server code:\n${orphans.join("\n")}\n`).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY ERROR NAMESPACE IS FULLY TRANSLATED, AND NOTHING WAS CHECKING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-09-06, and the number is the reason this test exists rather than a reason it does
 * not need to:
 *
 *     materialsErrors  24 en / 24 hi      otErrors  26 / 26      pharmacyErrors  32 / 32
 *     top-level keys   71 en / 71 hi      missing from hi: 0
 *
 * **Eighty-two error strings and seventy-one top-level keys at perfect parity, held entirely by
 * hand, enforced by nothing.** A record like that is not evidence a guard is unnecessary — it is a
 * record with no instrument defending it, and the first person in a hurry breaks it silently. The
 * file above imports `en.json` alone, so nothing in this suite had ever opened `hi.json`.
 *
 * It passes today, which is exactly when a census is cheapest to add.
 *
 * ═══ WHAT A GREEN HERE DOES **NOT** MEAN ═══
 *
 * **Parity is COVERAGE, not QUALITY.** This asserts that every key present in English is present in
 * Hindi. It cannot read Hindi, and nobody should ever cite it as "the Hindi is fine" — a
 * mistranslated clinical hard stop is worse than an English one, and only a clinician can say which
 * is which. The distinction is stated here because a later reader will meet the green before they
 * meet this paragraph.
 */
describe("the Hindi locale covers the English one, namespace by namespace", () => {
  /**
   * `labErrors` is DELIBERATELY ABSENT from both locales and is not listed here, because there is
   * nothing yet to be at parity with. The laboratory's refusals reach the screen as the SERVER's
   * English prose — measured in a real browser on 2026-09-06, with the whole UI in Hindi — and the
   * reason lab has no namespace is not an oversight: 68 of its 77 refusal messages interpolate a
   * runtime value (an analyte code, a measured number, a UHID) and only 16 carry a structured
   * `detail` to rebuild one from. A generic Hindi sentence that dropped "999" and "1.0000 … 25.0000"
   * would be a DOWNGRADE for the technologist it is meant to help, because the digits are the
   * actionable part and they read the same in both scripts.
   *
   * So the gap is named here rather than papered over, and closing it is server work before it is
   * translation work. See `docs/superpowers/plans/reports/2026-09-06-lab-walk-findings.md`.
   */
  const NAMESPACES = ["pharmacyErrors", "materialsErrors", "otErrors"] as const;

  it.each(NAMESPACES)("%s — every English key has a Hindi one", (ns) => {
    const e = en[ns] as Record<string, string>;
    const h = (hi as unknown as Record<string, Record<string, string>>)[ns] ?? {};
    const missing = Object.keys(e).filter((k) => typeof h[k] !== "string" || h[k] === "");
    expect(missing, `these ${ns} refusals reach a Hindi-speaking user in English:\n${missing.join("\n")}\n`).toEqual([]);
  });

  /**
   * The whole file, not only the error namespaces: the same hand-held parity covers all 71 top-level
   * keys, and a screen's labels going untranslated is the same failure one layer out.
   */
  it("and every top-level namespace exists in Hindi", () => {
    const missing = Object.keys(en).filter((k) => !(k in (hi as unknown as Record<string, unknown>)));
    expect(missing, `these namespaces are missing from hi.json:\n${missing.join("\n")}\n`).toEqual([]);
  });
});
