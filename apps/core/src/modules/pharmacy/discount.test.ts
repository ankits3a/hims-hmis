import { roundTotalBy, totalInvoice } from "../billing";
import { roundTotalToRupee } from "../tariff";
import { discountTier, pharmacyRoundingRule } from "./discount";
import { tenderPayables } from "./bill";

/**
 * OWNER RULINGS 2026-09-30 (money), the pure half: which rounding a tender gets, what each rule makes of
 * ₹33.60, and who may give a discount — pinned at the exact boundaries the owner named.
 */
describe("ruling 1 — the rounding follows the tender", () => {
  it("any cash rounds to the nearest rupee; UPI or card alone collects to the paisa; no tender (the owner's credit) is cash", () => {
    expect(pharmacyRoundingRule([{ mode: "cash" }])).toBe("half_up");
    expect(pharmacyRoundingRule([{ mode: "upi" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "card" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "upi" }, { mode: "card" }])).toBe("exact");
    expect(pharmacyRoundingRule([{ mode: "cash" }, { mode: "upi" }])).toBe("half_up");
    expect(pharmacyRoundingRule([])).toBe("half_up");
  });

  /*
    The owner's amendment on PR #424, verbatim: "If the amount is 33.60, the collection should be 34. If it's 30.91
    then collection should be Rs 31. If it is Rs 30.49 then collection can be Rs 30. But if it's 30.51 then
    collection in cash should be 31." Each of his figures, and the half itself (30.50 → 31), in cash and by UPI.
  */
  it.each([
    [3360, 3400, 40], [3091, 3100, 9], [3049, 3000, -49], [3051, 3100, 49], [3050, 3100, 50], [3000, 3000, 0],
  ])("₹%s paise: cash collects %s (rounding %s); UPI and card collect it to the paisa", (raw, cash, rounding) => {
    expect(tenderPayables(raw)).toEqual({ cash: { netPayablePaise: cash, roundingPaise: rounding }, digital: { netPayablePaise: raw, roundingPaise: 0 } });
    expect(roundTotalBy("exact", raw)).toEqual({ roundedPaise: raw, roundingPaise: 0 });
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
    expect(totalInvoice([line], "exact")).toMatchObject({ netPayablePaise: 3360, roundingPaise: 0 });
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
