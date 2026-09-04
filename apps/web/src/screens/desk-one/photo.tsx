import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PHOTO_MAX_BYTES } from "../../lib/patients-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-14 — THE PATIENT'S PHOTO, TAKEN AT THE COUNTER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"We can add Camera/upload photo while registering new user in the left
 * sidebar."* The artboard says the same thing in the registration column — "Take a photo", under the
 * card the patient is about to be given.
 *
 * ═══ WHY IT EARNS THE SPACE, beyond being asked for ═══
 *
 * It is the counter's only defence against the wrong-patient error that the rest of this system
 * cannot see. Search shows two Asha Devis with the same village and a shared family mobile; the
 * duplicate warning says they look alike; nothing on the screen can say which one is standing there.
 * A face can. That is also why it belongs in the LEFT COLUMN and not on the form: the left column is
 * the patient session, present at every stage, so the face is beside the clerk when they take money
 * and when they seat a token — not only in the ninety seconds the enrolment form is open.
 *
 * ═══ THE DOWNSCALE IS NOT AN OPTIMISATION, IT IS THE CONTRACT ═══
 *
 * `photos.ts` caps the column at 512,000 bytes and refuses anything larger with a message that says
 * in as many words: *"the photo exceeds N bytes — the client must downscale"*. A modern phone photo
 * is several megabytes, so an un-downscaled client is one that fails on every real photograph and
 * works only in tests. `downscaleToDataUrl` is that contract being kept.
 */

/** The long edge, in pixels. A counter needs a recognisable face, not a portrait. */
const MAX_EDGE = 480;
const JPEG_QUALITY = 0.82;

/**
 * Downscale to a JPEG data URL small enough for the server to accept.
 *
 * The quality ladder is deliberate rather than a single guess: a 480px JPEG at 0.82 is
 * comfortably inside the cap for a face, but a noisy or highly detailed frame can still exceed it,
 * and the honest response to that is to try harder rather than to post something that will be
 * refused. Each step is measured against the ACTUAL encoded length, never an estimate.
 */
export async function downscaleToDataUrl(file: Blob): Promise<string> {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("this browser cannot render a canvas");
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);

  for (const quality of [JPEG_QUALITY, 0.6, 0.45, 0.3]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    // base64 carries 3 bytes per 4 chars; compare against the encoded payload the server will store
    if (base64Of(url).length * 0.75 <= PHOTO_MAX_BYTES) return url;
  }
  throw new Error("that image is too large even downscaled — try a plainer background");
}

export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  // Safari and jsdom fall back to an <img>, which needs an object URL and a load event.
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("that file is not an image")); };
    img.src = url;
  });
}

/** getUserMedia is absent on a desktop with no webcam, and on any page not served over HTTPS. */
export function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
}

export function PhotoPanel(
  { dataUrl, onCapture, onClear, caption }: {
    dataUrl: string | null;
    onCapture: (dataUrl: string) => void;
    onClear: () => void;
    caption: string;
  },
): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const stop = (): void => {
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = null;
    setLive(false);
  };

  const start = async (): Promise<void> => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      streamRef.current = stream;
      setLive(true);
      // the element only exists once `live` is true, so the assignment waits for the paint
      queueMicrotask(() => {
        if (videoRef.current !== null) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => { /* autoplay refusal is not fatal */ });
        }
      });
    } catch {
      setError(t("registrationCounter.photo.noCamera"));
    }
  };

  const snap = (): void => {
    const video = videoRef.current;
    if (video === null) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((video.videoWidth || MAX_EDGE) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || MAX_EDGE) * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    stop();
  };

  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(null);
    try {
      onCapture(await downscaleToDataUrl(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("registrationCounter.photo.failed"));
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="tag">{caption}</div>

      {/*
        FD-19 — NO FULL-SIZE PREVIEW. The picture is shown in the 44px square beside the name (see
        `dossier.tsx`); repeating it here at 250px was the same information twice and cost the rail
        the space the history and the account now use. `photo-preview` is kept as a ZERO-SIZE marker
        so a test can still ask "is a photo held" without the layout paying for the answer — the
        square is where a human looks.
      */}
      {dataUrl !== null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <img data-testid="photo-preview" src={dataUrl} alt="" style={{ width: 0, height: 0 }} />
          <span style={{ fontSize: 11.5, color: "var(--green)" }}>{t("registrationCounter.photo.onFile")}</span>
          <button className="sec" data-testid="photo-clear" onClick={onClear}>
            {t("registrationCounter.photo.retake")}
          </button>
        </div>
      ) : live ? (
        <div style={{ marginTop: 8 }}>
          {/* A live camera preview carries no audio track, so there is nothing to caption. */}
          <video
            ref={videoRef}
            data-testid="photo-video"
            muted
            playsInline
            style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)", display: "block", background: "#000" }}
          />
          <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
            <button className="sec grn" data-testid="photo-snap" onClick={snap}>
              {t("registrationCounter.photo.snap")}
            </button>
            <button className="sec" data-testid="photo-cancel" onClick={stop}>
              {t("registrationCounter.photo.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
          {cameraAvailable() ? (
            <button className="sec" data-testid="photo-camera" onClick={() => void start()}>
              {t("registrationCounter.photo.camera")}
            </button>
          ) : null}
          <button className="sec" data-testid="photo-upload" onClick={() => fileRef.current?.click()}>
            {t("registrationCounter.photo.upload")}
          </button>
          <input
            ref={fileRef}
            data-testid="photo-file"
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => { void pick(e.target.files?.[0]); }}
          />
        </div>
      )}

      {error === null ? null : (
        <div data-testid="photo-error" style={{ fontSize: 11, color: "var(--red)", marginTop: 6, lineHeight: "15px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
