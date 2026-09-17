import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SLIP DESK — SCAN, SEE WHO IT IS, PHOTOGRAPH, FILE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: the staff member outside the consultation room takes the paper prescription
 * from the patient as they leave, scans the QR in its footer, and photographs it — so the doctor
 * can see that photograph in the patient's history.
 *
 * ═══ THE READ-BACK IS THE CONTROL, AND IT IS NOT OPTIONAL ═══
 *
 * *"the staff only ever press capture or retake"* describes the work but leaves out the step that
 * makes it safe. A slip filed against the wrong visit is a clinical-record error, and the operator
 * is the only one who can catch it — they are holding the paper and looking at the person. So the
 * scan RESOLVES first and the camera does not open until the screen has said, in words, whose visit
 * it matched. Nothing is guessed and nothing is filed on a scan alone.
 *
 * ═══ ONE BOX FOR THE SCANNER AND THE KEYBOARD ═══
 *
 * A wedge scanner IS a keyboard: it types the visit number and presses Enter. `vitals-bay.tsx`
 * states the same rule for the same reason. So there is one input, it takes either, and a desk with
 * a broken scanner keeps working by typing.
 *
 * ═══ THE CLIENT DOWNSCALES, BECAUSE THE SERVER REFUSES ═══
 *
 * `captureDocument` refuses anything over 1.5 MB rather than re-encoding it — a server that
 * silently re-compressed a clinical image would be deciding how legible a prescription is. A raw
 * phone photo is 2-4 MB, so this downscales before it ever asks: longest edge to 1600 px, JPEG,
 * and the quality stepped down until it fits. 1600 px across an A5 slip is about 190 dpi, which
 * reads comfortably and is what makes the owner's ~145 GB/year into ~22.
 */
const MAX_EDGE = 1600;
const TARGET_BYTES = 1_400_000; // just under the server's 1.5 MB refusal
const QUALITIES = [0.82, 0.7, 0.6, 0.5, 0.4];

type Resolved = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  serviceDate: string;
  patient: { uhid: string; name: string | null; alias: string | null } | null;
};

/**
 * Draw the frame to a canvas at a bounded size and encode it, stepping the quality down until it
 * fits. Returns base64 WITHOUT the data-URI prefix, which is what the route takes.
 *
 * Returns null when every quality still overflows — a caller must not send something the server
 * will refuse, and must not silently send a smear either.
 */
/**
 * The bounded size for a source of this shape. Pulled out so the arithmetic is testable without a
 * rasteriser — jsdom has no canvas, so a screen test cannot prove a single pixel of it.
 *
 * NEVER UPSCALES: a 400 px photograph of a slip is a bad photograph, and stretching it to 1600
 * makes a bigger bad photograph and a bigger file. `Math.min(1, …)` is that rule.
 */
export function fitToMaxEdge(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest === 0 ? 1 : Math.min(1, MAX_EDGE / longest);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The byte count of a base64 payload WITHOUT decoding it — 4 characters carry 3 bytes. Decoding a
 * 1.5 MB string on a desk machine to find out whether it is 1.5 MB is work for nothing.
 */
export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

export function fitsBudget(b64: string): boolean {
  return base64Bytes(b64) <= TARGET_BYTES;
}

export async function downscaleToJpeg(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  /*
    A source with no area cannot be a photograph of anything. This matters because a 0x0 canvas
    still ENCODES — to a couple of dozen bytes that sail through the size budget — so without this
    line the desk files a blank page and the screen congratulates it by name. Browser-walked
    2026-09-15 against a camera that had not yet delivered a frame: 0 bytes reached the server.
  */
  if (width <= 0 || height <= 0) return null;
  const fit = fitToMaxEdge(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = fit.width;
  canvas.height = fit.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  for (const q of QUALITIES) {
    const url = canvas.toDataURL("image/jpeg", q);
    const b64 = url.split(",")[1] ?? "";
    if (fitsBudget(b64)) return b64;
  }
  return null;
}

export function SlipCapture(): React.ReactElement {
  const { t } = useTranslation();
  const [visitNo, setVisitNo] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [kind, setKind] = useState("consult_prescription");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef<HTMLInputElement | null>(null);

  /* The camera holds the device. Releasing it on unmount is not tidiness — a desk that leaves the
     lamp on cannot use the camera from any other tab, and the operator has no way to know why. */
  useEffect(() => () => { streamRef.current?.getTracks().forEach((tr) => { tr.stop(); }); }, []);

  const resolve = async (): Promise<void> => {
    const v = visitNo.trim();
    if (v === "") return;
    setError(null); setResolved(null); setShot(null); setFiled(null);
    try {
      const r = await api<Resolved>("GET", `/opd/visits/by-number/${encodeURIComponent(v)}`);
      setResolved(r);
    } catch {
      /* Named for what the operator can DO about it: check the number, or type it. */
      setError(t("slipCapture.notFound", { visitNo: v }));
    }
  };

  const startCamera = async (): Promise<void> => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        /* The REAR camera: this desk is photographing paper on a counter, not a face. */
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
      });
      streamRef.current = stream;
      setCameraOn(true);
    } catch {
      /* No camera, no permission, or no secure context. The file input below still works and on a
         phone it opens the camera anyway — so this is a fallback, not a dead end. */
      setError(t("slipCapture.noCamera"));
    }
  };

  const stopCamera = (): void => {
    streamRef.current?.getTracks().forEach((tr) => { tr.stop(); });
    streamRef.current = null;
    setCameraOn(false);
  };

  /*
    ═══ THE STREAM IS ATTACHED ONCE THE ELEMENT EXISTS, NEVER BEFORE ═══

    `<video>` renders only under `cameraOn`, so attaching inside `startCamera` read
    `videoRef.current` in the very tick that set the flag — the element had not mounted and the ref
    was still null. Not a race: it failed on every run, the preview stayed empty, and `takeShot`
    then photographed a 0x0 frame. Found by driving real Chromium on 2026-09-15; S7 is the row that
    goes red if this ever moves back into `startCamera`.
  */
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraOn || video === null || stream === null) return;
    video.srcObject = stream;
    void video.play().catch(() => { setError(t("slipCapture.noCamera")); });
  }, [cameraOn, t]);

  const takeShot = async (): Promise<void> => {
    const video = videoRef.current;
    if (video === null) return;
    /* A camera reports 0x0 until its first frame lands — a real one has that window after play()
       too, so this outlives the attach bug it was found with. Say what the operator can DO. */
    if (video.videoWidth === 0 || video.videoHeight === 0) { setError(t("slipCapture.notReady")); return; }
    const b64 = await downscaleToJpeg(video, video.videoWidth, video.videoHeight);
    if (b64 === null) { setError(t("slipCapture.tooLarge")); return; }
    setShot(b64);
    stopCamera();
  };

  const fromFile = async (file: File): Promise<void> => {
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((done, fail) => {
        img.onload = () => { done(); };
        img.onerror = () => { fail(new Error("decode")); };
        img.src = url;
      });
      const b64 = await downscaleToJpeg(img, img.naturalWidth, img.naturalHeight);
      if (b64 === null) { setError(t("slipCapture.tooLarge")); return; }
      setShot(b64);
    } catch {
      setError(t("slipCapture.badImage"));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const file = async (): Promise<void> => {
    if (resolved === null || shot === null) return;
    setError(null);
    try {
      await api("POST", `/patients/${resolved.patientId}/documents`, {
        imageBase64: shot,
        mimeType: "image/jpeg",
        kind,
        encounterId: resolved.encounterId,
        note: note.trim() === "" ? null : note.trim(),
      });
      /* The confirmation NAMES the patient. A desk that photographs forty slips an hour needs to see
         which one just landed, not a green tick that could belong to any of them. */
      setFiled(t("slipCapture.filed", { name: resolved.patient?.name ?? resolved.patient?.alias ?? resolved.visitNo }));
      setVisitNo(""); setResolved(null); setShot(null); setNote("");
      scanRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("slipCapture.failed"));
    }
  };

  return (
    <PaperScreen testId="slip-capture">
      <ScreenTitle title={t("slipCapture.title")} />
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("slipCapture.intro")}</p>

      {/* ── 1. the scan ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
        <input
          id="slip-visit" ref={scanRef} aria-label={t("slipCapture.visitNo")}
          value={visitNo} autoComplete="off" autoFocus
          onChange={(e) => { setVisitNo(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void resolve(); } }}
          className="in mo" style={{ width: 260, height: 34, fontSize: 13.5 }}
          placeholder={t("slipCapture.visitNoHint")}
        />
        <button type="button" className="pri" data-testid="slip-find" style={{ height: 34 }} onClick={() => void resolve()}>
          {t("slipCapture.find")}
        </button>
      </div>

      {error !== null && (
        <p role="alert" data-testid="slip-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>
      )}
      {filed !== null && (
        <p data-testid="slip-filed" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--green)" }}>{filed}</p>
      )}

      {/* ── 2. the read-back: who it matched, before anything is photographed ── */}
      {resolved !== null && (
        <div
          data-testid="slip-readback"
          style={{ border: "1px solid var(--green)", borderRadius: 6, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 4 }}
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
            {resolved.patient?.name ?? resolved.patient?.alias ?? t("slipCapture.unnamed")}
          </p>
          <p className="mo" style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>
            {resolved.patient?.uhid ?? "—"} · {resolved.visitNo} · {resolved.serviceDate}
          </p>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>{t("slipCapture.checkPerson")}</p>
        </div>
      )}

      {/* ── 3. the camera ── */}
      {resolved !== null && shot === null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {!cameraOn && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
              <button type="button" className="pri" data-testid="slip-camera" style={{ height: 34 }} onClick={() => void startCamera()}>
                {t("slipCapture.openCamera")}
              </button>
              {/*
                THE FALLBACK IS A REAL PATH, NOT AN APOLOGY. `capture="environment"` opens the rear
                camera directly on a phone, and on a desktop with no webcam it is a file picker —
                which is how a desk with a scanner-and-no-camera still gets the slip in.
              */}
              <label style={{ fontSize: 12, color: "var(--dim)" }}>
                {t("slipCapture.orChooseFile")}
                <input
                  type="file" accept="image/*" capture="environment" data-testid="slip-file"
                  aria-label={t("slipCapture.orChooseFile")}
                  style={{ display: "block", marginTop: 3, fontSize: 12 }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void fromFile(f); }}
                />
              </label>
            </div>
          )}
          {cameraOn && (
            <>
              <video ref={videoRef} data-testid="slip-video" playsInline muted style={{ width: "100%", maxWidth: 520, borderRadius: 6, border: "1px solid var(--line)" }} />
              <div style={{ display: "flex", gap: 7 }}>
                <button type="button" className="pri" data-testid="slip-shoot" style={{ height: 34 }} onClick={() => void takeShot()}>
                  {t("slipCapture.capture")}
                </button>
                <button type="button" className="sec" style={{ height: 34 }} onClick={() => { stopCamera(); }}>
                  {t("slipCapture.cancel")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 4. review, then file ── */}
      {resolved !== null && shot !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <img
            data-testid="slip-preview" src={`data:image/jpeg;base64,${shot}`} alt={t("slipCapture.previewAlt")}
            style={{ width: "100%", maxWidth: 520, borderRadius: 6, border: "1px solid var(--line)" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
            <select
              aria-label={t("slipCapture.kind")} value={kind} onChange={(e) => { setKind(e.target.value); }}
              className="in" style={{ width: 230, height: 32, fontSize: 12.5 }}
            >
              <option value="consult_prescription">{t("slipCapture.kinds.consult_prescription")}</option>
              <option value="outside_prescription">{t("slipCapture.kinds.outside_prescription")}</option>
              <option value="outside_report">{t("slipCapture.kinds.outside_report")}</option>
            </select>
            <input
              aria-label={t("slipCapture.note")} value={note} onChange={(e) => { setNote(e.target.value); }}
              className="in" style={{ width: 240, height: 32, fontSize: 12.5 }}
              placeholder={t("slipCapture.noteHint")}
            />
            <button type="button" className="pri" data-testid="slip-file-it" style={{ height: 32 }} onClick={() => void file()}>
              {t("slipCapture.fileIt")}
            </button>
            {/* RETAKE, in the owner's own words — and it discards rather than stacking a second shot. */}
            <button type="button" className="sec" data-testid="slip-retake" style={{ height: 32 }} onClick={() => { setShot(null); }}>
              {t("slipCapture.retake")}
            </button>
          </div>
        </div>
      )}
    </PaperScreen>
  );
}
