/**
 * DOCUMENT CROP — the pure half: corner order, the perspective map, the flat output size and the
 * pixel warp. No DOM and no canvas, so every line here runs under jsdom and node (the canvas-bound
 * half is `browser.ts`). Owner, 2026-10-05: the slip desk crops the photographed page — found
 * automatically, adjusted by hand.
 */

export type Point = { x: number; y: number };
/** Four corners, ALWAYS in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];
/** An RGBA pixel buffer — `ImageData` satisfies it, and so does a test's hand-made one. */
export type Pixels = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Put four points in the order TL, TR, BR, BL whatever order they came in. Sorted by angle round
 * their centroid (clockwise in screen coordinates), then rotated so the corner nearest the image's
 * top-left — the smallest x + y — comes first. A page turned past 45° is then named by where its
 * corners ARE, which is what a person dragging them expects.
 */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error("a quadrilateral has four corners");
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const byAngle = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) if (byAngle[i]!.x + byAngle[i]!.y < byAngle[first]!.x + byAngle[first]!.y) first = i;
  return [0, 1, 2, 3].map((k) => byAngle[(first + k) % 4]!) as Quad;
}

/** The whole frame, or the frame pulled in by `inset` (a fraction of each side). */
export function frameQuad(width: number, height: number, inset = 0): Quad {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy }, { x: width - dx, y: dy },
    { x: width - dx, y: height - dy }, { x: dx, y: height - dy },
  ];
}

/** Twice the signed area (shoelace). Positive for TL→TR→BR→BL in screen coordinates. */
export function polygonArea(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** A quad a person could have meant: convex, and not folded over itself. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Solve A·x = b by Gaussian elimination with partial pivoting. Null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** The 3×3 homography (row-major, h33 = 1) that maps each `from[i]` onto `to[i]`. */
export function homography(from: Quad, to: Quad): number[] | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(a, b);
  return h === null ? null : [...h, 1];
}

export function applyHomography(h: readonly number[], p: Point): Point {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  return { x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w, y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w };
}

const ROOT2 = Math.SQRT2;

type V3 = [number, number, number];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The page's TRUE height ÷ width, recovered from how the camera saw it (Zhang & He, "Whiteboard
 * scanning and image enhancement", 2007): the four corners of a rectangle fix the camera's focal
 * length, and with it the rectangle's real proportions. A phone held at an angle shortens the far
 * edge; measuring edges alone would print a squat page. When the view is near head-on the focal
 * length is undetermined, and the edges ARE the proportions, so those are used. `cx, cy` is the
 * photo's centre (the principal point).
 */
export function pageAspect(q: Quad, cx: number, cy: number): number {
  const edges = (dist(q[0], q[3]) + dist(q[1], q[2])) / (dist(q[0], q[1]) + dist(q[3], q[2]));
  const m1: V3 = [q[0].x, q[0].y, 1]; // top-left
  const m2: V3 = [q[1].x, q[1].y, 1]; // top-right
  const m3: V3 = [q[3].x, q[3].y, 1]; // bottom-left
  const m4: V3 = [q[2].x, q[2].y, 1]; // bottom-right
  const k2 = dot3(cross3(m1, m4), m3) / dot3(cross3(m2, m4), m3);
  const k3 = dot3(cross3(m1, m4), m2) / dot3(cross3(m3, m4), m2);
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const denom = n2[2] * n3[2];
  if (!Number.isFinite(k2) || !Number.isFinite(k3) || Math.abs(denom) < 1e-9) return edges;
  const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * cx + n2[2] * n3[2] * cx * cx)
    + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * cy + n2[2] * n3[2] * cy * cy)) / denom;
  if (!(f2 > 0)) return edges;
  /* nᵀ·A⁻ᵀA⁻¹·n with A the camera matrix (focal f, centre cx, cy). */
  const norm = (n: V3): number => {
    const x = (n[0] - cx * n[2]); const y = (n[1] - cy * n[2]);
    return (x * x + y * y) / f2 + n[2] * n[2];
  };
  const ratio = Math.sqrt(norm(n3) / norm(n2));
  return Number.isFinite(ratio) && ratio > 0.1 && ratio < 10 ? ratio : edges;
}

/**
 * The flat page's size. Width is the longer of the top and bottom edges; height is that width ×
 * the page's true proportion (`aspect`, height ÷ width; the measured edges when not given). Indian
 * prescription sheets are A4 or A5, both √2, so a proportion within 6% of √2 is snapped to it. The
 * long edge is capped at `maxEdge`.
 */
export function flatSize(q: Quad, maxEdge: number, aspect?: number): { width: number; height: number } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let a = aspect ?? Math.max(dist(q[0], q[3]), dist(q[1], q[2])) / w;
  if (Math.abs(a - ROOT2) / ROOT2 <= 0.06) a = ROOT2;
  else if (Math.abs(1 / a - ROOT2) / ROOT2 <= 0.06) a = 1 / ROOT2;
  let h = w * a;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  w *= scale; h *= scale;
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/**
 * Warp the quad of `src` onto a flat `width × height` page, sampling bilinearly. Each output pixel
 * is mapped BACK into the photo (the inverse direction), so the page has no holes.
 */
export function warpPixels(src: Pixels, q: Quad, width: number, height: number): Pixels {
  const h = homography(frameQuad(width, height), q);
  if (h === null) throw new Error("the corners do not make a page");
  const out = new Uint8ClampedArray(width * height * 4);
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyHomography(h, { x: x + 0.5, y: y + 0.5 });
      const fx = Math.min(sw - 1, Math.max(0, p.x - 0.5));
      const fy = Math.min(sh - 1, Math.max(0, p.y - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = s[(y0 * sw + x0) * 4 + c]! * (1 - ax) + s[(y0 * sw + x1) * 4 + c]! * ax;
        const bot = s[(y1 * sw + x0) * 4 + c]! * (1 - ax) + s[(y1 * sw + x1) * 4 + c]! * ax;
        out[o + c] = top * (1 - ay) + bot * ay;
      }
    }
  }
  return { data: out, width, height };
}
