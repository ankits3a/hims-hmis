import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchIntent } from "./phrasebook";

/**
 * E1.3 — THE PHONE'S CHIPS ARE PHRASEBOOK PHRASES (spec /opt/hmis-context/SPEC-copilot-phone-2026-10-11.md §7).
 *
 * A chip sends its own label, in the reader's language, as the question. Each label must route to the
 * chip's intent through the phrasebook alone, so a chip is answered with no model and never lands on
 * "I did not understand". The labels and the chip→intent table live in the phone app; this reads them.
 */
const MOBILE = join(__dirname, "..", "..", "..", "..", "mobile", "src");
const model = readFileSync(join(MOBILE, "copilot", "model.ts"), "utf8");
const chipIntents = Object.fromEntries(
  [...model.matchAll(/^\s+(\w+): \{ intent: "([\w.]+)", permission:/gm)].map((m) => [m[1]!, m[2]!]),
);

describe("E1.3 — every phone chip routes to its intent by the phrasebook", () => {
  it("reads the four chips from the app", () => {
    expect(chipIntents).toEqual({
      queue: "queue_depth", myDuty: "roster.my_duties", myNight: "roster.my_duties", myDay: "my_day_report",
    });
  });

  for (const lang of ["en", "hi"] as const) {
    it(`${lang}: each chip label is answered by its own intent`, () => {
      const labels = (JSON.parse(readFileSync(join(MOBILE, "locales", `${lang}.json`), "utf8")) as {
        copilotPhone: { chip: Record<string, string> };
      }).copilotPhone.chip;
      expect(Object.keys(labels).sort()).toEqual(Object.keys(chipIntents).sort());
      for (const [chip, label] of Object.entries(labels)) {
        expect([chip, label, matchIntent(label)?.intent ?? null]).toEqual([chip, label, chipIntents[chip]]);
      }
    });
  }
});
