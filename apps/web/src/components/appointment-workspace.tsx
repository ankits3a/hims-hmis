import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "./submit-button";
import { useDebounced } from "../lib/format";
import {
  bookAppointment, checkInAppointment, getContinuity, getOpdConfig, getSlots,
  listPatientAppointments, opdErrorMessage, todayIst, triage, walkIn,
} from "../lib/opd-api";
import type { WireAppointment, WireDoctorSummary, WireSlot } from "../lib/opd-api";
import { DELAY_HIGHLIGHT_MINUTES, proposeWalkIn } from "../lib/walk-in-routing";
import type { WalkInProposal } from "../lib/walk-in-routing";
import { fetchDrawerState, useQueueSummary, waitEstimate } from "../screens/registration-counter";

/**
 * ═══ FD-8 — THE APPOINTMENT STAGE, ONE IMPLEMENTATION, TWO SEATS ═══
 *
 * The owner authorised BOTH shapes of the front desk, and they are not in conflict:
 *
 *   · THREE PEOPLE — `/registration`, `/appointment`, `/billing`, one screen each (users 1-3).
 *   · ONE PERSON — user 4 holds all three grants and works Desk One: a single desk with a
 *     persistent dossier and a stage that advances `find → reg → appt → bill`.
 *
 * This is the appointment stage for BOTH. `/appointment` mounts it with its own chrome; the counter
 * mounts it as one stage of its workspace, inside the dossier layout. One implementation, because
 * the three walk-in routing rules and the 20-minute rule are money-and-safety behaviour, and two
 * copies of them would drift — the defect this codebase has produced repeatedly.
 *
 * It renders NO header and NO patient search. Whoever mounts it has already put a patient in hand.
 */

type Mode = "walkin" | "future";

/**
 * What the stage produces, so the mounting seat can advance its own flow.
 *
 * The walk-in outcome carries everything the counter's BILL stage and its printed slip need, because
 * this is the moment those facts are true: the walk-in response has the visit number, the service
 * date and the visit type, and the summary row the clerk just chose has the doctor, the department
 * and the room. Looking any of them up again at print time is how a slip ends up naming the wrong
 * doctor after a re-assign (`SeatVisit.slip`'s own docstring).
 */
export type OpenedVisit = {
  encounterId: string;
  patientId: string;
  tokenNo: number | null;
  flow: { counterSequence: string; tokenLane: string };
  slip: {
    visitNo: string; serviceDate: string; visitType: string;
    doctorName: string; departmentName: string; roomCode: string | null;
  };
};

export type AppointmentOutcome =
  | ({ kind: "walkin" } & OpenedVisit)
  | ({ kind: "checkedIn" } & OpenedVisit)
  | { kind: "booked"; at: string };

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
     * nobody — and a visit cannot be opened without a doctor (`visitOpenBody` requires one). So this
     * branch does NOT offer a confirm it could not honour: it says nobody is sitting, and sends the
     * clerk to the future lane, which is the only truthful next step.
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
      {/*
        Rule 1 dropped out — and the clerk is told WHICH reason, because they have to say it out loud
        to a patient who asked for that doctor by name. "Dr Sharma is on leave today" is an answer;
        "Dr Sharma is not on today's board" is a shrug.
      */}
      {proposal.anchorUnavailable && proposal.anchor !== null && (
        <p data-testid="appt-anchor-unavailable" className="mt-1 text-sm text-muted-foreground">
          {t(proposal.anchorOnLeave ? "appointmentSeat.anchorOnLeave" : "appointmentSeat.anchorUnavailable",
            { doctor: proposal.anchor.doctorName })}
        </p>
      )}

      {/* MINUTES **AND** A CLOCK TIME, both, always — the design's own words. */}
      <p data-testid="appt-proposal-wait" className="mt-2 text-sm">
        <span data-testid="appt-wait-ahead">{t("registrationCounter.wait.ahead", { count: proposal.doctor.waitingCount })}</span>
        {" · "}
        <span data-testid="appt-wait-line">{t("registrationCounter.wait.line", { minutes, clock })}</span>
      </p>

      {/*
        ═══ THE OWNER'S 20-MINUTE RULE ═══
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
   THE STAGE
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The complaint is asked once the clerk stops typing — not per keystroke. */
const TRIAGE_DEBOUNCE_MS = 500;

export function AppointmentWorkspace({
  patientId, patientName, now = new Date(), onOutcome,
}: {
  patientId: string;
  /** For the one question this stage asks: "What brings <name> in?" */
  patientName?: string | null;
  now?: Date;
  onOutcome?: (outcome: AppointmentOutcome) => void;
}): React.ReactElement {
  const { t } = useTranslation();

  const [mode, setMode] = useState<Mode>("walkin");
  const [complaint, setComplaint] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  /** The clerk's own choice — set by the by-name door and by taking the alternative. Overrules the proposal. */
  const [overrideDoctorId, setOverrideDoctorId] = useState("");
  const [date, setDate] = useState(todayIst(now));
  /**
   * R4 — the channel-partner slip, captured where the patient hands it over. The walk-in is the
   * moment a visit exists to attach it to, which registration (ending at the UHID) no longer is.
   * Stored unvalidated: billing owns the check that a code binds to this patient.
   */
  const [attributionCode, setAttributionCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const summaries = useQueueSummary(todayIst(now));
  const departments = useQuery({
    queryKey: ["opd", "departments"],
    queryFn: () => api<{ items: { id: string; name: string }[] }>("GET", "/opd/departments"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const deptName = useCallback(
    (id: string): string => departments.data?.items.find((d) => d.id === id)?.name ?? id,
    [departments.data],
  );

  /*
   * ═══ THE COMPLAINT, IN THE PATIENT'S OWN WORDS ═══
   *
   * Desk One does not ask a clerk to pick a department from a dropdown; it asks what brings the
   * patient in and ranks the hospital's departments from the answer. Debounced, because this is a
   * network call and a counter should not make one per keystroke — and NEVER blocking: the server
   * answers from its keyword table instantly and only refines with the model if it can (measured:
   * the gateway takes 22-40 s, so the refinement usually never arrives, and that costs nothing).
   */
  const debouncedComplaint = useDebounced(complaint.trim(), TRIAGE_DEBOUNCE_MS);
  const suggested = useQuery({
    queryKey: ["opd", "triage", debouncedComplaint],
    queryFn: () => triage(debouncedComplaint),
    enabled: debouncedComplaint.length > 1,
    retry: false,
    staleTime: 5 * 60_000,
  });

  /*
   * RULE 1's read. It fires only once BOTH the patient and the department are known, which is the
   * privacy shape as well as the obvious enabling condition: the server answers about a department
   * the clerk named, and asking before one is named would be asking "where has this patient been".
   */
  const continuity = useQuery({
    queryKey: ["opd", "continuity", patientId, departmentId],
    queryFn: () => getContinuity(patientId, departmentId),
    enabled: departmentId !== "",
    retry: false,
  });

  /** The third door. A patient with a booking is CHECKED IN, never walked in beside it. */
  const booked = useQuery({
    queryKey: ["opd", "appointments", "patient", patientId],
    queryFn: () => listPatientAppointments(patientId),
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

  /**
   * ═══ THE ACT THAT OPENS THE VISIT NOW OWNS THE VISIT'S PRECONDITIONS ═══
   *
   * The flow read and the bill-first drawer check used to live in `RegisterPanel`, because
   * registration and seating were one call. Splitting them (registration ends at the UHID) moved
   * the opening HERE — so these moved with it. Deleting them would have been a real regression:
   * under `bill_first` a visit opened with a closed drawer is one this desk cannot take money for.
   *
   * Both are read LIVE, not from a cache, for the reason RC-4 recorded: `counter_sequence` is
   * hospital-wide and a supervisor can flip it from another counter, and a session closed from
   * another screen at 13:00 is invisible to a cache filled at 09:00 in a tab that never lost focus.
   */
  async function confirmWalkIn(idempotencyKey: string): Promise<void> {
    if (chosen === null) return;
    setError(null);
    try {
      const config = await getOpdConfig();
      const flow = { counterSequence: config.counterSequence, tokenLane: config.tokenLane };
      if (flow.counterSequence === "bill_first") {
        const drawer = await fetchDrawerState();
        if (drawer !== "open") {
          setError(t(`registrationCounter.drawer.${drawer === "pending" ? "closed" : drawer}`));
          return;
        }
      }
      const slipCode = attributionCode.trim();
      const body = {
        patient: { existingId: patientId },
        departmentId: chosen.doctor.departmentId,
        doctorId: chosen.doctor.id,
        ...(slipCode === "" ? {} : { attributionCode: slipCode }),
      };
      const r = flow.counterSequence === "bill_first"
        ? await walkIn({ ...body, join: "defer" }, idempotencyKey)
        : await walkIn(body, idempotencyKey);
      onOutcome?.({
        kind: "walkin",
        encounterId: r.encounter.id, patientId: r.patientId, tokenNo: r.tokenNo, flow,
        slip: {
          visitNo: r.encounter.visitNo, serviceDate: r.encounter.serviceDate, visitType: r.visitType,
          doctorName: chosen.doctor.displayName,
          departmentName: deptName(chosen.doctor.departmentId),
          roomCode: chosen.roomCode,
        },
      });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  async function book(slot: WireSlot): Promise<void> {
    if (overrideDoctorId === "") return;
    setError(null);
    try {
      const r = await bookAppointment({ patientId, doctorId: overrideDoctorId, slotStart: slot.start });
      onOutcome?.({ kind: "booked", at: r.appointment.slotStart });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  async function arrive(appointment: WireAppointment): Promise<void> {
    setError(null);
    try {
      const config = await getOpdConfig();
      const r = await checkInAppointment(appointment.id);
      const doctor = summaries.find((s2) => s2.doctor.id === appointment.doctorId) ?? null;
      onOutcome?.({
        kind: "checkedIn",
        encounterId: r.encounter.id, patientId: appointment.patientId, tokenNo: r.tokenNo,
        flow: { counterSequence: config.counterSequence, tokenLane: config.tokenLane },
        slip: {
          visitNo: r.encounter.visitNo, serviceDate: r.encounter.serviceDate, visitType: r.visitType,
          doctorName: doctor?.doctor.displayName ?? "",
          departmentName: doctor === null ? "" : deptName(doctor.doctor.departmentId),
          roomCode: doctor?.roomCode ?? null,
        },
      });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  }

  const suggestions = suggested.data?.suggestions ?? [];

  return (
    <section data-testid="appointment-workspace" className="space-y-4">
      {/* THE THIRD DOOR, offered before the two — an existing booking is checked in, not duplicated. */}
      {(booked.data?.items ?? []).length > 0 && (
        <div data-testid="appt-arrival" className="rounded-md border border-state-waiting/50 bg-state-waiting/10 p-4">
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
        </div>
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

      {/* ═══ THE COMPLAINT — Desk One's own question, in the patient's own words ═══ */}
      <div>
        <label htmlFor="appt-complaint" className="text-base font-semibold">
          {t("appointmentSeat.complaintTitle", { name: patientName ?? t("appointmentSeat.themDefault") })}
        </label>
        <input
          id="appt-complaint" data-testid="appt-complaint" value={complaint}
          onChange={(e) => setComplaint(e.target.value)}
          placeholder={t("appointmentSeat.complaintHint")}
          className="mt-2 h-12 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
        />
        {suggestions.length > 0 && (
          <div data-testid="appt-suggestions" className="mt-2 flex flex-wrap items-center gap-2">
            {suggestions.map((s) => (
              <Button
                key={s.departmentId} type="button" variant="outline" size="sm"
                data-testid={`appt-suggest-${s.departmentId}`}
                onClick={() => { setDepartmentId(s.departmentId); setOverrideDoctorId(""); }}
              >
                {deptName(s.departmentId)}
                <span className="ml-2 text-xs text-muted-foreground">{s.reason}</span>
              </Button>
            ))}
            {/*
              THE SEAT SAYS WHERE THE ADVICE CAME FROM. Advice whose origin is hidden gets trusted
              too much, and these two are not equally strong: the keyword table is a fixed list, the
              model actually read the sentence.
            */}
            <span data-testid="appt-suggest-source" className="text-xs text-muted-foreground">
              {t(suggested.data?.source === "model" ? "appointmentSeat.bySuggestion" : "appointmentSeat.byKeyword")}
            </span>
          </div>
        )}
      </div>

      {/* DOOR TWO — the department, whether the clerk picked a chip above or knows it already. */}
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

      {/* R4 — the slip, captured where the patient is still holding the paper. */}
      <div>
        <label htmlFor="appt-slip" className="text-xs font-medium text-muted-foreground">
          {t("appointmentSeat.partnerSlip")}
        </label>
        <input
          id="appt-slip" data-testid="appt-slip" value={attributionCode}
          onChange={(e) => setAttributionCode(e.target.value)}
          className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-base"
        />
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
        <div data-testid="appt-future" className="space-y-3 rounded-md border border-border p-4">
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
        </div>
      )}

      {error !== null && (
        <p data-testid="appt-error" role="alert" className="rounded-md border border-state-danger/40 bg-state-danger/10 px-3 py-2 font-medium text-state-danger">
          {error}
        </p>
      )}
    </section>
  );
}
