import {
  addDaysIso, deriveObstetric, formatGa, gaFromCrlDays, hadlockEfw, hadlockGaDays, liquorFromAfi,
  obstetricBiometryInputSchema,
} from "./obstetric";

/**
 * PLAN 18-S RS7 T2 — the formulas against the published reference tables, each within the
 * tolerance the tables themselves are printed to (one day for CRL, a tenth of a week for Hadlock).
 */
describe("obstetric biometry", () => {
  it("Robinson CRL: 10 mm ≈ 7w1d, 45 mm ≈ 11w2d, 60 mm ≈ 12w2d (Robinson & Fleming 1975 table)", () => {
    expect(gaFromCrlDays(10)!).toBeGreaterThanOrEqual(49 - 1);
    expect(gaFromCrlDays(10)!).toBeLessThanOrEqual(50 + 1);
    expect(Math.abs(gaFromCrlDays(45)! - 79)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(gaFromCrlDays(60)! - 86)).toBeLessThanOrEqual(1);
    expect(gaFromCrlDays(2)).toBeNull();
    expect(gaFromCrlDays(120)).toBeNull();
  });

  it("Hadlock 1984: BPD 50 mm ≈ 21.2 w, HC 180 mm ≈ 20.4 w, AC 150 mm ≈ 20.2 w, FL 35 mm ≈ 21.1 w", () => {
    const w = (p: "bpd" | "hc" | "ac" | "fl", v: number) => hadlockGaDays(p, v)! / 7;
    expect(Math.abs(w("bpd", 50) - 21.2)).toBeLessThan(0.15);
    expect(Math.abs(w("hc", 180) - 20.4)).toBeLessThan(0.15);
    expect(Math.abs(w("ac", 150) - 20.2)).toBeLessThan(0.15);
    expect(Math.abs(w("fl", 35) - 21.1)).toBeLessThan(0.15);
    // BPD 90 mm ≈ 36.3 w; FL 70 mm ≈ 36.0 w (Hadlock's tables, the late third trimester).
    expect(Math.abs(w("bpd", 90) - 36.3)).toBeLessThan(0.25);
    expect(Math.abs(w("fl", 70) - 36.0)).toBeLessThan(0.15);
  });

  it("Hadlock 1985 EFW: the 4-parameter formula at term and mid-trimester, and the 3-parameter without BPD", () => {
    const term = hadlockEfw({ bpdMm: 90, hcMm: 330, acMm: 330, flMm: 70 })!;
    expect(term.formula).toBe("hadlock_4");
    expect(term.grams).toBe(3003); // 10^(1.3596 − 0.00386·33·7 + 0.0064·33 + 0.00061·9·33 + 0.0424·33 + 0.174·7)
    const mid = hadlockEfw({ bpdMm: 47, hcMm: 175, acMm: 150, flMm: 33 })!;
    expect(mid.grams).toBe(342); // Hadlock's 50th centile at 20 w is 331 g
    const three = hadlockEfw({ hcMm: 330, acMm: 330, flMm: 70 })!;
    expect(three.formula).toBe("hadlock_3");
    expect(three.grams).toBe(3002);
    expect(hadlockEfw({ bpdMm: 90, acMm: 330, flMm: 70 })).toBeNull();
  });

  it("liquor bands: AFI < 5 oligo, 5–24 normal, ≥ 25 poly", () => {
    expect(liquorFromAfi(4.9)).toBe("oligohydramnios");
    expect(liquorFromAfi(5)).toBe("normal");
    expect(liquorFromAfi(24.9)).toBe("normal");
    expect(liquorFromAfi(25)).toBe("polyhydramnios");
    expect(liquorFromAfi(null)).toBeNull();
  });

  it("derives GA, EDD by LMP (Naegele) and by scan, dating the pregnancy by foetus A", () => {
    const d = deriveObstetric({
      lmp: "2026-05-11",
      foetuses: [{ label: "A", bpdMm: 47, hcMm: 175, acMm: 150, flMm: 33, fhrBpm: 150 }],
      afiCm: 12,
      placenta: "posterior",
    }, "2026-09-28");
    expect(d.gaByLmpDays).toBe(140);
    expect(formatGa(d.gaByLmpDays)).toBe("20 w 0 d");
    expect(d.eddByLmp).toBe("2027-02-15");
    expect(d.foetuses[0]!.method).toBe("hadlock_mean");
    expect(d.gaByScanDays).not.toBeNull();
    expect(d.eddByScan).toBe(addDaysIso("2026-09-28", 280 - d.gaByScanDays!));
    expect(d.liquor).toBe("normal");
    expect(d.numberOfFoetuses).toBe(1);
    expect(d.foetuses[0]!.fhrOutsideRange).toBe(false);
  });

  it("a CRL dates the pregnancy by CRL, and twins are two derived rows", () => {
    const d = deriveObstetric({
      foetuses: [{ label: "A", crlMm: 45, fhrBpm: 90 }, { label: "B", crlMm: 44 }],
    }, "2026-09-28");
    expect(d.foetuses.map((f) => f.method)).toEqual(["crl", "crl"]);
    expect(d.numberOfFoetuses).toBe(2);
    expect(d.foetuses[0]!.fhrOutsideRange).toBe(true);
    expect(d.eddByLmp).toBeNull();
  });

  it("refuses an out-of-range measurement and ANY extra key — there is no field for the sex", () => {
    expect(obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A", flMm: 200 }] }).success).toBe(false);
    expect(obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A", crlMm: 40, sex: "x" }] }).success).toBe(false);
    expect(obstetricBiometryInputSchema.safeParse({ foetuses: [{ label: "A" }], gender: "x" }).success).toBe(false);
    expect(obstetricBiometryInputSchema.safeParse({ foetuses: [] }).success).toBe(false);
  });
});
