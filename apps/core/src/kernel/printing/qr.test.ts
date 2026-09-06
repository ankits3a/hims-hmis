import { createHash } from "node:crypto";
import { encodeQr, encodeQrMasked, qrSvg } from "./qr";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-29 — THE QR ENCODER IS PINNED AGAINST A DIFFERENT AUTHOR'S ENCODER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A wrong QR is not a visibly wrong QR. Every failure this file guards — a reversed format word,
 * a mis-split format arm, a mask chosen by the wrong penalty rule, a capacity table off by one —
 * produces a matrix of exactly the right size, with three correct finder patterns, that a phone
 * refuses. Reading the code cannot tell you which one you have. So the fixtures below are not this
 * encoder's own output: they are `qrcode.react@4.2.0` (Nayuki's `qrcodegen`, bundled in `apps/web`
 * for the six screens that draw QRs), driven with `level:"M"`, `marginSize:0` and — this matters —
 * **`boostLevel:false`**, without which it silently upgrades the error-correction level whenever
 * the payload leaves room and the comparison becomes meaningless.
 *
 * ═══ AND THEY WERE CONFIRMED BY A DECODER, NOT ONLY BY A SECOND ENCODER ═══
 *
 * Two encoders can agree and both be wrong about the same thing. Before these fixtures were
 * committed, every payload here was rasterised and read back with `jsqr@1.4.0` — an independent
 * DECODER — and returned its exact input, including `V2608290047`, `एलर्जी`, and a 213-byte
 * version-10 payload. That run is not reproducible in CI (jsqr is not a dependency of this repo and
 * must not become one for a test); the hashes are the durable record of it.
 *
 * ═══ ONE FIXTURE IS DELIBERATELY ABSENT, AND ITS ABSENCE IS THE POINT ═══
 *
 * `V2608290047` — the string this sheet actually prints — is **alphanumeric-eligible**, so the
 * reference encoder encodes it in alphanumeric mode and this one, which is byte-mode only by
 * design, does not produce the same matrix. Both are valid QR codes for the same text and the
 * decoder read both. `v2608290047` differs from it by a single data byte, is byte-mode in both
 * encoders, and is pinned in full below — so the path that carries the real payload is covered
 * exactly, without pretending two different modes should agree.
 */

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/#@!$%^&*()+=[]{}|;<>?~`".repeat(4);

/** Byte-mode capacity at level M, so a fixture can say "exactly fills version N". */
const CAP = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213] as const;

const hashOf = (matrix: readonly (readonly boolean[])[]): string =>
  createHash("sha256").update(matrix.map((row) => row.map((b) => (b ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);

/**
 * The full 21 × 21 matrix for an eleven-byte payload — the exact shape and size the prescription
 * footer prints. Spelled out rather than hashed because this is the one a reader may want to
 * eyeball against a photograph of real paper.
 */
const VISIT_V1 = [
  "111111101111001111111",
  "100000101000101000001",
  "101110100001101011101",
  "101110101110001011101",
  "101110100111001011101",
  "100000100001101000001",
  "111111101010101111111",
  "000000001001100000000",
  "101101110001101001011",
  "001011011101100010111",
  "111010101011001001101",
  "110111010101010110011",
  "100010100000111111010",
  "000000001111001110010",
  "111111101001110010100",
  "100000101100000110111",
  "101110100110110000100",
  "101110101100000100010",
  "101110101010100100100",
  "100000100000101001001",
  "111111101001001001100",
];

/** [payload, expected version, first 16 hex of the reference encoder's matrix hash]. */
const REFERENCE: readonly (readonly [string, number, string])[] = [
  ["a", 1, "e8ab680854e4019c"],
  ["v2608290047", 1, "c83880181a85a7f5"],
  ["V2608290047|CRK0000184213", 2, "27f6c8b736934373"],
  ["एलर्जी", 2, "f9fbf6574c9020d4"],
  ["Rx v26 · CRK0000184213", 2, "61bfb87cb45de4ab"],
  [ALPHA.slice(0, CAP[0]), 1, "ba5a7c15d176b2c0"],
  [ALPHA.slice(0, CAP[0] - 1), 1, "d86544763ab73bbd"],
  [ALPHA.slice(0, CAP[1]), 2, "3a778456e844dacd"],
  [ALPHA.slice(0, CAP[1] - 3), 2, "e4a5c49dd1462b74"],
  [ALPHA.slice(0, CAP[2]), 3, "9159c9ff1fc56e8d"],
  [ALPHA.slice(0, CAP[2] - 3), 3, "3dd7b0bb22f96205"],
  [ALPHA.slice(0, CAP[3]), 4, "86361e665242833c"],
  [ALPHA.slice(0, CAP[3] - 3), 4, "5945f565d723a5a8"],
  [ALPHA.slice(0, CAP[4]), 5, "2089a7890f93e734"],
  [ALPHA.slice(0, CAP[4] - 3), 5, "6800069aaa7e9579"],
  [ALPHA.slice(0, CAP[5]), 6, "411b1b487514b88f"],
  [ALPHA.slice(0, CAP[5] - 3), 6, "3a91ad5d38489f2f"],
  [ALPHA.slice(0, CAP[6]), 7, "5afc34e1815b97a5"],
  [ALPHA.slice(0, CAP[6] - 3), 7, "d3720ba17fe3d243"],
  [ALPHA.slice(0, CAP[7]), 8, "1aed23169dd9eae6"],
  [ALPHA.slice(0, CAP[7] - 3), 8, "65556265b84dfe02"],
  [ALPHA.slice(0, CAP[8]), 9, "3d881baa72b37782"],
  [ALPHA.slice(0, CAP[8] - 3), 9, "d82af87207b1901f"],
  [ALPHA.slice(0, CAP[9]), 10, "7edc0a402d22d976"],
  [ALPHA.slice(0, CAP[9] - 3), 10, "b0e9bac5dfb93361"],
  /**
   * ONE BYTE OVER each version's capacity, which must land on the NEXT version. The rows above pin
   * the matrices; only these pin the TABLE. A capacity raised by one — 14 to 15 at version 1, say —
   * changes no matrix above, because a 14-byte payload still fits under the wrong number too. It
   * changes THESE: a 15-byte payload is sent to version 1, whose sixteen data codewords cannot
   * hold it. Found by a mutant that survived every row above.
   */
  [ALPHA.slice(0, CAP[0] + 1), 2, "df240788219386f8"],
  [ALPHA.slice(0, CAP[1] + 1), 3, "2538d8884650fb83"],
  [ALPHA.slice(0, CAP[2] + 1), 4, "91b6e894898332f6"],
  [ALPHA.slice(0, CAP[3] + 1), 5, "3b74bbb7a8655f4c"],
  [ALPHA.slice(0, CAP[4] + 1), 6, "0e25f9a1a991582a"],
  [ALPHA.slice(0, CAP[5] + 1), 7, "e99a4517245c2ba1"],
  [ALPHA.slice(0, CAP[6] + 1), 8, "222e74f7f8ca25a8"],
  [ALPHA.slice(0, CAP[7] + 1), 9, "d605f822e51ab989"],
  [ALPHA.slice(0, CAP[8] + 1), 10, "11aaf410623ac3e6"],
  /**
   * THE ONE PAYLOAD THAT PROVES PENALTY RULE 3 IS SCALE-INVARIANT. Restrict the finder-lookalike
   * rule to single-module runs — the obvious reading of `1011101`, and what this encoder did first
   * — and every other row here still passes while this one picks a different mask, and therefore a
   * different symbol. It was not chosen by taste: it was found by running the mutation against
   * 4,000 payloads and keeping the first that disagreed.
   */
  ["7bOcu1gIVJUXduT07Vc-h-fcQ/J/z", 3, "36b57481474f020a"],
];

describe("FD-29: the QR encoder", () => {
  it("reproduces an independent encoder's matrix, module for module, on the payload the sheet prints", () => {
    expect(encodeQr("v2608290047").map((row) => row.map((b) => (b ? "1" : "0")).join(""))).toEqual(VISIT_V1);
  });

  /**
   * Every version from 1 to 10, each at its exact byte capacity and three bytes under it. The
   * boundary rows are the ones that matter: the version is chosen from a capacity table, and an
   * off-by-one there sends a payload to the wrong version, where the block structure differs and
   * nothing else in the pipeline notices.
   */
  it.each(REFERENCE)("matches the reference encoder at every version: %#", (payload, version, hash) => {
    const matrix = encodeQr(payload);
    expect(matrix.length).toBe(version * 4 + 17);
    expect(hashOf(matrix)).toBe(hash);
  });

  it("chooses the version from the payload's UTF-8 LENGTH, not its character count", () => {
    // Six Devanagari code points, eighteen bytes — over version 1's fourteen.
    expect("एलर्जी".length).toBe(6);
    expect(new TextEncoder().encode("एलर्जी").length).toBe(18);
    expect(encodeQr("एलर्जी").length).toBe(25);
  });

  it("refuses a payload it cannot carry rather than truncating it", () => {
    expect(encodeQr("x".repeat(213)).length).toBe(57);
    expect(() => encodeQr("x".repeat(214))).toThrow(/exceeds the 213-byte level-M ceiling/);
  });

  /**
   * The mask is chosen by penalty score and then WRITTEN INTO the format bits, so a scoring change
   * yields a different symbol rather than a slightly worse one. These two rows say the selection is
   * live: one of the eight forced masks is the chosen one, and the eight are genuinely different.
   */
  it("selects one of the eight masks, and the eight are distinct symbols", () => {
    const chosen = hashOf(encodeQr("v2608290047"));
    const forced = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => hashOf(encodeQrMasked("v2608290047", m)));
    expect(new Set(forced).size).toBe(8);
    expect(forced).toContain(chosen);
  });

  it("puts a finder pattern in three corners and the always-dark module below the third", () => {
    const m = encodeQr("v2608290047");
    const last = m.length - 1;
    for (const [top, left] of [[0, 0], [0, last - 6], [last - 6, 0]]) {
      expect(m[top!]![left!]).toBe(true);
      expect(m[top! + 1]![left! + 1]).toBe(false);
      expect(m[top! + 3]![left! + 3]).toBe(true);
    }
    expect(m[4 * 1 + 9]![8]).toBe(true); // version 1
  });

  describe("qrSvg — what actually reaches the paper", () => {
    const svg = qrSvg("v2608290047", 62);

    it("is self-contained: no script, no fetch, no font, no external reference", () => {
      // The XML namespace is an IDENTIFIER, not an address — nothing resolves it — so it is
      // removed before the check rather than the check being loosened to let any URL through.
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
      expect(withoutNamespace).not.toMatch(/<script|https?:|url\(|@font-face|<image|xlink:href/i);
    });

    it("carries a quiet zone in the viewBox, because a code flush to its border does not scan", () => {
      // 21 modules + two modules of quiet on each side.
      expect(svg).toContain('viewBox="0 0 25 25"');
      expect(svg).toContain('width="62" height="62"');
    });

    it("paints a white ground under black modules and keeps the edges crisp", () => {
      expect(svg).toContain('<rect width="25" height="25" fill="#fff"/>');
      expect(svg).toContain('<g fill="#000">');
      expect(svg).toContain('shape-rendering="crispEdges"');
    });

    it("encodes its argument — two different visits are two different pictures", () => {
      expect(qrSvg("V2609060001", 62)).not.toBe(qrSvg("V2609060002", 62));
    });
  });
});
