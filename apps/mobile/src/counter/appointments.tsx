import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Button, MONO, Note, Tag } from "../ui";
import { refusalText } from "../vitals/api";
import type { CounterApi, WireAppointment, WireCheckIn, WireDepartment, WireLeave, WireMasterDoctor, WireRoom, WireSchedule, WireSlot } from "./api";
import {
  DAY_PART_ORDER, bookCounts, bookOrder, bookedAlready, dayOffer, dayPartOf, daysFrom, movedAlready, partCounts, rebookingToday, rowStateOf,
  sittingWeekdays, slotClock, telePhoneOf, upcomingOf, weekdayOf,
} from "./appointment-rules";
import type { DayOffer, DayPart } from "./appointment-rules";
import { Pill } from "./move";
import { SAMAJ_SEVA_AMOUNT } from "./rules";
import { TeleMark } from "./tele-mark";
import type { MoveConsultTerms } from "./rules";

/**
 * APPOINTMENTS ON THE PHONE'S DESK ONE (owner 2026-10-07; the web's appointment stage in
 * `desk-one/stages.tsx`). The same server routes under the same guards — `GET /opd/slots`,
 * `GET /opd/appointments`, `POST /opd/appointments{,/:id/reschedule,/:id/cancel,/:id/check-in}` —
 * and the same reading rules (`appointment-rules.ts`, one file with the web).
 *
 *   book        department → doctor → day → morning / noon / evening → the slot → confirm.
 *               The server's slot list is the only judge of what can be booked; the day strip
 *               only explains a closed day (leave, with its reason; or a weekday the doctor
 *               does not sit). No fee is taken at booking — the web takes none either: the
 *               visit and its bill begin at check-in. Nothing is printed or sent for a booking.
 *   check in    the booking BECOMES today's visit; the desk goes on to the normal bill step.
 *   move        the same grid with the booking marked as the one being moved; a doctor of
 *               another department asks why first (owner 2026-10-05).
 *   cancel      two deliberate acts and a reason — the server refuses a blank one.
 *
 * NOTHING IS QUEUED, AND NOTHING IS MADE TWICE. None of these routes takes an idempotency key, so
 * a lost answer is settled the only honest way: the patient's appointments are READ AGAIN first.
 * If the write did land the screen shows it and sends nothing; only if it did not is the same
 * request sent again. Until then the choice is locked and the screen says what is not known.
 */

type T = ReturnType<typeof useI18n>["t"];
const said = (e: unknown, t: T): string => (e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
const buzz = (kind: "ok" | "warn"): void => {
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};
const ddmm = (date: string): string => `${date.slice(8, 10)}-${date.slice(5, 7)}`;
export const dayWord = (date: string, t: T): string => `${t(`mobile.counter.appt.wd.${weekdayOf(date)}`)} ${ddmm(date)}`;
export const whoOf = (a: WireAppointment, t: T): string => a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted");
/** How far ahead the phone offers days: a fortnight on the strip, eight weeks behind "More dates". */
export const STRIP_DAYS = 14;
export const MORE_DAYS = 56;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PATIENT'S OWN BOOKINGS — on the person screen
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function PatientAppointments({ api, patientId, today, version, mayManage, mayCheckIn, doctorName, deptName, onMove, onCheckedIn, onAlreadyCheckedIn, onSaid }: {
  api: CounterApi; patientId: string; today: string;
  /** Bumped by the desk after any write elsewhere, so this list is read again. */
  version: number;
  mayManage: boolean; mayCheckIn: boolean;
  doctorName: (doctorId: string) => string | null; deptName: (departmentId: string) => string | null;
  onMove: (a: WireAppointment) => void;
  onCheckedIn: (res: WireCheckIn, a: WireAppointment) => void;
  /** A lost check-in answer that DID land: the visit already exists — the desk opens it, nothing is re-sent. */
  onAlreadyCheckedIn: (encounterId: string, a: WireAppointment) => void;
  onSaid: (text: string) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<WireAppointment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [unknown, setUnknown] = useState<{ id: string; kind: "checkin" | "cancel" } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const read = useCallback(async (): Promise<WireAppointment[] | null> => {
    try {
      const items = await api.patientAppointments(patientId);
      setRows(items); setFailed(false);
      return items;
    } catch {
      setFailed(true);
      return null;
    }
  }, [api, patientId]);
  useEffect(() => { setRows(null); void read(); }, [read, version]);

  const upcoming = useMemo(() => upcomingOf(rows ?? [], today), [rows, today]);

  const arrive = async (a: WireAppointment): Promise<void> => {
    setBusy(a.id); setErr(null);
    try {
      if (unknown?.id === a.id && unknown.kind === "checkin") {
        // READ FIRST: if the first request reached the server, the booking already is a visit.
        const fresh = await api.patientAppointments(patientId);
        setRows(fresh);
        const now = fresh.find((x) => x.id === a.id);
        if (now?.status === "checked_in" && now.encounterId !== null) { setUnknown(null); buzz("ok"); onAlreadyCheckedIn(now.encounterId, a); return; }
      }
      const res = await api.checkIn(a.id);
      setUnknown(null); buzz("ok");
      onCheckedIn(res, a);
    } catch (e) {
      buzz("warn");
      if (e instanceof NetworkError) {
        setUnknown({ id: a.id, kind: "checkin" });
        setErr({ id: a.id, text: t("mobile.counter.appt.checkInUnknown") });
      } else {
        setUnknown(null);
        setErr({ id: a.id, text: said(e, t) });
        void read();
      }
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (a: WireAppointment): Promise<void> => {
    const why = reason.trim();
    if (why === "") { setErr({ id: a.id, text: t("registrationCounter.book.cancelReasonRequired") }); return; }
    setBusy(a.id); setErr(null);
    const done = (): void => {
      setUnknown(null); setCancelling(null); setReason(""); buzz("ok");
      onSaid(t("mobile.counter.appt.cancelled", { when: `${dayWord(a.serviceDate, t)} ${slotClock(a.slotStart)}` }));
      void read();
    };
    try {
      if (unknown?.id === a.id && unknown.kind === "cancel") {
        const fresh = await api.patientAppointments(patientId);
        setRows(fresh);
        if (fresh.find((x) => x.id === a.id)?.status === "cancelled") { done(); return; }
      }
      await api.cancelAppointment(a.id, why);
      done();
    } catch (e) {
      buzz("warn");
      if (e instanceof NetworkError) {
        setUnknown({ id: a.id, kind: "cancel" });
        setErr({ id: a.id, text: t("mobile.counter.appt.cancelUnknown") });
      } else {
        setUnknown(null);
        setErr({ id: a.id, text: said(e, t) });
        void read();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: space.sm }} testID="appts">
      <Tag>{t("mobile.counter.appt.theirs")}</Tag>
      {rows === null && !failed && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}
      {failed && (
        <View style={{ gap: space.sm }}>
          <Note tone="warn" testID="appts-failed">{t("mobile.counter.appt.readFailed")}</Note>
          <Button testID="appts-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={() => { void read(); }} />
        </View>
      )}
      {rows !== null && upcoming.length === 0 && <Text style={s.dim} testID="appts-none">{t("mobile.counter.appt.none")}</Text>}
      {upcoming.map((a) => {
        const isToday = a.serviceDate.slice(0, 10) === today;
        const stranded = a.status === "needs_rebooking";
        const locked = unknown !== null && unknown.id === a.id;
        return (
          <View key={a.id} testID={`appt-${a.id}`} style={[s.card, stranded && { borderColor: color.goldLine, backgroundColor: color.goldSoft }, isToday && !stranded && { borderColor: color.greenLine, backgroundColor: color.greenSoft }]}>
            <View style={s.head}>
              <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>
                {isToday ? t("mobile.counter.appt.today") : dayWord(a.serviceDate, t)} · {slotClock(a.slotStart)}
              </Text>
              {a.mode === "tele" && <TeleMark testID={`appt-tele-${a.id}`} label={t("mobile.counter.appt.tele")} />}
            </View>
            <Text style={s.dim} numberOfLines={1}>{[doctorName(a.doctorId), deptName(a.departmentId)].filter((x) => x !== null).join(" · ")}</Text>
            {a.appointmentNo != null && <Text style={[s.dim, { fontFamily: MONO }]}>{a.appointmentNo}</Text>}
            {stranded && <Text style={[type.small, { color: color.gold, fontWeight: "700" }]} testID={`appt-stranded-${a.id}`}>{t("mobile.counter.appt.stranded")}</Text>}
            {err?.id === a.id && <Note tone="bad" testID={`appt-error-${a.id}`}>{err.text}</Note>}
            {cancelling === a.id ? (
              <View style={{ gap: space.sm, marginTop: space.sm }} testID={`appt-cancel-box-${a.id}`}>
                <Text style={[type.small, { color: color.ink }]}>{t("registrationCounter.book.cancelWhy")}</Text>
                <TextInput testID={`appt-cancel-reason-${a.id}`} style={s.input} value={reason} editable={!locked} onChangeText={setReason}
                  placeholder={t("registrationCounter.book.cancelReasonHint")} placeholderTextColor={color.faint} accessibilityLabel={t("registrationCounter.book.cancelReasonHint")} />
                <View style={s.two}>
                  <View style={{ flex: 1 }}><Button testID={`appt-cancel-no-${a.id}`} kind="secondary" disabled={locked} label={t("registrationCounter.book.cancelAbort")} onPress={() => { setCancelling(null); setReason(""); setErr(null); }} /></View>
                  <View style={{ flex: 1 }}><Button testID={`appt-cancel-yes-${a.id}`} busy={busy === a.id} label={locked ? t("mobile.counter.appt.checkAgain") : t("registrationCounter.book.cancelConfirm")} onPress={() => { void cancel(a); }} /></View>
                </View>
              </View>
            ) : (
              <View style={{ gap: space.sm, marginTop: space.sm }}>
                {isToday && !stranded && mayCheckIn && (
                  <Button testID={`appt-checkin-${a.id}`} busy={busy === a.id} label={locked ? t("mobile.counter.appt.checkAgain") : t("mobile.counter.appt.checkIn")} onPress={() => { void arrive(a); }} />
                )}
                {mayManage && !locked && (
                  <View style={s.two}>
                    <View style={{ flex: 1 }}><Button testID={`appt-move-${a.id}`} kind={stranded ? "primary" : "secondary"} label={t(stranded ? "mobile.counter.appt.rebook" : "mobile.counter.appt.move")} onPress={() => onMove(a)} /></View>
                    <View style={{ flex: 1 }}><Button testID={`appt-cancel-${a.id}`} kind="secondary" label={t("mobile.counter.appt.cancel")} onPress={() => { setCancelling(a.id); setReason(""); setErr(null); }} /></View>
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BOOK, OR MOVE — department → doctor → day → part of the day → slot → confirm
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function BookAppointment({ api, person, today, departments, labelOf, terms, moving, preset, onDone, onClose }: {
  api: CounterApi;
  /** `phone` is the patient's recorded mobile, when the desk has it — it waits in the tele-call field. */
  person: { id: string; name: string; phone?: string | null };
  today: string;
  departments: WireDepartment[];
  labelOf: (doctor: { userId: string; designation?: string | null }) => string | null;
  terms: MoveConsultTerms | undefined;
  /** The booking being moved; null books a new one. */
  moving: WireAppointment | null;
  preset?: { doctorId?: string; date?: string };
  onDone: (a: WireAppointment, kind: "booked" | "moved") => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [doctors, setDoctors] = useState<WireMasterDoctor[] | null>(null);
  const [doctorsFailed, setDoctorsFailed] = useState(false);
  const [rooms, setRooms] = useState<WireRoom[]>([]);
  const [theirs, setTheirs] = useState<WireAppointment[]>([]);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(preset?.doctorId ?? moving?.doctorId ?? null);
  const [schedules, setSchedules] = useState<WireSchedule[] | null>(null);
  const [leaves, setLeaves] = useState<WireLeave[]>([]);
  const [more, setMore] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [slots, setSlots] = useState<WireSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  /** Which doctor-day the slots in hand ANSWER — an effect must never judge a new day by the last day's list. */
  const [slotsOf, setSlotsOf] = useState<string | null>(null);
  const [part, setPart] = useState<DayPart | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  /*
    TELE-CALL (owner 2026-10-09). A NEW booking asks how: in person, as every booking was, or a
    tele-call, which needs the number the doctor will ring. A move asks nothing — the server
    carries the mode and the number to the new slot.
  */
  const [mode, setMode] = useState<"in_person" | "tele">("in_person");
  const [telePhone, setTelePhone] = useState(() => telePhoneOf(person.phone) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [done, setDone] = useState<{ a: WireAppointment; kind: "booked" | "moved" } | null>(null);
  const presetDate = useRef(preset?.date ?? null);
  /** True while the day in hand is one the SCREEN picked — only such a day may be stepped past when it turns out full. */
  const autoDay = useRef(false);

  const readDoctors = useCallback(() => {
    setDoctorsFailed(false);
    api.doctors().then((r) => setDoctors(r.items.filter((d) => d.active)), () => setDoctorsFailed(true));
  }, [api]);
  useEffect(() => {
    readDoctors();
    api.rooms().then((r) => setRooms(r.items), () => undefined);
    api.patientAppointments(person.id).then(setTheirs, () => undefined);
  }, [api, person.id, readDoctors]);

  const doctor = (doctors ?? []).find((d) => d.id === doctorId) ?? null;
  // The department follows the doctor in hand (a preset, or the booking being moved) until the clerk picks one.
  const shownDept = deptId ?? doctor?.departmentId ?? null;
  const inDept = (doctors ?? []).filter((d) => d.departmentId === shownDept);
  const withDoctors = departments.filter((d) => (doctors ?? []).some((x) => x.departmentId === d.id));
  const deptNameOf = (id: string | null | undefined): string => departments.find((d) => d.id === id)?.name ?? "";

  // ——— the doctor's timetable and leave: only to EXPLAIN a closed day; the server's slot list stays the judge ———
  useEffect(() => {
    if (doctorId === null) { setSchedules(null); setLeaves([]); return; }
    let live = true;
    setSchedules(null); setLeaves([]);
    api.schedules(doctorId).then((r) => { if (live) setSchedules(r.items); }, () => { if (live) setSchedules(null); });
    api.leaves(doctorId, today, daysFrom(today, MORE_DAYS)[MORE_DAYS - 1]!).then((r) => { if (live) setLeaves(r.items); }, () => undefined);
    return () => { live = false; };
  }, [api, doctorId, today]);

  const offerOf = useCallback((d: string): DayOffer | null => (schedules === null ? null : dayOffer(d, schedules, leaves)), [schedules, leaves]);
  const days = useMemo(() => daysFrom(today, more ? MORE_DAYS : STRIP_DAYS), [today, more]);
  const sits = schedules === null ? [] : sittingWeekdays(schedules, today);

  // The first day that is open is picked for the clerk — or the day a re-booking row asked for.
  useEffect(() => {
    if (doctorId === null || date !== null || unknown) return;
    const wanted = presetDate.current;
    if (wanted !== null) { presetDate.current = null; setDate(wanted); return; }
    if (schedules === null) return;
    const first = daysFrom(today, MORE_DAYS).find((d) => dayOffer(d, schedules, leaves).kind === "open");
    if (first !== undefined) { autoDay.current = true; setDate(first); }
  }, [doctorId, date, schedules, leaves, today, unknown]);

  const readSlots = useCallback(() => {
    if (doctorId === null || date === null) { setSlots(null); return; }
    setSlots(null); setSlotsError(null); setSlotsOf(null);
    api.slots(doctorId, date).then(
      (r) => { setSlots(r.slots); setSlotsOf(`${doctorId}|${date}`); },
      (e: unknown) => { setSlots([]); setSlotsError(said(e, t)); },
    );
  }, [api, doctorId, date, t]);
  useEffect(() => { readSlots(); }, [readSlots]);

  const counts = useMemo(() => partCounts(slots ?? []), [slots]);
  /*
    A day the screen picked that turns out to have NOTHING FREE (today at 4 pm; a fully booked
    morning) is stepped past to the next open day — the clerk was never shown a choice there. A day
    the clerk tapped is never moved: a full day is then an answer, shown as it is.
  */
  useEffect(() => {
    if (!autoDay.current || slots === null || slotsError !== null || date === null || schedules === null || unknown || slotsOf !== `${doctorId}|${date}`) return;
    if (slots.some((x) => !x.booked && !x.past)) { autoDay.current = false; return; }
    const next = daysFrom(date, MORE_DAYS).slice(1).find((d) => d <= daysFrom(today, MORE_DAYS)[MORE_DAYS - 1]! && dayOffer(d, schedules, leaves).kind === "open");
    if (next === undefined) { autoDay.current = false; return; }
    setDate(next); setPart(null); setPicked(null);
  }, [slots, slotsOf, slotsError, date, doctorId, schedules, leaves, today, unknown]);
  // With one part holding every free slot there is nothing to ask: it is opened.
  useEffect(() => {
    if (slots === null || part !== null || slotsOf !== `${doctorId}|${date}`) return;
    const open = DAY_PART_ORDER.filter((p) => counts[p].free > 0);
    if (open.length === 1) setPart(open[0]!);
  }, [slots, slotsOf, counts, part, doctorId, date]);

  const pickDoctor = (id: string): void => {
    if (unknown) return;
    autoDay.current = false;
    setDoctorId(id); setDate(null); setClosed(null); setPart(null); setPicked(null); setError(null);
  };
  const pickDay = (d: string): void => {
    if (unknown) return;
    autoDay.current = false;
    const offer = offerOf(d);
    setError(null);
    if (offer !== null && offer.kind !== "open") {
      // A closed day is explained, never silently skipped.
      setClosed(offer.kind === "leave"
        ? t(offer.reason === null ? "mobile.counter.appt.day.leave" : "mobile.counter.appt.day.leaveWhy", { doctor: doctor?.displayName ?? "", day: dayWord(d, t), reason: offer.reason ?? "" })
        : t("mobile.counter.appt.day.noSession", { doctor: doctor?.displayName ?? "", day: dayWord(d, t), days: sits.map((w) => t(`mobile.counter.appt.wd.${w}`)).join(", ") }));
      return;
    }
    setClosed(null); setDate(d); setPart(null); setPicked(null);
  };

  const slot = (slots ?? []).find((x) => x.start === picked) ?? null;
  const sameDay = theirs.filter((a) => (a.status === "booked" || a.status === "needs_rebooking") && a.serviceDate.slice(0, 10) === date && a.id !== moving?.id);
  const crossDept = moving !== null && doctor !== null && doctor.departmentId !== moving.departmentId;
  const roomCode = slot === null ? null : rooms.find((r) => r.id === slot.roomId)?.code ?? null;
  const tele = moving === null ? mode === "tele" : moving.mode === "tele";
  const teleReady = moving !== null || mode !== "tele" || telePhoneOf(telePhone) !== null;

  const finish = (a: WireAppointment, kind: "booked" | "moved"): void => {
    setUnknown(false); setError(null); buzz("ok");
    setDone({ a, kind });
  };

  const go = async (): Promise<void> => {
    if (doctor === null || slot === null || busy || !teleReady) return;
    if (crossDept && reason.trim() === "") { setError(t("registrationCounter.move.reasonRequired")); return; }
    setBusy(true); setError(null);
    try {
      if (unknown) {
        // A LOST ANSWER IS READ BEFORE ANYTHING IS RE-SENT (see the file's header).
        const fresh = await api.patientAppointments(person.id);
        setTheirs(fresh);
        const landed = moving === null ? bookedAlready(fresh, doctor.id, slot.start) : movedAlready(fresh, moving.id);
        if (landed !== null) { finish(landed, moving === null ? "booked" : "moved"); return; }
      }
      if (moving === null) {
        const r = await api.book({ patientId: person.id, doctorId: doctor.id, slotStart: slot.start, ...(note.trim() === "" ? {} : { note: note.trim() }), ...(mode === "tele" ? { mode: "tele" as const, telePhone: telePhoneOf(telePhone) ?? telePhone } : {}) });
        finish(r.appointment, "booked");
      } else {
        const r = await api.reschedule(moving.id, { slotStart: slot.start, doctorId: doctor.id, ...(crossDept ? { reason: reason.trim() } : {}) });
        finish(r.to, "moved");
      }
    } catch (e) {
      buzz("warn");
      if (e instanceof NetworkError) {
        setUnknown(true);
        setError(t(moving === null ? "mobile.counter.appt.bookUnknown" : "mobile.counter.appt.moveUnknown"));
      } else {
        setUnknown(false);
        setError(said(e, t));
        // The board moved under the clerk (somebody else took the slot, a leave was declared): show it as it now is.
        setPicked(null);
        readSlots();
      }
    } finally {
      setBusy(false);
    }
  };

  const title = moving === null ? t("mobile.counter.appt.bookTitle") : t("registrationCounter.book.moving", { who: person.name, was: `${dayWord(moving.serviceDate, t)} ${slotClock(moving.slotStart)}` });

  if (done !== null) {
    const d = (doctors ?? []).find((x) => x.id === done.a.doctorId) ?? doctor;
    return (
      <Modal visible animationType="slide" onRequestClose={() => onDone(done.a, done.kind)}>
        <View style={{ flex: 1, backgroundColor: color.paper }} testID="book-done">
          <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.xl, gap: space.lg }}>
            <View style={[s.card, { alignItems: "center", borderColor: color.greenLine, backgroundColor: color.greenSoft }]}>
              <Text style={[type.heading, { color: color.green }]} testID="book-done-word">{t(done.kind === "booked" ? "mobile.counter.appt.booked" : "mobile.counter.appt.moved")}</Text>
              <View style={s.head}>
                <Text style={s.big} testID="book-done-when">{slotClock(done.a.slotStart)}</Text>
                {done.a.mode === "tele" && <TeleMark label={t("mobile.counter.appt.tele")} size={26} />}
              </View>
              <Text style={[type.heading, { color: color.ink }]}>{dayWord(done.a.serviceDate, t)}</Text>
              <Text style={[type.body, { color: color.ink, fontWeight: "700", marginTop: space.sm, textAlign: "center" }]}>{d?.displayName ?? ""}</Text>
              <Text style={[s.dim, { textAlign: "center" }]}>{[deptNameOf(done.a.departmentId), roomCode === null ? null : t("mobile.counter.appt.room", { room: roomCode })].filter((x) => x !== null && x !== "").join(" · ")}</Text>
              {done.a.appointmentNo != null && <Text style={[s.dim, { fontFamily: MONO, marginTop: 4 }]} testID="book-done-no">{done.a.appointmentNo}</Text>}
            </View>
            <Text style={[type.body, { color: color.ink }]}>{person.name}</Text>
            {done.a.mode !== "tele" && <Note tone="info" testID="book-done-fee">{t(terms?.consultFeeOff === true ? "mobile.counter.appt.feeOff" : "mobile.counter.appt.feeLater", { amount: SAMAJ_SEVA_AMOUNT })}</Note>}
            <Text style={s.dim}>{t("mobile.counter.appt.tell")}</Text>
          </ScrollView>
          <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
            <Button testID="book-done-close" label={t("mobile.counter.appt.doneClose")} onPress={() => onDone(done.a, done.kind)} />
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.paper }} testID="book">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl * 2, gap: space.md }}>
          <View>
            <Text style={[type.heading, { color: color.ink }]} testID="book-title">{title}</Text>
            {moving === null
              ? <Text style={s.dim}>{person.name}</Text>
              : <Text style={s.dim}>{t("registrationCounter.book.movingHint")}</Text>}
          </View>

          {doctorsFailed && (
            <View style={{ gap: space.sm }}>
              <Note tone="warn" testID="book-doctors-failed">{t("mobile.counter.appt.doctorsFailed")}</Note>
              <Button testID="book-doctors-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={readDoctors} />
            </View>
          )}
          {doctors === null && !doctorsFailed && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}

          {doctors !== null && (
            <>
              <Text style={s.lbl}>{t("mobile.counter.appt.department")}</Text>
              <View style={s.pills}>
                {withDoctors.map((d) => (
                  <Pill key={d.id} testID={`book-dept-${d.id}`} on={shownDept === d.id} label={d.name}
                    onPress={() => { if (unknown || shownDept === d.id) return; setDeptId(d.id); setDoctorId(null); setDate(null); setClosed(null); setPart(null); setPicked(null); setError(null); }} />
                ))}
              </View>
            </>
          )}

          {shownDept !== null && (
            <>
              <Text style={s.lbl}>{t("mobile.counter.appt.doctor")}</Text>
              {inDept.map((d) => {
                const on = d.id === doctorId;
                const beside = labelOf(d);
                return (
                  <Pressable key={d.id} testID={`book-doctor-${d.id}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => pickDoctor(d.id)}
                    style={[s.row, on && { borderColor: color.green, borderWidth: 2 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{d.displayName}</Text>
                      {beside !== null && <Text style={s.dim} numberOfLines={1}>{beside}</Text>}
                      {on && schedules !== null && (
                        <Text style={s.dim} testID="book-sits">
                          {sits.length === 0 ? t("mobile.counter.appt.sitsNever") : t("mobile.counter.appt.sits", { days: sits.map((w) => t(`mobile.counter.appt.wd.${w}`)).join(", ") })}
                        </Text>
                      )}
                    </View>
                    {on && <Text style={{ color: color.green, fontWeight: "700" }}>✓</Text>}
                  </Pressable>
                );
              })}
            </>
          )}

          {doctor !== null && (
            <>
              <Text style={s.lbl}>{t("mobile.counter.appt.day.title")}</Text>
              <View style={s.days} testID="book-days">
                {days.map((d) => {
                  const offer = offerOf(d);
                  const open = offer === null || offer.kind === "open";
                  const on = d === date;
                  return (
                    <Pressable key={d} testID={`book-day-${d}`} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !open }} onPress={() => pickDay(d)}
                      style={[s.day, on && { backgroundColor: color.green, borderColor: color.green }, !open && { backgroundColor: color.wash, borderStyle: "dashed" }]}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: on ? "#f2faf6" : open ? color.dim : color.faint }}>{d === today ? t("mobile.counter.appt.today") : t(`mobile.counter.appt.wd.${weekdayOf(d)}`)}</Text>
                      <Text style={{ fontSize: 15, fontWeight: "700", fontFamily: MONO, color: on ? "#f2faf6" : open ? color.ink : color.faint }}>{ddmm(d)}</Text>
                      <Text style={{ fontSize: 10.5, color: on ? "#f2faf6" : offer?.kind === "leave" ? color.gold : color.faint }}>
                        {offer === null ? " " : offer.kind === "open" ? offer.sessions.map((x) => x.startTime).join(" · ") : t(offer.kind === "leave" ? "mobile.counter.appt.day.leaveShort" : "mobile.counter.appt.day.noneShort")}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {!more && (
                <Pressable testID="book-more-days" accessibilityRole="button" onPress={() => setMore(true)} style={{ minHeight: TOUCH - 8, justifyContent: "center" }}>
                  <Text style={{ color: color.green, fontWeight: "700", fontSize: 14 }}>{t("mobile.counter.appt.day.more")}</Text>
                </Pressable>
              )}
              {closed !== null && <Note tone="warn" testID="book-day-closed">{closed}</Note>}
            </>
          )}

          {doctor !== null && date !== null && (
            <>
              <Text style={s.lbl}>{t("mobile.counter.appt.when", { day: dayWord(date, t) })}</Text>
              {slots === null && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}
              {slotsError !== null && (
                <View style={{ gap: space.sm }}>
                  <Note tone="bad" testID="book-slots-error">{slotsError}</Note>
                  <Button testID="book-slots-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={readSlots} />
                </View>
              )}
              {slots !== null && slotsError === null && slots.length === 0 && <Note tone="info" testID="book-no-slots">{t("mobile.counter.appt.noSlots", { doctor: doctor.displayName, day: dayWord(date, t) })}</Note>}
              {slots !== null && slots.length > 0 && (
                <>
                  <View style={s.two} testID="book-parts">
                    {DAY_PART_ORDER.map((p) => {
                      const c = counts[p];
                      const on = part === p;
                      const none = c.all === 0;
                      return (
                        <Pressable key={p} testID={`book-part-${p}`} accessibilityRole="button" accessibilityState={{ selected: on, disabled: none }} disabled={none || unknown}
                          onPress={() => { setPart(p); setClosed(null); if (picked !== null && dayPartOf(picked) !== p) setPicked(null); }}
                          style={[s.part, on && { borderColor: color.green, borderWidth: 2 }, none && { opacity: 0.45 }]}>
                          <Text style={{ fontSize: 20 }}>{p === "morning" ? "🌅" : p === "noon" ? "☀️" : "🌇"}</Text>
                          <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{t(`mobile.counter.appt.part.${p}`)}</Text>
                          <Text style={[type.small, { color: c.free > 0 ? color.green : color.faint, fontWeight: "600" }]} testID={`book-part-free-${p}`}>
                            {none ? t("mobile.counter.appt.part.none") : c.free === 0 ? t("mobile.counter.appt.part.full") : t("mobile.counter.appt.part.free", { count: c.free })}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {part !== null && (
                    <View style={s.pills} testID="book-slots">
                      {slots.filter((x) => dayPartOf(x.start) === part).map((x) => {
                        const taken = x.booked || x.past;
                        const on = picked === x.start;
                        return (
                          <Pressable key={x.start} testID={`book-slot-${slotClock(x.start)}`} accessibilityRole="button" accessibilityState={{ selected: on, disabled: taken }} disabled={taken || unknown}
                            onPress={() => { setPicked(x.start); setClosed(null); setError(null); }}
                            style={[s.slot, on && { backgroundColor: color.green, borderColor: color.green }, taken && { backgroundColor: color.wash }]}>
                            <Text style={{ fontFamily: MONO, fontSize: 16, fontWeight: "700", color: on ? "#f2faf6" : taken ? color.faint : color.ink, textDecorationLine: taken ? "line-through" : "none" }}>{slotClock(x.start)}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </>
              )}
            </>
          )}

          {slot !== null && doctor !== null && date !== null && (
            <View style={s.card} testID="book-confirm">
              <Text style={[type.tag, { color: color.dim, fontFamily: MONO }]}>{t("mobile.counter.appt.confirm")}</Text>
              <Text style={[type.heading, { color: color.ink }]} testID="book-confirm-when">{dayWord(date, t)} · {slotClock(slot.start)}–{slotClock(slot.end)}</Text>
              <Text style={[type.body, { color: color.ink }]}>{doctor.displayName}{labelOf(doctor) === null ? "" : ` · ${labelOf(doctor)}`}</Text>
              <Text style={s.dim}>{[deptNameOf(doctor.departmentId), roomCode === null ? null : t("mobile.counter.appt.room", { room: roomCode })].filter((x) => x !== null && x !== "").join(" · ")}</Text>
              {sameDay.length > 0 && (
                <Note tone="warn" testID="book-same-day">
                  {t("registrationCounter.book.alreadyBooked", { count: sameDay.length, name: person.name })} — {sameDay.map((a) => slotClock(a.slotStart)).join(" · ")}. {t("registrationCounter.book.alreadyBookedHint")}
                </Note>
              )}
              {crossDept && (
                <View style={{ gap: 6 }} testID="book-cross">
                  <Text style={[type.small, { color: color.ink, fontWeight: "700" }]}>{t("registrationCounter.move.apptCross", { from: deptNameOf(moving?.departmentId), to: deptNameOf(doctor.departmentId) })}</Text>
                  <TextInput testID="book-reason" style={s.input} value={reason} editable={!unknown} onChangeText={(v) => { setReason(v); setError(null); }}
                    placeholder={t("registrationCounter.move.reasonHint")} placeholderTextColor={color.faint} accessibilityLabel={t("registrationCounter.move.reasonHint")} />
                </View>
              )}
              {moving === null && (
                <TextInput testID="book-note" style={s.input} value={note} editable={!unknown} onChangeText={setNote} maxLength={300}
                  placeholder={t("mobile.counter.appt.noteHint")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.counter.appt.noteHint")} />
              )}
              {!tele && <Text style={s.dim} testID="book-fee">{t(terms?.consultFeeOff === true ? "mobile.counter.appt.feeOff" : "mobile.counter.appt.feeLater", { amount: SAMAJ_SEVA_AMOUNT })}</Text>}
            </View>
          )}
          {slot !== null && doctor !== null && date !== null && moving === null && (
            <View style={s.card} testID="book-how">
              <Text style={[type.tag, { color: color.dim, fontFamily: MONO }]}>{t("mobile.counter.appt.how")}</Text>
              <View style={[s.two, { marginTop: 4 }]} accessibilityRole="radiogroup">
                {(["in_person", "tele"] as const).map((m) => {
                  const on = mode === m;
                  return (
                    <Pressable key={m} testID={`book-mode-${m}`} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: unknown }} disabled={unknown}
                      onPress={() => { setMode(m); setError(null); }} style={[s.seg, on && { backgroundColor: color.green, borderColor: color.green }]}>
                      {m === "tele" && <TeleMark size={17} tint={on ? "#f2faf6" : color.blue} />}
                      <Text style={{ fontSize: 14, fontWeight: "700", color: on ? "#f2faf6" : color.ink }} numberOfLines={1}>{t(m === "tele" ? "mobile.counter.appt.tele" : "mobile.counter.appt.inPerson")}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {mode === "tele" && (
                <View style={{ gap: 4, marginTop: space.sm }}>
                  <Text style={s.dim}>{t("mobile.counter.appt.telePhone")}</Text>
                  <TextInput testID="book-tele-phone" style={[s.input, { fontFamily: MONO }]} value={telePhone} editable={!unknown} onChangeText={(v) => { setTelePhone(v); setError(null); }}
                    keyboardType="number-pad" maxLength={16} autoCorrect={false} accessibilityLabel={t("mobile.counter.appt.telePhone")} />
                  {!teleReady && <Text style={s.dim} testID="book-tele-hint">{t("mobile.counter.appt.telePhoneHint")}</Text>}
                </View>
              )}
            </View>
          )}
          {error !== null && <Note tone="bad" testID="book-error">{error}</Note>}
        </ScrollView>

        <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
          <Button testID="book-go" busy={busy} disabled={slot === null || !teleReady}
            label={unknown ? t("mobile.counter.appt.checkAgain") : slot === null ? t("mobile.counter.appt.pickFirst") : t(moving === null ? "mobile.counter.appt.go" : "mobile.counter.appt.goMove", { time: slotClock(slot.start), day: date === null ? "" : dayWord(date, t) })}
            onPress={() => { void go(); }} />
          {!unknown && (
            <Pressable testID="book-close" accessibilityRole="button" onPress={onClose} style={{ minHeight: TOUCH, justifyContent: "center", alignItems: "center" }}>
              <Text style={{ color: color.dim, fontWeight: "600", fontSize: 14 }}>{t(moving === null ? "mobile.back" : "mobile.counter.appt.leaveIt")}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE DESK'S LISTS — today's book, and the bookings a doctor's leave has stranded
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function DeskAppointments({ api, today, mayManage, onPick, onRebook, onClose }: {
  api: CounterApi; today: string; mayManage: boolean;
  onPick: (a: WireAppointment) => void;
  onRebook: (a: WireAppointment) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"today" | "rebook">("today");
  const [rows, setRows] = useState<WireAppointment[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [doctors, setDoctors] = useState<WireMasterDoctor[]>([]);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [stranded, setStranded] = useState<WireAppointment[] | null>(null);
  const [strandedFailed, setStrandedFailed] = useState(false);

  const read = useCallback(() => {
    setFailed(false);
    api.dayAppointments(today).then(
      (items) => { setRows(items); setAsOf(slotClock(new Date().toISOString())); },
      () => setFailed(true),
    );
  }, [api, today]);
  useEffect(() => { read(); api.doctors().then((r) => setDoctors(r.items), () => undefined); }, [api, read]);
  /*
    THE NUMBERS ARE READ ONLY WHEN THE LIST IS OPENED. `contact=true` records one disclosure per
    telephone number with its reason; reading it on every visit to this screen would bury the real
    disclosures under noise.
  */
  const readStranded = useCallback(() => {
    setStrandedFailed(false);
    api.needsRebooking().then((items) => setStranded(rebookingToday(items, today)), () => setStrandedFailed(true));
  }, [api, today]);
  useEffect(() => { if (tab === "rebook" && stranded === null) readStranded(); }, [tab, stranded, readStranded]);

  const now = new Date();
  const nameOfDoctor = (id: string): string => doctors.find((d) => d.id === id)?.displayName ?? "";
  const live = (rows ?? []).filter((a) => a.status !== "rescheduled");
  const inList = [...new Set(live.map((a) => a.doctorId))];
  const needle = q.trim().toLowerCase();
  const shown = bookOrder(live.filter((a) => (doctorId === null || a.doctorId === doctorId)
    && (needle === "" || whoOf(a, t).toLowerCase().includes(needle) || (a.patient?.uhid ?? "").toLowerCase().includes(needle))), now);
  const counts = bookCounts(live.filter((a) => doctorId === null || a.doctorId === doctorId), now);
  const tone = (state: string): string => (state === "missed" || state === "needs_rebooking" ? color.red : state === "waiting" ? color.green : state === "cancelled" ? color.faint : color.dim);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.paper }} testID="desk-appts">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl, gap: space.md }}>
          <Text style={[type.heading, { color: color.ink }]}>{t("mobile.counter.appt.deskTitle")}</Text>
          <View style={s.pills}>
            <Pill testID="desk-appts-tab-today" on={tab === "today"} label={t("mobile.counter.appt.tabToday")} onPress={() => setTab("today")} />
            {mayManage && <Pill testID="desk-appts-tab-rebook" on={tab === "rebook"} label={t("appointmentSeat.rail.needRebooking")} onPress={() => setTab("rebook")} />}
          </View>

          {tab === "today" && (
            <>
              {failed && (
                <View style={{ gap: space.sm }}>
                  <Note tone="warn" testID="desk-appts-failed">{t("mobile.counter.appt.readFailed")}</Note>
                  <Button testID="desk-appts-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={read} />
                </View>
              )}
              {rows === null && !failed && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}
              {rows !== null && (
                <>
                  <Text style={[type.body, { color: color.ink }]} testID="desk-appts-counts">
                    {t("mobile.counter.appt.counts", { arrived: counts.checkedIn, toArrive: counts.toArrive, missed: counts.missed })}
                    {asOf === null ? "" : ` · ${t("mobile.counter.appt.asOf", { time: asOf })}`}
                  </Text>
                  <TextInput testID="desk-appts-q" style={s.input} value={q} onChangeText={setQ} autoCapitalize="none" autoCorrect={false}
                    placeholder={t("mobile.counter.appt.search")} placeholderTextColor={color.faint} accessibilityLabel={t("mobile.counter.appt.search")} />
                  {inList.length > 1 && (
                    <View style={s.pills}>
                      <Pill testID="desk-appts-doc-all" on={doctorId === null} label={t("mobile.counter.appt.allDoctors")} onPress={() => setDoctorId(null)} />
                      {inList.map((id) => <Pill key={id} testID={`desk-appts-doc-${id}`} on={doctorId === id} label={nameOfDoctor(id) || id} onPress={() => setDoctorId(id)} />)}
                    </View>
                  )}
                  {shown.length === 0 && <Text style={s.dim} testID="desk-appts-none">{t(live.length === 0 ? "mobile.counter.appt.noneToday" : "mobile.counter.appt.noMatch")}</Text>}
                  {shown.map((a) => {
                    const state = rowStateOf(a, now);
                    return (
                      <Pressable key={a.id} testID={`desk-appt-${a.id}`} accessibilityRole="button" onPress={() => onPick(a)} style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}>
                        <Text style={{ fontFamily: MONO, fontSize: 15, fontWeight: "700", color: color.ink, width: 54 }}>{slotClock(a.slotStart)}</Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[type.body, { color: color.ink, fontWeight: "700" }]} numberOfLines={1}>{whoOf(a, t)}</Text>
                          <Text style={s.dim} numberOfLines={1}>{nameOfDoctor(a.doctorId)}</Text>
                        </View>
                        {a.mode === "tele" && <TeleMark testID={`desk-appt-tele-${a.id}`} label={t("mobile.counter.appt.tele")} />}
                        <Text testID={`desk-appt-state-${a.id}`} style={[s.state, { color: tone(state), borderColor: tone(state) }]}>{t(`mobile.counter.appt.state.${state}`)}</Text>
                      </Pressable>
                    );
                  })}
                </>
              )}
            </>
          )}

          {tab === "rebook" && (
            <>
              {strandedFailed && (
                <View style={{ gap: space.sm }}>
                  <Note tone="warn" testID="rebook-failed">{t("mobile.counter.appt.readFailed")}</Note>
                  <Button testID="rebook-retry" kind="secondary" label={t("mobile.vitals.retry")} onPress={readStranded} />
                </View>
              )}
              {stranded === null && !strandedFailed && <Text style={s.dim}>{t("mobile.counter.reading")}</Text>}
              {stranded !== null && stranded.length === 0 && <Text style={s.dim} testID="rebook-none">{t("appointmentSeat.rail.nothingToMove")}</Text>}
              {stranded !== null && stranded.length > 0 && <Text style={[type.body, { color: color.ink }]} testID="rebook-count">{t("mobile.counter.appt.rebookCount", { count: stranded.length })}</Text>}
              {(stranded ?? []).map((a) => {
                const phone = a.patient?.phone ?? null;
                return (
                  <View key={a.id} style={[s.card, { borderColor: color.goldLine, backgroundColor: color.goldSoft }]} testID={`rebook-${a.id}`}>
                    <View style={s.head}>
                      <Text style={[type.body, { color: color.ink, fontWeight: "700", flexShrink: 1 }]}>{whoOf(a, t)}</Text>
                      {a.mode === "tele" && <TeleMark testID={`rebook-tele-${a.id}`} label={t("mobile.counter.appt.tele")} />}
                    </View>
                    <Text style={s.dim}>{t("mobile.counter.appt.was", { when: `${dayWord(a.serviceDate, t)} ${slotClock(a.slotStart)}`, doctor: nameOfDoctor(a.doctorId) })}</Text>
                    <Text style={[s.dim, { fontFamily: MONO }]} testID={`rebook-phone-${a.id}`}>{phone ?? t("appointmentSeat.rail.noPhone")}</Text>
                    <View style={[s.two, { marginTop: space.sm }]}>
                      {phone !== null && <View style={{ flex: 1 }}><Button testID={`rebook-call-${a.id}`} kind="secondary" label={t("mobile.counter.appt.call")} onPress={() => { void Linking.openURL(`tel:${phone}`).catch(() => undefined); }} /></View>}
                      <View style={{ flex: 1 }}><Button testID={`rebook-go-${a.id}`} label={t("mobile.counter.appt.rebook")} onPress={() => onRebook(a)} /></View>
                    </View>
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>
        <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
          <Button testID="desk-appts-close" kind="secondary" label={t("mobile.back")} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  dim: { ...type.small, color: color.dim },
  lbl: { ...type.tag, color: color.dim, fontFamily: MONO, marginTop: space.sm },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 12, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  input: { minHeight: TOUCH + 4, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: color.ink },
  two: { flexDirection: "row", gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  seg: { flex: 1, minHeight: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, paddingHorizontal: 6 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  days: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  day: { width: "23.4%", minHeight: TOUCH + 14, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, paddingVertical: 4 },
  part: { flex: 1, minHeight: 92, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, padding: space.sm },
  slot: { minWidth: 76, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, paddingHorizontal: 10 },
  state: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  big: { fontFamily: MONO, fontSize: 44, fontWeight: "700", color: color.ink, letterSpacing: 1 },
  bar: { paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
});
