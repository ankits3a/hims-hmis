/**
 * The phone's pixel engine (src/slips/imaging.native.ts) cannot run here — Skia is native code.
 * What CAN be pinned is everything this file decides around it: which matrix it hands the engine,
 * that corners come back in the photo's own pixels, that the page is kept inside the server's size
 * budget, and that a phone on which the engine fails still files a slip (the plain cut).
 */
import { applyHomography, frameQuad } from "../src/slips/rules";
import type { Quad } from "../src/slips/rules";

type Draw = { matrix: number[] | null; scale: [number, number] | null; size: [number, number]; encoded: number[] };
const mockSkia = { fail: false, image: { w: 1920, h: 2560 }, draws: [] as Draw[], bytesAt: (_q: number) => 1000, pixels: null as Uint8Array | null };

jest.mock("@shopify/react-native-skia", () => {
  const image = (w: number, h: number, d?: Draw) => ({
    width: () => w, height: () => h,
    readPixels: () => mockSkia.pixels,
    encodeToBase64: (_f: number, q: number) => { d?.encoded.push(q); return "A".repeat(Math.ceil((mockSkia.bytesAt(q) * 4) / 3)); },
  });
  return {
    FilterMode: { Linear: 1 }, MipmapMode: { None: 0 }, ColorType: { RGBA_8888: 4 }, AlphaType: { Unpremul: 3 }, ImageFormat: { JPEG: 3 },
    Skia: {
      Data: { fromURI: async () => { if (mockSkia.fail) throw new Error("no engine"); return {}; } },
      Image: { MakeImageFromEncoded: () => image(mockSkia.image.w, mockSkia.image.h) },
      Color: (c: string) => c,
      Matrix: (m: number[]) => ({ __m: m }),
      Surface: {
        Make: (w: number, h: number) => {
          const d: Draw = { matrix: null, scale: null, size: [w, h], encoded: [] };
          mockSkia.draws.push(d);
          return {
            getCanvas: () => ({
              clear: () => undefined, drawImageOptions: () => undefined,
              scale: (x: number, y: number) => { d.scale = [x, y]; },
              concat: (m: { __m: number[] }) => { d.matrix = m.__m; },
            }),
            flush: () => undefined,
            makeImageSnapshot: () => image(w, h, d),
          };
        },
      },
    },
  };
});
const mockManip = { calls: [] as { actions: unknown[]; opts: { compress: number; base64?: boolean } }[] };
jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  manipulateAsync: jest.fn(async (uri: string, actions: unknown[], opts: { compress: number; base64?: boolean }) => {
    mockManip.calls.push({ actions, opts });
    return { uri: `${uri}#out`, width: 1200, height: 1600, base64: opts.base64 === true ? "QUJD" : undefined };
  }),
}));

// jest-expo resolves `./imaging` to imaging.native.ts — the phone's file.
import { findPage, flatten, normalize } from "../src/slips/imaging";

const PHOTO = { uri: "file:///work.jpg", width: 1920, height: 2560 };
const QUAD: Quad = [{ x: 300, y: 380 }, { x: 1650, y: 420 }, { x: 1700, y: 2300 }, { x: 240, y: 2250 }];

beforeEach(() => { mockSkia.fail = false; mockSkia.image = { w: 1920, h: 2560 }; mockSkia.draws = []; mockSkia.bytesAt = () => 1000; mockSkia.pixels = null; mockManip.calls = []; });

describe("the phone's pixel engine, around Skia", () => {
  it("keeps a camera photo at up to 2560 px for cropping, upright", async () => {
    const out = await normalize({ uri: "file:///shot.jpg", width: 3000, height: 4000 });
    expect(mockManip.calls[0]!.actions).toEqual([{ resize: { height: 2560 } }]);
    expect(out.uri).toBe("file:///shot.jpg#out");
    await normalize({ uri: "file:///small.jpg", width: 1200, height: 1600 });
    expect(mockManip.calls[1]!.actions).toEqual([]); // never upscaled
  });

  it("hands the engine the matrix that carries the four corners onto the flat page's corners", async () => {
    const flat = await flatten(PHOTO, QUAD, 1600);
    expect(flat).not.toBeNull();
    expect(flat!.straightened).toBe(true);
    const d = mockSkia.draws[0]!;
    expect(Math.max(...d.size)).toBeLessThanOrEqual(1600);
    const page = frameQuad(d.size[0], d.size[1]);
    QUAD.forEach((corner, i) => {
      const to = applyHomography(d.matrix!, corner);
      expect(Math.hypot(to.x - page[i]!.x, to.y - page[i]!.y)).toBeLessThan(0.01);
    });
  });

  it("uses the whole photo, downscaled, when no crop is asked", async () => {
    const flat = await flatten(PHOTO, null, 1600);
    expect(flat).toMatchObject({ width: 1200, height: 1600, straightened: false });
    expect(mockSkia.draws[0]!.matrix).toBeNull();
    expect(mockSkia.draws[0]!.scale![0]).toBeCloseTo(1200 / 1920);
  });

  it("steps the JPEG quality down until the page fits the server's budget, and gives up rather than send a refusal", async () => {
    mockSkia.bytesAt = (q) => (q >= 70 ? 1_600_000 : 900_000);
    const flat = await flatten(PHOTO, QUAD, 1600);
    expect(mockSkia.draws[0]!.encoded).toEqual([82, 70, 60]);
    expect(flat).not.toBeNull();
    mockSkia.draws = []; mockSkia.bytesAt = () => 1_600_000;
    expect(await flatten(PHOTO, QUAD, 1600)).toBeNull();
    expect(mockSkia.draws[0]!.encoded).toEqual([82, 70, 60, 50, 40]);
  });

  it("a phone on which the engine fails still files a slip: cut to the corners' rectangle, marked not straightened", async () => {
    mockSkia.fail = true;
    const flat = await flatten(PHOTO, QUAD, 1600);
    expect(flat).toMatchObject({ base64: "QUJD", straightened: false });
    expect(mockManip.calls[0]!.actions[0]).toEqual({ crop: { originX: 240, originY: 380, width: 1460, height: 1920 } });
    expect(mockManip.calls[0]!.opts.base64).toBe(true);
    expect(await findPage(PHOTO)).toBeNull(); // and the desk drags the corners itself
  });

  it("returns the page's corners in the photo's own pixels", async () => {
    // The 240×320 grey copy the phone looks at (320 px long edge): a light page on a dark counter.
    const w = 240, h = 320;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const on = x > 40 && x < 200 && y > 46 && y < 274;
      const i = (y * w + x) * 4; const v = on ? 235 : 60 + ((x * 7 + y * 13) % 20);
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
    mockSkia.pixels = px;
    const found = await findPage(PHOTO);
    expect(found).not.toBeNull();
    expect(mockSkia.draws[0]!.size).toEqual([240, 320]);
    const k = 1920 / w;
    const want: Quad = [{ x: 40 * k, y: 46 * k }, { x: 200 * k, y: 46 * k }, { x: 200 * k, y: 274 * k }, { x: 40 * k, y: 274 * k }];
    found!.quad.forEach((c, i) => { expect(Math.hypot(c.x - want[i]!.x, c.y - want[i]!.y)).toBeLessThan(40); });
  });
});
