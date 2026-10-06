import { QUALITIES, detectDocument, fitToMaxEdge, fitsBudget, flatSize, frameQuad, pageAspect, warpPixels } from "./rules";
import type { Detection, Pixels, Quad } from "./rules";

/**
 * PIXELS, FOR THE WEB EXPORT (the browser preview used to look at screens). Metro picks
 * `imaging.native.ts` on a phone — that file does the same three jobs with Skia. This one uses a
 * DOM canvas and the shared `warpPixels`, exactly as the web slip desk does.
 *
 * The three jobs, on every platform:
 *   normalize  the camera's file, upright, long edge ≤ WORK_EDGE — what the crop step shows
 *   findPage   the page's four corners in that photo, or null
 *   flatten    the quad warped to a flat upright page (or the whole photo), JPEG, inside the
 *              server's size budget; null when no quality fits
 */
export type Photo = { uri: string; width: number; height: number };
export type Flat = { base64: string; width: number; height: number; straightened: boolean };
/** The photo kept for cropping: sharper than the 1600 px page that is filed, small enough to handle. */
export const WORK_EDGE = 2560;

function load(uri: string): Promise<HTMLImageElement> {
  return new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => { done(img); };
    img.onerror = () => { fail(new Error("decode")); };
    img.src = uri;
  });
}
function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("no canvas");
  return { canvas, ctx };
}
function encode(canvas: HTMLCanvasElement): string | null {
  for (const q of QUALITIES) {
    const b64 = canvas.toDataURL("image/jpeg", q).split(",")[1] ?? "";
    if (fitsBudget(b64)) return b64;
  }
  return null;
}

export async function normalize(shot: Photo): Promise<Photo> {
  const img = await load(shot.uri);
  return { uri: shot.uri, width: img.naturalWidth, height: img.naturalHeight };
}

export async function findPage(photo: Photo): Promise<Detection> {
  try {
    const img = await load(photo.uri);
    const scale = Math.min(1, 480 / Math.max(photo.width, photo.height));
    const w = Math.max(1, Math.round(photo.width * scale));
    const h = Math.max(1, Math.round(photo.height * scale));
    const { ctx } = canvasOf(w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const found = detectDocument(ctx.getImageData(0, 0, w, h) as unknown as Pixels);
    return found === null ? null : { score: found.score, quad: found.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad };
  } catch {
    return null;
  }
}

export async function flatten(photo: Photo, quad: Quad | null, maxEdge: number): Promise<Flat | null> {
  const img = await load(photo.uri);
  if (quad === null) {
    const fit = fitToMaxEdge(photo.width, photo.height);
    const { canvas, ctx } = canvasOf(fit.width, fit.height);
    ctx.drawImage(img, 0, 0, fit.width, fit.height);
    const b64 = encode(canvas);
    return b64 === null ? null : { base64: b64, ...fit, straightened: false };
  }
  const src = canvasOf(photo.width, photo.height);
  src.ctx.drawImage(img, 0, 0, photo.width, photo.height);
  const size = flatSize(quad, maxEdge, pageAspect(quad, photo.width / 2, photo.height / 2));
  const flat = warpPixels(src.ctx.getImageData(0, 0, photo.width, photo.height) as unknown as Pixels, quad, size.width, size.height);
  const out = canvasOf(size.width, size.height);
  out.ctx.putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
  const b64 = encode(out.canvas);
  return b64 === null ? null : { base64: b64, ...size, straightened: true };
}

/** For a caller that wants the plain rectangle the quad sits in (the native fallback uses it). */
export function boundsOf(quad: Quad, width: number, height: number): { originX: number; originY: number; width: number; height: number } {
  const xs = quad.map((p) => p.x); const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))); const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs))); const y1 = Math.min(height, Math.ceil(Math.max(...ys)));
  return { originX: x0, originY: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}
export { frameQuad };
