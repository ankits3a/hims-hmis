/**
 * ═══ #659 — THE VISIT NUMBER, READ FROM THE PHOTOGRAPH ITSELF ═══
 *
 * The prescription sheet prints ONE QR, and it encodes exactly the visit number (kernel/printing
 * render.ts, `qrSvg(s.visitNo)`). Reading that QR from the photo the desk just took tells the desk
 * whether the PAPER in the photo is the visit it scanned — the one mistake the read-back cannot see:
 * the right patient scanned, a different sheet photographed.
 *
 * QR FIRST, TEXT SECOND (memory opd-slip-capture-gap): a QR read is exact where text recognition is
 * probabilistic. The readers below are asked in order and the first that reads wins.
 *
 * SUGGEST-ONLY, NEVER A FILER (brainstorms: "OCR suggestion never auto-commits"; OCR text is untrusted
 * content). A read that disagrees with the scanned visit STOPS the filing; a read that agrees, or no
 * read at all, files nothing by itself — the operator's own look at the paper stays the control.
 *
 * ═══ TEXT READING (OCR) IS OWED ═══
 * No OCR engine is on this build (no model, no service, nothing in the bundle). `ocrReader` is the
 * seam: it reads nothing today, and `OCR_OWED` says so, so a screen can say "not read" honestly. When
 * an engine arrives it plugs in here; nothing else changes. Owed: GitHub #659.
 */
export type PhotoReader = { name: "qr" | "ocr"; read: (jpegBase64: string) => Promise<string | null> };
export type PhotoRead = { visitNo: string | null; via: "qr" | "ocr" | null };

/** A visit number and nothing else (`V` + date-coded digits, the shape `lab/desk.ts` VISIT_RE accepts). */
export function visitNumberIn(text: string): string | null {
  const t = text.trim().toUpperCase();
  return /^V\d{6,}$/.test(t) ? t : null;
}

/** Ask each reader in turn; the first visit number wins. A reader that throws is a reader that did not read. */
export async function readVisitNumber(jpegBase64: string, readers: readonly PhotoReader[]): Promise<PhotoRead> {
  for (const r of readers) {
    let raw: string | null = null;
    try { raw = await r.read(jpegBase64); } catch { raw = null; }
    const visitNo = raw === null ? null : visitNumberIn(raw);
    if (visitNo !== null) return { visitNo, via: r.name };
  }
  return { visitNo: null, via: null };
}

type Detector = { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

async function pixelsOf(jpegBase64: string): Promise<{ img: HTMLImageElement; data: ImageData } | null> {
  const img = new Image();
  await new Promise<void>((done, fail) => { img.onload = () => { done(); }; img.onerror = () => { fail(new Error("decode")); }; img.src = `data:image/jpeg;base64,${jpegBase64}`; });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (ctx === null || typeof ctx.getImageData !== "function") return null;
  ctx.drawImage(img, 0, 0);
  return { img, data: ctx.getImageData(0, 0, w, h) };
}

/** The sheet's QR: the browser's own detector where it has one (Android, ChromeOS, macOS), else jsQR. */
export const qrReader: PhotoReader = {
  name: "qr",
  read: async (jpegBase64) => {
    const px = await pixelsOf(jpegBase64);
    if (px === null) return null;
    const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (Ctor !== undefined) {
      try {
        const found = await new Ctor({ formats: ["qr_code"] }).detect(px.img);
        const hit = found.map((f) => f.rawValue).find((v) => visitNumberIn(v) !== null);
        if (hit !== undefined) return hit;
      } catch { /* fall through to jsQR */ }
    }
    // Loaded on demand: the app ships as one chunk, and only this desk ever needs jsQR.
    const { default: jsQR } = await import("jsqr");
    return jsQR(px.data.data, px.data.width, px.data.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  },
};

/** OWED (#659): no text-recognition engine on this build. Reads nothing; see the header. */
export const OCR_OWED = true;
export const ocrReader: PhotoReader = { name: "ocr", read: () => Promise.resolve(null) };

/** What the slip desk calls: QR first, text (owed) second. */
export function readPhotoVisitNumber(jpegBase64: string): Promise<PhotoRead> {
  return readVisitNumber(jpegBase64, [qrReader, ocrReader]);
}
