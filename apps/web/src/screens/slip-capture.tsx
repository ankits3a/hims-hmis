import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { fmtIst, useDebounced } from "../lib/format";
import { StationShell } from "../components/station/station-shell";
import { DocCrop, type CropStatus } from "../components/doc-crop";
import { frameQuad, isConvex, type Quad } from "../lib/doc-crop/geometry";
import { detectInImage, loadImage, warpToCanvas } from "../lib/doc-crop/browser";
import type { StationLink } from "../components/station/station-shell";
import "./slip-desk.css";

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
 *
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE SAME FLOW, IN THE HOUSE STATION ═══
 *
 * The owner-approved board (`docs/design/2026-09-28-ux-audit/slip-desk.html`) keeps every control
 * above and moves it into the station shell: the matched person in the LEFT lane (the read-back
 * never scrolls away), one numbered flow — Scan · Check · Photograph · File — in the CENTRE over a
 * pinned dock whose Enter is the one next act, and TODAY'S SLIPS on the right (waiting oldest first,
 * then retakes, then filed; no filter tabs), with "Clocks running" collapsed under it.
 *
 * Owner rulings, 28-Sep-2026, that this screen carries:
 *   · a missing slip SHOWS — in the list and the clocks — and goes to MRD at day end. Nothing here
 *     escalates while the day runs, so the clocks never raise their alert;
 *   · when the QR is torn, the desk may find TODAY's visit by name or UHID and confirm the person —
 *     the same read-back the scan gets, so the check is not skipped by the other door;
 *   · the doctor is named by Doctor ID only.
 */
const MAX_EDGE = 1600;
const TARGET_BYTES = 1_400_000; // just under the server's 1.5 MB refusal
const QUALITIES = [0.82, 0.7, 0.6, 0.5, 0.4];

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

/**
 * Draw the frame to a canvas at a bounded size and encode it, stepping the quality down until it
 * fits. Returns base64 WITHOUT the data-URI prefix, which is what the route takes.
 *
 * Returns null when every quality still overflows — a caller must not send something the server
 * will refuse, and must not silently send a smear either.
 */
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

type Summary = {
  uhid: string; name: string | null; alias: string | null;
  administrativeGender?: string | null; dob?: string | null;
};

/** `GET /opd/visits/by-number/:visitNo` — and each hit of `GET /opd/slips/find`. */
type Readback = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  serviceDate: string;
  patient: Summary | null;
  /* UX-AUDIT 2026-09-28 · BOARD — additive server fields; optional so an older API still reads. */
  doctorCode?: string | null;
  departmentName?: string | null;
  roomName?: string | null;
  filed?: { id: string; kind: string; capturedAt: string; retakeRequestedAt: string | null }[];
};

type SlipRow = {
  encounterId: string; patientId: string; visitNo: string; patient: Summary;
  doctorCode: string | null; roomName: string | null; state: "waiting" | "retake" | "filed";
  consultDoneAt: string | null; filedAt: string | null; pages: number; kinds: string[];
  retakeRequestedAt: string | null; retakeReason: string | null;
};
type SlipDay = { serviceDate: string; items: SlipRow[]; counts: { waiting: number; retake: number; filed: number } };

const KINDS = ["consult_prescription", "outside_prescription", "outside_report"] as const;
type Kind = (typeof KINDS)[number];

/** OPD's screens, for the header's switch — the board's seven, each shown only to a person who may open it. */
const OPD_STATIONS: readonly (Omit<StationLink, "label"> & { labelKey: string })[] = [
  { key: "desk", to: "/opd/desk", labelKey: "slipCapture.stations.desk", permission: "opd.visits.open" },
  { key: "appointments", to: "/opd/appointments", labelKey: "slipCapture.stations.appointments", permission: "opd.appointments.read" },
  { key: "vitals", to: "/opd/vitals", labelKey: "slipCapture.stations.vitals", permission: "opd.vitals.record" },
  { key: "slips", to: "/opd/slips", labelKey: "slipCapture.stations.slips", permission: "patients.update" },
  { key: "scribe", to: "/opd/scribe", labelKey: "slipCapture.stations.scribe", permission: "opd.prescription.draft" },
  { key: "display", to: "/opd/display", labelKey: "slipCapture.stations.display", permission: "opd.display.read" },
  { key: "report", to: "/reports/opd-day", labelKey: "slipCapture.stations.report", permission: "opd.reports.read" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-09-28` → `28-Sep-2026`, the board's date. No timezone: the server already chose the IST day. */
function dmy(serviceDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(serviceDate);
  return m === null ? serviceDate : `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? ""}-${m[1]}`;
}
/** Whole years from an ISO date of birth. */
function ageYears(dob: string | null | undefined, now: number): number | null {
  if (dob === null || dob === undefined) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(now);
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y -= 1;
  return y;
}
const minutesSince = (iso: string | null, now: number): number =>
  iso === null ? 0 : Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/** Keys a desk types into a box must not also fire the dock — except the scan box's own Enter. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}

const ScanIcon = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M1 5V1h4M13 1h4v4M17 13v4h-4M5 17H1v-4M4 9h10" stroke="#0e6b4e" strokeWidth="1.6" fill="none" />
  </svg>
);
const Corners = (): React.ReactElement => (
  <>
    <span className="sd-corner tl" aria-hidden="true" /><span className="sd-corner tr" aria-hidden="true" />
    <span className="sd-corner bl" aria-hidden="true" /><span className="sd-corner br" aria-hidden="true" />
  </>
);

export function SlipCapture(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [visitNo, setVisitNo] = useState("");
  const [resolved, setResolved] = useState<Readback | null>(null);
  /** How the visit in hand was reached — the lane says so, because a name search is the weaker door. */
  const [via, setVia] = useState<"qr" | "search">("qr");
  const [shot, setShot] = useState<string | null>(null);
  const [shotSize, setShotSize] = useState<{ width: number; height: number } | null>(null);
  /*
    THE PHOTO BEFORE IT IS CROPPED (owner, 2026-10-05). The camera's frame lands here first, the page
    is found in it, and the desk confirms or drags the corners; "Use this" flattens it into `shot`.
    It is KEPT after that, so "Adjust the crop" goes back to the same photo instead of a retake.
  */
  const [raw, setRaw] = useState<{ b64: string; width: number; height: number; quad: Quad; status: CropStatus } | null>(null);
  const [cropping, setCropping] = useState(false);
  const [kind, setKind] = useState<Kind>("consult_prescription");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The number the server did not know — state B's red box and its alert. */
  const [refused, setRefused] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ back: Readback; kind: Kind; at: string } | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  /* The camera holds the device. Releasing it on unmount is not tidiness — a desk that leaves the
     lamp on cannot use the camera from any other tab, and the operator has no way to know why. */
  useEffect(() => () => { streamRef.current?.getTracks().forEach((tr) => { tr.stop(); }); }, []);

  /* UX-AUDIT 2026-09-28 · BOARD — today's slips. A desk on an older API gets a 404 here and keeps
     working: the list is where the day shows, never a step in the flow. */
  const day = useQuery({
    queryKey: ["opd", "slips", "today"],
    queryFn: () => api<SlipDay>("GET", "/opd/slips/today"),
    refetchInterval: 30_000,
  });
  const q = useDebounced(findQ.trim(), 250);
  const hits = useQuery({
    queryKey: ["opd", "slips", "find", q],
    queryFn: () => api<{ items: Readback[] }>("GET", `/opd/slips/find?q=${encodeURIComponent(q)}`),
    enabled: findOpen && q.length >= 2,
  });

  const stopCamera = useCallback((): void => {
    streamRef.current?.getTracks().forEach((tr) => { tr.stop(); });
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const take = (back: Readback, how: "qr" | "search"): void => {
    setResolved(back); setVia(how); setShot(null); setRaw(null); setShotSize(null); setKind("consult_prescription"); setNote("");
    setRefused(null); setError(null); setFiled(null); setFindOpen(false); setFindQ("");
  };

  const resolveNumber = async (raw: string): Promise<void> => {
    const v = raw.trim();
    if (v === "") return;
    setError(null); setRefused(null); setResolved(null); setShot(null); setRaw(null); setFiled(null);
    stopCamera();
    try {
      const r = await api<Readback>("GET", `/opd/visits/by-number/${encodeURIComponent(v)}`);
      take(r, "qr");
    } catch {
      /* Named for what the operator can DO about it: check the number, or type it — and the torn-QR
         door opens beside it (owner ruling 28-Sep-2026). */
      setRefused(v);
      setFindOpen(true);
    }
  };
  const resolve = (): Promise<void> => resolveNumber(visitNo);

  /** Esc — the wrong person, or a slip put down: nothing in hand, the scan box ready. */
  const clearDesk = useCallback((): void => {
    stopCamera();
    setResolved(null); setShot(null); setRaw(null); setShotSize(null); setNote(""); setError(null); setRefused(null);
    setVisitNo("");
    setTimeout(() => scanRef.current?.focus(), 0);
  }, [stopCamera]);

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
      /* No camera, no permission, or no secure context. "Choose a photo" still works and on a
         phone it opens the camera anyway — so this is a fallback, not a dead end. */
      setError(t("slipCapture.noCamera"));
    }
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
    toCrop(b64, fitToMaxEdge(video.videoWidth, video.videoHeight));
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
      toCrop(b64, fitToMaxEdge(img.naturalWidth, img.naturalHeight));
      stopCamera();
    } catch {
      setError(t("slipCapture.badImage"));
    } finally {
      URL.revokeObjectURL(url);
      if (fileRef.current !== null) fileRef.current.value = "";
    }
  };

  const retake = (): void => { setShot(null); setShotSize(null); setRaw(null); setError(null); };

  /* A new photograph opens the crop step with the corners just inside the frame, then looks for the page. */
  const toCrop = (b64: string, size: { width: number; height: number }): void => {
    setRaw({ b64, ...size, quad: frameQuad(size.width, size.height, 0.04), status: "finding" });
  };
  const rawKey = raw?.b64;
  useEffect(() => {
    if (rawKey === undefined) return;
    let live = true;
    void (async () => {
      let found: Awaited<ReturnType<typeof detectInImage>> = null;
      try { found = await detectInImage(await loadImage(`data:image/jpeg;base64,${rawKey}`)); } catch { found = null; }
      if (!live) return;
      setRaw((r) => r === null || r.b64 !== rawKey || r.status !== "finding" ? r
        : found === null ? { ...r, status: "none" } : { ...r, quad: found.quad, status: "found" });
    })();
    return () => { live = false; };
  }, [rawKey]);

  const resetCrop = (): void => { setRaw((r) => r === null ? r : { ...r, quad: frameQuad(r.width, r.height) }); };

  /*
    "Use this": the quad is warped flat and goes through the SAME downscale-and-budget as every shot.
    Corners left on the photo's own edges mean "no crop" — the photo is used as taken, with no
    second JPEG pass to soften it.
  */
  const applyCrop = async (): Promise<void> => {
    if (raw === null || cropping || !isConvex(raw.quad)) return;
    const full = frameQuad(raw.width, raw.height);
    const untouched = raw.quad.every((p, i) => Math.hypot(p.x - full[i]!.x, p.y - full[i]!.y) <= Math.max(raw.width, raw.height) * 0.005);
    if (untouched) { setShot(raw.b64); setShotSize({ width: raw.width, height: raw.height }); return; }
    setCropping(true); setError(null);
    try {
      const img = await loadImage(`data:image/jpeg;base64,${raw.b64}`);
      const sx = img.naturalWidth / raw.width;
      const sy = img.naturalHeight / raw.height;
      const quad = raw.quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
      const flat = warpToCanvas(img, quad, MAX_EDGE);
      const b64 = await downscaleToJpeg(flat, flat.width, flat.height);
      if (b64 === null) { setError(t("slipCapture.tooLarge")); return; }
      setShot(b64); setShotSize(fitToMaxEdge(flat.width, flat.height));
    } catch {
      setError(t("slipCapture.crop.failed"));
    } finally {
      setCropping(false);
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
      setFiled({ back: resolved, kind, at: new Date().toISOString() });
      setVisitNo(""); setResolved(null); setShot(null); setRaw(null); setShotSize(null); setNote("");
      void queryClient.invalidateQueries({ queryKey: ["opd", "slips", "today"] });
      setTimeout(() => scanRef.current?.focus(), 0);
    } catch (e) {
      setError(e instanceof ApiError || !(e instanceof Error) ? t("slipCapture.failed") : e.message);
    }
  };

  /** P — another page for the patient just filed, without scanning again. The read-back is re-read, so "page 2" is the server's. */
  const addPage = async (): Promise<void> => {
    if (filed === null) return;
    const prev = filed.back;
    try {
      take(await api<Readback>("GET", `/opd/visits/by-number/${encodeURIComponent(prev.visitNo)}`), "qr");
    } catch {
      take(prev, "qr");
    }
  };

  const nameOf = (back: { patient: Summary | null; visitNo: string }): string =>
    back.patient?.name ?? back.patient?.alias ?? t("slipCapture.unnamed");

  /* The flow's one position: 1 scan · 2 check · 3 photograph · 4 file. */
  const step = resolved === null ? 1 : shot !== null ? 4 : cameraOn || raw !== null ? 3 : 2;

  /* ═══ THE KEYS — Enter the dock's act, R retake, Esc clear, P add a page ═══ */
  const act = useRef<() => void>(() => undefined);
  act.current = () => {
    if (step === 2) void startCamera();
    else if (step === 3 && raw !== null) void applyCrop();
    else if (step === 3) void takeShot();
    else if (step === 4) void file();
    else scanRef.current?.focus();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" && resolved !== null) { e.preventDefault(); clearDesk(); return; }
      if (typingIn(e.target)) return;
      if (e.key === "Enter") { e.preventDefault(); act.current(); return; }
      const k = e.key.toLowerCase();
      if (k === "r" && (shot !== null || raw !== null)) { e.preventDefault(); retake(); return; }
      if (k === "p" && resolved === null && filed !== null) { e.preventDefault(); void addPage(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const items = day.data?.items ?? [];
  const counts = day.data?.counts ?? null;
  const waiting = items.filter((i) => i.state === "waiting");
  const oldest = waiting.length === 0 ? null : minutesSince(waiting[0]!.consultDoneAt, now);
  const kindLabel = (k: string): string => (KINDS as readonly string[]).includes(k) ? t(`slipCapture.kinds.${k}`) : k;
  const pageNo = (resolved?.filed?.length ?? 0) + 1;

  /* ── the header's one status pill ── */
  const status = counts === null ? undefined : (
    <span className={`sd-pill ${counts.waiting > 0 ? "gd" : "on"}`} data-testid="slip-status">
      <span className="sd-long">{counts.waiting > 0 ? t("slipCapture.statusWaiting", { count: counts.waiting }) : t("slipCapture.statusNone")}</span>
      <span className="sd-short">{t("slipCapture.statusShort", { count: counts.waiting })}</span>
    </span>
  );

  /* ── LEFT: whoever is in hand, or the day ── */
  const facts = (rows: [string, React.ReactNode, boolean?][]): React.ReactElement => (
    <dl className="sd-facts">
      {rows.map(([k, v, mono]) => (
        <div className="sd-fact" key={k}><dt>{k}</dt><dd className={mono === true ? "mo" : undefined}>{v}</dd></div>
      ))}
    </dl>
  );
  let lane: React.ReactNode;
  if (resolved !== null) {
    const gender = resolved.patient?.administrativeGender;
    const age = ageYears(resolved.patient?.dob, now);
    const sub = [
      gender === null || gender === undefined ? null : t(`slipCapture.gender.${gender}`, { defaultValue: gender }),
      age === null ? null : t("slipCapture.ageY", { age }),
    ].filter((s) => s !== null).join(" · ");
    const already = resolved.filed ?? [];
    const firstRx = already.find((d) => d.kind === "consult_prescription") ?? already[0];
    lane = (
      <div className="sd-lane">
        {/* The board's phone frame: one compact card over the flow, so the camera is on the first screen. */}
        <div className="sd-card">
          <span className="tag">{t("slipCapture.inHand")}</span>
          <div className="sd-card-h"><b>{nameOf(resolved)}</b>{sub !== "" && <span>{sub}</span>}</div>
          <div className="mo sd-card-ids">{resolved.patient?.uhid ?? "—"} · {resolved.visitNo} · {dmy(resolved.serviceDate)}</div>
          <div className="sd-card-ok">✓ {t("slipCapture.checkShort")}</div>
          {already.length > 0 && <div className="sd-card-gd">! {t("slipCapture.addsPageShort", { n: already.length + 1 })}</div>}
        </div>
        <div className="sd-full" data-testid="slip-readback">
          <span className="tag">{via === "qr" ? t("slipCapture.inHandQr") : t("slipCapture.inHandSearch")}</span>
          <h2>{nameOf(resolved)}</h2>
          {sub !== "" && <div className="sub">{sub}</div>}
          <div className="sd-note ok"><b aria-hidden="true">✓</b><span>{t("slipCapture.checkPerson")}</span></div>
          {facts([
            [t("slipCapture.fact.uhid"), resolved.patient?.uhid ?? "—", true],
            [t("slipCapture.fact.visit"), resolved.visitNo, true],
            [t("slipCapture.fact.date"), dmy(resolved.serviceDate), true],
            [t("slipCapture.fact.doctorId"), resolved.doctorCode ?? "—", true],
            [t("slipCapture.fact.department"), resolved.departmentName ?? "—"],
            ...(resolved.roomName === null || resolved.roomName === undefined ? [] : [[t("slipCapture.fact.room"), resolved.roomName] as [string, string]]),
          ])}
        </div>
        <div className="sd-onfile sd-full" data-testid="slip-onfile">
          <span className="tag">{t("slipCapture.onFile")}</span>
          {already.length === 0 ? (
            <p>{t("slipCapture.onFileNone")}</p>
          ) : (
            <>
              <ul>
                {already.map((d, i) => (
                  <li key={d.id}>{t("slipCapture.onFileRow", { n: i + 1, kind: kindLabel(d.kind), at: fmtIst(d.capturedAt) })}</li>
                ))}
              </ul>
              <div className="sd-note gd"><b aria-hidden="true">!</b><span>{t("slipCapture.addsPage", { kind: kindLabel(firstRx!.kind), at: fmtIst(firstRx!.capturedAt), n: already.length + 1 })}</span></div>
            </>
          )}
        </div>
        <div className="sd-hints" aria-label={t("slipCapture.keys")}>
          <div><span className="kb">⏎</span>{t("slipCapture.keyEnter")}</div>
          <div><span className="kb">R</span>{t("slipCapture.keyR")}</div>
          <div><span className="kb">Esc</span>{t("slipCapture.keyEsc")}</div>
        </div>
      </div>
    );
  } else {
    lane = (
      <div className="sd-lane">
        <span className="tag">{t("slipCapture.nobody")}</span>
        <p className="lead">{refused !== null ? t("slipCapture.nobodyRefused") : t("slipCapture.nobodyLead")}</p>
        {counts !== null && (
          <div data-testid="slip-day">
            <span className="tag" style={{ display: "block", marginBottom: 4 }}>{t("slipCapture.yourDay")}</span>
            {facts([
              [t("slipCapture.dayFiled"), counts.filed, true],
              [t("slipCapture.dayWaiting"), <span key="w" style={{ color: counts.waiting > 0 ? "#9a6208" : undefined }}>{counts.waiting}</span>, true],
              [t("slipCapture.dayRetakes"), counts.retake, true],
            ])}
          </div>
        )}
      </div>
    );
  }

  /* ── RIGHT: today's slips, one list ── */
  const FILED_SHOWN = 30;
  const shown = [...items.filter((i) => i.state !== "filed"), ...items.filter((i) => i.state === "filed").slice(0, FILED_SHOWN)];
  const list = (
    <section className="sd-list box" aria-label={t("slipCapture.listTitle", { count: items.length })} data-testid="slip-list">
      <div className="sd-list-h"><span className="tag">{t("slipCapture.listTitle", { count: items.length })}</span></div>
      {day.isError ? (
        <p className="sd-list-empty">{t("slipCapture.listUnavailable")}</p>
      ) : items.length === 0 ? (
        <p className="sd-list-empty">{day.isLoading ? "…" : t("slipCapture.listEmpty")}</p>
      ) : (
        <ol>
          {shown.map((row) => {
            const here = resolved?.encounterId === row.encounterId;
            const chip = row.state === "retake" ? t("slipCapture.chipRetake") : (row.roomName ?? row.doctorCode ?? "—").toUpperCase();
            const age = minutesSince(row.consultDoneAt, now);
            const detail = row.state === "retake"
              ? t("slipCapture.rowRetake", { at: row.retakeRequestedAt === null ? "" : fmtIst(row.retakeRequestedAt) })
              : row.state === "filed"
                ? t("slipCapture.rowFiled", { at: row.filedAt === null ? "" : fmtIst(row.filedAt), kinds: row.kinds.map((k) => t(`slipCapture.kindsShort.${k}`, { defaultValue: k })).join(" + "), count: row.pages })
                : row.patient.uhid;
            const pill = here
              ? <span className="sd-pill on">{t("slipCapture.pillInHand")}</span>
              : row.state === "retake" ? <span className="sd-pill rd">{t("slipCapture.pillRetake")}</span>
                : row.state === "filed" ? <span className="sd-pill on">{t("slipCapture.pillFiled")}</span>
                  : <span className={`sd-pill${age >= 5 ? " gd" : ""}`}>{t("slipCapture.minutes", { count: age })}</span>;
            const body = (
              <>
                <span className="sd-src" title={row.roomName ?? undefined}>{chip}</span>
                <span className="t"><b>{nameOf(row)}</b><small className={row.state === "waiting" ? "mo" : undefined}>{detail}</small></span>
                {pill}
              </>
            );
            return (
              <li key={row.encounterId}>
                {row.state === "filed" ? (
                  <div className="row" aria-current={here ? "true" : undefined}>{body}</div>
                ) : (
                  <button
                    type="button" className="row" aria-current={here ? "true" : undefined} data-testid={`slip-row-${row.visitNo}`}
                    onClick={() => void resolveNumber(row.visitNo)}
                  >{body}</button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {counts !== null && <div className="sd-list-f">{t("slipCapture.listFoot", { count: counts.filed })}</div>}
    </section>
  );
  const clocks = (
    <div>
      {waiting.length > 0 && (
        <ul className="sd-clocks">
          {waiting.slice(0, 8).map((w) => (
            <li key={w.encounterId}><span>{nameOf(w)}</span><span className="mo">{t("slipCapture.minutes", { count: minutesSince(w.consultDoneAt, now) })}</span></li>
          ))}
        </ul>
      )}
      <p className="sd-clocks-note">{t("slipCapture.clocksNote")}</p>
    </div>
  );
  const clocksSummary = (
    <span>
      {waiting.length}
      {oldest !== null && <> · <span className="sd-clock-sum">{t("slipCapture.oldest", { count: oldest })}</span></>}
    </span>
  );

  /* ── CENTRE: the numbered flow ── */
  const stepState = (n: number): "done" | "now" | "todo" => (n < step ? "done" : n === step ? "now" : "todo");
  const steps: { n: number; label: string; small: string }[] = [
    { n: 1, label: t("slipCapture.step1"), small: resolved?.visitNo ?? t("slipCapture.step1Hint") },
    { n: 2, label: t("slipCapture.step2"), small: resolved === null ? t("slipCapture.step2Hint") : nameOf(resolved) },
    {
      n: 3, label: t("slipCapture.step3"),
      small: shot !== null && shotSize !== null
        ? `${String(shotSize.width)} × ${String(shotSize.height)} · ${String(Math.round(base64Bytes(shot) / 1024))} KB`
        : t("slipCapture.step3Hint"),
    },
    { n: 4, label: t("slipCapture.step4"), small: t("slipCapture.step4Hint") },
  ];

  const fileInput = (
    <label className="sec sd-filebtn">
      <span aria-hidden="true">⬆</span> {t("slipCapture.choosePhoto")}
      {/*
        THE FALLBACK IS A REAL PATH, NOT AN APOLOGY. `capture="environment"` opens the rear camera
        directly on a phone, and on a desktop with no webcam it is a file picker — which is how a
        desk with a scanner-and-no-camera still gets the slip in. Hidden behind the house button
        (board: no bare "Choose File / No file chosen").
      */}
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" data-testid="slip-file" className="sd-filein"
        aria-label={t("slipCapture.choosePhoto")}
        onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void fromFile(f); }}
      />
    </label>
  );

  let work: React.ReactNode;
  let dock: React.ReactNode;
  if (resolved === null) {
    work = (
      <>
        {filed !== null && (
          <div className="sd-note ok big" data-testid="slip-filed">
            <b aria-hidden="true">✓</b>
            <span>
              <b>{t("slipCapture.filed", { name: nameOf(filed.back) })}</b>{" · "}
              <span className="mo">{filed.back.patient?.uhid ?? "—"} · {filed.back.visitNo}</span><br />
              <span className="dim">
                {t("slipCapture.filedLine", { kind: kindLabel(filed.kind), at: fmtIst(filed.at), doctor: filed.back.doctorCode ?? "—" })}
              </span>
            </span>
          </div>
        )}
        <div>
          <label className="tag sd-lbl" htmlFor="slip-visit">{filed !== null ? t("slipCapture.nextSlip") : t("slipCapture.visitNo")}</label>
          <div className="sd-scan" data-refused={refused !== null ? "true" : undefined}>
            <ScanIcon />
            <input
              id="slip-visit" ref={scanRef} aria-label={t("slipCapture.visitNo")}
              value={visitNo} autoComplete="off" autoFocus spellCheck={false}
              onChange={(e) => { setVisitNo(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void resolve(); } }}
              placeholder={t("slipCapture.visitNoHint")}
            />
            <span className="kb" aria-hidden="true">⏎</span>
          </div>
          {refused === null && <p className="sd-help">{t("slipCapture.scanHelp")}</p>}
        </div>
        {refused !== null && (
          <div className="sd-note rd" role="alert" data-testid="slip-error">
            <b aria-hidden="true">✕</b>
            <span><b>{t("slipCapture.notFoundHead", { visitNo: refused })}</b> {t("slipCapture.notFoundBody")}</span>
          </div>
        )}
        {findOpen ? (
          <div className="box sd-find" data-testid="slip-find-box">
            <label className="tag" htmlFor="slip-find-q">{t("slipCapture.tornTitle")}</label>
            <p>{t("slipCapture.tornBody")}</p>
            <input
              id="slip-find-q" className="in" value={findQ} autoComplete="off" autoFocus={refused === null}
              placeholder={t("slipCapture.tornHint")} onChange={(e) => { setFindQ(e.target.value); }}
            />
            {q.length >= 2 && hits.data !== undefined && (
              hits.data.items.length === 0 ? (
                <p className="sd-help" style={{ margin: 0 }}>{t("slipCapture.tornNone")}</p>
              ) : (
                <ul className="sd-hits" data-testid="slip-find-hits">
                  {hits.data.items.map((h) => (
                    <li key={h.encounterId}>
                      <button type="button" onClick={() => { take(h, "search"); }}>
                        <span style={{ flexGrow: 1, minWidth: 0 }}>
                          <b>{nameOf(h)}</b>
                          <small className="mo">{h.patient?.uhid ?? "—"} · {h.visitNo}{h.doctorCode ? ` · ${h.doctorCode}` : ""}</small>
                        </span>
                        <span className="sd-pill">{t("slipCapture.pick")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        ) : (
          <button type="button" className="sd-linkbtn" data-testid="slip-torn" onClick={() => { setFindOpen(true); }}>
            {t("slipCapture.tornLink")}
          </button>
        )}
      </>
    );
    dock = filed !== null && refused === null ? (
      <>
        <div className="who"><b>{t("slipCapture.dockAnother", { name: nameOf(filed.back) })}</b><small>{t("slipCapture.dockAnotherSub")}</small></div>
        <div className="acts">
          <button type="button" className="sec" data-testid="slip-add-page" onClick={() => void addPage()}>
            {t("slipCapture.addPage")} <span className="kb">P</span>
          </button>
        </div>
      </>
    ) : (
      <>
        <div className="who">
          <b>{refused !== null ? t("slipCapture.dockFix") : t("slipCapture.dockScan")}</b>
          <small>{refused !== null ? t("slipCapture.dockFixSub") : t("slipCapture.dockScanSub")}</small>
        </div>
        <div className="acts">
          <button type="button" className="pri" data-testid="slip-find" disabled={visitNo.trim() === ""} onClick={() => void resolve()}>
            {refused !== null ? t("slipCapture.findAgain") : t("slipCapture.find")} <span className="kb">⏎</span>
          </button>
        </div>
      </>
    );
  } else if (shot === null && raw !== null) {
    work = (
      <DocCrop
        src={`data:image/jpeg;base64,${raw.b64}`} width={raw.width} height={raw.height}
        quad={raw.quad} status={raw.status} onQuad={(quad) => { setRaw((r) => r === null ? r : { ...r, quad }); }}
      />
    );
    const usable = isConvex(raw.quad);
    dock = (
      <>
        <div className="who">
          <b>{t("slipCapture.crop.dock")}</b>
          <small>{usable ? t("slipCapture.crop.dockSub") : t("slipCapture.crop.crossed")}</small>
        </div>
        <div className="acts">
          <button type="button" className="sec" data-testid="slip-retake" onClick={retake}>
            {t("slipCapture.retake")} <span className="kb">R</span>
          </button>
          <button type="button" className="sec" data-testid="slip-crop-reset" onClick={resetCrop}>{t("slipCapture.crop.reset")}</button>
          <button type="button" className="pri" data-testid="slip-crop-use" disabled={!usable || cropping} onClick={() => void applyCrop()}>
            {cropping ? t("slipCapture.crop.working") : t("slipCapture.crop.use")} <span className="kb">⏎</span>
          </button>
        </div>
      </>
    );
  } else if (shot === null) {
    work = (
      <div className="sd-cam" data-testid="slip-cam">
        {cameraOn ? (
          <video ref={videoRef} data-testid="slip-video" playsInline muted />
        ) : (
          <div className="paper" aria-hidden="true" />
        )}
        <Corners />
        <span className="hint">{cameraOn ? t("slipCapture.fitCorners") : t("slipCapture.camIdle")}</span>
      </div>
    );
    dock = cameraOn ? (
      <>
        <div className="acts">
          {fileInput}
          <button type="button" className="sec sd-cancel" onClick={() => { stopCamera(); }}>{t("slipCapture.cancel")}</button>
        </div>
        <span className="sd-grow" />
        <div className="acts">
          <button type="button" className="pri" data-testid="slip-shoot" onClick={() => void takeShot()}>
            {t("slipCapture.capture")} <span className="kb">⏎</span>
          </button>
        </div>
      </>
    ) : (
      <>
        <div className="who">
          <b>{t("slipCapture.dockCheck", { name: nameOf(resolved) })}</b>
          <small>{t("slipCapture.dockCheckSub")}</small>
        </div>
        <div className="acts">
          {fileInput}
          <button type="button" className="pri" data-testid="slip-camera" onClick={() => void startCamera()}>
            {t("slipCapture.openCamera")} <span className="kb">⏎</span>
          </button>
        </div>
      </>
    );
  } else {
    work = (
      <div className="box sd-review">
        <div className="sd-shot">
          <img data-testid="slip-preview" src={`data:image/jpeg;base64,${shot}`} alt={t("slipCapture.previewAlt")} />
          <Corners />
        </div>
        <div className="sd-choices">
          <div>
            <span className="tag" style={{ display: "block", marginBottom: 4 }}>{t("slipCapture.readableQ")}</span>
            <p className="lead">{t("slipCapture.readableBody")}</p>
          </div>
          <fieldset className="sd-opts">
            <legend className="tag" style={{ marginBottom: 6, padding: 0 }}>{t("slipCapture.kind")}</legend>
            {KINDS.map((k) => (
              <label className="sd-opt" key={k}>
                <input type="radio" name="slip-kind" value={k} checked={kind === k} onChange={() => { setKind(k); }} />
                <span className="rd" aria-hidden="true" />
                <span><b>{t(`slipCapture.kinds.${k}`)}</b><small>{t(`slipCapture.kindHints.${k}`)}</small></span>
              </label>
            ))}
          </fieldset>
          <div>
            <label className="tag" htmlFor="slip-note" style={{ display: "block", marginBottom: 6 }}>
              {t("slipCapture.note")} <span className="sd-opt-tag">{t("slipCapture.optional")}</span>
            </label>
            <input
              id="slip-note" className="in" value={note} onChange={(e) => { setNote(e.target.value); }}
              placeholder={t("slipCapture.noteHint")}
            />
          </div>
        </div>
      </div>
    );
    dock = (
      <>
        <div className="who">
          <b>{t("slipCapture.dockFile", { name: nameOf(resolved) })} · <span className="mo">{resolved.visitNo}</span></b>
          <small>{t("slipCapture.dockFileSub", { kind: kindLabel(kind), n: pageNo })}</small>
        </div>
        <div className="acts">
          {/* RETAKE, in the owner's own words — and it discards rather than stacking a second shot. */}
          <button type="button" className="sec" data-testid="slip-retake" onClick={retake}>
            {t("slipCapture.retake")} <span className="kb">R</span>
          </button>
          {raw !== null && (
            <button type="button" className="sec" data-testid="slip-crop-adjust" onClick={() => { setShot(null); setShotSize(null); }}>
              {t("slipCapture.crop.adjust")}
            </button>
          )}
          <button type="button" className="pri" data-testid="slip-file-it" onClick={() => void file()}>
            {t("slipCapture.fileIt")} <span className="kb">⏎</span>
          </button>
        </div>
      </>
    );
  }

  return (
    <StationShell
      brand={t("slipCapture.brand")}
      stations={OPD_STATIONS.map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current="slips"
      title={t("slipCapture.title")}
      place=""
      stats={[]}
      statsLabel={t("slipCapture.yourDay")}
      laneHead={false}
      status={status}
      lane={lane}
      list={list}
      clocks={clocks}
      clocksSummary={clocksSummary}
    >
      <div className="sd" data-testid="slip-capture" data-step={step}>
        <div className="sd-h1">
          <h1>
            {t("slipCapture.title")}
            {/* The board's bilingual title: the Hindi name beside the English one, never twice in Hindi. */}
            {!i18n.language.startsWith("hi") && <span className="hi"> · {t("slipCapture.title", { lng: "hi" })}</span>}
          </h1>
          <p>{t("slipCapture.intro")}</p>
        </div>
        <ol className="sd-stepper" aria-label={t("slipCapture.stepsLabel")}>
          {steps.map((s) => (
            <li className="sd-stp" key={s.n} data-state={stepState(s.n)} aria-current={s.n === step ? "step" : undefined}>
              <span className="nb">{s.n < step ? "✓" : s.n}</span>
              <span>
                <b className="sd-stp-l">{s.label}</b><b className="sd-stp-s">{t(`slipCapture.stepShort${String(s.n)}`)}</b>
                <small className={s.n === 1 && resolved !== null ? "mo" : undefined}>{s.small}</small>
              </span>
            </li>
          ))}
        </ol>
        {error !== null && (
          <div className="sd-note rd" role="alert" data-testid="slip-error"><b aria-hidden="true">✕</b><span>{error}</span></div>
        )}
        {work}
        <div className="sd-dock" data-testid="slip-dock">{dock}</div>
      </div>
    </StationShell>
  );
}
