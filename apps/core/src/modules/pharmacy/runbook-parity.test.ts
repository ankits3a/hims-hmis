import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PHARMACY_ERROR_CODES } from "./errors";

/**
 * ═══ PHARMACY P9 — THE RUNBOOK'S REFUSAL TABLE CANNOT FALL BEHIND `errors.ts` ═══
 *
 * `docs/runbooks/pharmacy-go-live.md` §4 is what staff read when the counter refuses. Its heading said
 * "all 33 codes" while `errors.ts` declared 50, and three codes had no row. Nothing had noticed:
 * a written count goes stale silently. This test is the check, so the prose no longer has to be
 * remembered.
 */
const RUNBOOK = join(__dirname, "../../../../../docs/runbooks/pharmacy-go-live.md");

describe("the pharmacy runbook's refusal table (P9)", () => {
  const text = readFileSync(RUNBOOK, "utf8");
  const section = text.slice(text.indexOf("## 4. What refuses"), text.indexOf("## 5."));

  it("names every code errors.ts declares, and says how many there are", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(PHARMACY_ERROR_CODES.filter((c) => !section.includes(`\`${c}\``))).toEqual([]);
    expect(section).toContain(`all ${String(PHARMACY_ERROR_CODES.length)} codes`);
    expect(section).toContain(`\`errors.ts\` declares ${String(PHARMACY_ERROR_CODES.length)}`);
  });
});
