import { act, renderHook } from "@testing-library/react";
import { fmtIst, fmtPaise, monthYearIst, useDebounced } from "./format";

describe("format", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fmtPaise renders integer paise as rupees in INDIAN digit grouping, signed when negative", () => {
    // The plan's two fixture strings, transcribed (D3 / T13 step 1) — the grouping rule is not
    // re-derived here: 1,123,350 paise is ₹11,233.50 and 123,456,789 paise is ₹12,34,567.89, and
    // the second is the one that discriminates Indian grouping from western (₹1,234,567.89).
    expect(fmtPaise(1123350)).toBe("₹11,233.50");
    expect(fmtPaise(123456789)).toBe("₹12,34,567.89");

    // the boundaries either side of a group
    expect(fmtPaise(0)).toBe("₹0.00");
    expect(fmtPaise(5)).toBe("₹0.05");
    expect(fmtPaise(99)).toBe("₹0.99");
    expect(fmtPaise(100)).toBe("₹1.00");
    expect(fmtPaise(99999)).toBe("₹999.99");
    expect(fmtPaise(100000)).toBe("₹1,000.00");
    expect(fmtPaise(10000000)).toBe("₹1,00,000.00"); // one lakh — the first two-digit group
    expect(fmtPaise(1000000000)).toBe("₹1,00,00,000.00"); // one crore

    // T15's variance is signed: the minus rides OUTSIDE the rupee sign, never inside the digits.
    expect(fmtPaise(-172000)).toBe("-₹1,720.00");
    expect(fmtPaise(-5)).toBe("-₹0.05");
  });

  it("fmtIst renders a UTC instant as IST HH:MM — the opd-desk behaviour, transcribed not imported", () => {
    // 04:30Z + 5:30 = 10:00 IST (the exact pair opd-desk.test.tsx asserts for its arrivals row).
    expect(fmtIst("2026-08-18T04:30:00.000Z")).toBe("10:00");
    // Midnight IST is the previous UTC day — the case a naive getHours() on a UTC-configured desk
    // machine gets wrong, and the reason this is arithmetic rather than Intl.
    expect(fmtIst("2026-03-31T18:30:00.000Z")).toBe("00:00");
    expect(fmtIst("2026-08-17T18:29:00.000Z")).toBe("23:59");
    expect(fmtIst("2026-08-18T00:00:00.000Z")).toBe("05:30");
  });

  it("useDebounced settles ONCE on the trailing value after the window, never on the values in between", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ v }) => {
        const debounced = useDebounced(v, 250);
        seen.push(debounced);
        return debounced;
      },
      { initialProps: { v: "9" } },
    );

    expect(result.current).toBe("9");
    rerender({ v: "98" });
    rerender({ v: "987" });
    rerender({ v: "9876" });
    // nothing has settled yet: the window restarts on every keystroke
    expect(result.current).toBe("9");

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe("9");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("9876");

    // FIRES ONCE: the three intermediate values never reached a consumer, so a debounced search
    // box makes one request, not four.
    expect([...new Set(seen)]).toEqual(["9", "9876"]);
  });

  /**
   * FD-11 — "on file since", and the reason it is arithmetic rather than `Intl`.
   *
   * It sits under two rows of a duplicate list to say which record is the old one, so the month it
   * names has to be the month the HOSPITAL registered the patient, not the month the desk machine's
   * timezone thinks it was. Hospital hardware clocks are routinely set wrong; IST is a fixed +05:30
   * with no DST, so the shift is exact and never consults the host.
   */
  it("monthYearIst names the IST month, so a record made just after midnight is not the month before", () => {
    // 2019-03-31T20:30:00Z is 2019-04-01T02:00 IST — a UTC reader would call this March.
    expect(monthYearIst("2019-03-31T20:30:00.000Z")).toBe("Apr 2019");
    // ...and one minute earlier really is March, in IST.
    expect(monthYearIst("2019-03-31T18:29:00.000Z")).toBe("Mar 2019");
    // The year rolls on the same boundary.
    expect(monthYearIst("2025-12-31T18:30:00.000Z")).toBe("Jan 2026");
    expect(monthYearIst("2025-12-31T18:29:00.000Z")).toBe("Dec 2025");
  });

  /*
    A row whose date the server could not send must render as nothing rather than as "Invalid Date"
    or "NaN NaN" — the line exists to help a clerk choose between two people, and a broken string in
    it is worse than a missing one.
  */
  it("monthYearIst renders nothing for a date it cannot read", () => {
    expect(monthYearIst("")).toBe("");
    expect(monthYearIst("not-a-date")).toBe("");
  });
});
