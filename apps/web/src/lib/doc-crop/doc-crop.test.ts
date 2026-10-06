import { describe, expect, it } from "vitest";
import {
  applyHomography, flatSize, frameQuad, homography, isConvex, orderQuad, pageAspect, polygonArea, warpPixels,
  type Pixels, type Point, type Quad,
} from "./geometry";
import { detectDocument } from "./detect";

/** A deterministic pseudo-random stream, so a "noisy counter" is the same counter on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function inside(q: readonly Point[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!; const b = q[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** A page (light, with dark "handwriting" strokes) at `q` on a grained, noisy counter. */
function photo(w: number, h: number, q: Quad | null, opts: { page?: number; counter?: number; seed?: number } = {}): Pixels {
  const r = rng(opts.seed ?? 7);
  const page = opts.page ?? 232;
  const counter = opts.counter ?? 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const grain = 18 * Math.sin(y / 3 + Math.sin(x / 40) * 2);
      let v = counter + grain + (r() - 0.5) * 30;
      if (q !== null && inside(q, x + 0.5, y + 0.5)) {
        v = page + (r() - 0.5) * 10;
        if (y % 23 < 2 && x % 61 > 8) v = 40; // lines of writing
      }
      const o = (y * w + x) * 4;
      data[o] = v + 12; data[o + 1] = v; data[o + 2] = v - 14; data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const near = (a: Point, b: Point, tol: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

describe("geometry", () => {
  it("orders four corners TL, TR, BR, BL whatever order they arrive in", () => {
    const tl = { x: 10, y: 12 }; const tr = { x: 200, y: 20 }; const br = { x: 190, y: 300 }; const bl = { x: 5, y: 280 };
    expect(orderQuad([br, tl, bl, tr])).toEqual([tl, tr, br, bl]);
    expect(orderQuad([bl, br, tr, tl])).toEqual([tl, tr, br, bl]);
  });

  it("names a page turned ~45° by where its corners ARE: the corner nearest the top-left comes first", () => {
    // The left corner sits just BELOW the centre, so a plain angle sort would put it last.
    const left = { x: 0, y: 125 }; const top = { x: 130, y: 0 }; const right = { x: 230, y: 120 }; const bottom = { x: 100, y: 235 };
    expect(orderQuad([top, right, bottom, left])).toEqual([left, top, right, bottom]);
  });

  it("maps every corner of the page onto the corner of the flat sheet", () => {
    const q: Quad = [{ x: 30, y: 40 }, { x: 410, y: 25 }, { x: 440, y: 590 }, { x: 15, y: 560 }];
    const flat = frameQuad(300, 424);
    const h = homography(q, flat);
    expect(h).not.toBeNull();
    q.forEach((p, i) => { expect(near(applyHomography(h!, p), flat[i]!, 1e-6)).toBe(true); });
  });

  it("tells a convex page from a folded (self-crossing) one", () => {
    expect(isConvex(frameQuad(100, 100))).toBe(true);
    const folded: Quad = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
    expect(isConvex(folded)).toBe(false);
  });

  it("snaps a nearly-√2 crop to A-series and caps the long edge", () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1350 }, { x: 0, y: 1350 }];
    const s = flatSize(q, 1600);
    expect(s.width).toBe(1000);
    expect(s.height).toBe(Math.round(1000 * Math.SQRT2));
    const big = flatSize(frameQuad(4000, 2000), 1600);
    expect(Math.max(big.width, big.height)).toBe(1600);
    const strip = flatSize(frameQuad(800, 200), 1600); // a receipt keeps its shape
    expect(strip).toEqual({ width: 800, height: 200 });
  });

  /** A W × H page seen by a pinhole camera (focal f, centre cx, cy), tilted by rx/ry/rz radians at distance d. */
  function seen(W: number, H: number, rx: number, ry: number, rz: number, f: number, d: number, cx: number, cy: number): Quad {
    const corners = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]] as const;
    return corners.map(([x0, y0]) => {
      let x = x0; let y = y0; let z = 0;
      [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
      [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
      [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
      z += d;
      return { x: cx + (f * x) / z, y: cy + (f * y) / z };
    }) as Quad;
  }

  it("recovers a tilted page's TRUE proportions, where its edges alone would make it squat", () => {
    const q = seen(210, 297, 0.45, 0.2, -0.15, 1400, 520, 600, 800); // A4, phone tipped back ~26°
    const edges = (Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y) + Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y))
      / (Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) + Math.hypot(q[3].x - q[2].x, q[3].y - q[2].y));
    expect(Math.abs(edges - Math.SQRT2) / Math.SQRT2).toBeGreaterThan(0.06); // the edges are misleading…
    expect(pageAspect(q, 600, 800)).toBeCloseTo(297 / 210, 2); // …the camera geometry is not
    const letter = seen(216, 279, -0.35, 0.3, 0.4, 1500, 600, 600, 800); // a US-letter report: NOT snapped to A4
    expect(pageAspect(letter, 600, 800)).toBeCloseTo(279 / 216, 2);
    const s = flatSize(letter, 1600, pageAspect(letter, 600, 800));
    expect(s.height / s.width).toBeCloseTo(279 / 216, 1);
  });

  it("falls back to the edges when the photo is taken head-on (no perspective to read)", () => {
    expect(pageAspect([{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 524 }, { x: 100, y: 524 }], 250, 312)).toBeCloseTo(424 / 300, 5);
  });

  it("warps a skewed page flat: what was at a corner of the page is at the corner of the output", () => {
    const q: Quad = [{ x: 40, y: 30 }, { x: 160, y: 50 }, { x: 150, y: 180 }, { x: 30, y: 170 }];
    const src = photo(200, 200, q, { page: 240, counter: 20 });
    const out = warpPixels(src, q, 60, 80);
    const at = (x: number, y: number): number => out.data[(y * out.width + x) * 4 + 1]!;
    expect(at(30, 41)).toBeGreaterThan(180); // page everywhere (off the writing lines)
    expect(at(3, 3)).toBeGreaterThan(150);
    expect(out.width * out.height).toBe(60 * 80);
  });
});

describe("detectDocument", () => {
  it("finds a rotated page on a grained counter within a few pixels", () => {
    const q: Quad = [{ x: 120, y: 70 }, { x: 470, y: 120 }, { x: 420, y: 560 }, { x: 60, y: 500 }];
    const d = detectDocument(photo(560, 640, q));
    expect(d).not.toBeNull();
    d!.quad.forEach((p, i) => { expect(near(p, q[i]!, 8)).toBe(true); });
  });

  it("finds a perspective-skewed page in a large photo (coordinates come back at full size)", () => {
    const q: Quad = [{ x: 300, y: 180 }, { x: 1250, y: 230 }, { x: 1380, y: 1500 }, { x: 160, y: 1440 }];
    const d = detectDocument(photo(1600, 1700, q, { seed: 3 }));
    expect(d).not.toBeNull();
    d!.quad.forEach((p, i) => { expect(near(p, q[i]!, 18)).toBe(true); });
    expect(polygonArea(d!.quad) / polygonArea(q)).toBeGreaterThan(0.95);
  });

  it("finds a dark page on a light counter too", () => {
    const q: Quad = [{ x: 90, y: 80 }, { x: 380, y: 60 }, { x: 400, y: 420 }, { x: 70, y: 440 }];
    const d = detectDocument(photo(480, 500, q, { page: 60, counter: 215 }));
    expect(d).not.toBeNull();
    d!.quad.forEach((p, i) => { expect(near(p, q[i]!, 10)).toBe(true); });
  });

  it("keeps the corner of a page shaded at one end — the light/dark split alone would bite it off", () => {
    const q: Quad = [{ x: 90, y: 60 }, { x: 400, y: 100 }, { x: 370, y: 540 }, { x: 60, y: 500 }];
    const w = 480; const h = 600;
    const r = rng(11);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 112 + (r() - 0.5) * 16;
        if (inside(q, x + 0.5, y + 0.5)) {
          const t = Math.min(1, Math.max(0, ((x - 90) / 310 + (y - 60) / 480) / 2)); // 0 at top-left, 1 at bottom-right
          v = 236 - 96 * t * t + (r() - 0.5) * 6; // a lamp at the top-left: the far corner is barely lighter than the counter
        }
        const o = (y * w + x) * 4;
        data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
      }
    }
    const d = detectDocument({ data, width: w, height: h });
    expect(d).not.toBeNull();
    d!.quad.forEach((p, i) => { expect(near(p, q[i]!, 8)).toBe(true); });
  });

  it("says NOT FOUND for a photo with no page in it", () => {
    expect(detectDocument(photo(400, 500, null))).toBeNull();
    const flat: Pixels = { data: new Uint8ClampedArray(300 * 300 * 4).fill(200), width: 300, height: 300 };
    expect(detectDocument(flat)).toBeNull();
  });

  it("is not fooled by lamp light on a bare counter — a bright patch with soft edges is not a page", () => {
    const w = 480; const h = 640; const r = rng(5);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // a pool of lamp light with a soft rim (≈ 40 px wide at this size), bottom-right of the counter
        const rim = (Math.hypot((x - 400) / 1.1, y - 560) - 300) / 14;
        const v = 70 + 90 / (1 + Math.exp(rim)) + 12 * Math.sin(y / 3 + Math.sin(x / 40) * 2) + (r() - 0.5) * 20;
        const o = (y * w + x) * 4;
        data[o] = v + 12; data[o + 1] = v; data[o + 2] = v - 14; data[o + 3] = 255;
      }
    }
    expect(detectDocument({ data, width: w, height: h })).toBeNull();
  });
});
