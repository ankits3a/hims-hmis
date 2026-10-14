import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dateLocale } from "./date-locale";

/**
 * WALK 2026-10-14 — Hindi screens printed "WED 14 OCT" and "23 Sept": a date with a NAMED month or
 * weekday was formatted with a hard-coded English locale. Such a date takes its locale from
 * `dateLocale()`, which follows the app's language. Numeric dates and times read the same in both
 * languages and are not this defect.
 */
describe("dates with a named month or weekday follow the language", () => {
  it("dateLocale() is Hindi in Hindi and the screen's English otherwise", () => {
    expect(dateLocale("hi")).toBe("hi-IN");
    expect(dateLocale("en")).toBe("en-IN");
    expect(dateLocale("en", "en-GB")).toBe("en-GB");
  });

  it("no screen formats a named month or weekday with a hard-coded English locale", () => {
    /* Each exception says why the text must stay English. */
    const ALLOWED: Record<string, string> = {
      "lib/snippets.ts": "a comment that documents the en-IN month spelling",
      "components/radiology/imaging-report-print.tsx": "a signed imaging report: the printed clinical record keeps one language",
    };
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).replace(/\\/g, "/");
      if (ALLOWED[rel] !== undefined) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/"en-(IN|GB|US)"/g)) {
        // the options object of the same call: up to its closing brace
        const after = text.slice(m.index, m.index + 260);
        const call = after.slice(0, (after.indexOf("}") + 1) || after.length);
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        // `dateLocale(undefined, "en-GB")` names the English the helper falls back to, which is fine
        if (/(month:\s*"(short|long)"|weekday:)/.test(call) && !/hi-IN|dateLocale\(undefined, $/.test(before)) {
          offenders.push(`${rel}:${String(text.slice(0, m.index).split("\n").length)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
