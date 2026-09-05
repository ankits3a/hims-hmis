import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { SlotBoardEmptyState, SlotGrid, SlotLegend } from "../components/slot-board";
import { PatientPicker } from "../components/patient-picker";
import { usePatientInHand } from "../lib/patient-in-hand";
import { useAuth } from "../lib/auth";
import { bookCounts, bookOrder, rebookingToday, rowStateOf, slotClock } from "../lib/appointment-view";
import type { RowState } from "../lib/appointment-view";
import {
  bookAppointment, cancelAppointment, checkInAppointment, getSlots, listDayAppointments,
  listDoctors, listLeaves, listNeedsRebooking, listRooms, opdErrorMessage, patientTimeline,
  rescheduleAppointment, todayIst,
} from "../lib/opd-api";
import type { WireAppointment, WireDoctor, WireSlot } from "../lib/opd-api";
import type { PatientPickerHit } from "../components/patient-picker";
import { dayMonthIst } from "../lib/format";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 2 — `/appointment`, THE APPOINTMENT CLERK'S SEAT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Artboard: `docs/design/2026-09-03-front-desk-three-seats/Appointment.dc.html`, signed off.
 * Keys: `…/Keymap.dc.html` §appointment — Search → Doctor → Day → Slot grid → Confirm.
 *
 * ═══ WHAT THIS SEAT IS, AND HOW IT DIFFERS FROM `/opd/appointments` ═══
 *
 * `/opd/appointments` is the SUPERVISOR's read: gated on `opd.appointments.read`, it browses the
 * book for any doctor on any day. This seat is gated on `opd.appointments.manage` — the WRITE — and
 * it is organised around one patient at a time: who is this, when can they come, book it, and
 * whose appointments did today's leave just destroy.
 *
 * ═══ THE REBOOKING RAIL IS THE POINT OF THE SCREEN ═══
 *
 * It is, in the artboard's own words, *"the only screen in the product that can answer 'the doctor
 * is away — who do I have to call?'"*. Everything else here exists on some other surface; that
 * question does not. Two things had to be built for it and both are recorded where they live:
 * a phone number per row (`getPatientSummaries`'s opt-in `withContact`, audited, restricted rows
 * excluded) and a date bound (`rebookingToday`, because the server read has none and returns every
 * such row ever created).
 *
 * ═══ IT WEARS `.pp` INSIDE THE SHELL ═══
 *
 * Same reasoning as `/registration`: this is one seat of three and its clerk still needs the nav.
 * See `components/paper-screen.tsx` for why the artboard's own header bar becomes a screen title.
 */

/* ── the rail ────────────────────────────────────────────────────────────────────────────────── */

/**
 * "Their history" — the five rows that tell a clerk whether this person actually turns up.
 *
 * Lifted from `desk-one/dossier.tsx`'s private `History`, which draws exactly this and could not be
 * reused because it read `useDesk()` for the surrounding dossier. Prop-driven here.
 */
function History({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const timeline = useQuery({
    queryKey: ["appt-history", patientId],
    queryFn: () => patientTimeline(patientId),
    staleTime: 60_000,
  });
  const rows = (timeline.data?.items ?? []).slice(0, 5);
  if (rows.length === 0) {
    return <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("appointmentSeat.rail.noHistory")}</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {rows.map((item) => (
        <div key={item.encounterId} style={{ display: "flex", alignItems: "baseline", gap: 9, fontSize: 11.5 }}>
          <span className="mo" style={{ width: 56, flexShrink: 0, color: "var(--dim)" }}>{dayMonthIst(item.openedAt)}</span>
          <span style={{ flexGrow: 1, minWidth: 0, color: "var(--dim)" }}>
            {[item.doctorName, item.departmentName].filter((x) => x !== null).join(" · ")}
          </span>
          {/* The state pill the artboard draws — whether they actually turned up, which is the
              whole reason a booking clerk reads a history at all. */}
          <span className={item.status === "completed" ? "pill" : item.status === "abandoned" ? "pill gd" : "pill on"}>
            {t(`appointmentSeat.history.${item.status === "completed" ? "seen" : item.status === "abandoned" ? "missed" : "open"}`)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── the screen ──────────────────────────────────────────────────────────────────────────────── */

export function AppointmentSeat(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { inHand, takePatient, release } = usePatientInHand();
  const inHandId = inHand?.patientId ?? null;
  /*
    THE PICKED ROW IS HELD, NOT RE-FETCHED. `GET /patients/:id` writes a PHI-access row per call, so
    a rail that resolved the name on every render would bury the real disclosures in its own noise —
    the same reasoning that made the rebooking rail a batched opt-in rather than N× that route. The
    picker already returned the name and UHID; this keeps them.
  */
  const [whoPicked, setWhoPicked] = useState<PatientPickerHit | null>(null);

  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(() => {
    /* Tomorrow, in IST — a booking seat opens on the first day it can actually book. */
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 86_400_000));
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; who: string; was: string } | null>(null);
  const [cancelling, setCancelling] = useState<{ id: string; reason: string } | null>(null);
  const [log, setLog] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  /*
    `PatientPicker` owns its own input and exposes no ref, so `Esc` focuses through the WRAPPER —
    the picker's box is the thing the header button promises to return the cursor to, and reaching
    into another component's DOM is cheaper here than widening its props for one caller.
  */
  const pickerRef = useRef<HTMLDivElement>(null);

  const note = useCallback((text: string, kind: AgentLine["kind"] = "did"): void => {
    setLog((prev) => logged(prev, text, kind));
  }, []);

  /* ── who are we booking for ──────────────────────────────────────────────────────────────── */

  /* ── the doctor master, NOT today's board ────────────────────────────────────────────────── */

  /*
    FD-22's finding, kept: a future booking must see every doctor. `GET /opd/queues/summary` is
    TODAY's board, so a doctor not sitting today could not be booked for next week — the one thing a
    future booking is for. The MASTER is the right source for "who can be booked on a date that is
    not today".
  */
  const doctors = useQuery({ queryKey: ["all-doctors"], queryFn: listDoctors, staleTime: 5 * 60_000 });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: listRooms, staleTime: 5 * 60_000 });
  const active = useMemo(() => (doctors.data?.items ?? []).filter((d) => d.active), [doctors.data]);
  const chosen: WireDoctor | null = useMemo(
    () => active.find((d) => d.id === doctorId) ?? active[0] ?? null,
    [active, doctorId],
  );
  const activeDoctorId = chosen?.id ?? "";

  const slots = useQuery({
    queryKey: ["slots", activeDoctorId, date],
    queryFn: () => getSlots(activeDoctorId, date),
    enabled: activeDoctorId !== "",
  });
  const all: WireSlot[] = slots.data?.slots ?? [];
  const free = all.filter((s) => !s.booked && !s.past);
  /*
    ═══ THE HELD SLOT IS RESOLVED AGAINST THE BOARD, NOT REMEMBERED ═══

    `picked` is an ISO string kept in state, and it outlives the board it was chosen on: the doctor
    and the day are separate state, the slots are a query keyed on both, and every road that moves
    either one has to remember to drop the pick. Two roads did not, and the failure was invisible in
    exactly the way that matters — `SlotGrid` can only highlight a start it is RENDERING, so the
    board showed nothing held while the confirm button stayed live and `commit` posted `picked`,
    never `date`. The server derives `serviceDate` FROM the slot it is handed, so a move onto a day
    the screen was no longer showing succeeded silently whenever the new doctor sat the same clock
    time, and was an unexplainable `invalid_slot` refusal when they did not.

    Clearing the pick on each road closes those two roads. THIS closes the rule — you may only
    commit a slot the board is offering — and it holds for a road nobody has written yet, and for
    the board changing under a held slot (another clerk takes it while the refresh is in flight).
    It is the sibling booking stage's guard, `all.find((x) => x.start === picked)` in
    `desk-one/stages.tsx`, which this seat was built without. Resolved against `free` rather than
    `all` because a slot that has been taken or has gone past is not a slot this screen may promise.
  */
  const held: WireSlot | null = free.find((s) => s.start === picked) ?? null;

  /*
    THE ROOM IS DERIVED, NEVER CHOSEN. The artboard shows "OPD-1 · Ground" as a fact about the
    schedule, and offering a room picker would let a clerk book a doctor into a room they are not
    sitting in — the schedule owns that pairing and the screen only reports it.
  */
  const roomLabel = useMemo(() => {
    const roomId = all[0]?.roomId;
    if (roomId === undefined) return null;
    const room = (rooms.data?.items ?? []).find((r) => r.id === roomId);
    return room === undefined ? null : `${room.code}${room.floor === null || room.floor === "" ? "" : ` · ${room.floor}`}`;
  }, [all, rooms.data]);

  /* ── the day's book, and the leave cascade ───────────────────────────────────────────────── */

  const book = useQuery({
    queryKey: ["day-book", activeDoctorId, date],
    queryFn: () => listDayAppointments(activeDoctorId, date),
    enabled: activeDoctorId !== "",
    refetchInterval: 30_000,
  });
  const bookRows = useMemo(() => bookOrder(book.data?.items ?? []), [book.data]);
  const counts = useMemo(() => bookCounts(book.data?.items ?? []), [book.data]);

  const rebooking = useQuery({
    queryKey: ["needs-rebooking"],
    /*
      `contact=true` — the numbers this rail exists to show. The server accepts it ONLY here, and
      records one PHI-access row per number with the reason attached. See `listNeedsRebooking`.
    */
    queryFn: () => listNeedsRebooking(true),
    refetchInterval: 60_000,
  });
  const toCall = useMemo(
    () => rebookingToday(rebooking.data?.items ?? [], todayIst()),
    [rebooking.data],
  );

  const leaves = useQuery({
    queryKey: ["leaves-week"],
    queryFn: () => listLeaves({ status: "scheduled", from: todayIst() }),
    staleTime: 5 * 60_000,
  });
  const leaveCount = leaves.data?.items.length ?? 0;

  /* ── writing ─────────────────────────────────────────────────────────────────────────────── */

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["slots"] }),
      qc.invalidateQueries({ queryKey: ["day-book"] }),
      qc.invalidateQueries({ queryKey: ["needs-rebooking"] }),
    ]);
  }, [qc]);

  const commit = useCallback(async (): Promise<void> => {
    /*
      `POST /opd/appointments` TAKES NO IDEMPOTENCY KEY — unlike `walkIn`. A double-click fires two
      bookings and the second gets `slot_taken` off the insert's `onConflictDoNothing`, which is a
      refusal the clerk did not cause and cannot act on. The ref is the guard; `busy` is only the
      affordance, because two clicks in one React tick both observe `busy === false`.
    */
    if (held === null || chosen === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (moving !== null) {
        await rescheduleAppointment(moving.id, held.start, chosen.id);
        note(t("appointmentSeat.log.moved", { who: moving.who, from: moving.was, to: slotClock(held.start) }), "ok");
        setMoving(null);
      } else {
        /*
          ═══ THE BOOKING GOES TO THE CARD, NOT TO SESSION STORAGE ═══

          This seat holds two ideas of "who". `inHand` is app-wide, lives in sessionStorage and
          survives a route change; `whoPicked` is the "Booking for" card this rail draws. They come
          apart on three roads, and on every one of them the rail reads "Nobody picked yet" while
          somebody is still in hand: arriving from `/counter`, a rebooking-rail row, and a row's
          Rebook — the last two take a patient in hand precisely so the MOVE knows who it is for,
          and blank the card as they do it. Booking `inHandId` there books a patient this screen is
          not showing, and the confirm button's own label names a time and a doctor and no patient,
          so nothing in this seat contradicted the write.

          `/registration` closed the identical hole in its close pass 2 — `registration.tsx` posted
          `{ existingId: held.id }` while somebody else's details were on screen — and its ruling
          applies here: the write goes to what is displayed, and being wrong in the safe direction
          costs one search.

          A STOPGAP, AND SAID SO. The shell's `PatientStrip` DOES resolve the in-hand id live, so
          after a handover from `/counter` the strip names Ramesh at the top of the screen while
          this button now answers "Pick the patient first". That contradiction is the safe half of a
          handover that was already broken in its visible half. The proper repair is for this rail
          to render the in-hand id as a card — reusing the strip's own query key, which costs no
          extra request and no extra PHI-access row — and it is a design decision about this seat's
          arrival path, not a bug fix. Until it is taken, the refusal is the honest half.
        */
        if (whoPicked === null) { setError(t("appointmentSeat.errors.noPatient")); return; }
        await bookAppointment({ patientId: whoPicked.id, doctorId: chosen.id, slotStart: held.start });
        note(t("appointmentSeat.log.booked", { time: slotClock(held.start), doctor: chosen.displayName }), "ok");
      }
      setPicked(null);
      await refresh();
    } catch (e) {
      const message = opdErrorMessage(e);
      setError(message);
      note(message, "err");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [held, chosen, moving, whoPicked, note, t, refresh]);
  const inFlight = useRef(false);

  /*
    ROW REFUSALS BELONG UNDER THE ROW, KEYED BY APPOINTMENT ID. FD-22 ruled the placement and the
    reason is that two rows must not be able to show each other's answer: a page banner reading
    "this appointment is not today" beside eight rows names none of them.
  */
  const rowAct = useCallback(async (id: string, fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setRowError((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      await fn();
      note(ok, "ok");
      await refresh();
    } catch (e) {
      const message = opdErrorMessage(e);
      setRowError((prev) => ({ ...prev, [id]: message }));
      note(message, "err");
    }
  }, [note, refresh]);

  /* ── keyboard ────────────────────────────────────────────────────────────────────────────── */

  const backToSearch = useCallback((): void => {
    const input = pickerRef.current?.querySelector("input");
    if (input !== null && input !== undefined) { input.focus(); input.select(); }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        /* Once returns the cursor; twice releases the patient — the Keymap's own two-step. */
        if (document.activeElement === pickerRef.current?.querySelector("input") && inHandId !== null) { release(); setWhoPicked(null); }
        else backToSearch();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void commit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); };
  }, [backToSearch, commit, inHandId, release]);

  /* ── the co-pilot ────────────────────────────────────────────────────────────────────────── */

  const ask = useCallback((question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    if (q.includes("call") || q.includes("rebook") || q.includes("leave")) {
      setAnswer(toCall.length === 0
        ? t("appointmentSeat.agent.nothingToMove")
        : t("appointmentSeat.agent.toCall", { count: toCall.length }));
    } else if (q.includes("free") || q.includes("slot") || q.includes("when")) {
      setAnswer(activeDoctorId === ""
        ? t("appointmentSeat.agent.noDoctor")
        : t("appointmentSeat.agent.freeSlots", { count: free.length, doctor: chosen?.displayName ?? "", date }));
    } else if (q.includes("missed") || q.includes("arrive") || q.includes("book")) {
      setAnswer(t("appointmentSeat.agent.counts", { ...counts }));
    } else {
      setAnswer(t("appointmentSeat.agent.scope"));
    }
  }, [toCall, activeDoctorId, free.length, chosen, date, counts, t]);

  /*
    THE ONE THING THE BAR OFFERS TO DO. Not a model: it reads the rebooking rail and the free-slot
    count that are already on this screen, and drafting is a LOCAL act — it writes the call list
    into the log where the clerk can work down it. Nothing is sent and nothing is promised.
  */
  const draftCalls = useCallback((): void => {
    for (const a of toCall) {
      const who = a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted");
      const phone = a.patient?.phone ?? null;
      note(t("appointmentSeat.log.call", {
        who,
        phone: phone ?? t("appointmentSeat.rail.noPhone"),
        was: `${dayMonthIst(a.slotStart)} ${slotClock(a.slotStart)}`,
      }), "warn");
    }
    setAnswer(t("appointmentSeat.agent.drafted", { count: toCall.length }));
  }, [toCall, note, t]);

  /* ── render ──────────────────────────────────────────────────────────────────────────────── */

  const who = whoPicked;
  const canCheckIn = can("opd.visits.open");

  return (
    <PaperScreen testId="appointment-seat">
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", padding: "18px 22px", gap: 14, minWidth: 0 }}>
        <ScreenTitle
          title={t("appointmentSeat.header.title")}
          route="/appointment"
          actions={
            <>
              <span
                className={leaveCount === 0 ? "pill on" : "pill gd"}
                data-testid="leave-pill"
              >
                {leaveCount === 0
                  ? t("appointmentSeat.header.noLeave")
                  : t("appointmentSeat.header.leaveDeclared", { count: leaveCount })}
              </span>
              <button className="sec" type="button" data-testid="focus-search" onClick={backToSearch} style={{ gap: 9 }}>
                <span>{t("appointmentSeat.header.backToSearch")}</span>
                <span className="kb">Esc</span>
              </button>
            </>
          }
        />

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* ═══ THE RAIL ═══ */}
          <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column", gap: 13 }}>
            <div className="box" style={{ padding: 14 }}>
              <span className="tag">{t("appointmentSeat.rail.bookingFor")}</span>
              {who === null ? (
                <>
                  <p data-testid="rail-empty" style={{ margin: "9px 0 9px", color: "var(--faint)", fontSize: 12.5 }}>
                    {t("appointmentSeat.rail.nobodyYet")}
                  </p>
                  <div ref={pickerRef}><PatientPicker onPick={(p) => { takePatient(p.id); setWhoPicked(p); }} autoFocus /></div>
                </>
              ) : (
                <>
                  <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span data-testid="rail-name" style={{ fontSize: 16, fontWeight: 600, lineHeight: "20px" }}>{who.name}</span>
                    <span className="mo" style={{ fontSize: 12.5, color: "var(--dim)" }}>{who.uhid}</span>
                  </div>
                  <div style={{ marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line2)" }}>
                    <span className="tag">{t("appointmentSeat.rail.theirHistory")}</span>
                    <History patientId={who.id} />
                  </div>
                </>
              )}
            </div>

            {/* ═══ THE REBOOKING RAIL — the reason this screen exists ═══ */}
            <div className="box" style={{ padding: 14 }} data-testid="rebooking-rail">
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="tag">{t("appointmentSeat.rail.needRebooking")}</span>
                <span
                  className={toCall.length === 0 ? "pill" : "pill rd"}
                  data-testid="rebooking-count"
                  style={{ marginLeft: "auto" }}
                >
                  {toCall.length === 0
                    ? t("appointmentSeat.rail.none")
                    : t("appointmentSeat.rail.patients", { count: toCall.length })}
                </span>
              </div>
              {toCall.length === 0 ? (
                <p style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--faint)" }}>
                  {t("appointmentSeat.rail.nothingToMove")}
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 9 }}>
                  {toCall.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="drow"
                      data-testid={`rebook-${a.id}`}
                      onClick={() => {
                        takePatient(a.patientId);
                        setWhoPicked(null);
                        setDoctorId(a.doctorId);
                        setDate(a.serviceDate);
                        /*
                          THE HELD SLOT DIES WITH THE DAY IT BELONGED TO. Every other road that
                          moves this board clears it — the doctor select, the date input, "Stop
                          moving" — and this row moves the doctor AND the day in one click. A pick
                          carried across it belongs to a board nobody is looking at any more.
                        */
                        setPicked(null);
                        setMoving({
                          id: a.id,
                          who: a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted"),
                          was: slotClock(a.slotStart),
                        });
                        note(t("appointmentSeat.log.moving", { who: a.patient?.name ?? "" }));
                      }}
                      style={{ flexDirection: "column", alignItems: "stretch", gap: 2, textAlign: "left" }}
                    >
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 500, flexGrow: 1, minWidth: 0 }}>
                          {a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted")}
                        </span>
                        {/*
                          THE NUMBER IS THE POINT. A restricted row carries none by design — if the
                          name is sealed the contact is sealed with it — and the copy says so rather
                          than rendering a blank column a clerk would read as a data error.
                        */}
                        <span className="mo" style={{ fontSize: 11, color: "var(--dim)", flexShrink: 0 }}>
                          {a.patient?.phone ?? t("appointmentSeat.rail.noPhone")}
                        </span>
                      </span>
                      <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                        {dayMonthIst(a.slotStart)} {slotClock(a.slotStart)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ═══ THE WORKSPACE ═══ */}
          <div style={{ flexGrow: 1, minWidth: 340, display: "flex", flexDirection: "column", gap: 14 }}>

            {/* ── BOOK A SLOT ── */}
            <div className="box" style={{ padding: "15px 16px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t("appointmentSeat.book.heading")}</span>
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("appointmentSeat.book.subtitle")}</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 13, marginTop: 12 }}>
                <div>
                  <label className="tag" htmlFor="appt-doctor" style={{ display: "block", marginBottom: 5 }}>
                    {t("appointmentSeat.book.doctor")}
                  </label>
                  <select
                    id="appt-doctor" className="in" data-testid="appt-doctor" style={{ height: 40 }}
                    value={activeDoctorId}
                    onChange={(e) => { setDoctorId(e.target.value); setPicked(null); }}
                  >
                    {active.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="tag" htmlFor="appt-date" style={{ display: "block", marginBottom: 5 }}>
                    {t("appointmentSeat.book.day")}
                  </label>
                  <input
                    id="appt-date" className="in mo" type="date" data-testid="appt-date" style={{ height: 40 }}
                    value={date}
                    onChange={(e) => { setDate(e.target.value); setPicked(null); }}
                  />
                </div>
                <div>
                  <span className="tag" style={{ display: "block", marginBottom: 5 }}>{t("appointmentSeat.book.room")}</span>
                  <div
                    data-testid="appt-room"
                    style={{ height: 40, display: "flex", alignItems: "center", fontSize: 13, color: "var(--dim)" }}
                  >
                    {roomLabel ?? t("appointmentSeat.book.noRoom")}
                  </div>
                </div>
              </div>

              {/* ── THE SLOT BOARD ── */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 10 }}>
                  <span className="tag">{t("appointmentSeat.book.theSlots")}</span>
                  <span style={{ fontSize: 11, color: "var(--faint)" }}>
                    {held === null
                      ? t("appointmentSeat.book.nothingHeld")
                      : t("appointmentSeat.book.held", { time: slotClock(held.start) })}
                  </span>
                  <SlotLegend />
                </div>
                <SlotBoardEmptyState loading={slots.isFetching} total={all.length} free={free.length} />
                <SlotGrid slots={all} picked={picked} onPick={setPicked} disabled={chosen === null} />
              </div>

              {moving === null ? null : (
                <p data-testid="moving-banner" className="pill gd" style={{ height: "auto", padding: "8px 11px", marginTop: 12 }}>
                  {t("appointmentSeat.book.moving", { who: moving.who, was: moving.was })}
                </p>
              )}
              {error === null ? null : (
                <p data-testid="appt-error" className="pill rd" style={{ height: "auto", padding: "8px 11px", marginTop: 12 }}>{error}</p>
              )}

              {/* ── THE COMMIT ROW. A booking is a promise about a time. ── */}
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--line2)", flexWrap: "wrap" }}>
                <button
                  className="pri"
                  type="button"
                  data-testid={moving === null ? "confirm-slot" : "confirm-move"}
                  disabled={held === null || busy || chosen === null}
                  onClick={() => { void commit(); }}
                >
                  {/*
                    THE KEYCAP MUST NOT LIE. Both the affordance and the label are the RESOLVED
                    slot, not the remembered one, so a button that offers to book 09:50 is a button
                    whose 09:50 is on the board underneath it.
                  */}
                  {held === null
                    ? t("appointmentSeat.book.pickFirst")
                    : moving === null
                      ? t("appointmentSeat.book.confirm", { time: slotClock(held.start), doctor: chosen?.displayName ?? "" })
                      : t("appointmentSeat.book.confirmMove", { who: moving.who, time: slotClock(held.start) })}
                  <span className="kb" style={{ borderColor: "rgba(255,255,255,.3)", background: "transparent", color: "#cfe8dc" }}>
                    Ctrl ⏎
                  </span>
                </button>
                {moving === null ? null : (
                  <button className="sec" type="button" data-testid="cancel-move" onClick={() => { setMoving(null); setPicked(null); }}>
                    {t("appointmentSeat.book.stopMoving")}
                  </button>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--faint)" }}>
                  {held === null ? t("appointmentSeat.book.notHeldYet") : t("appointmentSeat.book.confirmsBy")}
                </span>
              </div>
            </div>

            {/* ── TODAY'S BOOK ── */}
            <div className="box" style={{ padding: "15px 16px" }} data-testid="days-book">
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t("appointmentSeat.day.heading")}</span>
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
                  {dayMonthIst(`${date}T00:00:00.000Z`)} · {chosen?.displayName ?? ""}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <span className="pill on" data-testid="count-checked-in">{t("appointmentSeat.day.checkedIn", { count: counts.checkedIn })}</span>
                  <span className="pill gd" data-testid="count-to-arrive">{t("appointmentSeat.day.toArrive", { count: counts.toArrive })}</span>
                  <span className={counts.missed === 0 ? "pill" : "pill rd"} data-testid="count-missed">
                    {t("appointmentSeat.day.missed", { count: counts.missed })}
                  </span>
                </span>
              </div>

              <div style={{ display: "flex", gap: 11, padding: "7px 11px", marginTop: 11, background: "var(--wash)", borderRadius: 6 }}>
                <span className="tag" style={{ width: 52 }}>{t("appointmentSeat.day.time")}</span>
                <span className="tag" style={{ flexGrow: 1 }}>{t("appointmentSeat.day.patient")}</span>
                <span className="tag" style={{ width: 96 }}>{t("appointmentSeat.day.status")}</span>
                <span className="tag" style={{ width: 120, textAlign: "right" }}>{t("appointmentSeat.day.action")}</span>
              </div>

              {bookRows.length === 0 ? (
                <p data-testid="book-empty" style={{ margin: "11px 0 0", fontSize: 12, color: "var(--faint)" }}>
                  {t("appointmentSeat.day.empty")}
                </p>
              ) : bookRows.map((a) => <BookRow
                key={a.id}
                appointment={a}
                canCheckIn={canCheckIn}
                error={rowError[a.id]}
                onCheckIn={() => { void rowAct(a.id, () => checkInAppointment(a.id), t("appointmentSeat.log.checkedIn", { who: a.patient?.name ?? "" })); }}
                onRebook={() => {
                  takePatient(a.patientId);
                  setWhoPicked(null);
                  /* Same rule as the rail row, and Desk One's: a new move starts with nothing held. */
                  setPicked(null);
                  setMoving({ id: a.id, who: a.patient?.name ?? t("appointmentSeat.rail.restricted"), was: slotClock(a.slotStart) });
                }}
                onCancel={() => { setCancelling({ id: a.id, reason: "" }); }}
              />)}

              {/* CANCELLING IS TWO DELIBERATE ACTS AND A REASON — the server requires one, and so should the screen. */}
              {cancelling === null ? null : (
                <div style={{ marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line2)", display: "flex", gap: 9, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ flexGrow: 1, minWidth: 200 }}>
                    <label className="tag" htmlFor="cancel-reason" style={{ display: "block", marginBottom: 5 }}>
                      {t("appointmentSeat.day.cancelReason")}
                    </label>
                    <input
                      id="cancel-reason" className="in" data-testid="cancel-reason" autoFocus
                      value={cancelling.reason}
                      onChange={(e) => { setCancelling({ ...cancelling, reason: e.target.value }); }}
                    />
                  </div>
                  <button
                    className="sec" type="button" data-testid="cancel-confirm"
                    disabled={cancelling.reason.trim() === ""}
                    onClick={() => {
                      const { id, reason } = cancelling;
                      setCancelling(null);
                      void rowAct(id, () => cancelAppointment(id, reason.trim()), t("appointmentSeat.log.cancelled"));
                    }}
                  >
                    {t("appointmentSeat.day.cancelConfirm")}
                  </button>
                  <button className="sec" type="button" data-testid="cancel-abandon" onClick={() => { setCancelling(null); }}>
                    {t("appointmentSeat.day.cancelAbandon")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("appointmentSeat.agent.placeholder")}
        idle={toCall.length === 0
          ? t("appointmentSeat.agent.idleQuiet")
          : t("appointmentSeat.agent.idleCalls", { count: toCall.length, free: free.length })}
        {...(toCall.length === 0
          ? {}
          : { action: { label: t("appointmentSeat.agent.draftCalls"), onAct: draftCalls } })}
      />
    </PaperScreen>
  );
}

/* ── one row of the day's book ───────────────────────────────────────────────────────────────── */

const ROW_TONE: Record<RowState, string> = {
  seen: "pill", in_consult: "pill on", waiting: "pill on", booked: "pill gd",
  missed: "pill rd", cancelled: "pill", needs_rebooking: "pill rd",
};

function BookRow(
  { appointment: a, canCheckIn, error, onCheckIn, onRebook, onCancel }: {
    appointment: WireAppointment;
    canCheckIn: boolean;
    error?: string;
    onCheckIn: () => void;
    onRebook: () => void;
    onCancel: () => void;
  },
): React.ReactElement {
  const { t } = useTranslation();
  const state = rowStateOf(a);
  const name = a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted");
  return (
    <div data-testid={`book-row-${a.id}`}>
      <div style={{ display: "flex", gap: 11, alignItems: "center", padding: "9px 11px", borderTop: "1px solid var(--line2)" }}>
        <span className="mo" style={{ width: 52, flexShrink: 0, fontSize: 11.5, fontWeight: 600 }}>{slotClock(a.slotStart)}</span>
        <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 13 }}>{name}</span>
          <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>{a.patient?.uhid ?? "—"}</span>
        </span>
        <span style={{ width: 96, flexShrink: 0 }}>
          <span className={ROW_TONE[state]} data-testid={`state-${a.id}`}>{t(`appointmentSeat.state.${state}`)}</span>
        </span>
        <span style={{ width: 120, flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 6 }}>
          {/*
            A ROW THAT ALREADY HAS A TOKEN SHOWS THE TOKEN AND NO BUTTON — the artboard is explicit,
            and the reason is that checking somebody in twice is the error this column invites.
          */}
          {state === "waiting" || state === "in_consult" || state === "seen" ? (
            <span className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>{t("appointmentSeat.day.checkedInMark")}</span>
          ) : state === "missed" ? (
            <button className="sec" type="button" data-testid={`rebook-row-${a.id}`} onClick={onRebook} style={{ height: 26 }}>
              {t("appointmentSeat.day.rebook")}
            </button>
          ) : state === "booked" && canCheckIn ? (
            <button className="sec grn" type="button" data-testid={`checkin-${a.id}`} onClick={onCheckIn} style={{ height: 26 }}>
              {t("appointmentSeat.day.checkIn")}
            </button>
          ) : null}
          {state === "booked" ? (
            <button className="sec" type="button" data-testid={`cancel-${a.id}`} onClick={onCancel} style={{ height: 26, padding: "0 8px" }}>
              {t("appointmentSeat.day.cancel")}
            </button>
          ) : null}
        </span>
      </div>
      {error === undefined ? null : (
        <p data-testid={`row-error-${a.id}`} style={{ margin: "0 0 8px 63px", fontSize: 11, color: "var(--red)" }}>{error}</p>
      )}
    </div>
  );
}
