import { roundTotalBy, totalInvoice } from "../billing";
import { roundTotalToRupee } from "../tariff";
import { discountTier, pharmacyRoundingRule } from "./discount";
import { tenderPayables } from "./bill";

/**
 * OWNER RULINGS 2026-09-30 (money), the pure half: which rounding a tender gets, what each rule makes of
 * ₹33.60, and who may give a discount — pinned at the exact boundaries the owner named.
 */
describe("ruling 1 — the rounding follows the tender", () => {
  it("any cash rounds DOWN; UPI or card alone collects to the paisa; no tender (the owner's credit) rounds down", () => {
    expect(pharmacyRoundingRule([{ mode: "cash" }])).toBe("down");
    expect(pharmacyRoundingRule([{ mode: "upi" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "card" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "upi" }, { mode: "card" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "cash" }, { mode: "upi" }])).toBe("down");
    expect(pharmacyRoundingRule([])).toBe("down");
  });

  it("₹33.60 is ₹33.00 in cash (a −₹0.60 rounding line) and ₹33.60 by UPI — never ₹34.00", () => {
    expect(roundTotalBy("down", 3360)).toEqual({ roundedPaise: 3300, roundingPaise: -60 });
    expect(roundTotalBy("exact", 3360)).toEqual({ roundedPaise: 3360, roundingPaise: 0 });
    expect(tenderPayables(3360)).toEqual({ cash: { netPayablePaise: 3300, roundingPaise: -60 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } });
    // Down never rounds a whole rupee away, and never goes up.
    expect(roundTotalBy("down", 3300)).toEqual({ roundedPaise: 3300, roundingPaise: 0 });
    expect(roundTotalBy("down", 3399)).toEqual({ roundedPaise: 3300, roundingPaise: -99 });
  });

  it("every other bill keeps §170 exactly as it was: half-up to the rupee, and it is the default", () => {
    for (const raw of [0, 1, 49, 50, 3340, 3350, 3360, 50_000, 12_345_678]) {
      expect(roundTotalBy("half_up", raw)).toEqual(roundTotalToRupee(raw));
    }
    expect(roundTotalBy("half_up", 3360)).toEqual({ roundedPaise: 3400, roundingPaise: 40 });
    // totalInvoice with no rule is the OPD/lab/radiology path: unchanged.
    const line = {
      lineId: "l1", serviceId: "s1", serviceName: "Consultation", category: "consultation", qty: 1, unitPaise: 3360, grossPaise: 3360,
      regulatedClamp: null, candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 3360,
      gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "category_exempt" as const, cgstPaise: 0, sgstPaise: 0 }, netPaise: 3360,
    };
    expect(totalInvoice([line])).toMatchObject({ rawTotalPaise: 3360, netPayablePaise: 3400, roundingPaise: 40 });
    expect(totalInvoice([line], "down")).toMatchObject({ netPayablePaise: 3300, roundingPaise: -60 });
  });
});

describe("ruling 2 — who gives a discount", () => {
  const pct = (bps: number, gross = 100_000) => discountTier({ kind: "percent_bps", value: bps }, gross, Math.floor((gross * bps) / 10000));

  it("up to 10% inclusive is the pharmacist's; 10.01% is the in-charge's", () => {
    expect(pct(800)).toBe("pharmacist");
    expect(pct(1000)).toBe("pharmacist");
    expect(pct(1001)).toBe("pharmacy_incharge");
  });

  it("up to 25% inclusive is the in-charge's; 25.01% is the owner's", () => {
    expect(pct(1500)).toBe("pharmacy_incharge");
    expect(pct(2500)).toBe("pharmacy_incharge");
    expect(pct(2501)).toBe("owner");
    expect(pct(10000)).toBe("owner");
  });

  it("a discount worth MORE than ₹25,000 on one bill is the owner's whatever the %; exactly ₹25,000 is not", () => {
    // 10% of ₹2,50,000 = ₹25,000.00 exactly: still the pharmacist's.
    expect(discountTier({ kind: "percent_bps", value: 1000 }, 25_000_000, 2_500_000)).toBe("pharmacist");
    expect(discountTier({ kind: "percent_bps", value: 1000 }, 25_000_010, 2_500_001)).toBe("owner");
    // 25% of ₹1,00,000 = ₹25,000.00 exactly: the in-charge's.
    expect(discountTier({ kind: "percent_bps", value: 2500 }, 10_000_000, 2_500_000)).toBe("pharmacy_incharge");
    expect(discountTier({ kind: "flat_paise", value: 2_500_001 }, 100_000_000, 2_500_001)).toBe("owner");
  });

  it("a rupee discount is judged by its exact share of the MRP total", () => {
    // ₹100.00 off ₹1,000.00 = 10.00%: the pharmacist's. One paisa more is the in-charge's.
    expect(discountTier({ kind: "flat_paise", value: 10_000 }, 100_000, 10_000)).toBe("pharmacist");
    expect(discountTier({ kind: "flat_paise", value: 10_001 }, 100_000, 10_001)).toBe("pharmacy_incharge");
    expect(discountTier({ kind: "flat_paise", value: 25_000 }, 100_000, 25_000)).toBe("pharmacy_incharge");
    expect(discountTier({ kind: "flat_paise", value: 25_001 }, 100_000, 25_001)).toBe("owner");
  });
});
