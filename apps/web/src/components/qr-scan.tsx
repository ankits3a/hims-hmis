import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * STORES S2b UX pass (#1112) — A LIVE QR SCAN from the phone's back camera. The readers are the ones the slip
 * desk already trusts (`lib/slip-read.ts`): the browser's own `BarcodeDetector` where it has one (Android,
 * ChromeOS, macOS), else jsQR on the video frame (iPhone Safari), loaded on demand. The first read wins and the
 * camera stops. No camera, or permission refused, calls `onClose("unavailable")` — the screen keeps its typed
 * fallback, so the scan is never a dead end. `photo-capture.tsx` takes a still for filing; this one only reads.
 */
type Detector = { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const FRAME_MS = 200;

/** A camera this browser can open (the readers are always there: BarcodeDetector or jsQR). */
export function cameraScanPossible(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function QrScan({ onRead, onClose }: { onRead: (text: string) => void; onClose: (why: "unavailable" | "cancel") => void }): React.ReactElement {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const read = useRef(onRead);
  const close = useRef(onClose);
  read.current = onRead;
  close.current = onClose;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = (): void => {
      done.current = true;
      if (timer !== null) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    let detector: Detector | null = null;
    try { detector = Ctor === undefined ? null : new Ctor({ formats: ["qr_code"] }); } catch { detector = null; }

    const frame = async (): Promise<string | null> => {
      const v = videoRef.current;
      if (v === null) return null;
      if (detector !== null) {
        try {
          const found = await detector.detect(v);
          const hit = found.map((f) => f.rawValue.trim()).find((x) => x !== "");
          if (hit !== undefined) return hit;
        } catch { /* a frame not ready yet; try the next */ }
        return null;
      }
      if (v.videoWidth === 0 || v.videoHeight === 0) return null;
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      if (ctx === null) return null;
      ctx.drawImage(v, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height);
      const { default: jsQR } = await import("jsqr");
      const text = jsQR(px.data, px.width, px.height, { inversionAttempts: "dontInvert" })?.data.trim() ?? "";
      return text === "" ? null : text;
    };
    const loop = async (): Promise<void> => {
      if (done.current) return;
      const hit = await frame();
      if (done.current) return;
      if (hit !== null) { stop(); read.current(hit); return; }
      timer = setTimeout(() => { void loop(); }, FRAME_MS);
    };

    done.current = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (s) => {
        stream = s;
        if (done.current) { stop(); return; }
        const v = videoRef.current;
        if (v !== null) {
          v.srcObject = s;
          try { await v.play(); } catch { /* autoplay refused: frames still arrive on a muted inline video */ }
        }
        void loop();
      })
      .catch(() => { stop(); close.current("unavailable"); });
    return stop;
  }, []);

  return (
    <div data-testid="qr-scan" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <video ref={videoRef} muted playsInline aria-label={t("stores.ticket.scan")}
        style={{ width: "100%", maxHeight: "45vh", objectFit: "cover", background: "var(--ink, #222)", borderRadius: 6 }} />
      <button type="button" onClick={() => { done.current = true; close.current("cancel"); }}
        style={{ minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent" }}>
        {t("stores.ticket.cancel")}
      </button>
    </div>
  );
}
