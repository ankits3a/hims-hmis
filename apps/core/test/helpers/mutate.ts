/**
 * PLAN 09 CLOSE, 2026-08-26 — A TEST THAT MUTATES AN INPUT MUST PROVE THE MUTATION MUTATED.
 *
 * The specimen. Plan 09's T7 asserted that "a code differing by ONE CHARACTER resolves to nothing"
 * and built that code as `` `${code.slice(0, -1)}X` `` — replace the last character with a literal
 * `X`. Attribution codes are `RF-` plus the last ten characters of a ULID, and ULID uses Crockford
 * base32, so **one code in thirty-two already ends in `X`**. On those runs the "mutated" code is
 * BYTE-IDENTICAL to the original, the lookup correctly finds the record, and the assertion fails —
 * a red that no diff can explain, on code nobody touched.
 *
 * It cost this project a red CI on Plan 09's own CLOSE commit, an hour of diagnosis, and very nearly
 * a wrong conclusion (see EXECUTION-LESSONS §2.98). Two sites carried the pattern, so the phase ran
 * at roughly a 6% chance of an unexplained red per CI run.
 *
 * THE THROW IS THE POINT, not the swap. A helper that merely picked a different letter would fix
 * these two sites and be silently re-broken by the next one. This one **cannot** return its input:
 * if a future alphabet, prefix or length makes the swap collide, the test fails LOUDLY at the line
 * that built the fixture rather than mysteriously three assertions later.
 */
export function differingByOneChar(value: string): string {
  if (value.length === 0) throw new Error("differingByOneChar: empty string has no character to change");
  const last = value.slice(-1);
  // Two candidates so the swap is total: whichever the original is, the other differs.
  const replacement = last === "X" ? "Y" : "X";
  const mutated = `${value.slice(0, -1)}${replacement}`;
  if (mutated === value) {
    throw new Error(`differingByOneChar: the mutation did not mutate "${value}" — the fixture proves nothing`);
  }
  return mutated;
}
