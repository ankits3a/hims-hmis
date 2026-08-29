import { formatPaise } from "./money";

/**
 * PLAN 07c T2 — the server's money renderer, pinned against the WEB's `fmtPaise` behaviour it was
 * transcribed from. Two copies of one function is a deviation from the house rule (see the file's
 * header for why the report needs it); these assertions are what makes the deviation safe rather
 * than a second answer waiting to diverge.
 */
it("renders paise as rupees with Indian digit grouping — 12,34,567, never 1,234,567", () => {
  expect(formatPaise(123456700)).toBe("₹12,34,567.00");
  expect(formatPaise(100000)).toBe("₹1,000.00");
  expect(formatPaise(99900)).toBe("₹999.00");
});

it("always shows two decimal places, including the ones a human would drop", () => {
  expect(formatPaise(30000)).toBe("₹300.00");
  expect(formatPaise(30050)).toBe("₹300.50");
  expect(formatPaise(30005)).toBe("₹300.05");
  expect(formatPaise(0)).toBe("₹0.00");
  expect(formatPaise(7)).toBe("₹0.07");
});

/** A cashier's variance is a real negative number, and an unsigned one on a filed sheet is a lie. */
it("renders a negative amount signed", () => {
  expect(formatPaise(-172000)).toBe("-₹1,720.00");
  expect(formatPaise(-5)).toBe("-₹0.05");
});
