import { creditShare } from "./credit-share";
import type { CreditShare, CreditableLine } from "./credit-share";
import { BillingError } from "./errors";
import { TariffError } from "../tariff";

/**
 * Plan 08 D4 / Task 2. The pro-ration rule is CUMULATIVE: the share of a money field F for a credit of
 * qty k after p already credited is divHalfUp(F x (p + k), n) - divHalfUp(F x p, n). Every value here is
 * hand-derived in the plan document (Task 2's B-05 and B-06 derivations, self-review items 2 and 21).
 */
const netOf = (share: CreditShare): number => share.taxableBasePaise + share.cgstPaise + share.sgstPaise;

/** B-05: F = 100 over n = 3 — the fixture chosen because the naive rule visibly leaks a paise. */
const b05: CreditableLine = { grossPaise: 100, discountPaise: 0, taxableBasePaise: 100, cgstPaise: 0, sgstPaise: 0, qty: 3 };

/** B-06: qty 3, gross 10000, discount 1000, base 9000 at 1200 bps — taxHead(9000, 1200) = 540 per head, net 10080. */
const b06: CreditableLine = { grossPaise: 10000, discountPaise: 1000, taxableBasePaise: 9000, cgstPaise: 540, sgstPaise: 540, qty: 3 };

describe("creditShare (pure, cumulative pro-ration, D4)", () => {
  it("B-05: the cumulative rule pays 33, 34, 33 — the naive per-refund share pays 33, 33, 33", () => {
    // cum(1) = divHalfUp(100, 3) = floor((200 + 3) / 6) = 33; cum(2) = divHalfUp(200, 3) = floor((400 + 3) / 6) = 67;
    // cum(3) = divHalfUp(300, 3) = 100. Shares: 33, 67 - 33 = 34, 100 - 67 = 33.
    expect(creditShare(b05, 0, 1).grossPaise).toBe(33);
    expect(creditShare(b05, 1, 1).grossPaise).toBe(34);
    expect(creditShare(b05, 2, 1).grossPaise).toBe(33);
  });

  it("B-05: cumulative credits EXHAUST the line exactly — 33 + 34 + 33 = 100, never 99", () => {
    const shares = [0, 1, 2].map((prevQty) => creditShare(b05, prevQty, 1));
    expect(shares.reduce((sum, s) => sum + s.grossPaise, 0)).toBe(100);
    expect(shares.reduce((sum, s) => sum + s.taxableBasePaise, 0)).toBe(100);
  });

  it("B-06 step 1 of 3: gross 3333, discount 333, base 3000, heads 180 — net 3360", () => {
    // divHalfUp(10000, 3) = floor((20,000 + 3) / 6) = 3333; divHalfUp(1000, 3) = floor((2,000 + 3) / 6) = 333;
    // divHalfUp(9000, 3) = 3000; divHalfUp(540, 3) = 180.
    const share = creditShare(b06, 0, 1);
    expect(share).toEqual({ grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180 });
    expect(netOf(share)).toBe(3360);
  });

  it("B-06 step 2 of 3: the cumulative step pays gross 3334, discount 334 — net 3360", () => {
    // cum(2): divHalfUp(20,000, 3) = floor((40,000 + 3) / 6) = 6667, share 6667 - 3333 = 3334;
    // divHalfUp(2,000, 3) = floor((4,000 + 3) / 6) = 667, share 667 - 333 = 334; base 6000 - 3000 = 3000; heads 360 - 180 = 180.
    const share = creditShare(b06, 1, 1);
    expect(share).toEqual({ grossPaise: 3334, discountPaise: 334, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180 });
    expect(netOf(share)).toBe(3360);
  });

  it("B-06 step 3 of 3: the remainder lands on the last step and the line exhausts — 3 x 3360 = 10080", () => {
    // cum(3) = the whole line: gross 10000 - 6667 = 3333, discount 1000 - 667 = 333, base 9000 - 6000 = 3000, heads 540 - 360 = 180.
    const shares = [0, 1, 2].map((prevQty) => creditShare(b06, prevQty, 1));
    expect(shares[2]).toEqual({ grossPaise: 3333, discountPaise: 333, taxableBasePaise: 3000, cgstPaise: 180, sgstPaise: 180 });
    expect(shares.reduce((sum, s) => sum + netOf(s), 0)).toBe(10080);
    expect(shares.reduce((sum, s) => sum + s.grossPaise, 0)).toBe(10000);
    expect(shares.reduce((sum, s) => sum + s.discountPaise, 0)).toBe(1000);
    expect(shares.reduce((sum, s) => sum + s.cgstPaise, 0)).toBe(540);
  });

  it("crediting the whole qty in one step returns the line's own five money fields", () => {
    expect(creditShare(b06, 0, 3)).toEqual({ grossPaise: 10000, discountPaise: 1000, taxableBasePaise: 9000, cgstPaise: 540, sgstPaise: 540 });
  });

  it("a flat_paise discount pro-rates by qty exactly like a percentage one — 333, 334, 333 of 1000", () => {
    // D4: flat_paise is a WHOLE-LINE amount at pricing, so on refund it pro-rates by qty like every other field.
    // Base 29000 over 3: cum(1) = divHalfUp(29,000, 3) = floor((58,000 + 3) / 6) = 9667; cum(2) = divHalfUp(58,000, 3) =
    // floor((116,000 + 3) / 6) = 19333 (share 9666); cum(3) = 29000 (share 9667) — 9667 + 9666 + 9667 = 29000.
    const flat: CreditableLine = { grossPaise: 30000, discountPaise: 1000, taxableBasePaise: 29000, cgstPaise: 0, sgstPaise: 0, qty: 3 };
    const shares = [0, 1, 2].map((prevQty) => creditShare(flat, prevQty, 1));
    expect(shares.map((s) => s.discountPaise)).toEqual([333, 334, 333]);
    expect(shares.map((s) => s.taxableBasePaise)).toEqual([9667, 9666, 9667]);
    expect(shares.reduce((sum, s) => sum + s.taxableBasePaise, 0)).toBe(29000);
  });

  it("refuses a credit past the line's qty with credit_exceeds_line", () => {
    expect.assertions(2);
    try {
      creditShare(b06, 2, 2);
    } catch (e) {
      expect(e).toBeInstanceOf(BillingError);
      expect((e as BillingError).code).toBe("credit_exceeds_line");
    }
  });

  it("asserts integer paise on every money field of the stored line", () => {
    expect(() => creditShare({ ...b06, cgstPaise: 540.5 }, 0, 1)).toThrow(TariffError);
    expect(() => creditShare({ ...b06, grossPaise: -1 }, 0, 1)).toThrow(TariffError);
  });
});
