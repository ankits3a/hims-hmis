import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";

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
