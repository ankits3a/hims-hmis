import { matchReasonKeys, matchReasonsDiscriminate } from "./patients-api";
import type { WireMatchLane } from "./patients-api";

const hit = (...matchedOn: WireMatchLane[]): { matchedOn: WireMatchLane[] } => ({ matchedOn });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — A REASON EVERY ROW SHARES IS NOT A REASON
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FOUND BY LOOKING AT THE RUNNING DESK, 2026-09-03. A search for "Ramesh" returned eight rows and
 * all eight wore the same mint `same name` chip. A chip on every row carries no information: it
 * occupies the width where the thing that DOES tell the rows apart should be, and eight rows each
 * asserting a match read as corroboration rather than as the tautology it is.
 *
 * The D6 ruling this must not break is that an unexplained row never sits beside an explained one —
 * the unexplained one then reads as the stronger match. That ruling is about rows differing from
 * EACH OTHER, so the rule here is ALL OR NONE, never some.
 */
describe("matchReasonsDiscriminate", () => {
  it("hides the reasons when every row carries the identical set", () => {
    // The measured case: eight Ramesh Kumars, every one of them a name match.
    expect(matchReasonsDiscriminate(Array.from({ length: 8 }, () => hit("name")))).toBe(false);
    expect(matchReasonsDiscriminate([hit("mobile"), hit("mobile")])).toBe(false);
    // Identical PAIRS are identical too — the signature is the whole set, not its first element.
    expect(matchReasonsDiscriminate([hit("name", "mobile"), hit("name", "mobile")])).toBe(false);
  });

  it("shows them when they differ, which is the only time they tell rows apart", () => {
    expect(matchReasonsDiscriminate([hit("name"), hit("mobile")])).toBe(true);
    // A subset is a difference: "same name" beside "same name + same mobile" is worth reading.
    expect(matchReasonsDiscriminate([hit("name"), hit("name", "mobile")])).toBe(true);
    expect(matchReasonsDiscriminate([hit("name"), hit("name"), hit("uhid")])).toBe(true);
  });

  /*
    `[]` is the row that reached the result set through the trigram fallback rather than a lane, and
    `matchReasonKeys` renders it as "on file" precisely so it is never the one blank row in a column
    of explained ones. It is a signature like any other, and it differs from "same name".
  */
  it("treats the fallback row's empty set as a signature, not as absent", () => {
    expect(matchReasonsDiscriminate([hit(), hit()])).toBe(false);
    expect(matchReasonsDiscriminate([hit(), hit("name")])).toBe(true);
    expect(matchReasonKeys([])).toEqual(["registrationCounter.find.reason.onFile"]);
  });

  /*
    One row has nothing to be compared against, and its reason still tells the clerk the one thing
    they can go and check with the person in front of them. The empty result set cannot render a
    chip either way; it answers `true` rather than throwing on `hits[0]`.
  */
  it("keeps the reason on a lone hit, and does not read past the end of an empty set", () => {
    expect(matchReasonsDiscriminate([hit("mobile")])).toBe(true);
    expect(matchReasonsDiscriminate([])).toBe(true);
  });
});
