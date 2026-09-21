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
