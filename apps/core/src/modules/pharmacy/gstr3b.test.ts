import { setOff } from "./gstr3b";

/**
 * GAP CLOSURE A4 — rule 88A's order, pinned without a database. IGST credit goes first, and with no IGST
 * liability it pays the head its own credit cannot cover; CGST and SGST credit never cross; what is left
 * over is carried forward, per head.
 */
describe("GSTR-3B set-off (rule 88A)", () => {
  it("own credit pays its own head; the surplus is carried forward and never crosses to the other head", () => {
    const p = setOff({ igst: 0, cgst: 1000, sgst: 1000 }, { igst: 0, cgst: 1500, sgst: 400 });
    expect(p.cgst).toEqual({ liabilityPaise: 1000, byIgstPaise: 0, byOwnPaise: 1000, cashPaise: 0, carryForwardPaise: 500 });
    expect(p.sgst).toEqual({ liabilityPaise: 1000, byIgstPaise: 0, byOwnPaise: 400, cashPaise: 600, carryForwardPaise: 0 });
    expect(p.cashPaise).toBe(600);
  });

  it("IGST credit is spent first, on the head its own credit cannot cover, so the cash is least", () => {
    const p = setOff({ igst: 0, cgst: 1000, sgst: 1000 }, { igst: 700, cgst: 1000, sgst: 200 });
    expect(p.sgst).toMatchObject({ byIgstPaise: 700, byOwnPaise: 200, cashPaise: 100 });
    expect(p.cgst).toMatchObject({ byIgstPaise: 0, byOwnPaise: 1000, cashPaise: 0, carryForwardPaise: 0 });
    expect(p.igst.carryForwardPaise).toBe(0);
    expect(p.cashPaise).toBe(100);
  });

  it("IGST credit beyond both shortfalls is still used before own credit, which is then carried forward", () => {
    const p = setOff({ igst: 0, cgst: 500, sgst: 500 }, { igst: 800, cgst: 500, sgst: 500 });
    expect(p.cgst.byIgstPaise + p.sgst.byIgstPaise).toBe(800);
    expect(p.cgst.carryForwardPaise + p.sgst.carryForwardPaise).toBe(800);
    expect(p.cashPaise).toBe(0);
    expect(p.igst.carryForwardPaise).toBe(0);
  });

  it("more IGST credit than all liability is carried forward as IGST", () => {
    const p = setOff({ igst: 0, cgst: 100, sgst: 100 }, { igst: 500, cgst: 0, sgst: 0 });
    expect(p.igst.carryForwardPaise).toBe(300);
    expect(p.cashPaise).toBe(0);
  });
});
