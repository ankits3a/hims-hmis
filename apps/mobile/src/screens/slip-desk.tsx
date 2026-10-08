import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text, TextInput } from "../text";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { SlipCamera } from "../slips/camera";
import { Crop, type CropStatus } from "../slips/crop";
import { findPage, flatten, normalize, type Flat, type Photo } from "../slips/imaging";
import { MAX_PAGES, landedUnheard, moveById, paperOf, type PaperSaid } from "../slips/pages";
import {
  MAX_EDGE, SLIP_KINDS, ageYearsAt, base64Bytes, frameQuad, isConvex, minutesSince, slipDoor, slipOfPatient,
} from "../slips/rules";
import type { Quad, SlipDay, SlipKind, SlipPatient, SlipReadback, SlipRow } from "../slips/rules";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note, Tag } from "../ui";
import { refusalText } from "../vitals/api";
import { humanDate, istClock, tokenText } from "../vitals/rules";
import { Scanner } from "../vitals/scanner";
import { HeldCard, ScannedBanner, type Scanned } from "../scan/card";
import { SwipeHint, SwipeRow } from "../scan/gestures";

/**
 * THE SLIP DESK, ON A PHONE (plan M2; owner 2026-10-06) — scan, see who it is, photograph, file.
 * The web desk's flow (apps/web/src/screens/slip-capture.tsx) on the same server routes and guards:
 *
 *   1 find the visit   `slipDoor` reads what was typed or scanned — the visit number, the token as
 *                      the slip prints it, a UHID, a printed e-prescription's code, a patient card —
 *                      and every road ends at the SERVER's read-back of one visit
 *                      (`GET /opd/visits/by-number/:visitNo`). A torn slip is found by name
 *                      (`GET /opd/slips/find`), today's visits only.
 *   2 check the person THE READ-BACK IS THE CONTROL: a slip filed against the wrong visit is a
 *                      clinical-record error, and the desk is the only one who can catch it. The
 *                      camera does not open until the screen has said whose visit it matched.
 *   3 photograph       full-screen camera, then the crop: the page is found, the corners can be
 *                      dragged, "Use this" straightens it (../slips/imaging).
 *   4 file             what it is, an optional note, `POST /patients/:id/documents`. The server
 *                      refuses a page over 1.5 MB, so the page is brought inside that here.
 *
 * A record the caller may not see answers exactly as "no such visit" (the server's rule) and is
 * absent from today's list — this screen adds nothing that could reveal it.
 *
 * SEVERAL PAGES IN ONE GO (owner 2026-10-07 — "after capturing the first image, allow to capture
 * second image from the same screen, may '+' button would be enough"): the review step holds a strip
 * of pages. "+" reopens the camera and keeps it open — shoot, shoot, Done — and each of those pages
 * is cut to the corners that were found, to be fixed from the strip if they are off. A page whose
 * edges were NOT found is marked and must be opened once before anything is filed. The pages are
 * sent one after another in the order of the strip, which is the order the server numbers them in.
 *
 * NEVER QUEUED: a page that does not reach the server stays on screen, photo and crop intact, with
 * the reason and a Try again. The pages before it ARE filed and the screen says so; a retry after a
 * lost answer first asks the server what it holds for the visit, so a page is never filed twice.
 */
const DAY_POLL_MS = 30_000;
type T = ReturnType<typeof useI18n>["t"];
type Raw = { photo: Photo; quad: Quad; status: CropStatus };
/**
 * One page of the slip in hand. `flat` is the straightened page (null while it is being made, or when
 * it could not be); `check` — its edges were not found and nobody has looked yet; `docId` — the
 * server has it.
 */
type Page = { id: number; raw: Raw; flat: Flat | null; plainCut: boolean; check: boolean; docId: string | null; paper: string | null };
type CamMode = { kind: "first" } | { kind: "burst" } | { kind: "replace"; id: number };
/**
 * Owner ruling 2026-10-06 — a filed prescription slip also marks the visit consulted, when this login
 * is a Slip Desk or Desk Scribe and the visit is today's and still open. The SERVER decides and
 * answers beside the document id; `paper` is that answer's outcome code (null when it said nothing —
 * an older server, or a page that is not the doctor's slip), worded by `paper.outcome.*`.
 */
type Filed = { back: SlipReadback; kind: SlipKind; at: string; page: number; pages: number; paper: string | null };
const PAPER_CONSULTED = new Set(["marked", "already_marked", "doctor_completed"]);

const nameOf = (p: SlipPatient | null, t: T): string => p?.name ?? p?.alias ?? t("slipCapture.unnamed");
const buzz = (ok: boolean): void => {
  void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => undefined);
};

export function SlipDesk({ scanned = null }: { scanned?: Scanned | null } = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const { call, upload } = useSession();

  const [day, setDay] = useState<SlipDay | null>(null);
  /** The row being held: its action card is up. */
  const [held1, setHeld1] = useState<SlipRow | null>(null);
  const [scanSaid, setScanSaid] = useState<string | null>(scanned?.banner ?? null);
  const arrived = useRef(false);
  const [dayFailed, setDayFailed] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<SlipReadback | null>(null);
  const [via, setVia] = useState<"qr" | "search">("qr");
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SlipReadback[] | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  /** The page whose corners are on screen (step 3), and the one the strip shows large (step 4). */
  const [editing, setEditing] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [camMode, setCamMode] = useState<CamMode>({ kind: "first" });
  const [removing, setRemoving] = useState(false);
  const [working, setWorking] = useState(false);
  /** The page whose answer was lost on the way back: the next try asks the server before it sends. */
  const [unheard, setUnheard] = useState<number | null>(null);
  const nextId = useRef(1);
  const pagesRef = useRef<Page[]>([]);
  pagesRef.current = pages;
  const [kind, setKind] = useState<SlipKind>("consult_prescription");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<{ n: number; f: number } | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<TextInput | null>(null);
  const scroller = useRef<ScrollView | null>(null);

  const refreshDay = useCallback(async () => {
    try { setDay(await call<SlipDay>("GET", "/opd/slips/today")); setDayFailed(false); } catch { setDayFailed(true); }
    setNow(Date.now());
  }, [call]);
  useEffect(() => {
    void refreshDay();
    const id = setInterval(() => { void refreshDay(); }, DAY_POLL_MS);
    return () => clearInterval(id);
  }, [refreshDay]);

  const items = useMemo(() => day?.items ?? [], [day]);
  const counts = day?.counts ?? null;

  const take = (back: SlipReadback, how: "qr" | "search"): void => {
    setResolved(back); setVia(how); setPages([]); setEditing(null); setSel(null); setUnheard(null); setRemoving(false); setKind("consult_prescription"); setNote("");
    setRefused(null); setError(null); setFiled(null); setHits(null); setText(""); setListOpen(false); setSending(null);
  };
  const clearDesk = (): void => {
    setResolved(null); setPages([]); setEditing(null); setSel(null); setUnheard(null); setRemoving(false); setNote(""); setError(null); setRefused(null); setHits(null); setText(""); setSending(null);
  };
  const patch = (id: number, f: (p: Page) => Page): void => { setPages((ps) => ps.map((p) => (p.id === id ? f(p) : p))); };

  const search = useCallback(async (q: string): Promise<void> => {
    if (q.trim().length < 2) { setHits([]); return; }
    try { setHits((await call<{ items: SlipReadback[] }>("GET", `/opd/slips/find?q=${encodeURIComponent(q.trim())}`)).items); } catch { setHits([]); }
  }, [call]);

  /** Whatever was typed or scanned ends at the server's read-back of ONE visit, or at a plain refusal. */
  const resolve = useCallback(async (typed: string): Promise<void> => {
    const v = typed.trim();
    const door = slipDoor(items, v);
    if (door.to === "empty") return;
    setError(null); setRefused(null); setHits(null); setFiled(null);
    const readBack = async (visitNo: string): Promise<boolean> => {
      try { take(await call<SlipReadback>("GET", `/opd/visits/by-number/${encodeURIComponent(visitNo)}`), "qr"); return true; } catch { return false; }
    };
    if (door.to === "ambiguous") {
      const coded = door.rows.find((r) => r.departmentCode !== null && r.departmentCode !== undefined && r.departmentCode !== "");
      setError(coded === undefined
        ? t("slipCapture.miss.ambiguousPlain", { token: tokenText(door.door), count: door.rows.length })
        : t("slipCapture.miss.ambiguous", { token: tokenText(door.door), count: door.rows.length, example: `${coded.departmentCode!}-${String(door.door.tokenNo)}` }));
      return;
    }
    if (door.to === "miss") {
      setError(door.door.kind === "token" ? t("slipCapture.miss.token", { token: tokenText(door.door) }) : t("slipCapture.miss.prescription"));
      return;
    }
    setBusy(true);
    try {
      if (door.to === "verify") {
        try {
          const verdict = await call<{ ok: true; patient: { id: string; uhid: string } } | { ok: false; reason: string }>("POST", "/patients/qr/verify", { payload: door.payload });
          const row = verdict.ok ? slipOfPatient(items, verdict.patient.id) : null;
          if (row !== null && await readBack(row.visitNo)) return;
          setError(verdict.ok ? t("slipCapture.miss.card", { uhid: verdict.patient.uhid }) : t(`vitalsBay.identify.scanFailed.${verdict.reason}`));
        } catch {
          setError(t("vitalsBay.identify.scanUnavailable"));
        }
        return;
      }
      if (await readBack(door.to === "visit" ? door.visitNo : v)) return;
      // Named for what the desk can DO: check the number — and the torn-slip search opens beside it.
      setRefused(v);
      await search(v);
    } finally {
      setBusy(false);
    }
  }, [items, call, t, search]);

  // Arrived from a scan: the visit's read-back opens at once — who it is stays on screen before anything is photographed.
  useEffect(() => {
    if (scanned === null || scanned.visitNo === null || arrived.current) return;
    arrived.current = true;
    void resolve(scanned.visitNo);
  }, [scanned, resolve]);

  /* ── 3 · the photograph ── */
  /**
   * A page shot back-to-back is cut to the corners that were found, without a stop at the crop: the
   * desk fixes any that are off from the strip. Edges not found → the photo as taken, MARKED.
   */
  const autoCrop = async (id: number, photo: Photo): Promise<void> => {
    let found: Awaited<ReturnType<typeof findPage>> = null;
    try { found = await findPage(photo); } catch { found = null; }
    let flat: Flat | null = null;
    try { flat = await flatten(photo, found === null ? null : found.quad, MAX_EDGE); } catch { flat = null; }
    patch(id, (p) => (p.raw.photo !== photo ? p : {
      ...p, flat, plainCut: found !== null && flat !== null && !flat.straightened, check: found === null || flat === null,
      raw: { photo, quad: found === null ? p.raw.quad : found.quad, status: found === null ? "none" : "found" },
    }));
  };
  const onShot = async (p: Photo): Promise<void> => {
    const mode = camMode;
    if (mode.kind !== "burst") setCameraOpen(false);
    else if (pagesRef.current.length >= MAX_PAGES) return;
    setError(null); setRemoving(false);
    // The place in the strip is taken at once, so two quick shots keep the order they were taken in.
    const id = mode.kind === "replace" ? mode.id : nextId.current++;
    const holder: Photo = p;
    if (mode.kind !== "replace") {
      const fresh: Page = { id, raw: { photo: holder, quad: frameQuad(p.width, p.height, 0.04), status: "finding" }, flat: null, plainCut: false, check: false, docId: null, paper: null };
      pagesRef.current = [...pagesRef.current, fresh];
      setPages((ps) => [...ps, fresh]);
    }
    try {
      const photo = await normalize(p);
      const raw: Raw = { photo, quad: frameQuad(photo.width, photo.height, 0.04), status: "finding" };
      patch(id, (pg) => ({ ...pg, raw, flat: null, plainCut: false, check: false }));
      if (mode.kind === "burst") { setSel(id); await autoCrop(id, photo); return; }
      setEditing(id); setSel(id);
      const found = await findPage(photo);
      patch(id, (pg) => (pg.raw.photo !== photo || pg.raw.status !== "finding" ? pg
        : found === null ? { ...pg, raw: { ...pg.raw, status: "none" } } : { ...pg, raw: { ...pg.raw, quad: found.quad, status: "found" } }));
    } catch {
      if (mode.kind !== "replace") setPages((ps) => ps.filter((pg) => pg.id !== id));
      setError(t("mobile.slips.camFailed"));
    }
  };
  const openCamera = (mode: CamMode): void => { setError(null); setCamMode(mode); setCameraOpen(true); };
  /** Swipe right on a waiting row — "Photograph": the read-back is fetched and the camera opens on it, the two taps a row tap and "Open camera" make. */
  const photograph = (r: SlipRow): void => {
    void (async () => {
      setError(null); setRefused(null);
      try {
        take(await call<SlipReadback>("GET", `/opd/visits/by-number/${encodeURIComponent(r.visitNo)}`), "qr");
        openCamera({ kind: "first" });
      } catch {
        setRefused(r.visitNo);
      }
    })();
  };
  const current = editing === null ? null : pages.find((p) => p.id === editing) ?? null;
  const chosen = pages.find((p) => p.id === sel) ?? pages[pages.length - 1] ?? null;
  const retake = (): void => {
    const target = current ?? chosen;
    if (target === null) { openCamera({ kind: "first" }); return; }
    setSending(null); openCamera({ kind: "replace", id: target.id });
  };
  const resetCrop = (): void => { if (current !== null) patch(current.id, (p) => ({ ...p, raw: { ...p.raw, quad: frameQuad(p.raw.photo.width, p.raw.photo.height) } })); };

  /** "Use this": corners left on the photo's own edges mean "no crop"; anything else is straightened. */
  const applyCrop = async (): Promise<void> => {
    if (current === null || working || !isConvex(current.raw.quad)) return;
    const { photo, quad } = current.raw;
    const id = current.id;
    const full = frameQuad(photo.width, photo.height);
    const untouched = quad.every((pt, i) => Math.hypot(pt.x - full[i]!.x, pt.y - full[i]!.y) <= Math.max(photo.width, photo.height) * 0.005);
    setWorking(true); setError(null);
    try {
      const flat = await flatten(photo, untouched ? null : quad, MAX_EDGE);
      if (flat === null) { setError(t("slipCapture.tooLarge")); return; }
      // The desk has now looked at this page's corners: the mark comes off.
      patch(id, (p) => ({ ...p, flat, plainCut: !untouched && !flat.straightened, check: false }));
      setSel(id); setEditing(null);
    } catch {
      setError(t("slipCapture.crop.failed"));
    } finally {
      setWorking(false);
    }
  };

  const removeChosen = (): void => {
    if (chosen === null || chosen.docId !== null) return;
    const left = pages.filter((p) => p.id !== chosen.id);
    setPages(left); setSel(left[left.length - 1]?.id ?? null); setRemoving(false); setError(null);
  };
  const move = (by: -1 | 1): void => { if (chosen !== null) setPages((ps) => moveById(ps, chosen.id, by)); };

  /* ── 4 · file ── */
  const baseline = resolved?.filed?.length ?? 0;
  const anyFiled = pages.some((p) => p.docId !== null);
  const notReady = pages.some((p) => p.docId === null && (p.flat === null || p.check));
  const file = async (): Promise<void> => {
    if (resolved === null || pages.length === 0 || sending !== null || notReady) return;
    setError(null); setRemoving(false);
    let list = pages;
    const total = list.length;
    const mark = (id: number, docId: string, paper: string | null): void => {
      list = list.map((p) => (p.id === id ? { ...p, docId, paper } : p));
      setPages(list);
    };
    const partial = (): string => {
      const done = list.filter((p) => p.docId !== null).length;
      return done === 0 ? "" : ` ${t("mobile.slips.partFiled", { done, total })}`;
    };
    for (let i = 0; i < list.length; i++) {
      const page = list[i]!;
      if (page.docId !== null || page.flat === null) continue;
      setSending({ n: i + 1, f: 0 });
      try {
        if (unheard === page.id) {
          // The last try's answer never came back. Ask what the server holds before sending again.
          const now = await call<SlipReadback>("GET", `/opd/visits/by-number/${encodeURIComponent(resolved.visitNo)}`);
          if (landedUnheard(baseline, list.filter((p) => p.docId !== null).length, now.filed?.length ?? 0)) {
            setUnheard(null); mark(page.id, "landed", null);
            continue;
          }
        }
        const done = await upload<{ documentId: string; effects?: { "opd.paper"?: PaperSaid } }>("/patients/" + encodeURIComponent(resolved.patientId) + "/documents", {
          imageBase64: page.flat.base64, mimeType: "image/jpeg", kind, encounterId: resolved.encounterId,
          note: i === 0 && note.trim() !== "" ? note.trim() : null,
        }, (f) => setSending({ n: i + 1, f }));
        setUnheard(null);
        const said = done?.effects?.["opd.paper"];
        mark(page.id, done?.documentId ?? "filed", said === undefined ? null : said.failed === true ? "failed" : said.outcome ?? null);
      } catch (e) {
        buzz(false);
        if (e instanceof NetworkError) setUnheard(page.id);
        setSel(page.id);
        // The photo and the crop stay exactly as they are. Nothing is queued.
        setError((e instanceof NetworkError ? t("mobile.slips.uploadNetwork")
          : e instanceof ApiError ? t("mobile.slips.uploadRefused", { why: refusalText(e.body, t("slipCapture.failed")) })
            : t("slipCapture.failed")) + partial());
        setSending(null);
        return;
      }
    }
    buzz(true);
    // The confirmation NAMES the patient and the visit: forty slips an hour, and this is which one just landed.
    setFiled({ back: resolved, kind, at: new Date().toISOString(), page: baseline + 1, pages: total, paper: paperOf(list.map((p) => p.paper)) });
    setResolved(null); setPages([]); setEditing(null); setSel(null); setUnheard(null); setNote(""); setText("");
    setSending(null);
    void refreshDay();
  };

  const addPage = async (): Promise<void> => {
    if (filed === null) return;
    const prev = filed.back;
    try { take(await call<SlipReadback>("GET", `/opd/visits/by-number/${encodeURIComponent(prev.visitNo)}`), "qr"); } catch { take(prev, "qr"); }
  };

  const step = resolved === null ? 1 : current !== null ? 3 : pages.length > 0 ? 4 : 2;
  // Each step, and the "Filed against …" line after the last one, starts at the top of the page.
  useEffect(() => { scroller.current?.scrollTo({ y: 0, animated: false }); }, [step, filed]);
  const kindLabel = (k: string): string => ((SLIP_KINDS as readonly string[]).includes(k) ? t(`slipCapture.kinds.${k}`) : k);
  const waiting = items.filter((i) => i.state !== "filed");
  const pageNo = baseline + 1;

  const row = (r: SlipRow, onPress: (() => void) | null, swipe = false) => {
    const age = minutesSince(r.consultDoneAt, now);
    const pill = r.state === "retake" ? t("slipCapture.pillRetake") : r.state === "filed" ? t("slipCapture.pillFiled") : t("slipCapture.minutes", { count: age });
    const loud = r.state === "retake" || (r.state === "waiting" && age >= 5);
    const body = (
      <>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.rowName} numberOfLines={1}>{nameOf(r.patient, t)}</Text>
          <Text style={s.rowIds} numberOfLines={r.state === "retake" ? 2 : 1}>
            {r.state === "retake" ? t("slipCapture.rowRetake", { at: r.retakeRequestedAt === null ? "" : istClock(r.retakeRequestedAt) }) : `${r.visitNo} · ${r.patient.uhid}`}
          </Text>
        </View>
        <Text style={[s.rowPill, r.state === "retake" && { color: color.red, borderColor: color.redLine }, r.state === "waiting" && loud && { color: "#8a5a10", borderColor: color.goldLine }, r.state === "filed" && { color: color.green, borderColor: color.greenLine }]}>{pill}</Text>
      </>
    );
    if (onPress === null) return <View key={r.encounterId} style={[s.row, { opacity: 0.75 }]}>{body}</View>;
    // Press and hold = the action card a scan opens; swipe right (main list only) = "Photograph" (owner 2026-10-08).
    const hold = (): void => { setListOpen(false); setHeld1(r); };
    const pressable = (
      <Pressable key={r.encounterId} testID={`slip-row-${r.visitNo}`} accessibilityRole="button" onPress={onPress} onLongPress={hold}
        accessibilityActions={[{ name: "longpress", label: t("mobile.scan.more") }]}
        onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === "longpress") hold(); }}
        style={({ pressed }) => [s.row, pressed && { backgroundColor: color.wash }]}>{body}</Pressable>
    );
    return swipe
      ? <SwipeRow key={r.encounterId} testID={`slip-swipe-${r.visitNo}`} label={t("mobile.scan.swipe.photo")} onSwipe={() => photograph(r)}>{pressable}</SwipeRow>
      : pressable;
  };

  const stepper = (
    <View style={s.stepper} accessibilityLabel={t("slipCapture.stepsLabel")}>
      {[1, 2, 3, 4].map((n) => (
        <View key={n} testID={`step-${String(n)}`} style={[s.step, n === step && s.stepNow, n < step && s.stepDone]}>
          <Text style={[s.stepNo, n === step && { color: "#f2faf6" }, n < step && { color: color.green }]}>{n < step ? "✓" : String(n)}</Text>
          <Text style={[s.stepLabel, n === step && { color: "#f2faf6" }]} numberOfLines={1}>{t(`slipCapture.stepShort${String(n)}`)}</Text>
        </View>
      ))}
    </View>
  );

  const who = resolved === null ? null : (() => {
    const sub = [
      resolved.patient?.administrativeGender ? t(`slipCapture.gender.${resolved.patient.administrativeGender}`) : null,
      ((a) => (a === null ? null : t("slipCapture.ageY", { age: a })))(ageYearsAt(resolved.patient?.dob, now)),
    ].filter((x): x is string => x !== null && !x.startsWith("slipCapture.")).join(" · ");
    const already = resolved.filed ?? [];
    return (
      <View style={s.card} testID="slip-readback">
        <Tag>{t(via === "qr" ? "slipCapture.inHandQr" : "slipCapture.inHandSearch")}</Tag>
        <Text testID="slip-name" style={s.name}>{nameOf(resolved.patient, t)}</Text>
        {sub !== "" && <Text style={s.dim}>{sub}</Text>}
        <Text style={s.ids}>{resolved.patient?.uhid ?? "—"} · {resolved.visitNo} · {humanDate(resolved.serviceDate)}</Text>
        {step === 2 && (
          <>
            <View style={s.okNote}><Text style={s.okText}>✓ {t("slipCapture.checkPerson")}</Text></View>
            <Text style={s.dim}>
              {t("slipCapture.fact.doctorId")} {resolved.doctorCode ?? "—"} · {resolved.departmentName ?? "—"}{resolved.roomName ? ` · ${resolved.roomName}` : ""}
            </Text>
          </>
        )}
        {already.length > 0 && (
          <View testID="slip-onfile" style={s.warnNote}>
            <Text style={s.warnText}>! {t("slipCapture.addsPageShort", { n: already.length + 1 })}</Text>
            {step === 2 && already.map((d, i) => (
              <Text key={d.id} style={s.dim}>{t("slipCapture.onFileRow", { n: i + 1, kind: kindLabel(d.kind), at: istClock(d.capturedAt) })}</Text>
            ))}
          </View>
        )}
      </View>
    );
  })();

  /* The picture gets what the screen has left after the band, the stepper, the card and the dock. */
  const cropMax = Math.max(220, win.height - insets.top - insets.bottom - 430);

  let body: ReactNode;
  let dock: ReactNode;
  if (resolved === null) {
    body = (
      <>
        {filed !== null && (
          <View testID="slip-filed" accessibilityRole="alert" style={[s.card, { borderColor: color.greenLine, backgroundColor: color.greenSoft }]}>
            <Text style={s.filedTitle}>✓ {t("slipCapture.filed", { name: nameOf(filed.back.patient, t) })}</Text>
            <Text style={s.ids}>{filed.back.patient?.uhid ?? "—"} · {filed.back.visitNo}</Text>
            <Text style={s.dim}>{t("slipCapture.filedLine", { kind: kindLabel(filed.kind), at: istClock(filed.at), doctor: filed.back.doctorCode ?? "—" })}</Text>
            {filed.pages > 1 && <Text testID="slip-filed-pages" style={[s.dim, { fontWeight: "700", color: color.ink }]}>{t("mobile.slips.pagesFiled", { count: filed.pages })}</Text>}
            {filed.paper !== null && (
              <Text testID="slip-paper" style={[s.paper, PAPER_CONSULTED.has(filed.paper) && { color: color.green }]}>{t(`paper.outcome.${filed.paper}`)}</Text>
            )}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}><Button testID="slip-add-page" kind="secondary" label={t("slipCapture.addPage")} onPress={() => { void addPage(); }} /></View>
              <View style={{ flex: 1 }}><Button testID="slip-next" label={t("mobile.slips.nextSlip")} onPress={() => { setFiled(null); input.current?.focus(); }} /></View>
            </View>
          </View>
        )}
        <View style={s.card}>
          <Text style={[type.heading, { color: color.ink }]}>{t(filed !== null ? "slipCapture.nextSlip" : "slipCapture.step1")}</Text>
          <TextInput
            ref={input} testID="slip-visit" accessibilityLabel={t("slipCapture.visitNo")}
            autoCapitalize="characters" autoCorrect={false} autoComplete="off" returnKeyType="search" editable={!busy}
            placeholder={t("mobile.slips.typeHint")} placeholderTextColor={color.faint}
            value={text} onChangeText={setText} onSubmitEditing={() => { void resolve(text); }}
            style={[s.input, refused !== null && { borderColor: color.red, borderWidth: 2 }]}
          />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}><Button testID="slip-scan" kind="secondary" label={t("mobile.slips.scan")} onPress={() => { setError(null); setScanOpen(true); }} /></View>
            <View style={{ flex: 1 }}><Button testID="slip-find" label={t(refused !== null ? "slipCapture.findAgain" : "slipCapture.find")} busy={busy} disabled={text.trim() === ""} onPress={() => { void resolve(text); }} /></View>
          </View>
          {refused === null && error === null && <Text style={s.faint}>{t("mobile.slips.help")}</Text>}
          {refused !== null && (
            <Note tone="bad" testID="slip-error">{t("slipCapture.notFoundHead", { visitNo: refused })} {t("slipCapture.notFoundBody")}</Note>
          )}
          {error !== null && <Note tone="bad" testID="slip-error">{error}</Note>}
        </View>
        {hits !== null && (
          <View style={s.card} testID="slip-find-box">
            <Tag>{t("slipCapture.tornTitle")}</Tag>
            <Text style={s.dim}>{t("slipCapture.tornBody")}</Text>
            {hits.length === 0
              ? <Text style={s.faint} testID="slip-find-none">{t("slipCapture.tornNone")}</Text>
              : hits.map((h) => (
                <Pressable key={h.encounterId} testID={`slip-hit-${h.visitNo}`} accessibilityRole="button" onPress={() => take(h, "search")} style={({ pressed }) => [s.row, pressed && { backgroundColor: color.wash }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.rowName} numberOfLines={1}>{nameOf(h.patient, t)}</Text>
                    <Text style={s.rowIds} numberOfLines={1}>{h.patient?.uhid ?? "—"} · {h.visitNo}{h.doctorCode ? ` · ${h.doctorCode}` : ""}</Text>
                  </View>
                  <Text style={[s.rowPill, { color: color.green, borderColor: color.greenLine }]}>{t("slipCapture.pick")}</Text>
                </Pressable>
              ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
          <Tag>{t("mobile.slips.waitingNow")}</Tag>
          {day !== null && <Text style={s.asOf}>{t("slipCapture.dayFiled")} {String(day.counts.filed)}</Text>}
        </View>
        {dayFailed && day === null && <Text style={s.faint} testID="slip-list-unavailable">{t("slipCapture.listUnavailable")}</Text>}
        {day !== null && waiting.length === 0 && <Text style={s.faint} testID="slip-none-waiting">{t(items.length === 0 ? "slipCapture.listEmpty" : "mobile.slips.allFiled")}</Text>}
        <View style={{ gap: space.sm }}>{waiting.slice(0, 8).map((r) => row(r, () => { void resolve(r.visitNo); }, true))}</View>
        {waiting.length > 0 && <SwipeHint list="slips" />}
        <Text style={s.faint}>{t("slipCapture.clocksNote")}</Text>
      </>
    );
    dock = null;
  } else if (current !== null) {
    const raw = current.raw;
    const usable = isConvex(raw.quad);
    const at = pages.findIndex((p) => p.id === current.id) + 1;
    body = (
      <>
        <View style={s.strip} testID="slip-readback">
          <Text testID="slip-name" style={s.stripName} numberOfLines={1}>{nameOf(resolved.patient, t)}</Text>
          <Text style={s.ids} numberOfLines={1}>{pages.length > 1 ? `${t("mobile.slips.pageN", { n: at, total: pages.length })} · ` : ""}{resolved.visitNo}</Text>
        </View>
        {error !== null && <Note tone="bad" testID="slip-error">{error}</Note>}
        <Crop uri={raw.photo.uri} width={raw.photo.width} height={raw.photo.height} quad={raw.quad} status={raw.status}
          onQuad={(quad) => patch(current.id, (p) => ({ ...p, raw: { ...p.raw, quad } }))} />
        <Text style={s.faint}>{usable ? t("mobile.slips.dragHint") : t("slipCapture.crop.crossed")}</Text>
      </>
    );
    dock = (
      <>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}><Button testID="slip-retake" kind="secondary" label={t("slipCapture.retake")} onPress={retake} /></View>
          <View style={{ flex: 1.4 }}><Button testID="slip-crop-reset" kind="secondary" label={t("slipCapture.crop.reset")} onPress={resetCrop} /></View>
        </View>
        <Button testID="slip-crop-use" label={t(working ? "slipCapture.crop.working" : "slipCapture.crop.use")} busy={working} disabled={!usable || raw.status === "finding"} onPress={() => { void applyCrop(); }} />
      </>
    );
  } else if (pages.length === 0) {
    body = (
      <>
        {who}
        {error !== null && <Note tone="bad" testID="slip-error">{error}</Note>}
      </>
    );
    dock = (
      <>
        <Text style={s.dockLead}>{t("slipCapture.dockCheck", { name: nameOf(resolved.patient, t) })}</Text>
        <Button testID="slip-camera-open" label={t("slipCapture.openCamera")} onPress={() => openCamera({ kind: "first" })} />
        <Button testID="slip-not-this" kind="secondary" label={t("mobile.slips.notThis")} onPress={clearDesk} />
      </>
    );
  } else {
    const shot = chosen?.flat ?? null;
    const at = chosen === null ? 0 : pages.findIndex((p) => p.id === chosen.id);
    const shownW = shot === null ? 0 : Math.min(win.width - space.lg * 2, (cropMax * shot.width) / shot.height);
    const full = pages.length >= MAX_PAGES;
    const fixed = sending !== null || chosen === null || chosen.docId !== null;
    body = (
      <>
        <View style={s.strip} testID="slip-readback">
          <Text testID="slip-name" style={s.stripName} numberOfLines={1}>{nameOf(resolved.patient, t)}</Text>
          <Text style={s.ids} numberOfLines={1}>{resolved.visitNo}</Text>
        </View>
        <View style={s.card}>
          {/* The strip: every page of this slip in the order it will be filed, and the "+" for the next. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="slip-pages" contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }}>
            {pages.map((p, i) => (
              <Pressable key={p.id} testID={`slip-page-${String(i + 1)}`} accessibilityRole="button" accessibilityState={{ selected: chosen?.id === p.id }}
                accessibilityLabel={t("mobile.slips.pageN", { n: i + 1, total: pages.length })}
                onPress={() => { setSel(p.id); setRemoving(false); }} style={[s.thumb, chosen?.id === p.id && s.thumbOn, p.check && { borderColor: color.gold }]}>
                {p.flat !== null
                  ? <Image source={{ uri: `data:image/jpeg;base64,${p.flat.base64}` }} style={s.thumbImg} resizeMode="cover" />
                  : <View style={[s.thumbImg, { alignItems: "center", justifyContent: "center" }]}><Text style={s.faint}>…</Text></View>}
                <Text style={s.thumbNo}>{String(i + 1)}</Text>
                {p.docId !== null && <Text testID={`slip-page-filed-${String(i + 1)}`} style={s.thumbFiled}>✓</Text>}
                {p.check && <Text testID={`slip-page-check-${String(i + 1)}`} style={s.thumbCheck} numberOfLines={2}>{t("mobile.slips.checkCorners")}</Text>}
              </Pressable>
            ))}
            <Pressable testID="slip-add" accessibilityRole="button" accessibilityLabel={t("slipCapture.addPage")} disabled={full || sending !== null}
              onPress={() => openCamera({ kind: "burst" })} style={[s.thumb, s.addTile, (full || sending !== null) && { opacity: 0.45 }]}>
              <Text style={s.addPlus}>+</Text>
              <Text style={s.addText} numberOfLines={2}>{t(full ? "mobile.slips.pagesFull" : "slipCapture.addPage", { max: MAX_PAGES })}</Text>
            </Pressable>
          </ScrollView>
          {pages.length > 1 && !anyFiled && chosen !== null && (
            removing ? (
              <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                <Text style={[s.dim, { flex: 1, fontWeight: "700", color: color.ink }]}>{t("mobile.slips.removeAsk", { n: at + 1 })}</Text>
                <Pressable testID="slip-remove-no" accessibilityRole="button" onPress={() => setRemoving(false)} style={s.mini}><Text style={s.miniText}>{t("mobile.slips.removeNo")}</Text></Pressable>
                <Pressable testID="slip-remove-yes" accessibilityRole="button" onPress={removeChosen} style={[s.mini, { borderColor: color.redLine }]}><Text style={[s.miniText, { color: color.red }]}>{t("mobile.slips.removeYes")}</Text></Pressable>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Pressable testID="slip-move-left" accessibilityRole="button" accessibilityLabel={t("mobile.slips.moveEarlier")} disabled={fixed || at === 0} onPress={() => move(-1)} style={[s.mini, (fixed || at === 0) && { opacity: 0.4 }]}><Text style={s.miniText}>◀</Text></Pressable>
                <Pressable testID="slip-move-right" accessibilityRole="button" accessibilityLabel={t("mobile.slips.moveLater")} disabled={fixed || at === pages.length - 1} onPress={() => move(1)} style={[s.mini, (fixed || at === pages.length - 1) && { opacity: 0.4 }]}><Text style={s.miniText}>▶</Text></Pressable>
                <View style={{ flex: 1 }} />
                <Pressable testID="slip-remove" accessibilityRole="button" disabled={fixed} onPress={() => setRemoving(true)} style={[s.mini, fixed && { opacity: 0.4 }]}><Text style={s.miniText}>{t("mobile.slips.remove")}</Text></Pressable>
              </View>
            )
          )}
          {shot !== null ? (
            <>
              <Image testID="slip-preview" source={{ uri: `data:image/jpeg;base64,${shot.base64}` }} accessibilityLabel={t("slipCapture.previewAlt")}
                style={{ width: shownW - space.md * 2, height: ((shownW - space.md * 2) * shot.height) / shot.width, alignSelf: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: color.line }} resizeMode="contain" />
              <Text style={s.asOf} testID="slip-page-info">{pages.length > 1 ? `${t("mobile.slips.pageN", { n: at + 1, total: pages.length })} · ` : ""}{t("mobile.slips.pageInfo", { w: shot.width, h: shot.height, kb: Math.round(base64Bytes(shot.base64) / 1024) })}</Text>
            </>
          ) : (
            <Text style={s.faint} testID="slip-page-working">{t(chosen !== null && chosen.check ? "mobile.slips.pageUnmade" : "mobile.slips.pageWorking")}</Text>
          )}
          {chosen !== null && chosen.check && <Note tone="warn" testID="slip-check-note">{t("mobile.slips.checkNote")}</Note>}
          {chosen !== null && chosen.plainCut && <Note tone="warn" testID="slip-flat-only">{t("mobile.slips.flatOnly")}</Note>}
          <Text style={[s.dim, { fontWeight: "700", color: color.ink }]}>{t("slipCapture.readableQ")}</Text>
          <Text style={s.dim}>{t("slipCapture.readableBody")}</Text>
        </View>
        <View style={s.card}>
          <Tag>{t("slipCapture.kind")}</Tag>
          {SLIP_KINDS.map((k) => (
            <Pressable key={k} testID={`slip-kind-${k}`} accessibilityRole="radio" accessibilityState={{ selected: kind === k }} disabled={anyFiled} onPress={() => setKind(k)} style={[s.opt, kind === k && s.optOn]}>
              <View style={[s.radio, kind === k && { borderColor: color.green }]}>{kind === k && <View style={s.radioIn} />}</View>
              <View style={{ flex: 1 }}>
                <Text style={s.optTitle}>{t(`slipCapture.kinds.${k}`)}</Text>
                <Text style={s.dim}>{t(`slipCapture.kindHints.${k}`)}</Text>
              </View>
            </Pressable>
          ))}
          <Text style={s.dim}>{t("slipCapture.note")} {t("slipCapture.optional")}</Text>
          <TextInput testID="slip-note" accessibilityLabel={t("slipCapture.note")} value={note} onChangeText={setNote}
            placeholder={t("slipCapture.noteHint")} placeholderTextColor={color.faint} style={[s.input, { fontFamily: undefined, fontSize: 16 }]} />
        </View>
      </>
    );
    const many = pages.length > 1;
    const left = pages.filter((p) => p.docId === null).length;
    dock = (
      <>
        {error !== null && <Text accessibilityRole="alert" testID="slip-error" style={s.dockError}>{error}</Text>}
        <Text style={s.dockLead}>{t("slipCapture.dockFile", { name: nameOf(resolved.patient, t) })} · {resolved.visitNo}</Text>
        <Text style={s.dim}>{many ? t("mobile.slips.dockPages", { kind: kindLabel(kind), from: pageNo, to: pageNo + pages.length - 1 }) : t("slipCapture.dockFileSub", { kind: kindLabel(kind), n: pageNo })}</Text>
        {notReady && sending === null && <Text testID="slip-not-ready" style={[s.dim, { color: "#8a5a10", fontWeight: "700" }]}>{t(pages.some((p) => p.check) ? "mobile.slips.checkFirst" : "mobile.slips.pagesWorking")}</Text>}
        {sending !== null && (
          <View testID="slip-progress" accessibilityRole="progressbar" style={s.bar}>
            <View style={[s.barIn, { flex: Math.max(0.04, sending.f) }]} /><View style={{ flex: 1 - Math.max(0.04, sending.f) }} />
          </View>
        )}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}><Button testID="slip-retake" kind="secondary" label={t("slipCapture.retake")} disabled={fixed} onPress={retake} /></View>
          <View style={{ flex: 1.3 }}><Button testID="slip-crop-adjust" kind="secondary" label={t("slipCapture.crop.adjust")} disabled={fixed} onPress={() => { if (chosen !== null) { setEditing(chosen.id); setError(null); setRemoving(false); } }} /></View>
        </View>
        <Button testID="slip-file-it"
          label={sending !== null
            ? (many ? t("mobile.slips.sendingN", { n: sending.n, total: pages.length, pct: Math.round(sending.f * 100) })
              : sending.f > 0 && sending.f < 1 ? t("mobile.slips.sending", { pct: Math.round(sending.f * 100) }) : t("mobile.slips.filing"))
            : error !== null ? t("mobile.slips.retry")
              : many ? t(anyFiled ? "mobile.slips.fileRest" : "mobile.slips.fileN", { count: left }) : t("slipCapture.fileIt")}
          disabled={sending !== null || notReady} onPress={() => { void file(); }} />
      </>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }} testID="slip-desk">
      <Band
        right={
          <Pressable testID="slip-back" accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <View style={s.head}>
        <View style={s.dotMark} />
        <Text style={s.title}>{t("slipCapture.title")}</Text>
        <View style={{ flex: 1 }} />
        <Pressable testID="slip-list-toggle" accessibilityRole="button" onPress={() => setListOpen(true)} style={[s.listBtn, counts !== null && counts.waiting > 0 && { borderColor: color.gold, borderWidth: 2 }]}>
          <Text style={[s.listBtnText, counts !== null && counts.waiting > 0 && { color: "#8a5a10" }]}>
            {counts === null ? t("mobile.slips.list") : `${t("slipCapture.statusShort", { count: counts.waiting })} · ${t("mobile.slips.list")}`}
          </Text>
        </Pressable>
      </View>
      {stepper}
      {scanSaid !== null && <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}><ScannedBanner text={scanSaid} onDismiss={() => setScanSaid(null)} /></View>}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "web" ? undefined : "padding"}>
        {step === 3 ? (
          /* The crop is not scrolled: a finger on a corner must move the corner, never the page. */
          <View style={{ flex: 1, padding: space.lg, gap: space.sm }}>{body}</View>
        ) : (
          <ScrollView ref={scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}>
            {body}
          </ScrollView>
        )}
        {dock !== null && <View testID="slip-dock" style={[s.dock, { paddingBottom: Math.max(insets.bottom, space.md) }]}>{dock}</View>}
      </KeyboardAvoidingView>

      <Modal visible={listOpen} transparent animationType="slide" onRequestClose={() => setListOpen(false)}>
        <Pressable style={s.scrim} testID="slip-list-scrim" onPress={() => setListOpen(false)}>
          <Pressable style={s.sheet} testID="slip-list" onPress={() => undefined}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Tag>{t("slipCapture.listTitle", { count: items.length })}</Tag>
                {counts !== null && <Text style={s.dim}>{t("slipCapture.dayWaiting")} {String(counts.waiting)} · {t("slipCapture.dayRetakes")} {String(counts.retake)} · {t("slipCapture.dayFiled")} {String(counts.filed)}</Text>}
              </View>
              <Pressable testID="slip-list-close" accessibilityRole="button" onPress={() => setListOpen(false)} style={s.closeBtn}><Text style={s.closeText}>{t("mobile.slips.close")}</Text></Pressable>
            </View>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingVertical: space.md, gap: space.sm }}>
              {items.length === 0 && <Text style={s.faint}>{t(dayFailed ? "slipCapture.listUnavailable" : "slipCapture.listEmpty")}</Text>}
              {items.map((r) => row(r, r.state === "filed" ? null : () => { void resolve(r.visitNo); }))}
            </ScrollView>
            {counts !== null && <Text style={s.faint}>{t("slipCapture.listFoot", { count: counts.filed })}</Text>}
          </Pressable>
        </Pressable>
      </Modal>
      <Scanner open={scanOpen} onClose={() => setScanOpen(false)} onRead={(data) => { setScanOpen(false); setText(/^(q1|rx1)\./.test(data) ? "" : data); void resolve(data); }} />
      <HeldCard source={held1 === null ? null : { encounterId: held1.encounterId }} onClose={() => setHeld1(null)}
        onLocal={(action, visit) => { if (action !== "slip") return false; void resolve(visit.visitNo); return true; }} />
      <SlipCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onShot={(p) => { void onShot(p); }}
        burst={camMode.kind === "burst" ? { taken: pages.length, max: MAX_PAGES } : null} />
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line },
  dotMark: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.green },
  title: { fontFamily: MONO, fontSize: 14, fontWeight: "700", letterSpacing: 1, color: color.ink },
  listBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  listBtnText: { fontSize: 14.5, fontWeight: "700", color: color.green },
  stepper: { flexDirection: "row", gap: 6, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line },
  step: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 34, borderRadius: 17, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  stepNow: { backgroundColor: color.green, borderColor: color.green },
  stepDone: { borderColor: color.greenLine, backgroundColor: color.greenSoft },
  stepNo: { fontFamily: MONO, fontSize: 12.5, fontWeight: "800", color: color.dim },
  stepLabel: { fontSize: 12.5, fontWeight: "700", color: color.dim },
  strip: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
  stripName: { flex: 1, fontSize: 17, fontWeight: "800", color: color.ink },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  input: { minHeight: 52, paddingHorizontal: 14, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, fontFamily: MONO, fontSize: 18, color: color.ink },
  name: { fontSize: 22, fontWeight: "800", color: color.ink },
  ids: { fontFamily: MONO, fontSize: 13, color: color.dim },
  dim: { fontSize: 13.5, lineHeight: 19, color: color.dim },
  faint: { fontSize: 13, lineHeight: 18, color: color.faint },
  asOf: { fontFamily: MONO, fontSize: 11.5, color: color.faint },
  okNote: { borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft, borderRadius: radius.md, padding: 10 },
  okText: { fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.green },
  warnNote: { borderWidth: 1, borderColor: color.goldLine, backgroundColor: color.goldSoft, borderRadius: radius.md, padding: 10, gap: 2 },
  warnText: { fontSize: 14, lineHeight: 19, fontWeight: "700", color: "#8a5a10" },
  paper: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: "#8a5a10", marginTop: 6 },
  filedTitle: { fontSize: 17, lineHeight: 23, fontWeight: "800", color: color.green },
  row: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg },
  rowName: { fontSize: 16, fontWeight: "700", color: color.ink },
  rowIds: { fontFamily: MONO, fontSize: 12, color: color.faint },
  rowPill: { fontFamily: MONO, fontSize: 12, fontWeight: "700", color: color.dim, borderWidth: 1, borderColor: color.line, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, overflow: "hidden" },
  opt: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 8, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: color.line, borderRadius: radius.md },
  optOn: { borderColor: color.green, borderWidth: 2, backgroundColor: color.greenSoft },
  optTitle: { fontSize: 15, fontWeight: "700", color: color.ink },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.faint, alignItems: "center", justifyContent: "center" },
  radioIn: { width: 11, height: 11, borderRadius: 6, backgroundColor: color.green },
  dock: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
  dockLead: { fontSize: 15.5, fontWeight: "800", color: color.ink },
  dockError: { fontSize: 13.5, lineHeight: 18, fontWeight: "700", color: color.red },
  bar: { flexDirection: "row", height: 8, borderRadius: 4, backgroundColor: color.wash, overflow: "hidden" },
  barIn: { height: 8, borderRadius: 4, backgroundColor: color.green },
  thumb: { width: 76, height: 104, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.wash, overflow: "hidden" },
  thumbOn: { borderWidth: 3, borderColor: color.green },
  thumbImg: { width: "100%", height: "100%" },
  thumbNo: { position: "absolute", left: 4, top: 4, minWidth: 20, textAlign: "center", fontFamily: MONO, fontSize: 12, fontWeight: "800", color: "#fff", backgroundColor: "rgba(19,36,32,.72)", borderRadius: 10, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
  thumbFiled: { position: "absolute", right: 4, top: 4, width: 20, textAlign: "center", fontSize: 12, fontWeight: "800", color: "#fff", backgroundColor: color.green, borderRadius: 10, paddingVertical: 1, overflow: "hidden" },
  thumbCheck: { position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10.5, lineHeight: 13, fontWeight: "800", textAlign: "center", color: "#3d2a05", backgroundColor: "#ffd866", paddingVertical: 2, paddingHorizontal: 2 },
  addTile: { alignItems: "center", justifyContent: "center", gap: 2, borderStyle: "dashed", borderWidth: 2, borderColor: color.greenLine, backgroundColor: color.greenSoft, paddingHorizontal: 4 },
  addPlus: { fontSize: 34, lineHeight: 38, fontWeight: "700", color: color.green },
  addText: { fontSize: 11.5, lineHeight: 14, fontWeight: "700", textAlign: "center", color: color.green },
  mini: { minHeight: 44, minWidth: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  miniText: { fontSize: 14, fontWeight: "700", color: color.dim },
  closeBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  closeText: { fontSize: 13.5, fontWeight: "700", color: color.dim },
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(19, 36, 32, .35)" },
  sheet: { maxHeight: "82%", backgroundColor: color.paper, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: space.lg, paddingBottom: space.xl },
});
