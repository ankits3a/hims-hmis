import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { OtError, OT_ERROR_CODES, otHttpStatus } from "./errors";
import type { OtErrorCode } from "./errors";

/**
 * PLAN 15 T2 — the error union, held to the standard Plan 14's CLOSE had to invent.
 *
 * `materials/errors.test.ts` exists because `materials/errors.ts` PROMISED a test nobody wrote, and
 * behind that promise the union had drifted in both directions at once: five declared codes with
 * zero throw sites, and one code borrowed by a second caller to mean something else. This file is
 * that lesson applied at T2 instead of at CLOSE, which is the whole of the difference.
 *
 * ═══ WHY IT READS SOURCE TEXT INSTEAD OF EXERCISING THE CODE ═══
 *
 * The property is *"every declared code has a reachable thrower and every thrower is declared"*, and
 * it is a property of the MODULE, not of any one call. A behavioural suite proves it only for the
 * paths it happens to walk — which is precisely how five codes stayed in the materials union for
 * nine tasks. TypeScript already guarantees direction 2 for literal arguments; the scan is what
 * catches the direction TypeScript cannot see.
 *
 * ═══ DIRECTION 1 IS SCOPED BY WHICH FILE EXISTS, AND **NOT** BY A NUMBER ═══
 *
 * `errors.ts` declares every refusal for the WHOLE of Plan 15 at T2, before T3–T7 write the
 * throwers, so a flat "no orphans" assertion cannot pass at T2. The obvious fix — pin the orphan
 * COUNT and edit it down task by task — is a trap, and it is 16a's finding F1 wearing a different
 * hat: `errors.test.ts` is in T2's Files list and in NO other task's, so every later task would
 * have to edit a file it is not allowed to touch, and the fence would be broken by the very test
 * meant to hold the union honest.
 *
 * **So the expectation is DERIVED from the tree instead.** `OWNED_BY` names, for each code, the
 * shipped file that must throw it. A code whose file does not exist yet is legitimately unthrown; a
 * code whose file EXISTS and does not throw it is a failure, with no edit to this file at any point.
 * T3 lands `booking.ts` and `criteria_refused` becomes required in the same commit, automatically.
 * A task that lands its logic file without the refusals its Assertion Book names fails HERE.
 */
const MODULE_DIR = __dirname;

/**
 * Comments are stripped before anything is parsed. Both directions needed it in the materials
 * module and both would need it here: this module documents itself heavily, so a source scan is
 * parsing prose unless it says otherwise. It says otherwise.
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
 * Throw sites, matched ACROSS LINE BREAKS. The `[\s\S]*?` is load-bearing: house style breaks a long
 * `new OtError(` over three lines, so a single-line regex reports ZERO throwers for a code thrown
 * four times — and a scan that under-reports makes this test PASS while the union rots, which is
 * worse than not having it (materials' own recorded lesson).
 */
function throwSites(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { file, text } of shippedSources()) {
    if (file === "errors.ts") continue;
    for (const m of text.matchAll(/new OtError\(\s*"([a-z_]+)"/g)) {
      const code = m[1] as string;
      const set = found.get(code) ?? new Set<string>();
      set.add(file);
      found.set(code, set);
    }
  }
  return found;
}

describe("the OT error union (Plan 15 T2)", () => {
  it("direction 2: every THROWN code is declared in the union", () => {
    const declared = new Set<string>(OT_ERROR_CODES);
    const undeclared = [...throwSites().keys()].filter((c) => !declared.has(c));
    /**
     * A later task that needs a code this union does not carry has found a PLAN DEFECT and reports
     * it. It does not widen the union — `errors.ts` is T2's file and no other task's — and it does
     * not borrow a neighbouring code, which is the practice that made a `postGrn` caller chase a
     * transfer problem for a whole review cycle.
     */
    expect({ undeclared }).toEqual({ undeclared: [] });
  });

  it("direction 1: every code whose OWNING FILE exists is thrown by it", () => {
    const thrown = throwSites();
    const present = new Set(shippedSources().map((f) => f.file));

    /** The file that must throw each code, from the plan's Produces lists. */
    const OWNED_BY: Record<OtErrorCode, string> = {
      criteria_refused: "booking.ts",
      privilege_refused: "booking.ts",
      duplicate_booking: "booking.ts",
      definition_not_active: "definitions.ts",
      definition_invalid: "definitions.ts",
      unknown_case: "booking.ts",

      gate_open: "gates.ts",
      gate_not_overridable: "gates.ts",
      gate_already_terminal: "gates.ts",
      same_actor: "gates.ts",
      // CORRECTED at T4 by this very test (finding T4-c). `not_ready` was mapped to `lists.ts`
      // because "the list is where readiness is evaluated" — but evaluating readiness is not the
      // same act as REFUSING a case that is not ready, and nothing in `lists.ts` refuses anything on
      // that ground: `publishList` publishes whatever is bookable and `evaluateReadiness` returns a
      // state. The refusal happens where a not-ready case is STOPPED, which is the holding bay.
      not_ready: "cockpit.ts",
      consent_authority_missing: "consents.ts",
      list_not_publishable: "lists.ts",

      identity_mismatch: "cockpit.ts",
      bad_transition: "cockpit.ts",
      theatre_occupied: "cockpit.ts",
      checklist_incomplete: "cockpit.ts",
      count_mismatch: "counts.ts",
      stale_version: "counts.ts",
      implant_state: "implants.ts",
      implant_deploying: "cockpit.ts",
      duplicate_scan: "implants.ts",
      timestamp_immutable: "cockpit.ts",

      bay_occupied: "recovery.ts",
      escort_required: "recovery.ts",
      not_discharge_ready: "recovery.ts",

      bill_not_composable: "bill.ts",
      deposit_shortfall: "deposit.ts",
      cash_limit_exceeded: "bill.ts",
    };

    // The map itself must stay total — a code added to the union with no owner would be excused
    // from this check for ever, which is the hole the map replaces the number to avoid.
    expect(OT_ERROR_CODES.filter((c) => OWNED_BY[c] === undefined)).toEqual([]);

    const missing = OT_ERROR_CODES
      .filter((c) => present.has(OWNED_BY[c]))
      .filter((c) => !(thrown.get(c)?.has(OWNED_BY[c]) ?? false))
      .map((c) => `${OWNED_BY[c]} must throw "${c}"`);
    /**
     * The message names the two ways this fails and they need opposite fixes: the refusal was
     * designed and never implemented (write the thrower), or it was implemented in a NEIGHBOURING
     * file (move it, or correct this map and say why). Guessing wrong turns a missing refusal into
     * a misplaced one.
     */
    expect({ missing }).toEqual({ missing: [] });

    /**
     * ═══ THE TWO ANTI-VACUOUS GUARDS, BECAUSE AT T2 THE CHECK ABOVE IS EMPTY BY CONSTRUCTION ═══
     *
     * At T2 none of the owning files exists, so `missing` is `[]` for a reason that has nothing to
     * do with the code being right. §2.49's rule — a census is stated BEFORE anything is compared —
     * applies to the scanner itself:
     *
     *   1. **The scanner found source at all.** A `shippedSources()` that returned `[]` — a moved
     *      directory, a changed extension — would make every leg in this file pass for nothing.
     *   2. **The map's file set is the plan's own layout.** These eleven names come from T3–T7's
     *      Produces lists. Pinning them means a task that renames its logic file has to come here
     *      and say so, rather than silently excusing every code that file owned.
     */
    expect(present.size).toBeGreaterThan(0);
    expect([...new Set(Object.values(OWNED_BY))].sort()).toEqual([
      "bill.ts", "booking.ts", "cockpit.ts", "consents.ts", "counts.ts", "definitions.ts",
      "deposit.ts", "gates.ts", "implants.ts", "lists.ts", "recovery.ts",
    ]);
  });

  it("every code maps to a real 4xx status, and the map has no entry the union lacks", () => {
    /**
     * BOTH DIRECTIONS, and the second one is why this reads the SOURCE.
     *
     * TypeScript's `Record<OtErrorCode, number>` guarantees every code HAS an entry. It does not
     * catch a STALE entry: rename a code and add its replacement, and the record still typechecks
     * with the dead key sitting in it — mapping a string nothing can ever throw, for ever. The map
     * is module-private (deliberately: `otHttpStatus` is the only door), so the stale-key direction
     * is a claim about `errors.ts`'s text and is checked as one.
     */
    for (const code of OT_ERROR_CODES) {
      const status = otHttpStatus(code);
      // A real refusal status, not just "a number". `otHttpStatus("x" as OtErrorCode)` returning
      // `undefined` would satisfy `typeof === "number"` in neither direction but WOULD satisfy a
      // laxer assertion; naming the four is what makes this leg mean something.
      expect({ code, status }).toEqual({ code, status: expect.any(Number) });
      expect([403, 404, 409, 422]).toContain(status);
    }
    const errorsSource = stripComments(readFileSync(resolve(MODULE_DIR, "errors.ts"), "utf8"));
    const mapBody = errorsSource.split("const STATUS: Record<OtErrorCode, number> = {")[1]?.split("};")[0] ?? "";
    const mappedKeys = [...mapBody.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1] as string);
    // Every key in the map is a member of the union — the stale-rename direction.
    expect(mappedKeys.filter((k) => !(OT_ERROR_CODES as readonly string[]).includes(k))).toEqual([]);
    // …and the map is not truncated by a parse that found nothing, which would pass vacuously.
    expect(mappedKeys).toHaveLength(OT_ERROR_CODES.length);
  });

  /**
   * ═══ THE STATUS CLASSES, ASSERTED AS GROUPS RATHER THAN CODE BY CODE ═══
   *
   * A per-code assertion restates the table and catches only a typo. What is worth pinning is the
   * RULE, because the rule is a decision somebody will want to change under pressure: **a race is a
   * 409 and a hard stop is a 422**, and the difference is what the screen tells the nurse. A gate
   * refusal rendered as 409 reads as "try again"; the whole point of this module is that trying
   * again is exactly what must not work.
   */
  it("every race is a 409 and every hard stop a 422 — the difference the screen shows a nurse", () => {
    const races: OtErrorCode[] = [
      "duplicate_booking", "theatre_occupied", "bay_occupied", "stale_version", "duplicate_scan",
      "bad_transition", "gate_already_terminal", "definition_not_active", "timestamp_immutable",
    ];
    const hardStops: OtErrorCode[] = [
      "gate_open", "not_ready", "count_mismatch", "implant_deploying", "escort_required",
      "checklist_incomplete", "criteria_refused", "bill_not_composable", "not_discharge_ready",
    ];
    expect(races.map((c) => [c, otHttpStatus(c)])).toEqual(races.map((c) => [c, 409]));
    expect(hardStops.map((c) => [c, otHttpStatus(c)])).toEqual(hardStops.map((c) => [c, 422]));
    // The two authority refusals are 403: they are about WHO is acting, not about what was sent.
    expect(otHttpStatus("privilege_refused")).toBe(403);
    expect(otHttpStatus("same_actor")).toBe(403);
    // And the one lookup failure is a 404, so a caller can tell "no such case" from "wrong state".
    expect(otHttpStatus("unknown_case")).toBe(404);
  });

  it("carries its code, its detail and a default message", () => {
    const bare = new OtError("gate_open");
    expect({ name: bare.name, code: bare.code, message: bare.message })
      .toEqual({ name: "OtError", code: "gate_open", message: "OT refused: gate_open" });
    const detailed = new OtError("count_mismatch", "final swab count 10/9", { expected: 10, counted: 9 });
    expect({ message: detailed.message, detail: detailed.detail })
      .toEqual({ message: "final swab count 10/9", detail: { expected: 10, counted: 9 } });
  });

  /**
   * The union carries no duplicate. A repeated member changes no TypeScript at all — the derived
   * type is the same union either way — and would silently inflate the orphan pin above.
   */
  it("declares each code exactly once", () => {
    expect(new Set<string>(OT_ERROR_CODES).size).toBe(OT_ERROR_CODES.length);
  });
});
