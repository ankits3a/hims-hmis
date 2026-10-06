import { isConvex, orderQuad, polygonArea, type Pixels, type Point, type Quad } from "./geometry";

/**
 * FIND THE PAGE IN A PHOTO — self-contained, no OpenCV (≈8 MB) and no network.
 *
 * A slip photographed at the desk is a light page on a darker counter (or, less often, the
 * reverse). So: shrink to ≤ 480 px, grey, blur away the wood grain and the handwriting, split
 * light from dark at Otsu's threshold, open the mask so a bridge to a bright cup or sleeve is cut,
 * take the largest light region and the largest dark region, and for each: its convex hull, then
 * the biggest four-cornered shape inside that hull. A candidate is believed only if it LOOKS like a
 * page — it fills most of its hull, the hull is nearly that quad, it is neither a sliver nor the
 * whole frame, and it is clearly lighter or darker than what surrounds it. Otherwise: not found,
 * and the desk drags the corners itself (the owner's "if any changes are required").
 */

export const DETECT_EDGE = 480;
/** The smallest light-to-dark step (grey levels, across 6 px) a page's side may show. */
const MIN_STEP = 14;

export type Detection = { quad: Quad; score: number } | null;

/** Box-average shrink so the longest edge is at most `maxEdge`. Returns grey levels 0–255. */
export function shrinkToGrey(src: Pixels, maxEdge = DETECT_EDGE): { g: Float32Array; width: number; height: number; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const g = new Float32Array(width * height);
  const cnt = new Float32Array(width * height);
  const d = src.data;
  for (let y = 0; y < src.height; y++) {
    const ty = Math.min(height - 1, Math.floor(y * scale));
    for (let x = 0; x < src.width; x++) {
      const tx = Math.min(width - 1, Math.floor(x * scale));
      const i = (y * src.width + x) * 4;
      const t = ty * width + tx;
      g[t]! += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      cnt[t]! += 1;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] = cnt[i]! > 0 ? g[i]! / cnt[i]! : 0;
  return { g, width, height, scale };
}

function boxBlur(g: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(g.length);
  const out = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0; let n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += g[y * w + xx]!; n++; } }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0; let n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]!; n++; } }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function otsu(g: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, Math.round(g[i]!)))]! += 1;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0; let wB = 0; let best = 0; let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** 3×3 erode (min) or dilate (max) on a 0/1 mask. */
function morph(m: Uint8Array, w: number, h: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; const yy = y + dy;
          const p = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : m[yy * w + xx]!;
          if (dilate ? p === 1 : p === 0) v = dilate ? 1 : 0;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** The largest 4-connected region of 1s, as a 0/1 mask and its pixel count. */
function largestRegion(m: Uint8Array, w: number, h: number): { mask: Uint8Array; count: number } {
  const label = new Int32Array(m.length);
  const stack = new Int32Array(m.length);
  let bestLabel = 0; let bestCount = 0; let next = 0;
  for (let s = 0; s < m.length; s++) {
    if (m[s] !== 1 || label[s] !== 0) continue;
    next++;
    let top = 0; let count = 0;
    stack[top++] = s; label[s] = next;
    while (top > 0) {
      const p = stack[--top]!;
      count++;
      const x = p % w; const y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && m[q] === 1 && label[q] === 0) { label[q] = next; stack[top++] = q; }
    }
    if (count > bestCount) { bestCount = count; bestLabel = next; }
  }
  const mask = new Uint8Array(m.length);
  if (bestLabel !== 0) for (let i = 0; i < m.length; i++) if (label[i] === bestLabel) mask[i] = 1;
  return { mask, count: bestCount };
}

/** Andrew's monotone chain over the region's edge pixels (pixel corners, so a full row is not a line). */
function hullOf(mask: Uint8Array, w: number, h: number): Point[] {
  const pts: Point[] = [];
  for (let y = 0; y < h; y++) {
    let first = -1; let last = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x] === 1) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    pts.push({ x: first, y }, { x: first, y: y + 1 }, { x: last + 1, y }, { x: last + 1, y: y + 1 });
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drop the hull vertex that adds least area until at most `max` remain — corners survive, staircase steps go. */
function simplify(hull: Point[], max: number): Point[] {
  const p = [...hull];
  const tri = (a: Point, b: Point, c: Point): number => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  while (p.length > max) {
    let k = 0; let least = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i - 1 + p.length) % p.length]!, p[i]!, p[(i + 1) % p.length]!);
      if (a < least) { least = a; k = i; }
    }
    p.splice(k, 1);
  }
  return p;
}

/** The largest-area quadrilateral whose corners are hull vertices (hull order kept, so it is convex). */
function biggestQuad(hull: Point[]): Point[] | null {
  const n = hull.length;
  if (n < 4) return null;
  const tri = (a: Point, b: Point, c: Point): number => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  let best = -1; let pick: Point[] | null = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      let bj = -1; let aj = -1;
      for (let j = i + 1; j < k; j++) { const a = tri(hull[i]!, hull[j]!, hull[k]!); if (a > aj) { aj = a; bj = j; } }
      let bl = -1; let al = -1;
      for (let l = k + 1; l < n + i; l++) { const a = tri(hull[i]!, hull[k]!, hull[l % n]!); if (a > al) { al = a; bl = l % n; } }
      if (bj < 0 || bl < 0 || bl === i) continue;
      if (aj + al > best) { best = aj + al; pick = [hull[i]!, hull[bj]!, hull[k]!, hull[bl]!]; }
    }
  }
  return pick;
}

function meanInOut(g: Float32Array, mask: Uint8Array): { inside: number; outside: number } {
  let si = 0; let ni = 0; let so = 0; let no = 0;
  for (let i = 0; i < g.length; i++) { if (mask[i] === 1) { si += g[i]!; ni++; } else { so += g[i]!; no++; } }
  return { inside: ni === 0 ? 0 : si / ni, outside: no === 0 ? 0 : so / no };
}

/** Bilinear sample of a grey image, clamped at its borders. */
function sample(g: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x));
  const fy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(fx); const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1);
  const ax = fx - x0; const ay = fy - y0;
  const top = g[y0 * w + x0]! * (1 - ax) + g[y0 * w + x1]! * ax;
  const bot = g[y1 * w + x0]! * (1 - ax) + g[y1 * w + x1]! * ax;
  return top * (1 - ay) + bot * ay;
}

/**
 * THE SIDES, SNAPPED TO THE PAPER'S REAL EDGE. The light/dark split can bite a corner off a page
 * that is shaded at one end (a lamp on one side of the desk), and the four-cornered shape then
 * cuts across the page. So each side is searched for afresh near where the split put it: both of
 * its ends slide along the side's normal, and the line kept is the one with the strongest STEP
 * along its length — page on one side, counter on the other, measured a few pixels either side.
 * A step, not a gradient: a ruled line or a row of handwriting near the edge is dark on BOTH
 * sides of itself and scores nothing.
 */
function refineSides(g: Float32Array, w: number, h: number, q: Quad, light: boolean): { quad: Quad; steps: number[] } {
  const reach = Math.round(0.1 * Math.max(w, h));
  const off = 3;
  const sign = light ? 1 : -1;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const lines: { p: Point; d: Point }[] = [];
  const strength: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i]!; const b = q[(i + 1) % 4]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = -(b.y - a.y) / len; let ny = (b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; } // outward
    const steps = Math.max(8, Math.floor(len / 3));
    const score = (sa: number, sb: number): number => {
      const ax = a.x + nx * sa; const ay = a.y + ny * sa;
      const bx = b.x + nx * sb; const by = b.y + ny * sb;
      let s = 0;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const x = ax + (bx - ax) * t; const y = ay + (by - ay) * t;
        s += Math.max(0, sign * (sample(g, w, h, x - nx * off, y - ny * off) - sample(g, w, h, x + nx * off, y + ny * off)));
      }
      return s / (steps - 1);
    };
    let best = score(0, 0); let ba = 0; let bb = 0;
    for (let sa = -reach; sa <= reach; sa += 4) for (let sb = -reach; sb <= reach; sb += 4) {
      const v = score(sa, sb); if (v > best) { best = v; ba = sa; bb = sb; }
    }
    const ca = ba; const cb = bb;
    for (let sa = ca - 3; sa <= ca + 3; sa++) for (let sb = cb - 3; sb <= cb + 3; sb++) {
      const v = score(sa, sb); if (v > best) { best = v; ba = sa; bb = sb; }
    }
    strength.push(best);
    const p = { x: a.x + nx * ba, y: a.y + ny * ba };
    lines.push({ p, d: { x: b.x + nx * bb - p.x, y: b.y + ny * bb - p.y } });
  }
  const meet = (l1: { p: Point; d: Point }, l2: { p: Point; d: Point }): Point | null => {
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
    return { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
  };
  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const c = meet(lines[(i + 3) % 4]!, lines[i]!); // corner i is where side i-1 meets side i
    if (c === null || c.x < -0.05 * w || c.y < -0.05 * h || c.x > 1.05 * w || c.y > 1.05 * h) return { quad: q, steps: strength };
    out.push({ x: Math.min(w, Math.max(0, c.x)), y: Math.min(h, Math.max(0, c.y)) });
  }
  const r = out as Quad;
  return { quad: isConvex(r) ? r : q, steps: strength };
}

/** The page's corners in the SOURCE image's pixel coordinates, with a 0–1 score; null when not believable. */
export function detectDocument(src: Pixels): Detection {
  const { g: raw, width: w, height: h, scale } = shrinkToGrey(src);
  if (w < 16 || h < 16) return null;
  const g = boxBlur(boxBlur(raw, w, h, 2), w, h, 2);
  const thr = otsu(g);
  const frameArea = w * h;
  let best: Detection = null;
  for (const light of [true, false]) {
    let m: Uint8Array = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = (light ? g[i]! > thr : g[i]! <= thr) ? 1 : 0;
    m = morph(morph(m, w, h, false), w, h, false);
    m = morph(morph(m, w, h, true), w, h, true);
    const { mask, count } = largestRegion(m, w, h);
    if (count < frameArea * 0.08) continue;
    const hull = hullOf(mask, w, h);
    if (hull.length < 4) continue;
    const hullArea = polygonArea(hull);
    const corners = biggestQuad(simplify(hull, 48));
    if (corners === null) continue;
    const rough = orderQuad(corners);
    if (!isConvex(rough)) continue;
    const { quad, steps } = refineSides(g, w, h, rough, light);
    /*
      A PAPER EDGE IS A STEP. Lamp light falling off across a bare counter makes a light region with
      four "sides" too, but its edge is a slow ramp: a few levels across six pixels, where paper on
      wood is tens. Every side the photo actually shows must be a step; a side lying ALONG the
      frame's edge (the page runs out of the photo) shows nothing to measure and is not counted,
      but at least two must be seen.
    */
    const onBorder = (i: number): boolean => {
      const a = quad[i]!; const b = quad[(i + 1) % 4]!;
      const m = 3;
      return (a.x <= m && b.x <= m) || (a.y <= m && b.y <= m) || (a.x >= w - m && b.x >= w - m) || (a.y >= h - m && b.y >= h - m);
    };
    const seenSides = [0, 1, 2, 3].filter((i) => !onBorder(i));
    if (seenSides.length < 2 || seenSides.some((i) => steps[i]! < MIN_STEP)) continue;
    const quadArea = polygonArea(quad);
    const ofFrame = quadArea / frameArea;
    if (ofFrame < 0.12 || ofFrame > 0.97) continue; // a sliver, or the threshold took the whole frame
    if (polygonArea(rough) / hullArea < 0.9) continue; // the region is not four-sided
    if (count / hullArea < 0.6) continue; // it does not fill its own outline — clutter, not a page
    const { inside, outside } = meanInOut(g, mask);
    const contrast = Math.abs(inside - outside);
    if (contrast < 25) continue; // the page does not stand out from the counter
    const score = Math.min(1, (quadArea / hullArea) * Math.min(1, contrast / 60));
    if (best === null || score > best.score) {
      best = { quad: quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad, score };
    }
  }
  return best;
}
