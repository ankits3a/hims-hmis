/**
 * HK-1 (#973) — reading the door QR on the attendant's phone. The QR holds the door page's address
 * (`<origin>/door#<token>`); the scan proof is the token after `#`. A camera photo is decoded by the browser's own
 * detector where it has one, else by jsQR (loaded on demand, the slip desk's rule). A typed or scanner-wedge code works
 * the same way.
 */
export function tokenFromScan(raw: string): string {
  const v = raw.trim();
  const i = v.indexOf("#");
  return i >= 0 ? decodeURIComponent(v.slice(i + 1)) : v;
}

type Detector = { detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o: { formats: string[] }) => Detector;

/** The QR text in a photo, or null. */
export async function readQrFromFile(file: Blob): Promise<string | null> {
  if (typeof createImageBitmap !== "function") return null;
  const img = await createImageBitmap(file);
  const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (Ctor !== undefined) {
    try {
      const found = await new Ctor({ formats: ["qr_code"] }).detect(img);
      if (found[0] !== undefined) return found[0].rawValue;
    } catch { /* fall through to jsQR */ }
  }
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const { default: jsQR } = await import("jsqr");
  return jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/** A photo as base64 (no data: prefix), downscaled to at most `max` px on its long side as JPEG. */
export async function photoBase64(file: Blob, max = 1280): Promise<{ mimeType: string; base64: string }> {
  if (typeof createImageBitmap !== "function") {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return { mimeType: file.type || "image/jpeg", base64: btoa(bin) };
  }
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.8);
  return { mimeType: "image/jpeg", base64: url.slice(url.indexOf(",") + 1) };
}
