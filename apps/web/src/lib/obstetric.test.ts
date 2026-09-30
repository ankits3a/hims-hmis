import { describe, expect, it } from "vitest";
// The contracts SOURCE by path — the server's one copy — not the package entry (see eye-line.ts).
import * as server from "../../../../packages/contracts/src/obstetric";
import * as web from "./obstetric";

/**
 * PLAN 18-S RS7 — the Scan room's live GA/EFW/EDD is the web's copy of the server's formulas. Both
 * copies over the same measurements, so the number a sonologist reads while measuring is the number
 * the server stores on save.
 */
const CASES: { input: server.ObstetricBiometryInput; day: string }[] = [
  { day: "2026-09-28", input: { lmp: "2026-05-11", afiCm: 12, placenta: "posterior", foetuses: [{ label: "A", bpdMm: 47, hcMm: 175, acMm: 150, flMm: 33, fhrBpm: 148 }] } },
  { day: "2026-09-28", input: { foetuses: [{ label: "A", crlMm: 45, fhrBpm: 90 }, { label: "B", crlMm: 44 }] } },
  { day: "2027-01-02", input: { lmp: "2026-04-01", afiCm: 4, foetuses: [{ label: "A", bpdMm: 90, hcMm: 330, acMm: 330, flMm: 70, fhrBpm: 170 }] } },
  { day: "2026-12-31", input: { afiCm: 26, foetuses: [{ label: "A", hcMm: 330, acMm: 330, flMm: 70 }] } },
];

describe("obstetric biometry — the web copy agrees with the server", () => {
  it("derives the same GA, EFW, EDD and liquor for every case", () => {
    for (const c of CASES) {
      expect(web.deriveObstetric(c.input as web.ObstetricBiometryInput, c.day)).toEqual(server.deriveObstetric(c.input, c.day));
    }
  });
  it("carries the same declaration, the same vocabularies and the same ranges", () => {
    expect(web.PCPNDT_REPORT_DECLARATION_EN).toBe(server.PCPNDT_REPORT_DECLARATION_EN);
    expect(web.PCPNDT_REPORT_DECLARATION_HI).toBe(server.PCPNDT_REPORT_DECLARATION_HI);
    expect(web.PLACENTA_POSITIONS).toEqual(server.PLACENTA_POSITIONS);
    expect(web.PRESENTATIONS).toEqual(server.PRESENTATIONS);
    for (const [k, max] of Object.entries(web.BIOMETRY_MAX)) {
      const key = k as keyof typeof web.BIOMETRY_MAX;
      if (key === "afiCm") {
        expect(server.obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A" }], afiCm: max }).success).toBe(true);
        expect(server.obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A" }], afiCm: max + 1 }).success).toBe(false);
      } else {
        expect(server.obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A", [key]: max }] }).success).toBe(true);
        expect(server.obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A", [key]: max + 1 }] }).success).toBe(false);
      }
    }
  });
});
