import { CASH_DENOMINATIONS_PAISE, sumDenominations } from "./cash-math";
import { BillingError } from "./errors";
import { TariffError } from "../tariff";

describe("cash-math: sumDenominations (D9 counted-cash denomination fold)", () => {
  test("hand-derived fold: {50000:3, 10000:2, 500:4} paise-denomination -> count => 172000 (150000+20000+2000)", () => {
    expect(sumDenominations({ "50000": 3, "10000": 2, "500": 4 })).toBe(172_000);
  });

  test("rejects a non-integer count, an unknown denomination key, and a negative count", () => {
    expect(() => sumDenominations({ "50000": 1.5 })).toThrow(TariffError); // assertPaise's own guard on the count
    expect(() => sumDenominations({ "999": 1 })).toThrow(BillingError); // 999 paise is not a real note/coin
    expect(() => sumDenominations({ "50000": -1 })).toThrow(TariffError);
  });

  test("an empty denomination map counts as zero", () => {
    expect(sumDenominations({})).toBe(0);
  });

  test("assertPaise guards the OUTPUT too: a count large enough to overflow the running total throws even though no single entry would have", () => {
    // Number.MAX_SAFE_INTEGER is itself a safe integer, so the per-count assertPaise lets it
    // through; only the running total's OWN assertPaise -- applied to the fold's output -- catches
    // the resulting overflow.
    expect(Number.isSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(() => sumDenominations({ [String(CASH_DENOMINATIONS_PAISE[0])]: Number.MAX_SAFE_INTEGER })).toThrow(TariffError);
  });
});
