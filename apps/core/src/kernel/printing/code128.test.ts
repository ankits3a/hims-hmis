import { CODE128_PATTERNS, CODE128_STOP, code128Svg, code128Values, code128Widths } from "./code128";

/**
 * #1029 — THE CODE 128 ENCODER, PINNED BY HAND AND (ONCE, OFFLINE) BY A DECODER.
 *
 * A wrong Code 128 looks exactly like a right one. The durable evidence here is the symbol values
 * of the real payload, worked by hand from the standard's table, plus the table's own invariants.
 * Before commit, every code set B character and every code set C digit pair was rasterised and read
 * back by `@zxing/library@0.21.3` (38/38 payloads returned their exact input); zxing is not a
 * dependency of this repo and must not become one for a test.
 */
describe("code128", () => {
  it("every pattern is six elements over eleven modules, and no two are alike", () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    for (const p of CODE128_PATTERNS) {
      expect(p).toHaveLength(6);
      expect([...p].reduce((a, d) => a + Number(d), 0)).toBe(11);
    }
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
    expect([...CODE128_STOP].reduce((a, d) => a + Number(d), 0)).toBe(13);
  });

  it("encodes the token's visit number as Start B, V, Code C, five digit pairs, check", () => {
    // check = (104 + 1·54 + 2·99 + 3·26 + 4·10 + 5·6 + 6·0 + 7·1) mod 103 = 511 mod 103 = 99
    expect(code128Values("V2610060001")).toEqual([104, 54, 99, 26, 10, 6, 0, 1, 99]);
    // 9 symbols × 11 modules + 13 for stop
    expect(code128Widths("V2610060001").reduce((a, b) => a + b, 0)).toBe(112);
  });

  it("starts in code set C for an even run of digits and drops back to B after a run", () => {
    expect(code128Values("1234")[0]).toBe(105);
    expect(code128Values("12")).toEqual([105, 12, (105 + 12) % 103]);
    // `E` after the 4444 run needs Code B (100); the odd run 333 gives its first digit to B
    const v = code128Values("C333D4444E");
    expect(v.slice(0, 4)).toEqual([104, "C".charCodeAt(0) - 32, "3".charCodeAt(0) - 32, "3".charCodeAt(0) - 32]);
    expect(v).toContain(99);
    expect(v).toContain(100);
  });

  it("refuses rather than prints a code that scans as something else", () => {
    expect(() => code128Values("")).toThrow(/empty/);
    expect(() => code128Values("V26\u0009")).toThrow(/ASCII/);
    expect(() => code128Values("एक")).toThrow(/ASCII/);
  });

  it("draws one rect per bar, sized to whole 203 dpi dots", () => {
    const svg = code128Svg("V2610060001");
    // 112 modules + 10 quiet each side = 132 modules × 0.375 mm (3 dots)
    expect(svg).toContain('width="49.500mm"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    const bars = code128Widths("V2610060001").filter((_, k) => k % 2 === 0).length;
    expect(svg.match(/<rect x=/g)).toHaveLength(bars);
  });
});
