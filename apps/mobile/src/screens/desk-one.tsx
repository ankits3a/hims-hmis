import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { counterApi, newIntentKey } from "../counter/api";
import { BookAppointment, DeskAppointments, PatientAppointments, dayWord, whoOf } from "../counter/appointments";
import { slotClock } from "../counter/appointment-rules";
import type {
  CounterApi, TenderMode, WireAppointment, WireCashSession, WireCheckIn, WireDepartment, WireMasterDoctor, WireDoctorSummary, WireFeeQuote, WireIssueBody, WireIssued, WireLinked, WireMoveResult,
  WirePatientHit, WirePrintJob,
} from "../counter/api";
import { MoveDepartment, Pill } from "../counter/move";
import {
  EMPTY_SHORT_REGISTRATION, GUARDIAN_RELATIONSHIPS, SAMAJ_SEVA_AMOUNT, ageOf, billOf, bookableToday, deptQueues, firstFreeDoctor, invoiceLinesOf, laneOf,
  moveFee, openVisitsToday, paperState, rs, sexLetter, shortFormGaps, shortRegisterBody, shouldJoinNow, tokenLabel, tokenStateOf, waitMinutes,
} from "../counter/rules";
import type { CounterTimelineItem, DeptQueue, Lane, MoveConsultTerms, MoveVisitType, OpenVisit, ShortRegistration } from "../counter/rules";
import { VisitCard } from "../counter/visit-card";
import { besideName } from "../doctor/rules";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note, Tag, keyboardScrollInsets } from "../ui";
import { refusalText } from "../vitals/api";
import { todayIst } from "../vitals/rules";
import { Scanner } from "../vitals/scanner";
import { HeldCard, ScannedBanner, type Scanned } from "../scan/card";
import { ToCollectList } from "../counter/to-collect";
import { mayReadToCollect } from "../../../../packages/contracts/src/to-collect";
import type { WireToCollectRow } from "../../../../packages/contracts/src/to-collect";
import { SEAT_OF } from "../scan/model";

/**
 * DESK ONE, ON A PHONE (plan M4; owner 2026-10-06). The counter's essentials — find or register
 * the person, seat them with a doctor, take the fee — on the web desk's own server routes and
 * under its guards. One thing is asked per screen, and nothing is decided here:
 *
 *   find       `GET /patients/search` (name, mobile, UHID) or a scanned patient card, verified by
 *              the server; a shared mobile's other patients are offered ("shares a contact number")
 *   register   the short form (shared `shortRegisterBody`); the server's duplicate warning is a
 *              list to judge, never a silent second record
 *   seat       department → doctor off today's board, with the unit beside the name; the server
 *              opens the visit, classifies it (new / revisit / renewal) and gives the token
 *   bill       the server's own quote, line by line; a free visit says "₹0 (समाज सेवा छूट)";
 *              cash / UPI / card only with a cash session open and the billing permission
 *   book       a future appointment, a booked patient's check-in (the booking BECOMES the visit and
 *              the desk goes on to the bill), a move, a cancel — `../counter/appointments.tsx`
 *   paper      the slips are queued by the SERVER for the counter's printer inside the visit's own
 *              transaction; the phone shows whether they came out and can ask again
 *
 * MONEY AND A VISIT ARE NEVER QUEUED OFFLINE. Each of the two writes carries one `Idempotency-Key`
 * per intent; when an answer is lost the screen says what is NOT known, keeps what was typed, and
 * the retry re-reads the server first and then re-sends the SAME key — answered, never repeated.
 * The cashier's collected total is never shown here (blind count).
 */
export const BOARD_POLL_MS = 20_000;
/** The web's `DELAY_HIGHLIGHT_MINUTES` (`lib/walk-in-routing.ts`); `counter-rules.test.ts` pins the two together. */
export const DELAY_HIGHLIGHT_MINUTES = 20;
const PAPER_READS_MS = [600, 3_000, 8_000, 15_000] as const;

type T = ReturnType<typeof useI18n>["t"];
type Stage = "find" | "register" | "person" | "seat" | "bill" | "done";
type Person = { id: string; uhid: string; name: string; phone: string | null; gender: string; dob: string | null; sealed: boolean; justRegistered: boolean };
type Visit = {
  encounterId: string; patientId: string; visitNo: string; departmentId: string; departmentName: string; departmentCode: string | null;
  doctorName: string; roomCode: string | null; ahead: number; waitMin: number; tokenNo: number | null; visitType: MoveVisitType | null;
  joining: boolean; joinError: string | null;
};
type SeatIntent = { key: string; body: { patient: { existingId: string }; departmentId: string; doctorId: string; join: "queue" | "defer"; deskComplaint?: string } };
type SettleIntent = { key: string; body: WireIssueBody; mode: TenderMode };

const buzz = (kind: "ok" | "warn"): void => {
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};
const said = (e: unknown, t: T): string => (e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
const dmy = (iso: string): string => iso.slice(0, 10).split("-").reverse().join("-");

function holds(p: { hospital: string[]; scoped: { department: Record<string, string[]>; floor: Record<string, string[]> } }, permission: string): boolean {
  return p.hospital.includes(permission)
    || Object.values(p.scoped.department).some((l) => l.includes(permission))
    || Object.values(p.scoped.floor).some((l) => l.includes(permission));
}

function personLine(p: { gender: string; dob: string | null }): string {
  const age = ageOf(p.dob);
  return [age === "" ? null : (/m$/.test(age) ? age : `${age}y`), sexLetter(p.gender)].filter((x) => x !== null).join(" · ");
}

export function DeskOne({ scanned = null }: { scanned?: Scanned | null } = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { call, state } = useSession();
  const api: CounterApi = useMemo(() => counterApi(call), [call]);
  const perms = state.status === "signedIn" ? state.me.permissions : null;
  const can = useCallback((permission: string): boolean => perms !== null && holds(perms, permission), [perms]);
  const heldHere = useMemo((): readonly string[] => perms?.hospital ?? [], [perms]);
  const today = todayIst();

  const [stage, setStage] = useState<Stage>("find");
  /** The patient row being held: its action card is up. No swipe on this screen — its rows lead to money. */
  const [held1, setHeld1] = useState<string | null>(null);
  const [scanSaid, setScanSaid] = useState<string | null>(scanned?.banner ?? null);
  /** What a scan asked this desk to open, until it has been opened: the person first, then (once their visits are read) the visit. */
  const [want, setWant] = useState<Scanned | null>(scanned);
  const arriving = useRef<"person" | "visit" | "done">(scanned === null ? "done" : "person");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // ——— find ———
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WirePatientHit[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const searchSeq = useRef(0);

  // ——— the person in hand ———
  const [person, setPerson] = useState<Person | null>(null);
  const [linked, setLinked] = useState<WireLinked | null>(null);
  const [timeline, setTimeline] = useState<CounterTimelineItem[] | null>(null);
  const [card, setCard] = useState<CounterTimelineItem | null>(null);

  // ——— register ———
  const [form, setForm] = useState<ShortRegistration>(EMPTY_SHORT_REGISTRATION);
  const [duplicates, setDuplicates] = useState<WirePatientHit[] | null>(null);
  const [tried, setTried] = useState(false);

  // ——— the board ———
  const [lane, setLane] = useState<Lane>("F1");
  const [departments, setDepartments] = useState<WireDepartment[]>([]);
  const [summaries, setSummaries] = useState<WireDoctorSummary[] | null>(null);
  const [boardStale, setBoardStale] = useState(false);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState<MoveConsultTerms | undefined>(undefined);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ doctorId: string; doctorName: string; seenOn: string; windowEndsOn: string; wouldBe: MoveVisitType } | null>(null);
  const [complaint, setComplaint] = useState("");
  const seatIntent = useRef<SeatIntent | null>(null);
  const [seatUnknown, setSeatUnknown] = useState(false);

  // ——— the visit, its money and its paper ———
  const [visit, setVisit] = useState<Visit | null>(null);
  const [quote, setQuote] = useState<WireFeeQuote | null>(null);
  const [quoteState, setQuoteState] = useState<"none" | "reading" | "read" | "denied" | "failed">("none");
  const [cash, setCash] = useState<WireCashSession | null | undefined>(undefined);
  const [floatText, setFloatText] = useState("");
  const [mode, setMode] = useState<TenderMode>("cash");
  const [ref, setRef] = useState("");
  const [issued, setIssued] = useState<{ invoiceNo: string; receiptNo: string | null; paise: number; mode: TenderMode | null } | null>(null);
  const settleIntent = useRef<SettleIntent | null>(null);
  const [settleUnknown, setSettleUnknown] = useState(false);
  const [jobs, setJobs] = useState<WirePrintJob[] | null>(null);
  const [moving, setMoving] = useState(false);

  // ——— appointments (owner 2026-10-07): the patient's own bookings, the booking flow, the desk's lists ———
  const [masterDoctors, setMasterDoctors] = useState<WireMasterDoctor[]>([]);
  const [apptVersion, setApptVersion] = useState(0);
  const [booking, setBooking] = useState<{ moving: WireAppointment | null; preset?: { doctorId?: string; date?: string } } | null>(null);
  const [deskList, setDeskList] = useState(false);
  /** Owner 2026-10-09 — "To collect": the count on the desk home (null: not this login's to read, or not read yet), and the list. */
  const [toCollectN, setToCollectN] = useState<number | null>(null);
  const [collectList, setCollectList] = useState(false);

  const mayRegister = can("patients.register");
  const mayOpen = can("opd.visits.open");
  const mayQuote = can("billing.invoice.read");
  const mayCollect = can("billing.invoice.issue");
  const maySession = can("billing.session.own");
  const mayPaper = can("opd.paper.reprint");
  const mayApptRead = can("opd.appointments.read");
  const mayApptManage = mayApptRead && can("opd.appointments.manage");

  // ——— boot: the lane, the departments, the label beside each doctor, the price list. All optional reads. ———
  useEffect(() => {
    api.config().then((c) => setLane(laneOf(c)), () => undefined);
    api.departments().then((d) => setDepartments(d.items.filter((x) => x.active)), () => undefined);
    api.consultTerms().then(setTerms, () => undefined);
    // The doctor master names a booking's doctor on any day — today's board only knows who sits today.
    if (can("opd.appointments.read")) api.doctors().then((r) => setMasterDoctors(r.items), () => undefined);
    if (can("roster.read")) {
      api.doctorUnits(today).then((u) => setUnits(Object.fromEntries(u.map((x) => [x.userId, x.short]))), () => undefined);
    }
  }, [api, can, today]);

  const readBoard = useCallback(async (): Promise<void> => {
    try {
      const r = await api.summary(today);
      setSummaries(r.items); setBoardStale(false);
    } catch {
      setBoardStale(true);
    }
  }, [api, today]);
  // The board goes stale on its own (another counter seats somebody); it is re-read while a seat is being chosen.
  useEffect(() => {
    if (stage !== "seat" && !moving && card === null) return;
    void readBoard();
    const id = setInterval(() => { if (AppState.currentState !== "background") void readBoard(); }, BOARD_POLL_MS);
    return () => clearInterval(id);
  }, [stage, moving, card, readBoard]);

  const queues: DeptQueue<WireDoctorSummary>[] = useMemo(() => deptQueues(summaries ?? [], departments), [summaries, departments]);
  const labelOf = useCallback(
    (d: { userId: string; designation?: string | null }): string | null => besideName({ unit: units[d.userId] ?? null, designation: d.designation ?? null }),
    [units],
  );
  const codeOf = useCallback((departmentId: string | null): string | null => departments.find((d) => d.id === departmentId)?.code ?? null, [departments]);

  // ——— find ———
  const search = useCallback(async (text: string): Promise<void> => {
    const q = text.trim();
    if (q.length < 2) { setHits(null); return; }
    const seq = ++searchSeq.current;
    setBusy("search"); setError(null);
    try {
      const items = await api.search(q);
      if (seq === searchSeq.current) setHits(items);
    } catch (e) {
      if (seq === searchSeq.current) setError(said(e, t));
    } finally {
      if (seq === searchSeq.current) setBusy(null);
    }
  }, [api, t]);
  useEffect(() => {
    if (stage !== "find" || query.trim().length < 3) return;
    const id = setTimeout(() => { void search(query); }, 450);
    return () => clearTimeout(id);
  }, [query, stage, search]);

  const readPerson = useCallback((id: string) => {
    setLinked(null); setTimeline(null);
    api.linked(id).then((l) => setLinked(l), () => undefined);
    api.timeline(id).then((r) => setTimeline(r.items), () => setTimeline([]));
    api.patient(id).then((d) => setPerson((p) => (p?.id !== id ? p : {
      ...p, phone: d.patient.phone ?? p.phone, dob: d.patient.dob ?? p.dob,
      // A row picked off the day's book carries no sex: the patient's own record supplies it.
      gender: p.gender === "" ? d.patient.administrativeGender : p.gender,
    })), () => undefined);
  }, [api]);

  const hold = useCallback((p: Person) => {
    setPerson(p); setStage("person"); setError(null); setFlash(null); setHits(null); setQuery(""); setDuplicates(null);
    setVisit(null); setQuote(null); setQuoteState("none"); setIssued(null); setJobs(null);
    seatIntent.current = null; settleIntent.current = null; setSeatUnknown(false); setSettleUnknown(false);
    setDeptId(null); setDoctorId(null); setAnchor(null); setComplaint("");
    readPerson(p.id);
  }, [readPerson]);
  const holdHit = (h: { id: string; uhid: string; name: string; phone: string | null; administrativeGender: string; dob: string | null; isConfidential?: boolean }): void => {
    hold({ id: h.id, uhid: h.uhid, name: h.name, phone: h.phone, gender: h.administrativeGender, dob: h.dob, sealed: h.isConfidential === true, justRegistered: false });
  };

  const onScan = (data: string): void => {
    setScanning(false);
    if (!data.startsWith("q1.")) { setQuery(data); void search(data); return; }
    void (async () => {
      setBusy("search"); setError(null);
      try {
        // A card is trusted only after the server has checked its signature.
        const r = await api.verifyCard(data);
        if (r.ok) holdHit({ ...r.patient, phone: null });
        else setError(t("mobile.counter.cardRefused"));
      } catch (e) {
        setError(said(e, t));
      } finally {
        setBusy(null);
      }
    })();
  };

  const clearDesk = useCallback(() => {
    setStage("find"); setPerson(null); setLinked(null); setTimeline(null); setCard(null); setError(null); setFlash(null);
    setQuery(""); setHits(null); setForm(EMPTY_SHORT_REGISTRATION); setDuplicates(null); setTried(false);
    setVisit(null); setQuote(null); setQuoteState("none"); setIssued(null); setJobs(null); setMode("cash"); setRef("");
    seatIntent.current = null; settleIntent.current = null; setSeatUnknown(false); setSettleUnknown(false);
    setDeptId(null); setDoctorId(null); setAnchor(null); setComplaint("");
  }, []);

  // ——— register ———
  const startRegister = (): void => {
    const q = query.trim();
    const digits = q.replace(/\s/g, "");
    setForm({ ...EMPTY_SHORT_REGISTRATION, name: /^\d+$/.test(digits) ? "" : q.replace(/\d/g, "").trim(), phone: /^\d{6,}$/.test(digits) ? digits : "" });
    setDuplicates(null); setTried(false); setError(null); setStage("register");
  };
  const gaps = shortFormGaps(form);
  const register = async (acknowledge: boolean): Promise<void> => {
    setTried(true);
    if (gaps.length > 0) return;
    setBusy("register"); setError(null);
    try {
      const res = await api.register(shortRegisterBody(form, { acknowledgeDuplicates: acknowledge }));
      buzz("ok");
      // READ BACK, never rebuilt from the form: the server derived the date of birth and allocated the UHID.
      hold({ id: res.patient.id, uhid: res.patient.uhid, name: res.patient.name, phone: res.patient.phone, gender: form.sex, dob: res.patient.dob, sealed: false, justRegistered: true });
      setForm(EMPTY_SHORT_REGISTRATION); setTried(false);
    } catch (e) {
      buzz("warn");
      const body = e instanceof ApiError ? (e.body as { code?: string; detail?: { candidates?: unknown } } | null) : null;
      if (body?.code === "duplicate_suspected" && Array.isArray(body.detail?.candidates)) {
        // The server's near-matches: a list for the clerk to judge. Registering anyway is an explicit second tap.
        setDuplicates(body.detail.candidates as WirePatientHit[]);
      } else {
        setError(e instanceof NetworkError ? t("mobile.counter.registerNetwork") : said(e, t));
      }
    } finally {
      setBusy(null);
    }
  };

  // ——— seat ———
  const openVisits: OpenVisit[] = useMemo(() => openVisitsToday(timeline ?? [], today), [timeline, today]);
  const dq = queues.find((q) => q.departmentId === deptId) ?? null;
  const chosen = dq?.doctors.find((d) => d.doctor.id === doctorId) ?? null;

  const pickDept = (q: DeptQueue<WireDoctorSummary>): void => {
    if (seatUnknown) return;
    setDeptId(q.departmentId); setAnchor(null); setError(null);
    const first = firstFreeDoctor(q);
    setDoctorId(first?.doctor.id ?? null);
    if (person === null) return;
    /*
      Continuity first (the web's rule 1): the doctor who knows the patient, when on today's board —
      unless their line is past the 20-minute mark (owner 2026-09-03: highlight the delay, suggest the
      shorter line). Then the shortest line stays picked and the note says so; the clerk decides.
    */
    api.continuity(person.id, q.departmentId).then((r) => {
      if (r.anchor === null) return;
      setAnchor(r.anchor);
      const theirs = q.doctors.find((d) => d.doctor.id === r.anchor!.doctorId);
      if (theirs !== undefined && bookableToday(theirs) && waitMinutes(theirs) <= DELAY_HIGHLIGHT_MINUTES) setDoctorId(theirs.doctor.id);
    }, () => undefined);
  };

  const visitFrom = (res: { encounter: { id: string; visitNo: string }; tokenNo: number | null; patientId: string; visitType: MoveVisitType }, q: DeptQueue<WireDoctorSummary>, d: WireDoctorSummary): Visit => ({
    encounterId: res.encounter.id, patientId: res.patientId, visitNo: res.encounter.visitNo,
    departmentId: q.departmentId, departmentName: q.departmentName, departmentCode: codeOf(q.departmentId),
    doctorName: d.doctor.displayName, roomCode: d.roomCode, ahead: d.waitingCount, waitMin: waitMinutes(d),
    tokenNo: res.tokenNo, visitType: res.visitType, joining: false, joinError: null,
  });

  const seat = async (): Promise<void> => {
    if (person === null || dq === null || chosen === null) return;
    // ONE key per intent: a retry after a lost answer re-sends the same key and the same body.
    const intent: SeatIntent = seatIntent.current ?? {
      key: newIntentKey(),
      body: {
        patient: { existingId: person.id }, departmentId: dq.departmentId, doctorId: chosen.doctor.id,
        join: lane === "F3" ? "defer" : "queue",
        ...(complaint.trim() === "" ? {} : { deskComplaint: complaint.trim() }),
      },
    };
    seatIntent.current = intent;
    setBusy("seat"); setError(null);
    try {
      const res = await api.walkIn(intent.body, intent.key);
      buzz("ok");
      seatIntent.current = null; setSeatUnknown(false);
      setVisit(visitFrom(res, dq, chosen));
      setStage("bill");
      void readBoard();
      api.timeline(person.id).then((r) => setTimeline(r.items), () => undefined);
    } catch (e) {
      buzz("warn");
      if (e instanceof NetworkError) {
        // The request may or may not have arrived. Say exactly that, keep the choice, keep the key.
        setSeatUnknown(true);
        setError(t("mobile.counter.seatUnknown"));
      } else {
        seatIntent.current = null; setSeatUnknown(false);
        setError(said(e, t));
      }
    } finally {
      setBusy(null);
    }
  };

  // ——— appointments ———
  const doctorNameOf = useCallback((id: string): string | null => masterDoctors.find((d) => d.id === id)?.displayName ?? null, [masterDoctors]);
  const deptNameOf = useCallback((id: string): string | null => departments.find((d) => d.id === id)?.name ?? null, [departments]);
  const holdBooked = (a: WireAppointment): void => {
    hold({ id: a.patientId, uhid: a.patient?.uhid ?? "", name: whoOf(a, t), phone: a.patient?.phone ?? null, gender: "", dob: null, sealed: false, justRegistered: false });
  };
  /** A booked patient has arrived: the booking IS the visit now, and the desk goes on to its bill. */
  const onCheckedIn = (res: WireCheckIn, a: WireAppointment): void => {
    const summary = (summaries ?? []).find((x) => x.doctor.id === a.doctorId) ?? null;
    setVisit({
      encounterId: res.encounter.id, patientId: res.encounter.patientId, visitNo: res.encounter.visitNo,
      departmentId: a.departmentId, departmentName: deptNameOf(a.departmentId) ?? "—", departmentCode: codeOf(a.departmentId),
      doctorName: doctorNameOf(a.doctorId) ?? "—", roomCode: summary?.roomCode ?? null, ahead: summary?.waitingCount ?? 0, waitMin: summary === null ? 0 : waitMinutes(summary),
      tokenNo: res.tokenNo, visitType: res.visitType, joining: false, joinError: null,
    });
    setQuote(null); setQuoteState("none"); setIssued(null); setJobs(null); settleIntent.current = null; setSettleUnknown(false);
    setError(null); setFlash(t("mobile.counter.appt.checkedIn")); setStage("bill");
    setApptVersion((n) => n + 1);
    api.timeline(res.encounter.patientId).then((r) => setTimeline(r.items), () => undefined);
  };
  /** The check-in's answer was lost but it HAD landed: open the visit the server already made. Nothing is re-sent. */
  const onAlreadyCheckedIn = (encounterId: string, a: WireAppointment): void => {
    api.timeline(a.patientId).then((r) => {
      setTimeline(r.items);
      const v = openVisitsToday(r.items, today).find((x) => x.encounterId === encounterId);
      if (v !== undefined) { adopt(v); setFlash(t("mobile.counter.appt.checkedIn")); }
      setApptVersion((n) => n + 1);
    }, () => setApptVersion((n) => n + 1));
  };
  const onBooked = (a: WireAppointment, kind: "booked" | "moved"): void => {
    setBooking(null);
    setApptVersion((n) => n + 1);
    setFlash(t(kind === "booked" ? "mobile.counter.appt.bookedFlash" : "mobile.counter.appt.movedFlash", { when: `${dayWord(a.serviceDate, t)} ${slotClock(a.slotStart)}` }));
  };

  const adopt = (v: OpenVisit): void => {
    const summary = (summaries ?? []).find((x) => x.doctor.id === v.doctorId) ?? null;
    setVisit({
      encounterId: v.encounterId, patientId: person?.id ?? "", visitNo: v.visitNo,
      departmentId: v.departmentId ?? "", departmentName: v.departmentName ?? "—", departmentCode: codeOf(v.departmentId),
      doctorName: v.doctorName ?? "—", roomCode: summary?.roomCode ?? null, ahead: summary?.waitingCount ?? 0, waitMin: summary === null ? 0 : waitMinutes(summary),
      tokenNo: null, visitType: (["new", "revisit", "renewal"] as const).find((x) => x === v.visitType) ?? null, joining: false, joinError: null,
    });
    setQuote(null); setQuoteState("none"); setIssued(null); setJobs(null); settleIntent.current = null; setSettleUnknown(false);
    setError(null); setFlash(null); setStage("bill");
  };

  // ——— "To collect" (owner 2026-10-09): the count is read when the desk home shows; a doctor-only login never asks ———
  const readToCollect = useCallback(() => {
    if (!mayReadToCollect(heldHere)) return;
    api.toCollect().then((r) => setToCollectN(r.items.length), () => setToCollectN(null));
  }, [api, heldHere]);
  useEffect(() => { if (stage === "find") readToCollect(); }, [stage, readToCollect]);
  /**
   * Collect, from the list: the person and the visit are put in hand from the row itself and the
   * bill stage opens — the same stage, quote and settle a visit opened at this desk uses. Nothing
   * is written by arriving. The visit may be finished or days old, so it is not looked for among
   * today's open visits.
   */
  const collectFor = (row: WireToCollectRow): void => {
    arriving.current = "done";
    hold({ id: row.patientId, uhid: row.uhid, name: row.patientName, phone: null, gender: "unknown", dob: null, sealed: row.isConfidential, justRegistered: false });
    setVisit({
      encounterId: row.encounterId, patientId: row.patientId, visitNo: row.visitNo, departmentId: "", departmentName: "—", departmentCode: null,
      doctorName: row.doctorName ?? "—", roomCode: null, ahead: 0, waitMin: 0, tokenNo: row.tokenNo, visitType: null, joining: false, joinError: null,
    });
    setStage("bill");
  };

  // ——— arrived from a scan (owner 2026-10-08): the person is held, then the visit the code named is opened. Nothing is written by arriving. ———
  useEffect(() => {
    if (want === null || arriving.current !== "person") return;
    arriving.current = "visit";
    api.patient(want.patientId).then((d) => {
      hold({ id: want.patientId, uhid: d.patient.uhid, name: d.patient.name ?? d.patient.alias ?? d.patient.uhid, phone: d.patient.phone, gender: d.patient.administrativeGender, dob: d.patient.dob, sealed: d.patient.name === null, justRegistered: false });
    }, (e: unknown) => { arriving.current = "done"; setError(said(e, t)); });
  }, [want, api, hold, t]);
  useEffect(() => {
    if (want === null || arriving.current !== "visit" || person?.id !== want.patientId || timeline === null) return;
    arriving.current = "done";
    if (want.act === "book") { setBooking({ moving: null }); return; }
    if (want.act === "newVisit") { if (can("opd.visits.open")) setStage("seat"); return; }
    const v = openVisits.find((x) => x.encounterId === want.encounterId);
    if (v === undefined) return; // the visit has ended since: the person's own page says what is open
    adopt(v);
    if (want.act === "move") setMoving(true);
  }, [want, person, timeline, openVisits]);

  // ——— bill: the server's quote, the cash session, the paper ———
  const encounterId = visit?.encounterId ?? null;
  const readQuote = useCallback(async (): Promise<WireFeeQuote | null> => {
    if (encounterId === null) return null;
    if (!mayQuote) { setQuoteState("denied"); return null; }
    setQuoteState((s) => (s === "read" ? s : "reading"));
    try {
      const q = await api.feeQuote(encounterId);
      setQuote(q); setQuoteState("read");
      // The token and the department code are the board's own projection — the number on the patient's slip.
      const v = q.visit;
      if (v != null) setVisit((cur) => (cur?.encounterId !== encounterId ? cur : { ...cur, tokenNo: cur.tokenNo ?? v.tokenNo, departmentCode: v.departmentCode ?? cur.departmentCode }));
      return q;
    } catch (e) {
      setQuoteState(e instanceof ApiError && e.status === 403 ? "denied" : "failed");
      return null;
    }
  }, [api, encounterId, mayQuote]);
  useEffect(() => { if (encounterId !== null) void readQuote(); }, [encounterId, readQuote]);
  useEffect(() => {
    if (stage !== "bill" || !maySession || !mayCollect) return;
    api.cashSession().then((r) => setCash(r.session), () => setCash(undefined));
  }, [api, stage, maySession, mayCollect]);

  const readPaper = useCallback(() => {
    if (encounterId === null || !mayPaper) return;
    api.printJobs(encounterId).then((r) => setJobs(r.jobs), () => undefined);
  }, [api, encounterId, mayPaper]);
  useEffect(() => {
    if (encounterId === null || !mayPaper || (stage !== "bill" && stage !== "done")) return;
    const ids = PAPER_READS_MS.map((ms) => setTimeout(readPaper, ms));
    return () => ids.forEach(clearTimeout);
  }, [encounterId, mayPaper, stage, readPaper, issued, visit?.tokenNo]);

  const bill = billOf(quoteState === "read" ? quote : null);
  const alreadyBilled = quote?.alreadyBilled ?? null;
  const moneyTaken = issued !== null || (quoteState === "read" && quote !== null && (bill.free || alreadyBilled !== null));
  const token = tokenStateOf(lane, visit, moneyTaken);

  // Bill-first lane (F3): the position is allocated only once the money is in — RC-4's rule, fired here and nowhere else.
  useEffect(() => {
    if (!shouldJoinNow(lane, visit, moneyTaken) || visit === null) return;
    const target = visit.encounterId;
    setVisit((cur) => (cur === null ? cur : { ...cur, joining: true }));
    api.joinQueue(target).then(
      (r) => setVisit((cur) => (cur?.encounterId !== target ? cur : { ...cur, joining: false, tokenNo: r.tokenNo, joinError: null })),
      (e: unknown) => setVisit((cur) => (cur?.encounterId !== target ? cur : { ...cur, joining: false, joinError: said(e, t) })),
    );
  }, [api, lane, visit, moneyTaken, t]);

  const openCash = async (): Promise<void> => {
    const rupees = Number(floatText.trim() === "" ? "0" : floatText.trim());
    if (!Number.isFinite(rupees) || rupees < 0) { setError(t("mobile.counter.cash.floatBad")); return; }
    setBusy("cash"); setError(null);
    try {
      setCash(await api.openCashSession(Math.round(rupees * 100)));
      buzz("ok");
    } catch (e) {
      buzz("warn"); setError(said(e, t));
    } finally {
      setBusy(null);
    }
  };

  const settle = async (): Promise<void> => {
    if (visit === null || quote === null || quote.draft === null || issued !== null) return;
    if (settleIntent.current === null && mode !== "cash" && ref.trim() === "") { setError(t("registrationCounter.move.money.refRequired")); return; }
    setBusy("settle"); setError(null);
    try {
      /*
        A LOST ANSWER IS RE-READ BEFORE ANYTHING IS RE-SENT. If the first request did reach the
        server the quote now says so (`alreadyBilled`, FD-27's own duplicate guard) and nothing is
        sent at all; if it did not, the SAME key and the SAME body go again, so even a request still
        in flight cannot become a second bill.
      */
      if (settleIntent.current !== null) {
        const fresh = await api.feeQuote(visit.encounterId);
        setQuote(fresh); setQuoteState("read");
        if (fresh.alreadyBilled != null) {
          const held = settleIntent.current;
          setIssued({ invoiceNo: fresh.alreadyBilled.invoiceNo, receiptNo: null, paise: held.body.receipt.tenders[0]?.amountPaise ?? 0, mode: held.mode });
          settleIntent.current = null; setSettleUnknown(false); setStage("done"); buzz("ok");
          return;
        }
      }
      const intent: SettleIntent = settleIntent.current ?? {
        key: newIntentKey(),
        mode,
        body: {
          draftId: `m1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          patientId: visit.patientId, encounterId: visit.encounterId,
          lines: invoiceLinesOf(quote.draft),
          // `refText` travels for every non-cash mode — the settlement upload matches a bank row to the receipt by it.
          receipt: { tenders: [{ mode, amountPaise: bill.totalPaise, ...(mode === "cash" ? {} : { refText: ref.trim() }) }] },
        },
      };
      settleIntent.current = intent;
      const result: WireIssued = await api.issue(intent.body, intent.key);
      buzz("ok");
      settleIntent.current = null; setSettleUnknown(false);
      setIssued({ invoiceNo: result.invoiceNo, receiptNo: result.receiptNo, paise: intent.body.receipt.tenders[0]?.amountPaise ?? 0, mode: intent.mode });
      setStage("done");
    } catch (e) {
      buzz("warn");
      if (e instanceof NetworkError) {
        setSettleUnknown(true);
        setError(t("mobile.counter.settleUnknown"));
      } else if (e instanceof ApiError && e.code === "idempotency_key_in_progress") {
        // The first request is still settling on the server: the same key again in a moment, never a new one.
        setSettleUnknown(true);
        setError(t("mobile.counter.settleInProgress"));
      } else {
        settleIntent.current = null; setSettleUnknown(false);
        setError(said(e, t));
        void readQuote();
      }
    } finally {
      setBusy(null);
    }
  };

  const reprint = async (job: WirePrintJob): Promise<void> => {
    setBusy(`reprint-${job.id}`);
    try {
      const r = await api.reprint(job.id);
      setFlash(r.id === null ? t("mobile.counter.paper.refused") : t("mobile.counter.paper.sentAgain", { doc: t(`mobile.counter.doc.${job.document}`) }));
      readPaper();
    } catch (e) {
      setError(said(e, t));
    } finally {
      setBusy(null);
    }
  };

  const onMovedHeld = (r: WireMoveResult, to: { departmentName: string; doctor: WireDoctorSummary }): void => {
    setMoving(false);
    // The desk now holds the NEW visit: its number, its department's token, its own (re-read) money.
    setVisit({
      encounterId: r.to.encounter.id, patientId: r.to.encounter.patientId, visitNo: r.to.encounter.visitNo,
      departmentId: r.to.encounter.departmentId ?? to.doctor.doctor.departmentId, departmentName: to.departmentName, departmentCode: codeOf(r.to.encounter.departmentId ?? to.doctor.doctor.departmentId),
      doctorName: to.doctor.doctor.displayName, roomCode: to.doctor.roomCode, ahead: to.doctor.waitingCount, waitMin: waitMinutes(to.doctor),
      tokenNo: r.to.tokenNo, visitType: r.to.visitType, joining: false, joinError: null,
    });
    setQuote(null); setQuoteState("none"); setIssued(null); setJobs(null); settleIntent.current = null; setSettleUnknown(false); setError(null);
    setStage("bill");
    setFlash(t("mobile.counter.moved", { dept: to.departmentName, token: r.to.tokenNo === null ? "—" : tokenLabel(codeOf(r.to.encounter.departmentId), r.to.tokenNo) }));
    buzz("ok");
    if (person !== null) api.timeline(person.id).then((x) => setTimeline(x.items), () => undefined);
  };
  const onMovedCard = (r: WireMoveResult, to: { departmentName: string; doctor: WireDoctorSummary }): void => {
    setCard(null);
    setFlash(t("mobile.counter.moved", { dept: to.departmentName, token: r.to.tokenNo === null ? "—" : tokenLabel(codeOf(r.to.encounter.departmentId), r.to.tokenNo) }));
    buzz("ok");
    if (person !== null) api.timeline(person.id).then((x) => setTimeline(x.items), () => undefined);
  };

  const back = (): void => {
    setError(null);
    if (stage === "find") router.back();
    else if (stage === "register") setStage("find");
    else if (stage === "person") clearDesk();
    else if (stage === "seat") { if (!seatUnknown) setStage("person"); }
    else if (stage === "bill") setStage("person");
    else clearDesk();
  };

  const tokenText = visit !== null && visit.tokenNo !== null ? tokenLabel(visit.departmentCode, visit.tokenNo) : null;
  const paper = paperState(jobs ?? []);
  const visitKindText = (vt: string | null): string | null => (vt === "new" || vt === "revisit" || vt === "renewal" ? t(`registrationCounter.move.vt.${vt}`) : null);

  // ——— what the bill stage says about the fee when this login may not read the quote ———
  const termsLine = ((): string | null => {
    if (visit?.visitType == null) return null;
    const fee = moveFee(visit.visitType, terms);
    if (fee === null) return visitKindText(visit.visitType);
    return `${visitKindText(visit.visitType) ?? ""} · ${fee.kind === "amount" ? rs(fee.paise) : fee.kind === "feesOff" ? SAMAJ_SEVA_AMOUNT : t("registrationCounter.move.free")}`;
  })();
  const feesOffByTerms = terms?.consultFeeOff === true;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={
        <Pressable onPress={back} accessibilityRole="button" hitSlop={8} testID="counter-back" style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
          <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
        </Pressable>
      } />
      <View style={s.head}>
        <View style={s.dot} />
        <Text style={s.headTitle}>{t("screen.counter.title")}</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.step} testID="counter-step">{t(`mobile.counter.step.${stage}`)}</Text>
      </View>

      {/* The person in hand rides above every later stage — who this is never scrolls away. */}
      {person !== null && stage !== "find" && stage !== "register" && (
        <View style={s.person} testID="counter-person">
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[type.heading, { color: color.ink }]} numberOfLines={1}>{person.name}</Text>
            <Text style={[type.small, { color: color.dim, fontFamily: MONO }]} numberOfLines={1}>
              {[personLine(person), person.uhid, person.phone].filter((x) => x !== null && x !== "").join(" · ")}
            </Text>
          </View>
          {person.sealed && <Text style={s.mark}>{t("mobile.counter.sealed")}</Text>}
          {person.justRegistered && <Text style={[s.mark, { color: color.green, borderColor: color.green }]}>{t("mobile.counter.justRegistered")}</Text>}
        </View>
      )}

      <ScrollView {...keyboardScrollInsets()} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + 168, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {scanSaid !== null && <ScannedBanner text={scanSaid} onDismiss={() => setScanSaid(null)} />}
        {flash !== null && <Note tone="info" testID="counter-flash">{flash}</Note>}

        {/* ═══ FIND ═══ */}
        {stage === "find" && (
          <>
            <View style={s.cardBox}>
              <Text style={[type.heading, { color: color.ink }]}>{t("mobile.counter.find.title")}</Text>
              <TextInput testID="counter-query" style={[s.input, { marginTop: space.md }]} value={query} onChangeText={(v) => { setQuery(v); setError(null); }}
                placeholder={t("mobile.counter.find.hint")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.counter.find.hint")}
                autoCapitalize="words" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => { void search(query); }} />
              <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                <View style={{ flex: 1 }}><Button testID="counter-scan" kind="secondary" label={t("mobile.counter.find.scan")} onPress={() => setScanning(true)} /></View>
                <View style={{ flex: 1 }}><Button testID="counter-find" busy={busy === "search"} label={t("mobile.counter.find.go")} onPress={() => { void search(query); }} /></View>
              </View>
            </View>
            {error !== null && <Note tone="bad" testID="counter-error">{error}</Note>}
            {hits !== null && hits.length === 0 && <Note tone="info" testID="counter-nohits">{t("mobile.counter.find.none")}</Note>}
            {(hits ?? []).map((h) => (
              <Pressable key={h.id} testID={`hit-${h.id}`} accessibilityRole="button" onPress={() => holdHit(h)} onLongPress={() => setHeld1(h.id)}
                accessibilityActions={[{ name: "longpress", label: t("mobile.scan.more") }]} onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === "longpress") setHeld1(h.id); }} style={({ pressed }) => [s.rowCard, pressed && { opacity: 0.7 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{h.name}<Text style={{ color: color.dim, fontWeight: "400" }}> · {personLine({ gender: h.administrativeGender, dob: h.dob })}</Text></Text>
                  <Text style={[type.small, { color: color.dim, fontFamily: MONO }]} numberOfLines={1}>{[h.uhid, h.phone].filter((x) => x !== null && x !== "").join(" · ")}</Text>
                  <Text style={[type.small, { color: color.faint }]}>{(h.matchedOn.length === 0 ? ["onFile"] : h.matchedOn).map((m) => t(`mobile.counter.find.match.${m}`)).join(" · ")}</Text>
                </View>
                {h.isConfidential && <Text style={s.mark}>{t("mobile.counter.sealed")}</Text>}
                <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
              </Pressable>
            ))}
            {mayRegister
              ? <Button testID="counter-new" kind="secondary" label={t("mobile.counter.find.new")} onPress={startRegister} />
              : <Text style={[type.small, { color: color.faint }]} testID="counter-noregister">{t("mobile.counter.find.noRegister")}</Text>}
            {mayApptRead && <Button testID="appts-open" kind="secondary" label={t("mobile.counter.appt.open")} onPress={() => setDeskList(true)} />}
            {/* Owner 2026-10-09 — "To collect": who this hospital's desks let through unpaid. Drawn only while somebody is owing. */}
            {toCollectN !== null && toCollectN > 0 && (
              <Button testID="to-collect-open" kind="secondary" label={t("toCollect.count", { n: toCollectN })} onPress={() => setCollectList(true)} />
            )}
          </>
        )}

        {/* ═══ REGISTER ═══ */}
        {stage === "register" && (
          <>
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.counter.reg.title")}</Text>
            <View style={s.cardBox}>
              <Lbl>{t("mobile.counter.reg.name")}</Lbl>
              <TextInput testID="reg-name" style={[s.input, tried && gaps.includes("name") && s.bad]} value={form.name} onChangeText={(v) => setForm((f) => ({ ...f, name: v }))} autoCapitalize="words" accessibilityLabel={t("mobile.counter.reg.name")} />
              <Lbl>{t("mobile.counter.reg.sex")}</Lbl>
              <View style={s.pills}>
                {(["male", "female", "other"] as const).map((x) => (
                  <Pill key={x} testID={`reg-sex-${x}`} on={form.sex === x} label={t(`mobile.counter.reg.sex_${x}`)} onPress={() => setForm((f) => ({ ...f, sex: x }))} />
                ))}
              </View>
              {tried && gaps.includes("sex") && <Text style={s.gap}>{t("mobile.counter.reg.gap.sex")}</Text>}
              <Lbl>{t("mobile.counter.reg.age")}</Lbl>
              <TextInput testID="reg-age" style={[s.input, tried && gaps.includes("age") && s.bad]} value={form.ageOrDob} onChangeText={(v) => setForm((f) => ({ ...f, ageOrDob: v }))}
                placeholder={t("mobile.counter.reg.ageHint")} placeholderTextColor={color.faint} keyboardType="numbers-and-punctuation" accessibilityLabel={t("mobile.counter.reg.age")} />
              {tried && gaps.includes("age") && <Text style={s.gap}>{t("mobile.counter.reg.gap.age")}</Text>}
              <Lbl>{t("mobile.counter.reg.phone")}</Lbl>
              <TextInput testID="reg-phone" style={[s.input, gaps.includes("phone") && form.phone.replace(/\s/g, "").length >= 10 && s.bad]} value={form.phone} onChangeText={(v) => setForm((f) => ({ ...f, phone: v }))} keyboardType="phone-pad" maxLength={12} accessibilityLabel={t("mobile.counter.reg.phone")} />
              {tried && gaps.includes("phone") && <Text style={s.gap}>{t("mobile.counter.reg.gap.phone")}</Text>}
              <Lbl>{t("mobile.counter.reg.address")}</Lbl>
              <TextInput testID="reg-address" style={s.input} value={form.address} onChangeText={(v) => setForm((f) => ({ ...f, address: v }))} accessibilityLabel={t("mobile.counter.reg.address")} />
            </View>
            {/* A known minor's registration must name a guardian — the server's rule (DPDP §9), asked for before it refuses. */}
            {(gaps.includes("guardian") || form.guardianName !== "" || form.guardianRelationship !== "") && (
              <View style={[s.cardBox, tried && gaps.includes("guardian") && { borderColor: color.redLine }]} testID="reg-guardian">
                <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{t("mobile.counter.reg.guardianTitle")}</Text>
                <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.reg.guardianWhy")}</Text>
                <Lbl>{t("mobile.counter.reg.guardianName")}</Lbl>
                <TextInput testID="reg-guardian-name" style={s.input} value={form.guardianName} onChangeText={(v) => setForm((f) => ({ ...f, guardianName: v }))} autoCapitalize="words" accessibilityLabel={t("mobile.counter.reg.guardianName")} />
                <Lbl>{t("mobile.counter.reg.guardianRel")}</Lbl>
                <View style={s.pills}>
                  {GUARDIAN_RELATIONSHIPS.map((x) => (
                    <Pill key={x} testID={`reg-rel-${x}`} on={form.guardianRelationship === x} label={t(`mobile.counter.reg.rel.${x}`)} onPress={() => setForm((f) => ({ ...f, guardianRelationship: x }))} />
                  ))}
                </View>
                <Lbl>{t("mobile.counter.reg.guardianPhone")}</Lbl>
                <TextInput testID="reg-guardian-phone" style={s.input} value={form.guardianPhone} onChangeText={(v) => setForm((f) => ({ ...f, guardianPhone: v }))} keyboardType="phone-pad" maxLength={12} accessibilityLabel={t("mobile.counter.reg.guardianPhone")} />
                {tried && (gaps.includes("guardian") || gaps.includes("guardianPhone")) && <Text style={s.gap}>{t(gaps.includes("guardian") ? "mobile.counter.reg.gap.guardian" : "mobile.counter.reg.gap.phone")}</Text>}
              </View>
            )}
            <Text style={[type.small, { color: color.faint }]}>{t("mobile.counter.reg.rest")}</Text>
            {error !== null && <Note tone="bad" testID="counter-error">{error}</Note>}
            {duplicates !== null && (
              <View style={[s.cardBox, { borderColor: color.goldLine, backgroundColor: color.goldSoft }]} testID="reg-duplicates">
                <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{t("mobile.counter.reg.dupTitle", { count: duplicates.length })}</Text>
                <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.reg.dupWhy")}</Text>
                {duplicates.map((d) => (
                  <View key={d.id} style={s.dupRow} testID={`dup-${d.id}`}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{d.name ?? t("mobile.counter.sealed")} · {personLine({ gender: d.administrativeGender, dob: d.dob })}</Text>
                      <Text style={[type.small, { color: color.dim, fontFamily: MONO }]} numberOfLines={1}>{[d.uhid, d.phone].filter((x) => x !== null && x !== "").join(" · ")}</Text>
                    </View>
                    <View style={{ width: 148 }}><Button testID={`dup-take-${d.id}`} kind="secondary" label={t("mobile.counter.reg.dupTake")} onPress={() => holdHit({ ...d, name: d.name ?? "" })} /></View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {/* ═══ THE PERSON ═══ */}
        {stage === "person" && person !== null && (
          <>
            {error !== null && <Note tone="bad" testID="counter-error">{error}</Note>}
            {openVisits.length > 0 && (
              <View style={{ gap: space.sm }} testID="open-visits">
                <Tag>{t("mobile.counter.person.openToday")}</Tag>
                {openVisits.map((v) => (
                  <View key={v.encounterId} style={[s.cardBox, { borderColor: color.greenLine, backgroundColor: color.greenSoft }]} testID={`open-${v.encounterId}`}>
                    <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{[v.departmentName, v.doctorName].filter((x) => x !== null).join(" · ")}</Text>
                    <Text style={[type.small, { color: color.dim, fontFamily: MONO }]}>{v.visitNo} · {t(`mobile.counter.status.${v.status}`)}{v.referral === null ? "" : ` · ${t("mobile.counter.person.referral")}`}</Text>
                    <View style={{ marginTop: space.sm }}><Button testID={`adopt-${v.encounterId}`} label={t("mobile.counter.person.openThis")} onPress={() => adopt(v)} /></View>
                  </View>
                ))}
              </View>
            )}
            {linked !== null && linked.items.length > 0 && (
              <View style={{ gap: space.sm }} testID="linked">
                <Tag>{t("mobile.counter.person.linked", { count: linked.total })}</Tag>
                {linked.items.map((l) => (
                  <Pressable key={l.id} testID={`linked-${l.id}`} accessibilityRole="button" onPress={() => holdHit(l)} onLongPress={() => setHeld1(l.id)}
                    accessibilityActions={[{ name: "longpress", label: t("mobile.scan.more") }]} onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === "longpress") setHeld1(l.id); }} style={({ pressed }) => [s.rowCard, pressed && { opacity: 0.7 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{l.name} · {personLine({ gender: l.administrativeGender, dob: l.dob })}</Text>
                      <Text style={[type.small, { color: color.dim, fontFamily: MONO }]}>{l.uhid}</Text>
                    </View>
                    <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {mayApptRead && (
              <PatientAppointments
                api={api} patientId={person.id} today={today} version={apptVersion} mayManage={mayApptManage} mayCheckIn={mayOpen} mayCollectAdvance={can("billing.receipt.record")}
                doctorName={doctorNameOf} deptName={deptNameOf}
                onMove={(a) => setBooking({ moving: a })} onCheckedIn={onCheckedIn} onAlreadyCheckedIn={onAlreadyCheckedIn}
                onSaid={(text) => { setFlash(text); setApptVersion((n) => n + 1); }}
              />
            )}
            {mayApptManage && <Button testID="person-book" kind="secondary" label={t("mobile.counter.appt.book")} onPress={() => { setError(null); setBooking({ moving: null }); }} />}
            <View style={{ gap: space.sm }} testID="history">
              <Tag>{t("mobile.counter.person.history")}</Tag>
              {timeline === null ? <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.reading")}</Text>
                : timeline.length === 0 ? <Text style={[type.small, { color: color.dim }]} testID="history-none">{t("mobile.counter.person.noHistory")}</Text>
                : timeline.slice(0, 8).map((v) => (
                  <Pressable key={v.encounterId} testID={`visit-${v.encounterId}`} accessibilityRole="button" onPress={() => setCard(v)} style={({ pressed }) => [s.rowCard, pressed && { opacity: 0.7 }]}>
                    <Text style={[type.small, { color: color.dim, fontFamily: MONO, width: 84 }]}>{dmy(v.serviceDate)}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.body, { color: color.ink }]} numberOfLines={1}>{[v.departmentName, v.doctorName].filter((x) => x !== null).join(" · ")}</Text>
                      <Text style={[type.small, { color: color.dim }]}>{t(`mobile.counter.status.${v.status}`)}</Text>
                    </View>
                    <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
                  </Pressable>
                ))}
            </View>
          </>
        )}

        {/* ═══ SEAT ═══ */}
        {stage === "seat" && (
          <>
            <View style={s.cardBox}>
              <Lbl>{t("mobile.counter.seat.complaint")}</Lbl>
              <TextInput testID="seat-complaint" style={s.input} value={complaint} editable={!seatUnknown} onChangeText={setComplaint}
                placeholder={t("mobile.counter.seat.complaintHint")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.counter.seat.complaint")} />
            </View>
            {boardStale && <Note tone="warn" testID="board-stale">{t("mobile.counter.seat.stale")}</Note>}
            <Tag>{t("mobile.counter.seat.pickDept")}</Tag>
            {summaries === null && !boardStale && <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.reading")}</Text>}
            {summaries !== null && queues.length === 0 && <Note tone="info" testID="board-empty">{t("mobile.counter.seat.noBoard")}</Note>}
            <View style={s.pills}>
              {queues.map((q) => (
                <Pill key={q.departmentId} testID={`dept-${q.departmentId}`} on={deptId === q.departmentId}
                  label={`${q.departmentName} · ${Number.isFinite(q.poolWaitMinutes) ? t("mobile.counter.seat.deptWait", { count: q.waiting }) : t("mobile.counter.seat.deptShut")}`}
                  onPress={() => pickDept(q)} />
              ))}
            </View>
            {dq !== null && (
              <View style={{ gap: space.sm }}>
                <Tag>{t("mobile.counter.seat.pickDoctor")}</Tag>
                {anchor !== null && (() => {
                  const theirs = dq.doctors.find((d) => d.doctor.id === anchor.doctorId);
                  const vars = { doctor: anchor.doctorName, seen: dmy(anchor.seenOn), kind: visitKindText(anchor.wouldBe) ?? "", min: theirs === undefined ? 0 : waitMinutes(theirs) };
                  const key = theirs === undefined || !bookableToday(theirs) ? "anchorAway" : waitMinutes(theirs) > DELAY_HIGHLIGHT_MINUTES ? "anchorLong" : "anchor";
                  return <Note tone={key === "anchor" ? "info" : "warn"} testID="seat-anchor">{t(`mobile.counter.seat.${key}`, vars)}</Note>;
                })()}
                {[...dq.doctors].sort((a, b) => Number(b.doctor.id === anchor?.doctorId) - Number(a.doctor.id === anchor?.doctorId)).map((d) => {
                  const on = doctorId === d.doctor.id;
                  const open = bookableToday(d);
                  const tag = [labelOf(d.doctor), d.doctor.id === anchor?.doctorId ? t("mobile.counter.seat.sawLast") : null].filter((x) => x !== null).join(" · ") || null;
                  return (
                    <Pressable key={d.doctor.id} testID={`doctor-${d.doctor.id}`} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !open }} disabled={!open || seatUnknown}
                      onPress={() => { setDoctorId(d.doctor.id); setError(null); }}
                      style={[s.docRow, on && { borderColor: color.green, borderWidth: 2, backgroundColor: color.greenSoft }, !open && { opacity: 0.55 }]}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{d.doctor.displayName}</Text>
                        <Text style={[type.small, { color: color.dim }]} numberOfLines={2}>
                          {[d.roomCode === null ? null : t("mobile.counter.seat.room", { room: d.roomCode }), tag].filter((x) => x !== null).join(" · ") || " "}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        {open ? (
                          <>
                            <Text style={[type.body, { color: color.ink, fontWeight: "700", fontFamily: MONO }]}>{t("mobile.counter.seat.waiting", { count: d.waitingCount })}</Text>
                            <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.seat.about", { min: waitMinutes(d) })}</Text>
                          </>
                        ) : (
                          <Text style={[type.small, { color: color.dim }]}>{t(d.onLeaveToday ? "mobile.counter.seat.away" : "mobile.counter.seat.notToday")}</Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {error !== null && <Note tone="bad" testID="counter-error">{error}</Note>}
          </>
        )}

        {/* ═══ BILL ═══ */}
        {(stage === "bill" || stage === "done") && visit !== null && (
          <>
            <View style={[s.cardBox, { alignItems: "center" }]} testID="token-block">
              {stage === "done" && <Text style={s.doneWord} testID="done-word">{t("mobile.counter.done.title")}</Text>}
              <Tag>{t("mobile.counter.bill.token")}</Tag>
              {token.kind === "out" ? (
                <>
                  <Text style={s.token} testID="token-no">{tokenLabel(visit.departmentCode, token.tokenNo)}</Text>
                  {/* The stamp is a bordered WORD, never colour alone. */}
                  {quoteState === "read" || issued !== null ? (
                    <Text testID="token-stamp" style={[s.stamp, token.paid ? { color: color.green, borderColor: color.green } : { color: color.red, borderColor: color.red }]}>
                      {t(!token.paid ? "mobile.counter.bill.unpaid" : issued === null && alreadyBilled === null && bill.free ? "mobile.counter.bill.free" : "mobile.counter.bill.paid")}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text style={[type.body, { color: color.dim, textAlign: "center", marginTop: 6 }]} testID="token-held">
                  {visit.joining ? t("mobile.counter.bill.joining") : token.kind === "held" && token.position !== null ? t("mobile.counter.bill.heldF2") : lane === "F3" ? t("mobile.counter.bill.heldF3") : t("mobile.counter.bill.tokenOnSlip")}
                </Text>
              )}
              {visit.joinError !== null && <Note tone="bad" testID="join-error">{visit.joinError}</Note>}
              <Text style={[type.body, { color: color.ink, fontWeight: "700", marginTop: space.sm, textAlign: "center" }]}>{visit.doctorName}</Text>
              <Text style={[type.small, { color: color.dim, textAlign: "center" }]}>
                {[visit.departmentName, visit.roomCode === null ? null : t("mobile.counter.seat.room", { room: visit.roomCode })].filter((x) => x !== null).join(" · ")}
              </Text>
              <Text style={[type.small, { color: color.faint, fontFamily: MONO, marginTop: 2 }]} testID="visit-no">{visit.visitNo}</Text>
            </View>

            <View style={s.cardBox} testID="bill-block">
              <Tag>{t("mobile.counter.bill.title")}</Tag>
              {quoteState === "reading" && <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.reading")}</Text>}
              {quoteState === "failed" && (
                <>
                  <Note tone="warn" testID="quote-failed">{t("mobile.counter.bill.quoteFailed")}</Note>
                  <Button testID="quote-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={() => { void readQuote(); }} />
                </>
              )}
              {quoteState === "denied" && (
                <>
                  {termsLine !== null && <Text style={[type.heading, { color: color.ink }]} testID="terms-line">{termsLine}</Text>}
                  <Text style={[type.small, { color: color.dim }]} testID="bill-elsewhere">{t(feesOffByTerms ? "mobile.counter.bill.nothingFeesOff" : "mobile.counter.bill.elsewhere")}</Text>
                </>
              )}
              {quoteState === "read" && quote !== null && (
                <>
                  {visitKindText(quote.visitType) !== null && <Text style={[type.small, { color: color.dim }]} testID="visit-kind">{visitKindText(quote.visitType)}</Text>}
                  {bill.free ? (
                    <Text style={[type.heading, { color: color.ink }]} testID="bill-free">
                      {quote.feesOff === true ? SAMAJ_SEVA_AMOUNT
                        : quote.freeReason === null ? t("mobile.counter.bill.nothing")
                        : t(quote.freeReason.kind === "referral_window" ? "mobile.counter.bill.freeReferral" : "mobile.counter.bill.freeReview", { till: dmy(quote.freeReason.windowEndsOn) })}
                    </Text>
                  ) : (
                    <>
                      {bill.lines.map((l, i) => (
                        <View key={`${l.label}-${String(i)}`} style={s.billRow}>
                          <Text style={[type.body, { color: l.credit ? color.green : color.ink, flex: 1 }]}>{l.label === "GST" ? t("mobile.counter.bill.gst") : l.label === "rounding" ? t("mobile.counter.bill.rounding") : l.label}</Text>
                          <Text style={[type.body, { color: l.credit ? color.green : color.ink, fontFamily: MONO }]}>{l.paise < 0 ? `− ${rs(-l.paise)}` : rs(l.paise)}</Text>
                        </View>
                      ))}
                      <View style={[s.billRow, { borderTopWidth: 1, borderTopColor: color.ink, marginTop: 4, paddingTop: 8 }]}>
                        <Text style={[type.heading, { color: color.ink, flex: 1 }]}>{t(issued !== null ? "mobile.counter.bill.collected" : "mobile.counter.bill.toCollect")}</Text>
                        <Text style={[type.title, { color: color.ink, fontFamily: MONO }]} testID="bill-total">{rs(bill.totalPaise)}</Text>
                      </View>
                    </>
                  )}
                  {alreadyBilled !== null && issued === null && <Note tone="info" testID="already-billed">{t("mobile.counter.bill.already", { no: alreadyBilled.invoiceNo })}</Note>}
                </>
              )}
              {issued !== null && (
                <Note tone="info" testID="issued">
                  {t(issued.receiptNo === null ? "mobile.counter.done.billed" : "mobile.counter.done.receipt", {
                    no: issued.invoiceNo, receipt: issued.receiptNo ?? "", amount: rs(issued.paise), mode: issued.mode === null ? "" : t(`registrationCounter.move.money.mode.${issued.mode}`),
                  })}
                </Note>
              )}
            </View>

            {/* ——— taking the money: only with the billing permission AND an open cash session — the server's own conditions ——— */}
            {stage === "bill" && quoteState === "read" && quote !== null && !bill.free && alreadyBilled === null && issued === null && (
              !mayCollect ? (
                <Note tone="info" testID="collect-elsewhere">{t("mobile.counter.bill.elsewhere")}</Note>
              ) : maySession && cash === null ? (
                <View style={[s.cardBox, { borderColor: color.goldLine, backgroundColor: color.goldSoft }]} testID="no-cash-session">
                  <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{t("mobile.counter.cash.none")}</Text>
                  <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.cash.why")}</Text>
                  <Lbl>{t("mobile.counter.cash.float")}</Lbl>
                  <TextInput testID="cash-float" style={s.input} value={floatText} onChangeText={setFloatText} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={color.faint} accessibilityLabel={t("mobile.counter.cash.float")} />
                </View>
              ) : (
                <View style={s.cardBox} testID="tender">
                  <Tag>{t("mobile.counter.bill.how")}</Tag>
                  <View style={s.pills}>
                    {(["cash", "upi", "card"] as const).map((m) => (
                      <Pill key={m} testID={`tender-${m}`} on={(settleIntent.current?.mode ?? mode) === m} label={t(`registrationCounter.move.money.mode.${m}`)}
                        onPress={() => { if (!settleUnknown) { setMode(m); setError(null); } }} />
                    ))}
                  </View>
                  {mode !== "cash" && (
                    <TextInput testID="tender-ref" style={s.input} value={ref} editable={!settleUnknown} onChangeText={setRef} autoCapitalize="characters"
                      placeholder={t("registrationCounter.move.money.refHint")} placeholderTextColor={color.faint} accessibilityLabel={t("registrationCounter.move.money.refHint")} />
                  )}
                </View>
              )
            )}

            {mayPaper && jobs !== null && paper.state !== "none" && (
              <View style={s.cardBox} testID="paper-block">
                <Tag>{t("mobile.counter.paper.title")}</Tag>
                <Text testID="paper-state" style={[type.body, { color: paper.state === "failed" ? color.red : color.ink, fontWeight: paper.state === "failed" ? "700" : "400" }]}>
                  {paper.state === "failed"
                    ? t("mobile.counter.paper.didNot", { docs: paper.failed.map((j) => t(`mobile.counter.doc.${j.document}`)).join(", ") })
                    : paper.state === "waiting" ? t("mobile.counter.paper.waiting", { n: paper.pending.length, of: paper.current.length })
                    : t("mobile.counter.paper.printed")}
                </Text>
                <Text style={[type.small, { color: color.faint }]}>{t("mobile.counter.paper.where")}</Text>
                {paper.failed.map((j) => (
                  <Button key={j.id} testID={`reprint-${j.document}`} kind="secondary" busy={busy === `reprint-${j.id}`} label={t("mobile.counter.paper.againDoc", { doc: t(`mobile.counter.doc.${j.document}`) })} onPress={() => { void reprint(j); }} />
                ))}
              </View>
            )}

            {error !== null && <Note tone="bad" testID="counter-error">{error}</Note>}
            {stage === "bill" && mayOpen && issued === null && !settleUnknown && (
              <Pressable testID="move-open" accessibilityRole="button" onPress={() => setMoving(true)} style={{ minHeight: TOUCH, justifyContent: "center" }}>
                <Text style={{ color: color.green, fontWeight: "700", fontSize: 15 }}>{t("registrationCounter.move.open")}</Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>

      {/* ═══ ONE PRIMARY ACTION, ALWAYS IN THE SAME PLACE ═══ */}
      <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
        {stage === "register" && (duplicates === null
          ? <Button testID="reg-submit" busy={busy === "register"} label={t("mobile.counter.reg.submit")} onPress={() => { void register(false); }} />
          // With near-matches on screen the only way forward is to judge them: take one above, or say none is them.
          : <Button testID="reg-anyway" kind="secondary" busy={busy === "register"} label={t("mobile.counter.reg.dupAnyway")} onPress={() => { void register(true); }} />
        )}
        {stage === "person" && (
          mayOpen
            ? <Button testID="person-seat" label={t(openVisits.length > 0 ? "mobile.counter.person.another" : "mobile.counter.person.seat")} kind={openVisits.length > 0 ? "secondary" : "primary"} onPress={() => { setError(null); setStage("seat"); }} />
            : <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.person.noOpen")}</Text>
        )}
        {stage === "seat" && (
          <Button testID="seat-go" busy={busy === "seat"} disabled={chosen === null}
            label={seatUnknown ? t("mobile.counter.seat.again") : chosen === null ? t("mobile.counter.seat.pickFirst") : t("mobile.counter.seat.go", { doctor: chosen.doctor.displayName })}
            onPress={() => { void seat(); }} />
        )}
        {stage === "bill" && visit !== null && (() => {
          const payable = quoteState === "read" && quote !== null && !bill.free && alreadyBilled === null && issued === null;
          if (payable && mayCollect && !(maySession && cash === null)) {
            return (
              <Button testID="settle" busy={busy === "settle"}
                label={settleUnknown ? t("mobile.counter.bill.again") : t("mobile.counter.bill.collect", { amount: rs(bill.totalPaise), mode: t(`registrationCounter.move.money.mode.${mode}`) })}
                onPress={() => { void settle(); }} />
            );
          }
          if (payable && mayCollect) {
            // No cash session: opening one IS the next act. Leaving the fee for the billing counter is the quiet way out.
            return (
              <>
                <Button testID="cash-open" busy={busy === "cash"} label={t("mobile.counter.cash.open")} onPress={() => { void openCash(); }} />
                <Pressable testID="bill-done" accessibilityRole="button" onPress={() => { setError(null); setStage("done"); }} style={{ minHeight: TOUCH, justifyContent: "center", alignItems: "center" }}>
                  <Text style={{ color: color.dim, fontWeight: "600", fontSize: 14 }}>{t("mobile.counter.bill.leaveUnpaid")}</Text>
                </Pressable>
              </>
            );
          }
          return <Button testID="bill-done" label={t("mobile.counter.bill.done")} onPress={() => { setError(null); setStage("done"); }} />;
        })()}
        {stage === "done" && <Button testID="next-patient" label={t("mobile.counter.done.next")} onPress={clearDesk} />}
        {stage === "find" && <Text style={[type.small, { color: color.faint, textAlign: "center" }]}>{t("mobile.counter.find.foot")}</Text>}
      </View>

      <Scanner open={scanning} onRead={onScan} onClose={() => setScanning(false)} />
      <HeldCard source={held1 === null ? null : { patientId: held1 }} onClose={() => setHeld1(null)}
        onLocal={(action, v) => {
          // Everything Desk One owns is done HERE, on the desk already open; another screen's action opens that screen.
          if (SEAT_OF[action] !== "counter") return false;
          arriving.current = "person";
          setWant({ encounterId: v.encounterId, patientId: v.patientId, visitNo: v.visitNo, tokenNo: v.tokenNo, act: action, banner: null });
          return true;
        }} />
      {moving && visit !== null && (
        <MoveDepartment
          api={api} queues={queues} labelOf={labelOf} terms={terms}
          visit={{ encounterId: visit.encounterId, departmentId: visit.departmentId, departmentName: visit.departmentName, doctorName: visit.doctorName, tokenText }}
          onMoved={onMovedHeld} onClose={() => setMoving(false)}
        />
      )}
      {collectList && (
        <ToCollectList
          api={api} held={heldHere} mayOpenSession={maySession}
          onCollect={(row) => { setCollectList(false); collectFor(row); }}
          onClose={() => { setCollectList(false); readToCollect(); }}
        />
      )}
      {deskList && (
        <DeskAppointments
          api={api} today={today} mayManage={mayApptManage}
          onPick={(a) => { setDeskList(false); holdBooked(a); }}
          onRebook={(a) => { setDeskList(false); holdBooked(a); setBooking({ moving: a, preset: { doctorId: a.doctorId } }); }}
          onClose={() => setDeskList(false)}
        />
      )}
      {booking !== null && person !== null && (
        <BookAppointment
          api={api} person={{ id: person.id, name: person.name, phone: person.phone }} today={today} departments={departments} labelOf={labelOf} terms={terms}
          moving={booking.moving} preset={booking.preset} onDone={onBooked} onClose={() => setBooking(null)}
        />
      )}
      {card !== null && (
        <VisitCard
          api={api} visit={card} today={today} mayMove={mayOpen} mayPaper={mayPaper} mayBills={mayQuote}
          queues={queues} labelOf={labelOf} terms={terms} onMoved={onMovedCard} onClose={() => setCard(null)}
        />
      )}
    </View>
  );
}

function Lbl({ children }: { children: string }) {
  return <Text style={s.lbl}>{children}</Text>;
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.green },
  headTitle: { fontFamily: MONO, fontWeight: "700", fontSize: 15, letterSpacing: 1, color: color.ink },
  step: { ...type.tag, color: color.dim, fontFamily: MONO },
  person: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: color.wash, borderBottomWidth: 1, borderBottomColor: color.line },
  mark: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, color: color.red, borderWidth: 1, borderColor: color.red, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  cardBox: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 6 },
  rowCard: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 12, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  docRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 12, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  dupRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.goldLine },
  input: { minHeight: TOUCH + 4, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 17, color: color.ink },
  bad: { borderColor: color.red, borderWidth: 2 },
  gap: { ...type.small, color: color.red },
  lbl: { ...type.tag, color: color.dim, fontFamily: MONO, marginTop: space.sm },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  token: { fontFamily: MONO, fontSize: 44, fontWeight: "700", color: color.ink, letterSpacing: 1 },
  stamp: { fontSize: 13, fontWeight: "700", letterSpacing: 1.5, borderWidth: 2, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 2, marginTop: 2 },
  doneWord: { ...type.heading, color: color.green, marginBottom: space.sm },
  billRow: { flexDirection: "row", alignItems: "baseline", gap: space.md, paddingVertical: 3 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
});
