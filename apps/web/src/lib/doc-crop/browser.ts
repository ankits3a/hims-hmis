import { detectDocument, DETECT_EDGE, type Detection } from "./detect";
import { flatSize, pageAspect, warpPixels, type Quad } from "./geometry";

/**
 * DOCUMENT CROP — the canvas-bound half. jsdom has no canvas, so these are the seams a screen test
 * replaces; every decision they make is in `geometry.ts` / `detect.ts`, which are tested directly.
 */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => { done(img); };
    img.onerror = () => { fail(new Error("decode")); };
    img.src = src;
  });
}

function runDetect(pixels: ImageData): Promise<Detection> {
  if (typeof Worker === "undefined") return Promise.resolve(detectDocument(pixels));
  return new Promise((done) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./detect.worker.ts", import.meta.url), { type: "module" });
    } catch {
      done(detectDocument(pixels));
      return;
    }
    const finish = (d: Detection): void => { worker.terminate(); done(d); };
    worker.onmessage = (e: MessageEvent<Detection>) => { finish(e.data); };
    worker.onerror = () => { finish(detectDocument(pixels)); };
    worker.postMessage(pixels);
  });
}

/** The page's corners in the image's own pixel coordinates, or null — never throws. */
export async function detectInImage(img: HTMLImageElement): Promise<Detection> {
  try {
    const scale = Math.min(1, DETECT_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const found = await runDetect(ctx.getImageData(0, 0, w, h));
    if (found === null) return null;
    return { score: found.score, quad: found.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad };
  } catch {
    return null;
  }
}

/** The quad of `img` warped flat onto a new canvas (long edge ≤ `maxEdge`). */
export function warpToCanvas(img: HTMLImageElement, quad: Quad, maxEdge: number): HTMLCanvasElement {
  const src = document.createElement("canvas");
  src.width = img.naturalWidth; src.height = img.naturalHeight;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (sctx === null) throw new Error("no canvas");
  sctx.drawImage(img, 0, 0);
  const size = flatSize(quad, maxEdge, pageAspect(quad, img.naturalWidth / 2, img.naturalHeight / 2));
  const flat = warpPixels(sctx.getImageData(0, 0, src.width, src.height), quad, size.width, size.height);
  const out = document.createElement("canvas");
  out.width = size.width; out.height = size.height;
  const octx = out.getContext("2d");
  if (octx === null) throw new Error("no canvas");
  octx.putImageData(new ImageData(flat.data, flat.width, flat.height), 0, 0);
  return out;
}
