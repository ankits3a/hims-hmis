import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { LabError, LAB_ERROR_CODES, labHttpStatus } from "./errors";
import type { LabErrorCode } from "./errors";

/**
 * PLAN 17 T2 — the error union, held to the standard Plan 14's CLOSE had to invent and Plan 15's T2
 * adopted: **every declared code has a reachable thrower, and every thrower is declared.**
 *
 * It reads SOURCE TEXT rather than exercising the code, for the reason `ot/errors.test.ts` gives at
 * length: the property is a property of the MODULE, not of any one call, and a behavioural suite
 * proves it only for the paths it happens to walk — which is how five codes stayed in the materials
 * union for nine tasks.
 *
 * ═══ DIRECTION 1 IS SCOPED BY WHICH FILE EXISTS, NOT BY A NUMBER ═══
 *
 * `errors.ts` declares every refusal for the WHOLE of Plan 17 at T2, before T3–T8 write the
 * throwers, so a flat "no orphans" assertion cannot pass at T2 — and pinning the orphan COUNT and
 * editing it down task by task is a trap, because `errors.ts` and this file are in T2's Files list
 * and in no other task's. **So the expectation is DERIVED from the tree**: `OWNED_BY` names, for
 * each code, the shipped file that must throw it. A code whose file does not exist yet is
 * legitimately unthrown; a code whose file EXISTS and does not throw it is a failure, with no edit
 * to this file at any point. T3 lands `catalogue.ts` and `unknown_orderable` becomes required in
 * the same commit, automatically.
 */
const MODULE_DIR = __dirname;

/** Comments are stripped first: this module documents itself heavily, so a raw scan parses prose. */
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
 * Throw sites, matched ACROSS LINE BREAKS. The `\s*` is load-bearing: house style breaks a long
 * `new LabError(` over three lines, so a single-line regex reports ZERO throwers for a code thrown
 * four times — and a scan that under-reports makes this test PASS while the union rots.
 */
function throwSites(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { file, text } of shippedSources()) {
    if (file === "errors.ts") continue;
    for (const m of text.matchAll(/new LabError\(\s*"([a-z_]+)"/g)) {
      const code = m[1] as string;
      const set = found.get(code) ?? new Set<string>();
      set.add(file);
      found.set(code, set);
    }
  }
  return found;
}

/** The file that must throw each code, from the phase document's Produces lists. */
const OWNED_BY: Record<LabErrorCode, string> = {
  /**
   * PLAN 17b T6 (F28) — the cross-cutting authorization refusal, and it is owned by `results.ts`
   * because that is the first file 17b lands that throws it. `catalogue.ts` and `desk.ts` throw it
   * too now (their borrowings, repaired); direction 1 only requires the OWNING file to.
   */
  permission_denied: "results.ts",

  unknown_orderable: "catalogue.ts",
  unknown_analyte: "catalogue.ts",
  foetal_sex_refused: "catalogue.ts",
  catalogue_invalid: "catalogue.ts",

  unknown_service: "desk.ts",
  consent_required: "desk.ts",
  duplicate_unacknowledged: "desk.ts",
  addon_specimen_disposed: "desk.ts",
  unknown_item: "desk.ts",
  item_not_cancellable: "money.ts",

  tube_mismatch: "collection.ts",
  identity_recheck_required: "accession.ts",
  already_received: "accession.ts",
  unknown_specimen: "accession.ts",
  specimen_not_receivable: "accession.ts",
  no_active_order: "accession.ts",

  relabel_witness_required: "accession.ts",
  relabel_witness_same_actor: "accession.ts",

  absurd_value: "results.ts",
  analyte_not_applicable: "results.ts",
  impossible_override_same_actor: "results.ts",
  absurd_override_same_actor: "results.ts",
  sod_violation: "verify.ts",
  already_verified: "verify.ts",
  user_actor_required: "verify.ts",
  item_not_resultable: "results.ts",
  unknown_result: "results.ts",
  critical_already_closed: "criticals.ts",

  report_print_blocked: "reports.ts",
  collector_identity_required: "reports.ts",
  report_not_publishable: "reports.ts",
  unknown_report: "reports.ts",
  report_not_amendable: "reports.ts",
  release_approval_invalid: "reports.ts",
  /** 17-E T1 — the machine register. `instruments.ts` is the only file that names a machine. */
  unknown_instrument: "instruments.ts",

  /**
   * 17-E T7 — the rerun rule is resolved in `results.ts`, which is where the contradiction lived,
   * and ENFORCED in `verify.ts`, which is where a number becomes reportable. So the two families
   * are owned by two files on purpose: the write-side refusals belong to the writer, the sign-side
   * refusals to the signer, and `result_superseded` is thrown by both (the owner is the signer,
   * where it is the refusal that matters clinically).
   */
  machine_cannot_supersede: "results.ts",
  rerun_choice_reason_required: "results.ts",
  no_rerun_to_choose: "results.ts",
  rerun_choice_final: "results.ts",
  rerun_unchosen: "verify.ts",
  result_superseded: "verify.ts",
};

describe("the lab error union (Plan 17 T2)", () => {
  it("direction 2: every THROWN code is declared in the union", () => {
    const declared = new Set<string>(LAB_ERROR_CODES);
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
    const missing: string[] = [];
    for (const [code, file] of Object.entries(OWNED_BY)) {
      if (!present.has(file)) continue; // the task that lands it has not run yet
      if (!(thrown.get(code)?.has(file) ?? false)) missing.push(`${code} (expected in ${file})`);
    }
    expect({ missing }).toEqual({ missing: [] });
  });

  it("every code in OWNED_BY is in the union and vice versa — the map cannot go stale silently", () => {
    expect(Object.keys(OWNED_BY).sort()).toEqual([...LAB_ERROR_CODES].sort());
  });

  /**
   * THE MAP IS TOTAL AND EVERY STATUS IS A 4xx. A 5xx here would mean the lab treats a refusal it
   * DECIDED to make as its own failure, which is the exact defect Plan 09, Plan 13 and Plan 15 each
   * shipped in turn: a `MembershipError` escaping `toHttp` reached a busy counter as a 500.
   */
  it("labHttpStatus is total, and every code maps to a 4xx", () => {
    for (const code of LAB_ERROR_CODES) {
      const status = labHttpStatus(code);
      expect([code, status >= 400 && status < 500]).toEqual([code, true]);
    }
  });

  it("the statuses say what they mean: 404 unknown, 409 race, 403 authority, 422 clinical stop", () => {
    expect(LAB_ERROR_CODES.filter((c) => labHttpStatus(c) === 404).sort()).toEqual([
      "unknown_analyte", "unknown_instrument", "unknown_item", "unknown_orderable", "unknown_report",
      "unknown_result", "unknown_service", "unknown_specimen",
    ]);
    // A compare-and-set loser is a CONFLICT: the caller's correct response is to re-read, not to
    // fix its body.
    expect(LAB_ERROR_CODES.filter((c) => labHttpStatus(c) === 409).sort()).toEqual([
      "addon_specimen_disposed", "already_received", "already_verified", "critical_already_closed",
      "item_not_cancellable", "item_not_resultable", "no_active_order",
      /** 17-E T7 — there is nothing to choose between; the set is already signed; a newer row
       *  replaced this one. All three are re-read-and-retry, which is what 409 means. */
      "no_rerun_to_choose", "report_not_amendable", "rerun_choice_final", "result_superseded",
      "specimen_not_receivable",
    ]);
    // 403 is about WHO is acting — the same pair of hands twice, or a machine where a human is required.
    expect(LAB_ERROR_CODES.filter((c) => labHttpStatus(c) === 403).sort()).toEqual([
      "absurd_override_same_actor", "impossible_override_same_actor",
      /** 17-E T7 — the bridge's body is well formed; superseding is not an act a machine performs. */
      "machine_cannot_supersede",
      "permission_denied", "relabel_witness_same_actor", "sod_violation", "user_actor_required",
    ]);
    /**
     * `report_print_blocked` IS 422 AND NOT 402, and the distinction is operational rather than
     * pedantic: a payment-required status tells a counter to take money at the window that is
     * refusing, and the money is owed to BILLING. The lab is declining to hand over a document.
     */
    expect(labHttpStatus("report_print_blocked")).toBe(422);
    /**
     * ═══ THE FOURTH LIST, ADDED AT 17-E T7 AND THE REASON THIS ASSERTION MOVED AT ALL ═══
     *
     * The 404, 409 and 403 families were pinned as whole sorted lists and 422 was pinned by ONE
     * member — so six new codes broke two lists and slipped past the family they mostly belong to.
     * A census that pins three of four sets is a census with a documented blind spot, and the fix
     * is the fourth set rather than a fourth literal: `#157` — a census that pins an INSTANCE
     * instead of the PROPERTY passes when the property breaks.
     */
    expect(LAB_ERROR_CODES.filter((c) => labHttpStatus(c) === 422).sort()).toEqual([
      "absurd_value", "analyte_not_applicable", "catalogue_invalid", "collector_identity_required",
      "consent_required", "duplicate_unacknowledged", "foetal_sex_refused",
      "identity_recheck_required", "relabel_witness_required", "release_approval_invalid",
      "report_not_publishable", "report_print_blocked",
      /** 17-E T7 — the clinical hard stop this task exists to make unskippable, and the blank
       *  reason refused in the same family because the reason IS the record. */
      "rerun_choice_reason_required", "rerun_unchosen",
      "tube_mismatch",
    ]);
    /** Total: every code is in exactly one of the four families. */
    expect(LAB_ERROR_CODES.filter((c) => ![403, 404, 409, 422].includes(labHttpStatus(c))))
      .toEqual([]);
  });

  it("LabError carries its code, its detail and a default message", () => {
    const bare = new LabError("tube_mismatch");
    expect([bare.name, bare.code, bare.message]).toEqual(["LabError", "tube_mismatch", "lab refused: tube_mismatch"]);
    const detailed = new LabError("report_print_blocked", "two lines unpaid", { unpaidLineIds: ["l-1", "l-2"] });
    expect([detailed.message, detailed.detail]).toEqual(["two lines unpaid", { unpaidLineIds: ["l-1", "l-2"] }]);
    expect(detailed).toBeInstanceOf(Error);
  });
});
