import { assertPaise, divHalfUp, percentAmount, roundTotalToRupee, taxHead } from "./money";
import { TariffError } from "./errors";

test("divHalfUp rounds halves up and everything else to nearest", () => {
  expect(divHalfUp(16666500, 20000)).toBe(833); // 833.325 -> 833 (G02's CGST head)
  expect(divHalfUp(22650000, 20000)).toBe(1133); // 1132.5 -> 1133 (G03: banker's would say 1132)
  expect(divHalfUp(0, 100)).toBe(0);
});

test("percentAmount: half-up at the paise (G07's candidates)", () => {
  expect(percentAmount(33335, 1000)).toBe(3334); // 3333.5 -> 3334
  expect(percentAmount(33335, 500)).toBe(1667); // 1666.75 -> 1667
  expect(percentAmount(33335, 800)).toBe(2667); // 2666.8 -> 2667
});

test("taxHead computes ONE head (half the rate), half-up", () => {
  expect(taxHead(18875, 1200)).toBe(1133); // 6% = 1132.5 -> 1133
  expect(taxHead(10000, 1200)).toBe(600);
  expect(taxHead(33333, 500)).toBe(833); // 2.5% = 833.325 -> 833
});

test("roundTotalToRupee: nearest rupee, 50p goes up (§170 helper)", () => {
  expect(roundTotalToRupee(12349)).toEqual({ roundedPaise: 12300, roundingPaise: -49 });
  expect(roundTotalToRupee(12350)).toEqual({ roundedPaise: 12400, roundingPaise: 50 });
  expect(roundTotalToRupee(12351)).toEqual({ roundedPaise: 12400, roundingPaise: 49 });
});

test("assertPaise rejects floats, negatives, unsafe integers", () => {
  for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    expect(() => assertPaise(bad, "x")).toThrow(TariffError);
  }
  expect(() => assertPaise(0, "x")).not.toThrow();
});
