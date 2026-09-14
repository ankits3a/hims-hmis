import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PHASE STAFF-REPORTS T0 — EVERY DOOR THAT READS A PAST DAY GOES THROUGH THE HORIZON, AND THIS IS
 * WHAT GOES RED WHEN A NEW ONE DOES NOT.
 *
 * ═══ WHY A CENSUS AND NOT SIX UNIT TESTS ═══
 *
 * `horizon.test.ts` proves the helper is correct. It cannot prove the helper is CALLED, and a cap
 * that is correct and uncalled is indistinguishable from no cap at all — from the outside, and from
 * inside every test that exercises the function directly.
 *
 * The failure this guards is not "somebody wrote the check wrong". It is "somebody added a seventh
 * route six months from now and did not know the rule existed". A control that depends on the next
 * author remembering is not a control; this turns the rule into a compiler.
 *
 * It follows `ist-clock-parity.test.ts` exactly — read the source, pin the census, redden on an
 * addition — and for its stated reason: an import-based test cannot see a route that simply never
 * calls the thing it should have.
 *
 * ═══ WHAT WAS MEASURED, 2026-09-14 ═══
 *
 * SIX route handlers across the two desk controllers take a `date` or a `period`, and every one of
 * them is a historical read:
 *
 *   DeskController   GET  /me/desk         `date`   — a past day's cards
 *   DeskController   GET  /me/report       `date`   — a past day's rows
 *   DeskController   GET  /me/brief        `period` — a window ending today
 *   DeskController   GET  /me/report.csv   `date`   — the same rows as a file
 *   StaffController  GET  /staff/:id/brief `period` — a colleague's window
 *   StaffController  POST /staff/:id/drill `date`   — ONE day, and it can be ANY day
 *
 * The last is the one worth naming. A route that reads a single date LOOKS bounded and is not:
 * `date` is a free parameter, so an unguarded drill reaches four years back one day at a time.
 *
 * T3's range route joins this census when it lands. It will fail here first, which is the point.
 */
const CONTROLLERS = [
  "apps/core/src/kernel/desk/desk.controller.ts",
  "apps/core/src/kernel/desk/staff.controller.ts",
];

const REPO_ROOT = resolve(__dirname, "../../..");

/** The guard every date-taking handler must reach. Named once here so a rename fails loudly. */
const GUARD = "assertMayReach";

type Handler = { file: string; method: string; body: string };

/**
 * Split a controller into its route handlers. A handler starts at an `@Get(...)`/`@Post(...)`
 * decorator and runs to the next one (or to the end of the class), which is enough to tell whether
 * the guard is called INSIDE it rather than merely somewhere in the file — the distinction the whole
 * test turns on.
 *
 * THROWS rather than returning empty when a file yields no handlers, following
 * `caddyfile-parity.test.ts`'s discipline: a parser that silently finds nothing reports a perfect
 * score for a file it failed to read.
 */
function handlersOf(file: string): Handler[] {
  const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
  const starts: { index: number; method: string }[] = [];
  const re = /@(?:Get|Post)\([^)]*\)\s*(?:@[A-Za-z]+\([^)]*\)\s*)*(?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    starts.push({ index: m.index, method: m[1]! });
  }
  if (starts.length === 0) throw new Error(`no route handlers parsed out of ${file} — the parser is broken, not the file`);
  return starts.map((s, i) => ({
    file,
    method: s.method,
    body: src.slice(s.index, i + 1 < starts.length ? starts[i + 1]!.index : src.length),
  }));
}

/** A handler is a historical read if it takes a day or a window from the caller. */
function readsHistory(h: Handler): boolean {
  return /\b(?:q\.date|q\.period|b\.date)\b/.test(h.body);
}

describe("staff-reports T0 — the horizon census", () => {
  const all = CONTROLLERS.flatMap(handlersOf);

  it("parses every route handler out of both desk controllers", () => {
    // Pinned so a refactor that hides a route from the parser cannot quietly shrink the census.
    expect(all.map((h) => h.method).sort()).toEqual(
      ["brief", "brief", "desk", "drill", "report", "reportCsv", "staff"].sort(),
    );
  });

  it("SIX handlers read a past day, and that is the census", () => {
    expect(all.filter(readsHistory)).toHaveLength(6);
  });

  /**
   * THE ASSERTION. Not "the guard appears in the file" — `GUARD` is DEFINED in both files, so a
   * file-level grep would pass with every route unguarded.
   */
  it("every handler that reads a past day calls the horizon guard INSIDE itself", () => {
    const unguarded = all
      .filter(readsHistory)
      .filter((h) => !h.body.includes(`this.${GUARD}(`))
      .map((h) => `${h.file}#${h.method}`);
    expect(unguarded).toEqual([]);
  });

  /**
   * AND THE CONVERSE, which is what makes the census a census rather than a floor: a handler that
   * does NOT read a past day has nothing to cap, and guarding it would be cargo cult. `GET /staff`
   * is the staff picker — a list of active users, no date anywhere.
   */
  it("a handler with no date does not carry the guard", () => {
    const overGuarded = all
      .filter((h) => !readsHistory(h))
      .filter((h) => h.body.includes(`this.${GUARD}(`))
      .map((h) => `${h.file}#${h.method}`);
    expect(overGuarded).toEqual([]);
  });
});
