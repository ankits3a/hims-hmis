import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IST_UTC_OFFSET_MINUTES } from "../src/kernel/approvals/cumulative";

/**
 * PLAN 09a CLOSE — THE HOSPITAL'S CLOCK IS WRITTEN OUT BY HAND IN NINE PLACES, AND THIS IS WHAT
 * GOES RED WHEN ONE OF THEM DRIFTS.
 *
 * ═══ WHY THIS FILE EXISTS, AND WHAT IT COST TO LEARN ═══
 *
 * Plan 09's independent reviewer found MAJOR 3: `attributeInvoice` compared raw INSTANTS while the
 * counter compared IST CALENDAR DAYS, so for ~18.5 hours of every imported card's final day the
 * hospital honoured a discount and credited the partner nothing. Plan 09a fixed it — and then found
 * **a second copy of the same predicate** in `pnl.ts`, inside a function whose own docstring
 * declared it to BE `attributeInvoice`'s predicate. Fixing only the copy the reviewer named would
 * have made that comment false while leaving the P&L crediting a different set of invoices.
 *
 * Ledger §2.105 is the rule that came out of it: **the repair is not "never write it twice" — it is
 * one expression plus a test that reddens when the copies disagree.** This file applies that one
 * level DOWN: not to the predicate, but to the constant underneath every version of it.
 *
 * ═══ WHAT WAS MEASURED, 2026-08-26 ═══
 *
 * NINE sites carry the offset. **One of them — `kernel/approvals/cumulative.ts` — does it properly**,
 * exporting `IST_UTC_OFFSET_MINUTES = 330` and deriving from it. **Nothing in the repository imports
 * that constant.** The other eight hand-roll the arithmetic in two different spellings,
 * `5.5 * 60 * 60 * 1000` and `330 * 60_000`. Today all nine equal 19,800,000 and nothing enforces it;
 * **one mistyped digit reproduces MAJOR 3 exactly** — a module that believes a different day has
 * begun than the module next to it.
 *
 * They are NOT consolidated here, and that is deliberate rather than lazy. `scheduler.ts` states the
 * reason in as many words — *"kept local here rather than imported so the scheduler carries no
 * dependency on another kernel surface for one constant"* — which is defensible for a design-law
 * constant unchanged since 1947, and consolidating nine files across frozen modules is not a close
 * remediation's work. **The duplication is a choice; the silence was not.**
 *
 * ═══ HOW IT CHECKS, AND WHY IT READS SOURCE ═══
 *
 * Three of the nine are private to their file and one is inline inside an expression, so an
 * import-based test would be blind to exactly the copies most likely to drift. Each site's
 * expression is PINNED verbatim and evaluated by a small multiplier parser — never `eval`. A tenth
 * copy fails the census, the same discipline `manifests.test.ts` applies to module registration.
 *
 * ═══ THE TENTH COPY ARRIVED, 2026-08-27 (Plan 14 T6) ═══
 *
 * `modules/materials/grn.ts` needs the IST calendar date of an instant to number a GRN through
 * `EPISODE_SERIES`. It took the `modules/billing/time.ts` route — copy the two lines module-locally,
 * because cross-module internals are not importable (spec §4) and a goods-receipt date is not an OPD
 * concept — and **this census is what made that a DELIBERATE act rather than a silent one**: the
 * phase's verify went red here, the file was not in the task's Files list, and the copy had to be
 * argued for in writing before it could land. That is the friction the docstring above promises,
 * working exactly as designed, one phase later. Recorded as finding F10 in Plan 14's CLOSE.
 */

const IST_OFFSET_MS = 19_800_000; // 5h30m. Design law, no DST.

/** Every site, with the exact text it uses. A changed expression is a changed clock. */
const SITES: { file: string; expr: string }[] = [
  { file: "src/kernel/approvals/cumulative.ts", expr: "IST_UTC_OFFSET_MINUTES * 60_000" },
  { file: "src/kernel/retention/sweep.ts", expr: "330 * 60_000" },
  { file: "src/kernel/worker/partitions.ts", expr: "330 * 60_000" },
  { file: "src/kernel/worker/scheduler.ts", expr: "330 * 60_000" },
  { file: "src/modules/billing/time.ts", expr: "5.5 * 60 * 60 * 1000" },
  { file: "src/modules/membership/coupon-rules.ts", expr: "5.5 * 60 * 60 * 1000" },
  { file: "src/modules/opd/search-providers.ts", expr: "5.5 * 60 * 60 * 1000" },
  { file: "src/modules/opd/time.ts", expr: "5.5 * 60 * 60 * 1000" },
  { file: "src/modules/partners/kicker.ts", expr: "5.5 * 60 * 60 * 1000" },
  // PLAN 14 T6 — the tenth. See the paragraph above: a GRN number is series-numbered by IST
  // calendar date, and `grn.ts` resolves one when its caller does not supply it.
  { file: "src/modules/materials/grn.ts", expr: "5.5 * 60 * 60 * 1000" },
];

/** A product of number literals, with `IST_UTC_OFFSET_MINUTES` resolved. No eval, no Function. */
function productOf(expr: string): number | null {
  let acc = 1;
  for (const raw of expr.split("*")) {
    const p = raw.trim().replace(/_/g, "");
    if (p === "ISTUTCOFFSETMINUTES") { acc *= IST_UTC_OFFSET_MINUTES; continue; }
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    acc *= Number(p);
  }
  return acc;
}

const CORE = join(__dirname, "..");
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}
const rel = (f: string): string => f.slice(f.indexOf("src/"));

describe("the IST clock is the same clock everywhere (09a close, ledger §2.105)", () => {
  it("the one NAMED constant is 330 minutes, and every hand-rolled copy agrees with it", () => {
    expect({ istUtcOffsetMinutes: IST_UTC_OFFSET_MINUTES }).toEqual({ istUtcOffsetMinutes: 330 });
    expect(IST_UTC_OFFSET_MINUTES * 60_000).toBe(IST_OFFSET_MS);

    const disagreeing = SITES
      .map((s) => ({ file: s.file, expr: s.expr, value: productOf(s.expr) }))
      .filter((s) => s.value !== IST_OFFSET_MS);
    expect({ sitesDisagreeingWithTheClock: disagreeing })
      .toEqual({ sitesDisagreeingWithTheClock: [] });
  });

  it("every pinned site still contains the expression this test believes it contains", () => {
    // Without this the arithmetic above is checked against a list, not against the CODE — the
    // §2.105 defect exactly: a claim about a file that the file never has to honour.
    const drifted = SITES.filter((s) => !readFileSync(join(CORE, s.file), "utf8").includes(s.expr));
    expect({ sitesWhoseExpressionMoved: drifted.map((s) => `${s.file} :: ${s.expr}`) })
      .toEqual({ sitesWhoseExpressionMoved: [] });
  });

  it("the census is pinned — an ELEVENTH copy of the hospital clock is a deliberate change", () => {
    const carrying = new Set<string>();
    for (const file of sourceFiles(join(CORE, "src"))) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trimStart();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
        for (const m of line.matchAll(/(\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:_\d+)*(?:\.\d+)?){1,3})/g)) {
          if (productOf(m[1]!) === IST_OFFSET_MS) carrying.add(rel(file));
        }
        if (line.includes("IST_UTC_OFFSET_MINUTES * 60_000")) carrying.add(rel(file));
      }
    }
    expect({ sites: [...carrying].sort() }).toEqual({ sites: SITES.map((s) => s.file).sort() });
  });
});
