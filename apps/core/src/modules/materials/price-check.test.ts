import { PRICE_CHECK_THRESHOLD_BPS } from "./config";
import { isAboveReference, judgePrice, reasonAnswers } from "./price-check";
import type { PriceContract, PriceReceipt } from "./price-check";

/** #1061 / 0096 — the price check's pure rules. The paths that use them: pharmacy/acceptance/grn-price-check-1061.test.ts. */
describe("the purchase price check's judgement (#1061)", () => {
  const receipt = (paisePerBase: number, vendorId = "v-a"): PriceReceipt => ({ grnNo: "G", postedOn: "2026-11-01", vendorId, vendorName: vendorId, paisePerBase });
  const contract = (ratePaise: number, multiplier = 10): PriceContract => ({ vendorId: "v-a", vendorName: "v-a", uom: "strip", multiplier, ratePaise, paisePerBase: ratePaise / multiplier });

  it("is owned by the 2% ruling", () => {
    expect(PRICE_CHECK_THRESHOLD_BPS).toBe(200);
  });

  it("amber only MORE than 2% above, and never for a paisa of rounding", () => {
    expect(isAboveReference(816, 800)).toBe(false); // exactly 2%
    expect(isAboveReference(817, 800)).toBe(true);
    // A 10-paise tablet: one paisa is 10%, but it is the floor of a per-unit cost.
    expect(isAboveReference(11, 10)).toBe(false);
    expect(isAboveReference(12, 10)).toBe(true);
  });

  it("first purchase with nothing on record; ok within 2%; amber names the lower reference it exceeds", () => {
    expect(judgePrice(900, [], null, []).status).toBe("first");
    expect(judgePrice(810, [receipt(800)], null, [])).toMatchObject({ status: "ok", refKind: "last_receipt", refPaisePerBase: 800, riseBps: 125 });
    // Above both: the contract (780) is the lower, so it is the one named.
    expect(judgePrice(900, [receipt(800)], contract(7_800), [])).toMatchObject({ status: "amber", refKind: "contract", refPaisePerBase: 780 });
    // Above the contract only.
    expect(judgePrice(820, [receipt(850)], contract(7_800), [])).toMatchObject({ status: "amber", refKind: "contract" });
    // A contract that falls between two paise per unit (₹78.05 a strip of 10).
    expect(judgePrice(796, [], contract(7_805), []).status).toBe("ok");
    expect(judgePrice(797, [], contract(7_805), []).status).toBe("amber");
  });

  it("names the cheapest price on record below the line, by more than rounding", () => {
    const onRecord = [{ vendorId: "v-b", vendorName: "B", paisePerBase: 790 }, { vendorId: "v-c", vendorName: "C", paisePerBase: 760 }];
    expect(judgePrice(840, [receipt(800)], null, onRecord).cheaper).toEqual({ vendorId: "v-c", vendorName: "C", paisePerBase: 760 });
    expect(judgePrice(761, [receipt(800)], null, onRecord).cheaper).toBeNull();
  });

  it("a reason answers with one of the four codes, and 'other' only with words", () => {
    expect(reasonAnswers({ code: "urgent_buy" })).toBe(true);
    expect(reasonAnswers({ code: "other", text: "  " })).toBe(false);
    expect(reasonAnswers({ code: "other", text: "only stockist" })).toBe(true);
    expect(reasonAnswers({ code: "cheap" as never })).toBe(false);
    expect(reasonAnswers(null)).toBe(false);
  });
});
