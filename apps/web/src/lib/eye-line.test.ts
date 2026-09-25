import { describe, expect, it } from "vitest";
// The contracts SOURCE by path — the server's one copy — not the package entry (see eye-line.ts).
import * as server from "../../../../packages/contracts/src/rx-eye";
import * as web from "./eye-line";

describe("eye line — the web's copy matches the server's vocabulary exactly", () => {
  it("the taper wording, the day sum, the eye words and the bounds are identical", () => {
    for (const steps of [[{ timesPerDay: 6, days: 7 }, { timesPerDay: 4, days: 7 }], web.TAPER_PRESET, [{ timesPerDay: 12, days: 60 }, { timesPerDay: 1, days: 1 }]]) {
      expect(web.taperText(steps)).toBe(server.taperText(steps));
      expect(web.taperDays(steps)).toBe(server.taperDays(steps));
    }
    expect(web.EYE_TEXT).toEqual(server.EYE_TEXT);
    expect(web.EYES).toEqual(server.EYES);
    expect([web.TAPER_MIN_STEPS, web.TAPER_MAX_STEPS, web.TAPER_MAX_TIMES, web.TAPER_MAX_DAYS])
      .toEqual([server.TAPER_MIN_STEPS, server.TAPER_MAX_STEPS, server.TAPER_MAX_TIMES, server.TAPER_MAX_DAYS]);
    expect(web.taperText(web.TAPER_PRESET)).toBe("Taper: 6×/day × 7d → 4×/day × 7d → 3×/day × 7d → 2×/day × 7d → 1×/day × 7d");
  });
});
