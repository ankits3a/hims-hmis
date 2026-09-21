import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROSTER_ERROR_CODES, ROSTER_ERROR_SENTENCES, RosterError, rosterHttpStatus } from "./errors";

/**
 * PHASE R (R1) — **INVARIANT V10**: every refusal has one code, carries its facts in `detail`, and
 * has a fallback sentence a human can act on — with **no instant formatted into the message.**
 *
 * The UTC leg is the one worth explaining. A roster is read by people standing in a ward in Bihar
 * at 01:30, and every window this phase stores is a `timestamptz`. A refusal that renders one into
 * its own message renders it in whatever zone the server process happens to be in — which is
 * `Etc/UTC` here (ground truth G6) — and *"already on duty until 2026-10-13T02:30:00Z"* is a
 * sentence a junior resident will read as half past two in the morning of a day they are not
 * working. Instants travel in `detail`; IST rendering belongs to whatever shows them.
 */
describe("roster — refusals (V10)", () => {
  it("the code list has no duplicates and every code has a status", () => {
    expect(new Set(ROSTER_ERROR_CODES).size).toBe(ROSTER_ERROR_CODES.length);
    for (const code of ROSTER_ERROR_CODES) {
      const status = rosterHttpStatus(code);
      expect(`${code} -> ${status}`).toMatch(/-> (40[349]|422)$/);
    }
  });

  it("every code has a fallback sentence that stands on its own", () => {
    expect(Object.keys(ROSTER_ERROR_SENTENCES).sort()).toEqual([...ROSTER_ERROR_CODES].sort());
    for (const code of ROSTER_ERROR_CODES) {
      const sentence = ROSTER_ERROR_SENTENCES[code];
      // Long enough to say what to do about it, and not a restatement of the code.
      expect(`${code}: ${sentence.length >= 30}`).toBe(`${code}: true`);
      expect(sentence).not.toContain(code);
      // No placeholder left un-rendered: the sentence is shown when `detail` cannot be.
      expect(sentence).not.toMatch(/\{|\}|\$\{|%s/);
    }
  });

  it("NO sentence carries an instant, a UTC ISO string or a timezone offset", () => {
    for (const code of ROSTER_ERROR_CODES) {
      const sentence = ROSTER_ERROR_SENTENCES[code];
      expect(sentence).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(sentence).not.toMatch(/\d{2}:\d{2}/);
      expect(sentence).not.toMatch(/\bUTC\b|\bZ\b|[+-]\d{2}:\d{2}/);
    }
  });

  /**
   * PHASE R (R10) — **THE CENSUS ABOVE WALKS THE FALLBACK TABLE, NOT THE MESSAGES PEOPLE SEE.**
   *
   * `RosterError`'s constructor is `super(message ?? ROSTER_ERROR_SENTENCES[code])`, and roughly
   * thirty call sites across this module pass a message of their own — built from caller input,
   * from a person's name, from a window. V10 says *"no UTC ISO string in a `message`"*, and a close
   * review pointed out that for every message a user will actually read, that clause was unproven.
   *
   * So this walks the SOURCE for custom messages and refuses the two ways an instant gets into one:
   * a `.toISOString()` interpolated directly, and a bare `Date`-ish identifier dropped into a
   * template. Instants belong in `detail`, where the client renders them in IST — the whole reason
   * the clause exists, because "20:00Z" to somebody standing in a ward in Patna is a lie.
   *
   * **The lookahead is anchored, and the first version of it was not.** `(?!undefined)` after
   * `\s*` is evaluated at the space, which the engine can match zero-width, so it succeeded on
   * every site: 118 matches, 67 of them the literal `undefined`. A second reviewer measured it.
   * The count below therefore means what it says — sites that pass a message of their own.
   */
  it("V10: NO throw site interpolates an instant into a MESSAGE — they go in `detail`", () => {
    const SRC = resolve(__dirname);
    const offenders: string[] = [];
    let customMessages = 0;

    for (const file of readdirSync(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(SRC, file), "utf8");
      // `new RosterError("code", <message>, …` — the second argument, when it is not `undefined`.
      const re = /new RosterError\(\s*"[a-z_]+"\s*,\s*(?!undefined\s*[,)])([\s\S]{0,240}?)(?:,\s*\{|\)\s*;)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const msg = m[1];
        if (msg === undefined) continue;
        customMessages += 1;
        if (/toISOString\(\)/.test(msg)) offenders.push(`${file}: toISOString in a message — ${msg.slice(0, 70)}`);
        if (/\bUTC\b|[+-]\d{2}:\d{2}/.test(msg)) offenders.push(`${file}: a zone literal in a message — ${msg.slice(0, 70)}`);
        // The harder half: a Date-ish identifier interpolated bare. `${startsAt}` stringifies to
        // "Mon Oct 12 2026 20:00:00 GMT+0000" — no `toISOString()` to grep for, and the same lie.
        // `At` capitalised on purpose: the module's Date-ish names are `startsAt`, `endsAt`,
        // `decidedAt`. A lower-case `at` would also match `${what}`, a plain noun — which the
        // first version of this line did, and it is the difference between a guard and a nuisance.
        for (const g of msg.matchAll(/\$\{\s*([A-Za-z0-9_.]*(?:At|Date|From|To))\s*\}/g)) {
          offenders.push(`${file}: bare ${g[1]!} interpolated into a message — ${msg.slice(0, 70)}`);
        }
      }
    }

    // The scan FOUND custom-message sites — a census that matched nothing would pass vacuously.
    // This module has ~50; the assertion is loose on purpose so a refactor that moves messages
    // about does not fail it, and tight enough that a regex matching nothing does.
    expect(customMessages).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it("a thrown error carries its code, its sentence and its facts separately", () => {
    const e = new RosterError("unknown_position", undefined, { positionKey: "registrar" });
    expect(e.code).toBe("unknown_position");
    expect(e.message).toBe(ROSTER_ERROR_SENTENCES.unknown_position);
    expect(e.detail).toEqual({ positionKey: "registrar" });
    expect(e.name).toBe("RosterError");
    expect(e).toBeInstanceOf(Error);
  });

  it("the two 403s are DIFFERENT causes and a client can tell them apart", () => {
    // Plan 20 T1 had one `not_permitted` for both, which is a client that cannot tell a bug in its
    // own caller from a person who needs to be given a grant.
    expect(rosterHttpStatus("not_permitted")).toBe(403);
    expect(rosterHttpStatus("act_not_available_to_actor")).toBe(403);
    expect(ROSTER_ERROR_SENTENCES.not_permitted).not.toBe(ROSTER_ERROR_SENTENCES.act_not_available_to_actor);
  });
});
