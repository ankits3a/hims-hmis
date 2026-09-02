import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { useAuth } from "../lib/auth";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "../components/submit-button";
import {
  bookAppointment, checkInAppointment, getContinuity, getSlots, listPatientAppointments,
  opdErrorMessage, todayIst, walkIn,
} from "../lib/opd-api";
import type { WireAppointment, WireDoctorSummary, WireSlot } from "../lib/opd-api";
import { DELAY_HIGHLIGHT_MINUTES, proposeWalkIn } from "../lib/walk-in-routing";
import type { WalkInProposal } from "../lib/walk-in-routing";
import { FindPanel, useQueueSummary, waitEstimate } from "./registration-counter";

/**
 * ═══ FD-7 T2 — THE APPOINTMENT SEAT ═══
 *
 * The owner's 03-Sep correction, in one sentence: **the appointment does not flow below the
 * registration form.** Registration collects identity and ends at the UHID; a patient who needs a
 * doctor comes HERE, on a screen of its own, and a clerk without `opd.appointments.manage` never
 * sees it at all.
 *
 * Two lanes, and walk-in is the default because that is what an Indian OPD front desk does all day:
 *
 *   WALK-IN   two doors — a doctor BY NAME, or the complaint → a DEPARTMENT. When the department
 *             decides, `proposeWalkIn` fires the three rules in order and the card names which one
 *             fired. The clerk confirms or overrules; nothing is ever seated silently.
 *   FUTURE    a date and a doctor, the real slot grid off `GET /opd/slots`, and `POST
 *             /opd/appointments`. The toggle exists because "book me for Tuesday" is not a walk-in
 *             wearing a different date, and the previous design had nowhere to say it.
 *
 * A third door opens by itself: a patient who ALREADY has a booking is checked in rather than
 * walked in, because `check-in` is what turns their booking into a visit and a walk-in beside it
 * would leave the booking hanging as a no-show.
 */

type SeatMode = "walkin" | "future";

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE PROPOSAL CARD — the rule that fired, said out loud
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export function ProposalCard({
  proposal, now = new Date(), onTakeAlternative,
}: {
  proposal: WalkInProposal;
  now?: Date;
  onTakeAlternative?: (doctorId: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();

  if (proposal.doctor === null) {
    /*
     * RULE 3, AND THE SERVER'S OWN LIMIT. The design says "join the department queue" naming
     * nobody — and a visit cannot be opened without a doctor (`doctorId` is required, measured at
     * authoring). So this branch does NOT offer a confirm it could not honour: it says nobody is
     * sitting, and sends the clerk to the future lane, which is the only truthful next step.
     */
    return (
      <div data-testid="appt-no-doctor" role="status" className="rounded-md border border-dashed border-border p-4">
        <p data-testid="appt-proposal-rule" className="font-medium">{t("appointmentSeat.rule.departmentQueue")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("appointmentSeat.noDoctorToday")}</p>
      </div>
    );
  }

  const { minutes, clock } = waitEstimate(proposal.doctor.waitingCount, proposal.doctor.avgConsultMinutes, now);

  return (
    <div data-testid="appt-proposal" className="rounded-md border border-border bg-background p-4">
      {/* WHICH RULE FIRED — never a bare name. A clerk who cannot see the reason cannot overrule it well. */}
      <p data-testid="appt-proposal-rule" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t(proposal.rule === "continuity" ? "appointmentSeat.rule.continuity" : "appointmentSeat.rule.shortestWait")}
      </p>
      <p data-testid="appt-proposal-doctor" className="mt-1 text-lg font-semibold">{proposal.doctor.doctor.displayName}</p>

      {proposal.anchor !== null && proposal.rule === "continuity" && (
        <p data-testid="appt-proposal-seen" className="mt-1 text-sm text-muted-foreground">
          {t("appointmentSeat.seenOn", { date: proposal.anchor.seenOn })}
        </p>
      )}
      {/* Rule 1 dropped out — the clerk is told WHY the familiar doctor is not being proposed. */}
      {proposal.anchorUnavailable && proposal.anchor !== null && (
        <p data-testid="appt-anchor-unavailable" className="mt-1 text-sm text-muted-foreground">
          {t("appointmentSeat.anchorUnavailable", { doctor: proposal.anchor.doctorName })}
        </p>
      )}

      {/* MINUTES **AND** A CLOCK TIME, both, always — the design's own words. */}
      <p data-testid="appt-proposal-wait" className="mt-2 text-sm">
        <span data-testid="appt-wait-ahead">{t("registrationCounter.wait.ahead", { count: proposal.doctor.waitingCount })}</span>
        {" · "}
        <span data-testid="appt-wait-line">{t("registrationCounter.wait.line", { minutes, clock })}</span>
      </p>

      {/*
        ═══ THE OWNER'S 20-MINUTE RULE (R2) ═══
        A highlight, and a NAME — never a re-route. The proposal above is unchanged; this tells the
        clerk the line is long and who is shorter, and the clerk decides. Switching the patient away
        from the doctor who knows them, silently, would be rule 2 wearing rule 1's name.
      */}
      {proposal.delayed && (
        <div data-testid="appt-delay" role="alert" className="mt-3 rounded-md border border-state-danger/40 bg-state-danger/10 p-3">
          <p className="text-sm font-medium text-state-danger">
            {t("appointmentSeat.delay", { minutes: proposal.waitMinutes ?? minutes, threshold: DELAY_HIGHLIGHT_MINUTES })}
          </p>
          {proposal.alternative !== null ? (
            <p data-testid="appt-alternative" className="mt-2 text-sm">
              {t("appointmentSeat.alternative", {
                doctor: proposal.alternative.doctor.displayName,
                minutes: proposal.alternativeWaitMinutes ?? 0,
              })}
              <Button
                type="button" variant="outline" size="sm" className="ml-3"
                data-testid="appt-take-alternative"
                onClick={() => onTakeAlternative?.(proposal.alternative!.doctor.id)}
              >
                {t("appointmentSeat.takeAlternative")}
              </Button>
            </p>
          ) : (
            <p data-testid="appt-no-alternative" className="mt-1 text-sm text-muted-foreground">
              {t("appointmentSeat.noAlternative")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SEAT
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export function AppointmentSeat({ now = new Date() }: { now?: Date } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { inHand } = usePatientInHand();
  const { can } = useAuth();
  const patientId = inHand?.patientId ?? null;

  const [mode, setMode] = useState<SeatMode>("walkin");
  const [departmentId, setDepartmentId] = useState("");
  /** The clerk's own choice — set by the by-name door and by taking the alternative. Overrules the proposal. */
  const [overrideDoctorId, setOverrideDoctorId] = useState("");
  const [date, setDate] = useState(todayIst(now));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: "walkin"; tokenNo: number | null } | { kind: "booked"; at: string } | { kind: "checkedIn"; tokenNo: number | null } | null>(null);

  const summaries = useQueueSummary(todayIst(now));
  const departments = useQuery({
    queryKey: ["opd", "departments"],
    queryFn: () => api<{ items: { id: string; name: string }[] }>("GET", "/opd/departments"),
    staleTime: 5 * 60_000,
    retry: false,
  });

  /*
   * RULE 1's read. It fires only once BOTH the patient and the department are known, which is the
   * privacy shape as well as the obvious enabling condition: the server answers about a department
   * the clerk named, and a seat that asked before the clerk had named one would be asking "where has
   * this patient been".
   */
  const continuity = useQuery({
    queryKey: ["opd", "continuity", patientId, departmentId],
    queryFn: () => getContinuity(patientId!, departmentId),
    enabled: patientId !== null && departmentId !== "",
    retry: false,
  });

  /** The third door. A patient with a booking is CHECKED IN, never walked in beside it. */
  const booked = useQuery({
    queryKey: ["opd", "appointments", "patient", patientId],
    queryFn: () => listPatientAppointments(patientId!),
    enabled: patientId !== null,
    retry: false,
  });

  const proposal = useMemo(
    () => (departmentId === "" ? null : proposeWalkIn(departmentId, summaries, continuity.data?.anchor ?? null)),
    [departmentId, summaries, continuity.data],
  );

  /** The doctor actually about to be used: the clerk's overrule if there is one, else the proposal's. */
  const chosen: WireDoctorSummary | null = useMemo(() => {
    if (overrideDoctorId !== "") return summaries.find((s) => s.doctor.id === overrideDoctorId) ?? null;
    return proposal?.doctor ?? null;
  }, [overrideDoctorId, summaries, proposal]);

  const doctorsHere = useMemo(
    () => summaries.filter((s) => departmentId === "" || s.doctor.departmentId === departmentId),
    [summaries, departmentId],
  );

  const slots = useQuery({
    queryKey: ["opd", "slots", overrideDoctorId, date],
    queryFn: () => getSlots(overrideDoctorId, date),
    enabled: mode === "future" && overrideDoctorId !== "",
    retry: false,
  });

  const reset = useCallback((): void => {
    setDepartmentId(""); setOverrideDoctorId(""); setError(null); setDone(null); setMode("walkin");
  }, []);

  async function confirmWalkIn(idempotencyKey: string): Promise<void> {
    if (patientId === null || chosen === null) return;
    setError(null);
    try {
      const r = await walkIn({
        patient: { existingId: patientId },
        departmentId: chosen.doctor.departmentId,
        doctorId: chosen.doctor.id,
      }, idempotencyKey);
      setDone({ kind: "walkin", tokenNo: r.tokenNo });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  async function book(slot: WireSlot): Promise<void> {
    if (patientId === null || overrideDoctorId === "") return;
    setError(null);
    try {
      const r = await bookAppointment({ patientId, doctorId: overrideDoctorId, slotStart: slot.start });
      setDone({ kind: "booked", at: r.appointment.slotStart });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  async function arrive(appointment: WireAppointment): Promise<void> {
    setError(null);
    try {
      const r = await checkInAppointment(appointment.id);
      setDone({ kind: "checkedIn", tokenNo: r.tokenNo });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  /*
   * D2 — THE SEAT IS ITS OWN PERMISSION. The nav row is gated too, but a screen that renders its
   * controls to a caller who cannot use them teaches the desk that the system is broken; the honest
   * answer is the one the server would give.
   */
  if (!can("opd.appointments.manage")) {
    return (
      <div data-seat="appointment-seat" data-testid="appointment-seat" className="min-h-screen bg-background p-6 text-foreground">
        <p data-testid="appt-forbidden" role="alert">{t("appointmentSeat.forbidden")}</p>
      </div>
    );
  }

  return (
    <div data-seat="appointment-seat" data-testid="appointment-seat" className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">{t("appointmentSeat.title")}</h1>
        {inHand !== null && (
          <p data-testid="appt-patient" className="text-sm text-muted-foreground">{inHand.patientId}</p>
        )}
      </header>

      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {/* Nobody in hand: the same search-first door the counter uses, and the same component. */}
          {patientId === null && <FindPanel />}

          {patientId !== null && done === null && (
            <>
              {/* THE THIRD DOOR, offered before the two — an existing booking is checked in, not duplicated. */}
              {(booked.data?.items ?? []).length > 0 && (
                <section data-testid="appt-arrival" className="rounded-md border border-state-waiting/50 bg-state-waiting/10 p-4">
                  <p className="font-medium">{t("appointmentSeat.alreadyBooked")}</p>
                  <ul className="mt-2 space-y-2">
                    {(booked.data?.items ?? []).map((a) => (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-x-3">
                        <span data-testid={`appt-booked-when-${a.id}`} className="text-sm tabular-nums">{a.slotStart}</span>
                        <SubmitButton data-testid={`appt-checkin-${a.id}`} onClick={() => arrive(a)}>
                          {t("appointmentSeat.checkIn")}
                        </SubmitButton>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* THE LANE TOGGLE — walk-in selected, because that is what the desk does all day. */}
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("appointmentSeat.mode")}>
                <Button
                  type="button" variant={mode === "walkin" ? "default" : "outline"}
                  data-testid="appt-mode-walkin" aria-pressed={mode === "walkin"}
                  onClick={() => { setMode("walkin"); setError(null); }}
                >
                  {t("appointmentSeat.walkIn")}
                </Button>
                <Button
                  type="button" variant={mode === "future" ? "default" : "outline"}
                  data-testid="appt-mode-future" aria-pressed={mode === "future"}
                  onClick={() => { setMode("future"); setError(null); }}
                >
                  {t("appointmentSeat.future")}
                </Button>
              </div>

              {/* DOOR TWO — the complaint, as a department. Naming it is what makes the rules fire. */}
              <div>
                <label htmlFor="appt-dept" className="text-xs font-medium text-muted-foreground">
                  {t("appointmentSeat.department")}
                </label>
                <select
                  id="appt-dept" data-testid="appt-department" value={departmentId}
                  onChange={(e) => { setDepartmentId(e.target.value); setOverrideDoctorId(""); }}
                  className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                >
                  <option value="">{t("appointmentSeat.pickDepartment")}</option>
                  {(departments.data?.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>

              {/* DOOR ONE — a doctor by name. It also serves as the OVERRULE of whatever was proposed. */}
              <div>
                <label htmlFor="appt-doc" className="text-xs font-medium text-muted-foreground">
                  {t("appointmentSeat.doctor")}
                </label>
                <select
                  id="appt-doc" data-testid="appt-doctor" value={overrideDoctorId}
                  onChange={(e) => setOverrideDoctorId(e.target.value)}
                  className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                >
                  <option value="">{t("appointmentSeat.byProposal")}</option>
                  {doctorsHere.map((s) => (
                    <option key={s.doctor.id} value={s.doctor.id}>
                      {s.doctor.displayName} · {t("registrationCounter.wait.ahead", { count: s.waitingCount })}
                    </option>
                  ))}
                </select>
              </div>

              {mode === "walkin" && proposal !== null && overrideDoctorId === "" && (
                <ProposalCard proposal={proposal} now={now} onTakeAlternative={(id) => setOverrideDoctorId(id)} />
              )}

              {mode === "walkin" && chosen !== null && (
                <div className="flex flex-wrap items-center gap-2">
                  <SubmitButton data-testid="appt-confirm" onClick={(k) => confirmWalkIn(k)}>
                    {t("appointmentSeat.confirm", { doctor: chosen.doctor.displayName })}
                  </SubmitButton>
                  {overrideDoctorId !== "" && (
                    <Button type="button" variant="ghost" data-testid="appt-back-to-proposal" onClick={() => setOverrideDoctorId("")}>
                      {t("appointmentSeat.backToProposal")}
                    </Button>
                  )}
                </div>
              )}

              {/* THE FUTURE LANE — a real date and the doctor's real slots, never a free-text time. */}
              {mode === "future" && (
                <section data-testid="appt-future" className="space-y-3 rounded-md border border-border p-4">
                  <div>
                    <label htmlFor="appt-date" className="text-xs font-medium text-muted-foreground">
                      {t("appointmentSeat.date")}
                    </label>
                    <input
                      id="appt-date" data-testid="appt-date" type="date" value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                    />
                  </div>
                  {overrideDoctorId === "" ? (
                    <p data-testid="appt-pick-doctor-first" className="text-sm text-muted-foreground">
                      {t("appointmentSeat.pickDoctorFirst")}
                    </p>
                  ) : (
                    <ul data-testid="appt-slots" className="flex flex-wrap gap-2">
                      {(slots.data?.slots ?? []).filter((s) => !s.booked && !s.past).map((s) => (
                        <li key={s.start}>
                          <SubmitButton data-testid={`appt-slot-${s.start}`} onClick={() => book(s)}>
                            {s.start.slice(11, 16)}
                          </SubmitButton>
                        </li>
                      ))}
                      {(slots.data?.slots ?? []).filter((s) => !s.booked && !s.past).length === 0 && !slots.isFetching && (
                        <li data-testid="appt-no-slots" className="text-sm text-muted-foreground">{t("appointmentSeat.noSlots")}</li>
                      )}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}

          {/* THE FINISH. One line saying what happened, and the desk cleared for the next person. */}
          {done !== null && (
            <section data-testid="appt-done" className="rounded-md border border-primary/40 bg-primary/5 p-4">
              <p className="font-medium">
                {done.kind === "booked"
                  ? t("appointmentSeat.doneBooked", { at: done.at })
                  : t("appointmentSeat.doneToken", { token: done.tokenNo ?? "—" })}
              </p>
              <Button type="button" className="mt-3" data-testid="appt-next" onClick={reset}>
                {t("appointmentSeat.next")}
              </Button>
            </section>
          )}

          {error !== null && (
            <p data-testid="appt-error" role="alert" className="rounded-md border border-state-danger/40 bg-state-danger/10 px-3 py-2 font-medium text-state-danger">
              {error}
            </p>
          )}
        </div>

        <aside className="space-y-2">
          <h2 className="text-sm font-semibold">{t("appointmentSeat.board")}</h2>
          <ul className="space-y-1">
            {doctorsHere.map((s) => (
              <li key={s.doctor.id} data-testid={`appt-board-${s.doctor.id}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{s.doctor.displayName}</span>
                <span className="text-muted-foreground">
                  {t("registrationCounter.wait.ahead", { count: s.waitingCount })}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
