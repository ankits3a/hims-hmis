import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import {
  QUALITIES, detectDocument, fitToMaxEdge, fitsBudget, flatSize, frameQuad, homography, pageAspect,
} from "./rules";
import type { Detection, Pixels, Quad } from "./rules";

/**
 * PIXELS ON THE PHONE — DECIDED 2026-10-06 (plan §3b).
 *
 * React Native has no canvas: JavaScript cannot read a photo's pixels or draw a warped one. The
 * routes considered:
 *   · a pure-JS JPEG decoder/encoder (jpeg-js): works anywhere, but a 2560 px photo is ~6 M pixels —
 *     decode + warp + encode in Hermes is several seconds a page, at a desk filing forty an hour;
 *   · a cloud service: no (owner: nothing leaves the hospital's own servers);
 *   · **Skia** (`@shopify/react-native-skia`), the 2D engine Android itself draws with, compiled
 *     into the app by `expo prebuild`: decode, read pixels, draw through a 3×3 perspective matrix,
 *     encode JPEG — all native, synchronous, no network. CHOSEN.
 *
 * So Skia does the three heavy things, and the DECISIONS stay in the shared pure code the web desk
 * uses: `detectDocument` finds the page (on a ≤480 px copy Skia hands over), `homography` /
 * `pageAspect` / `flatSize` decide where each pixel goes; Skia only executes that matrix.
 *
 * EVERY SKIA CALL IS GUARDED. If the engine is missing or refuses on some phone, finding the page
 * answers "not found" (the desk drags the corners) and flattening falls back to a plain cut to the
 * corners' rectangle with `expo-image-manipulator`, marked `straightened: false` so the screen says
 * so. The desk is never left unable to file a slip.
 *
 * `require` and not `import`: the engine is loaded when the slip desk first needs it, so a phone on
 * which it fails to load still opens every other screen.
 */
export type Photo = { uri: string; width: number; height: number };
export type Flat = { base64: string; width: number; height: number; straightened: boolean };
export const WORK_EDGE = 2560;
/**
 * THE PAGE IS LOOKED FOR ON A 320 px COPY, not the web's 480 — MEASURED 2026-10-06 (plan §3b).
 * A phone runs JavaScript in Hermes, which has no JIT. With the JIT off, the detector costs about
 * 2.0 s at 480 px, 0.85 s at 320 px and 0.55 s at 256 px on the build server; with it on (a
 * browser), 90 / 40 / 22 ms. At 320 px all four test photographs are still found and the corners
 * land within 0.4% of the long edge of the 480 px answer; at 256 px the lamp-lit one is lost. So
 * 320: the smallest size that loses nothing. The desk sees "Finding the page's edges…" meanwhile.
 */
export const PHONE_DETECT_EDGE = 320;

type SkiaModule = typeof import("@shopify/react-native-skia");
function skia(): SkiaModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@shopify/react-native-skia") as SkiaModule;
}

/** Upright, long edge ≤ WORK_EDGE. The manipulator bakes the camera's rotation into the pixels. */
export async function normalize(shot: Photo): Promise<Photo> {
  const longest = Math.max(shot.width, shot.height);
  const actions = longest > WORK_EDGE
    ? [{ resize: shot.width >= shot.height ? { width: WORK_EDGE } : { height: WORK_EDGE } }]
    : [];
  const out = await manipulateAsync(shot.uri, actions, { compress: 0.92, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height };
}

async function decode(uri: string): Promise<import("@shopify/react-native-skia").SkImage> {
  const { Skia } = skia();
  const data = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (image === null) throw new Error("decode");
  return image;
}

export async function findPage(photo: Photo): Promise<Detection> {
  try {
    const { Skia, FilterMode, MipmapMode, ColorType, AlphaType } = skia();
    const image = await decode(photo.uri);
    const iw = image.width(); const ih = image.height();
    const scale = Math.min(1, PHONE_DETECT_EDGE / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const surface = Skia.Surface.Make(w, h);
    if (surface === null) return null;
    const canvas = surface.getCanvas();
    canvas.scale(w / iw, h / ih);
    canvas.drawImageOptions(image, 0, 0, FilterMode.Linear, MipmapMode.None);
    surface.flush();
    const raw = surface.makeImageSnapshot().readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
    if (raw === null || raw.length < w * h * 4) return null;
    const pixels: Pixels = { data: new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset, raw.byteOffset + w * h * 4) as ArrayBuffer), width: w, height: h };
    // Let the "Finding the page's edges…" line paint before the JS thread is held (see plan §3b for timings).
    await new Promise<void>((r) => { setTimeout(r, 0); });
    const found = detectDocument(pixels);
    if (found === null) return null;
    // Corners come back in the photo's own pixels, whatever size Skia decoded it at.
    const k = (photo.width / iw) / scale;
    return { score: found.score, quad: found.quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad };
  } catch {
    return null;
  }
}

function encodeWithin(image: import("@shopify/react-native-skia").SkImage): string | null {
  const { ImageFormat } = skia();
  for (const q of QUALITIES) {
    const b64 = image.encodeToBase64(ImageFormat.JPEG, Math.round(q * 100));
    if (b64 !== "" && fitsBudget(b64)) return b64;
  }
  return null;
}

async function flattenWithSkia(photo: Photo, quad: Quad | null, maxEdge: number): Promise<Flat | null> {
  const { Skia, FilterMode, MipmapMode } = skia();
  const image = await decode(photo.uri);
  const iw = image.width(); const ih = image.height();
  // The quad is in the photo's pixels; Skia may have decoded at another size.
  const kx = iw / photo.width; const ky = ih / photo.height;
  const q = quad === null ? null : quad.map((p) => ({ x: p.x * kx, y: p.y * ky })) as Quad;
  const size = q === null ? fitToMaxEdge(iw, ih) : flatSize(q, maxEdge, pageAspect(q, iw / 2, ih / 2));
  const surface = Skia.Surface.Make(size.width, size.height);
  if (surface === null) throw new Error("no surface");
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color("#ffffff"));
  if (q === null) {
    canvas.scale(size.width / iw, size.height / ih);
  } else {
    // photo → page: the matrix that carries the four corners onto the flat page's corners.
    const h = homography(q, frameQuad(size.width, size.height));
    if (h === null) throw new Error("the corners do not make a page");
    canvas.concat(Skia.Matrix(h));
  }
  canvas.drawImageOptions(image, 0, 0, FilterMode.Linear, MipmapMode.None);
  surface.flush();
  const b64 = encodeWithin(surface.makeImageSnapshot());
  return b64 === null ? null : { base64: b64, width: size.width, height: size.height, straightened: q !== null };
}

/** The fallback: cut to the rectangle the corners sit in, downscale, encode. No perspective. */
async function flattenPlain(photo: Photo, quad: Quad | null): Promise<Flat | null> {
  const actions: Parameters<typeof manipulateAsync>[1] = [];
  let w = photo.width; let h = photo.height;
  if (quad !== null) {
    const crop = boundsOf(quad, photo.width, photo.height);
    actions.push({ crop });
    w = crop.width; h = crop.height;
  }
  const fit = fitToMaxEdge(w, h);
  if (fit.width !== w) actions.push({ resize: { width: fit.width } });
  for (const q of QUALITIES) {
    const out = await manipulateAsync(photo.uri, actions, { compress: q, format: SaveFormat.JPEG, base64: true });
    if (out.base64 !== undefined && out.base64 !== "" && fitsBudget(out.base64)) {
      return { base64: out.base64, width: out.width, height: out.height, straightened: false };
    }
  }
  return null;
}

export async function flatten(photo: Photo, quad: Quad | null, maxEdge: number): Promise<Flat | null> {
  try {
    return await flattenWithSkia(photo, quad, maxEdge);
  } catch {
    return flattenPlain(photo, quad);
  }
}

export function boundsOf(quad: Quad, width: number, height: number): { originX: number; originY: number; width: number; height: number } {
  const xs = quad.map((p) => p.x); const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))); const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs))); const y1 = Math.min(height, Math.ceil(Math.max(...ys)));
  return { originX: x0, originY: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}
export { frameQuad };
