import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { Field, Fold, Segmented, TogglePills, GRID2 } from "../components/desk-fields";
import {
  abhaCapability, duplicateCandidates, matchReasonKeys, matchReasonsDiscriminate,
  registerPatient, searchPatients,
} from "../lib/patients-api";
import type { WirePatientHit } from "../lib/patients-api";
import { EMPTY_FORM, formAgeYears, formNeedsGuardian, registerBodyOf } from "./desk-one/session";
import type { Form } from "./desk-one/session";
import {
  getContinuity, listDepartments, listDoctors, listQueueSummary, opdErrorMessage, todayIst, triage, walkIn,
} from "../lib/opd-api";
import type { WireDoctorSummary } from "../lib/opd-api";
import { proposeWalkIn } from "../lib/walk-in-routing";
import type { WalkInProposal } from "../lib/walk-in-routing";
import { ageOf, etaClock, sexLetter, waitMinutes } from "./desk-one/model";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 1 — `/registration`, THE REGISTRATION CLERK'S SEAT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Artboard: `docs/design/2026-09-03-front-desk-three-seats/Registration.dc.html`, signed off.
 * Keys: `…/Keymap.dc.html`. Routing rules and the wait model: `…/Routing.dc.html`.
 *
 * ═══ WHY THIS ROUTE EXISTS AGAIN, WHEN FD-9 DELETED IT ═══
 *
 * FD-9 collapsed `/registration`, `/appointment` and `/billing` into one screen at `/counter` on
 * the owner's explicit ruling, for a hospital staffing ONE person at the front desk: *"Let's only
 * focus on one user right now. This user has access to registration, appointment and billing."*
 * That ruling has not been reversed and Desk One is not deleted — it remains the single-seat door,
 * and it is still where this design system lives.
 *
 * What changed is the staffing. The hospital now runs THREE seats, and the FD-8 memory records that
 * both shapes are authorised: three users = three routes, one user = Desk One's stages. This route
 * is the door for a clerk who holds `patients.register` and does NOT hold billing — a person who
 * registers patients and routes them to a doctor, and who should never be shown a cash drawer.
 * That is why re-adding it is not a reversal of FD-9's ruling but the other half of it.
 *
 * ═══ IT WEARS `.pp` AND LIVES INSIDE THE SHELL — DELIBERATELY, AND NOT WHAT THE PLAN SAID ═══
 *
 * The build plan proposed `staticData: { fullViewport: true }` on all five new seats, the way
 * `/counter` carries it. That is right for Desk One and wrong here, for a reason the plan's own
 * argument gives: `fullViewport` means the shell renders `<Outlet />` ALONE — no header, no
 * `ModeBanner`, no `PatientStrip`, no nav, none of them in the DOM at all. Desk One earns that
 * because it is the whole application for the person using it. A registration clerk is one seat of
 * three and still needs to reach a patient record, the appointment book and their own figures.
 *
 * The artboard's own 44px header bar is therefore rendered as a SCREEN TITLE and not a second
 * header — see `ScreenTitle`'s comment for the whole argument. One app header, one screen title.
 *
 * ═══ WHAT IT REUSES, AND WHY THAT MATTERED MORE THAN THE SCREEN ═══
 *
 * Nothing here is a second implementation of anything Desk One does. `registerBodyOf` builds the
 * POST body for both seats, `formNeedsGuardian` is the only implementation of the age<18 rule,
 * `proposeWalkIn` is the only implementation of the three routing rules, and `Field`/`Fold`/
 * `Segmented` are the shared primitives. The extraction that made this possible ALSO exposed two
 * defects that were live on the deployed counter — a confidential registration that could not
 * succeed, and four guardian authorities nobody had ever sent. See `register-body.test.ts`.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 *
 * It does not mount `DeskProvider`. That provider fires `GET /billing/sessions/current` and
 * `GET /billing/patients/:id/dues` unconditionally, and `front_office` holds neither
 * `billing.session.own` nor `billing.invoice.read` — so reusing it wholesale would 403 twice per
 * patient on the seat it was supposed to serve. This screen holds its own small state instead.
 */

/* ── the rail's "Their card" panel, and the honest thing it can say ──────────────────────────── */

/**
 * THE ARTBOARD ASKS FOR A UHID THIS SERVER CANNOT HONESTLY PREVIEW.
 *
 * It draws `{{nextUhid}}` under "the next number this hospital will issue", and the same value
 * again in the footer's "issues U00110012". There is no endpoint for it, and there should not be:
 * `allocateUhid` is transactional and serial — `uhid.test.ts` proves twenty concurrent allocations
 * get twenty distinct numbers — so any preview is a number the clerk at the next counter may take
 * first. Showing it would be a promise the hospital breaks whenever two people register at once.
 *
 * So the panel is drawn, the photo slot is drawn, and the number appears the moment it is REAL. A
 * caption that says "allocated when you register" is a smaller thing than the artboard asked for
 * and it is true, which the artboard's version could not be.
 */
function TheirCard({ uhid, onPhoto }: { uhid: string | null; onPhoto: () => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="box" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
      <span className="tag">{t("registrationSeat.rail.theirCard")}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 52, height: 52, borderRadius: 6, border: "1px dashed var(--line)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--faint)", flexShrink: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M3 8h3l2-3h8l2 3h3v11H3V8Z" />
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="mo" data-testid="rail-uhid" style={{ fontSize: 15, fontWeight: 600 }}>
            {uhid ?? "—"}
          </span>
          <span style={{ fontSize: 10.5, color: "var(--faint)", lineHeight: "14px" }}>
            {uhid === null ? t("registrationSeat.rail.uhidPending") : t("registrationSeat.rail.uhidIssued")}
          </span>
        </div>
      </div>
      <button
        className="sec"
        type="button"
        data-testid="rail-take-photo"
        onClick={onPhoto}
        disabled={uhid === null}
        style={{ justifyContent: "flex-start", gap: 8 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M3 8h3l2-3h8l2 3h3v11H3V8Z" />
        </svg>
        {t("registrationSeat.rail.takePhoto")}
      </button>
    </div>
  );
}

/* ── the proposal card: never a silent assignment ────────────────────────────────────────────── */

function Proposal(
  { proposal, departmentName }: { proposal: WalkInProposal; departmentName: string },
): React.ReactElement {
  const { t } = useTranslation();
  const wait = proposal.waitMinutes;
  const doctor = proposal.doctor;
  const continuity = proposal.rule === "continuity";
  return (
    <div
      data-testid="routing-proposal"
      style={{
        marginTop: 11, border: "1px solid var(--green-line)", background: "var(--green-soft)",
        borderRadius: 7, padding: "11px 13px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {/* THE RULE IS NAMED. A proposal that does not say which rule fired is an assignment. */}
        <span className="tag" data-testid="routing-rule" style={{ color: "var(--green)" }}>
          {continuity ? t("registrationSeat.proposal.ruleContinuity")
            : proposal.rule === "shortest_wait" ? t("registrationSeat.proposal.ruleShortest")
              : t("registrationSeat.proposal.ruleDepartment")}
        </span>
        {/*
          ═══ FOUND BY LOOKING — THE BADGE CONTRADICTED THE RULE BESIDE IT ═══

          This read `continuity ? seenBefore : shortestWait`, which is right for the two rules that
          pick a doctor and WRONG for the third. A screenshot showed a card headed "Rule 3 · the
          department queue", saying "No doctor is free in this department", wearing a green badge
          that said "shortest wait" — a claim about a comparison that was never made, on a card
          whose whole point is that there was nobody to compare.

          It is the keycap-that-lies rule in another costume: a badge is a claim, and a claim the
          card's own heading contradicts teaches a clerk to stop reading either. Rule 3 gets a badge
          that says what actually happened, and the tone drops to plain because there is nothing
          good to report.
        */}
        <span
          className={proposal.rule === "department_queue" ? "pill" : proposal.delayed ? "pill gd" : "pill on"}
          data-testid="routing-badge"
          style={{ marginLeft: "auto" }}
        >
          {proposal.rule === "department_queue"
            ? t("registrationSeat.proposal.badgeUnassigned")
            : continuity
              ? t("registrationSeat.proposal.badgeSeenBefore")
              : t("registrationSeat.proposal.badgeShortest")}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 8, flexWrap: "wrap" }}>
        <span data-testid="routing-doctor" style={{ fontSize: 15, fontWeight: 600 }}>
          {doctor?.doctor.displayName ?? t("registrationSeat.proposal.noDoctor")}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{departmentName}</span>
        {doctor?.roomCode == null ? null : (
          <span className="mo" style={{ fontSize: 11, color: "var(--faint)" }}>{doctor.roomCode}</span>
        )}
        {wait === null ? null : (
          <span className="mo" data-testid="routing-wait" style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 600 }}>
            {t("registrationSeat.proposal.waitLine", {
              ahead: doctor?.waitingCount ?? 0,
              minutes: wait,
              clock: etaClock(wait),
            })}
          </span>
        )}
      </div>
      {/*
        THE REASON, IN PROSE. The artboard is emphatic that the card carries a sentence a clerk can
        read out to the patient — "Dr Rao consulted her on 14-Aug for the same complaint" — because
        the patient is standing there asking why they are being sent to a longer line.
      */}
      <p data-testid="routing-reason" style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--dim)", lineHeight: "16px" }}>
        {proposal.anchorOnLeave
          ? t("registrationSeat.proposal.reasonAnchorOnLeave", { doctor: proposal.anchor?.doctorName ?? "" })
          : proposal.anchorUnavailable
            ? t("registrationSeat.proposal.reasonAnchorAway", { doctor: proposal.anchor?.doctorName ?? "" })
            : continuity
              ? t("registrationSeat.proposal.reasonContinuity", {
                doctor: proposal.anchor?.doctorName ?? doctor?.doctor.displayName ?? "",
                seenOn: proposal.anchor?.seenOn.slice(0, 10) ?? "",
              })
              : proposal.rule === "department_queue"
                ? t("registrationSeat.proposal.reasonDepartmentQueue", { department: departmentName })
                : t("registrationSeat.proposal.reasonShortest", { department: departmentName })}
      </p>
      {/*
        THE 20-MINUTE RULE — owner, 2026-09-03. A HIGHLIGHT, never a re-route: continuity still
        wins, the clerk is told the line is long and shown who is shorter, and the clerk decides.
      */}
      {proposal.delayed && proposal.alternative !== null ? (
        <p data-testid="routing-delay" style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--gold)", lineHeight: "16px" }}>
          {t("registrationSeat.proposal.delayed", {
            doctor: proposal.alternative.doctor.displayName,
            minutes: proposal.alternativeWaitMinutes ?? 0,
          })}
        </p>
      ) : null}
    </div>
  );
}

/* ── the screen ──────────────────────────────────────────────────────────────────────────────── */

type Held = { id: string; uhid: string; name: string; facts: string; hindiName: string | null };

export function Registration(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [duplicates, setDuplicates] = useState<WirePatientHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFold, setOpenFold] = useState<string | null>(null);
  const [doctorQuery, setDoctorQuery] = useState("");
  const [complaint, setComplaint] = useState("");
  const [pickedDoctorId, setPickedDoctorId] = useState<string | null>(null);
  const [triagedDepartmentId, setTriagedDepartmentId] = useState<string | null>(null);
  const [log, setLog] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ uhid: string; tokenNo: number | null } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const note = useCallback((text: string, kind: AgentLine["kind"] = "did"): void => {
    setLog((prev) => logged(prev, text, kind));
  }, []);

  /**
   * ═══ CLOSE PASS 2 — THE INVARIANT, RATHER THAN A THIRD EXIT CONTROL ═══
   *
   * Pass 1 fixed the Cancel BUTTON; pass 2 fixed the Esc KEY; pass 2 then pointed out that both are
   * instance-shaped, because two roads reach the same CRITICAL with no exit control at all:
   *
   *   · a register-only commit sets `held` and does NOT clear the form or navigate, so a clerk can
   *     simply type over it for the next patient;
   *   · taking a search hit sets `held`, and the enrolment form below is always visible.
   *
   * Either way `commit()` posts `{existingId: held.id}` and the person whose details are on screen is
   * never registered, while somebody else gets their token.
   *
   * The invariant is one line and it is here: TYPING INTO THE NEW-PATIENT FORM MEANS THE PATIENT IN
   * HAND IS NOT THE PATIENT ON SCREEN. This function already clears `duplicates` on every edit for
   * exactly that reason — a duplicate check is about the typed person, and so is the commit.
   *
   * Cheap to be wrong about in the safe direction: dropping `held` costs a clerk one search to pick
   * the person again. Keeping it costs the wrong patient a token and the right one a registration.
   */
  const set = useCallback((next: Partial<Form>): void => {
    setForm((f) => ({ ...f, ...next }));
    setDuplicates(null);
    setHeld(null);
  }, []);

  /* ── search ──────────────────────────────────────────────────────────────────────────────── */

  /*
    DEBOUNCED, and the debounce is on the QUERY rather than inside the fetcher, so a keystroke does
    not cancel an in-flight request that is about to answer. 250 ms is Desk One's value.
  */
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(query.trim()); }, 250);
    return () => { clearTimeout(id); };
  }, [query]);

  const hits = useQuery({
    queryKey: ["registration-search", debounced],
    queryFn: () => searchPatients(debounced, 3),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });

  /* ── the two doors to a doctor ───────────────────────────────────────────────────────────── */

  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments, staleTime: 5 * 60_000 });
  const doctors = useQuery({ queryKey: ["doctors"], queryFn: listDoctors, staleTime: 5 * 60_000 });

  const serviceDate = todayIst();
  const summaries = useQuery({
    queryKey: ["queue-summary", serviceDate],
    queryFn: () => listQueueSummary(serviceDate),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  /*
    DOOR ONE — a doctor by name. `matchedOn` is not involved; this is a plain prefix match over the
    doctor master the clerk can see, because a clerk who types "Rao" means Dr Rao and should not be
    routed through a triage model to reach him.
  */
  const doctorMatches = useMemo(() => {
    const q = doctorQuery.trim().toLowerCase();
    if (q === "") return [];
    return (doctors.data?.items ?? [])
      .filter((d) => d.active && d.displayName.toLowerCase().includes(q))
      .slice(0, 4);
  }, [doctorQuery, doctors.data]);

  /*
    DOOR TWO — the complaint, in whatever language it arrives in. `POST /opd/triage` takes free text
    including Hinglish ("seene mein dard") and answers with a department. Debounced for the same
    reason the search is, and only over text long enough to mean something.
  */
  useEffect(() => {
    const text = complaint.trim();
    if (text.length < 3) { setTriagedDepartmentId(null); return; }
    let live = true;
    const id = setTimeout(() => {
      void triage(text).then(
        (res) => {
          if (!live) return;
          const first = res.suggestions[0];
          setTriagedDepartmentId(first?.departmentId ?? null);
        },
        () => { if (live) setTriagedDepartmentId(null); },
      );
    }, 350);
    return () => { live = false; clearTimeout(id); };
  }, [complaint]);

  /*
    WHICH DOOR IS ANSWERED. Neither is the fallback — the artboard is explicit — so the department
    is whichever door the clerk actually used, with a named doctor winning when both are filled
    because naming a person is a more specific instruction than describing a symptom.
  */
  const pickedDoctor = useMemo(
    () => (doctors.data?.items ?? []).find((d) => d.id === pickedDoctorId) ?? null,
    [doctors.data, pickedDoctorId],
  );
  const departmentId = pickedDoctor?.departmentId ?? triagedDepartmentId;
  const departmentName = useMemo(
    () => (departments.data?.items ?? []).find((d) => d.id === departmentId)?.name ?? "",
    [departments.data, departmentId],
  );

  /* RULE 1's server answer — asked only for a person we already have, in the department we are routing into. */
  const continuity = useQuery({
    queryKey: ["continuity", held?.id ?? "", departmentId ?? ""],
    queryFn: () => getContinuity(held?.id ?? "", departmentId ?? ""),
    enabled: held !== null && departmentId !== null && departmentId !== "",
    staleTime: 60_000,
  });

  const proposal = useMemo((): WalkInProposal | null => {
    if (departmentId === null || departmentId === "") return null;
    const items: WireDoctorSummary[] = summaries.data?.items ?? [];
    if (items.length === 0) return null;
    const base = proposeWalkIn(departmentId, items, continuity.data?.anchor ?? null);
    /*
      A DOCTOR NAMED BY THE CLERK OVERRULES THE PROPOSAL, and the card says so rather than quietly
      showing the clerk's own choice back to them as a recommendation. `proposeWalkIn` is left
      untouched — it is the routing library and it answers what the RULES say; this is the clerk
      exercising the overrule the artboard's own prose tells them they have.
    */
    if (pickedDoctor === null) return base;
    const chosen = items.find((s) => s.doctor.id === pickedDoctor.id) ?? null;
    if (chosen === null) return base;
    return {
      ...base,
      rule: base.anchor?.doctorId === chosen.doctor.id ? "continuity" : base.rule,
      doctor: chosen,
      waitMinutes: waitMinutes(chosen),
    };
  }, [departmentId, summaries.data, continuity.data, pickedDoctor]);

  /* ── the form's own rules, all of them borrowed rather than re-derived ────────────────────── */

  const abha = useQuery({ queryKey: ["abha-capability"], queryFn: abhaCapability, staleTime: 5 * 60_000, retry: false });
  const needsGuardian = formNeedsGuardian(form);
  const guardianReady = form.guardianName.trim() !== "" && form.guardianRelationship !== "";
  const aliasReady = !form.isConfidential || form.alias.trim() !== "";
  const ready = form.name.trim() !== "" && form.sex !== "" && (!needsGuardian || guardianReady) && aliasReady;

  const age = formAgeYears(form);

  /* ── committing ──────────────────────────────────────────────────────────────────────────── */

  /**
   * ═══ ONE BUTTON, TWO HONEST LABELS ═══
   *
   * The artboard draws one primary action: "Register and open the visit". That is right whenever a
   * door has been answered. It is NOT right when no doctor has been chosen — and registering
   * somebody who is not seeing a doctor today is an ordinary thing a front desk does, for a lab
   * test, for a card, for an admission tomorrow.
   *
   * So the control is one button whose label says which of the two it is about to do, rather than
   * two buttons or one button that silently does different things. `POST /opd/walk-in` registers
   * AND seats in one server transaction when there is a doctor; `POST /patients` registers alone
   * when there is not.
   */
  const willOpenVisit = departmentId !== null && departmentId !== "" && proposal?.doctor != null;

  const commit = useCallback(async (acknowledgeDuplicates = false): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = registerBodyOf(form, { acknowledgeDuplicates });
      if (willOpenVisit && proposal?.doctor != null && departmentId !== null) {
        /*
          REGISTERED AND SEATED IN ONE CALL. `POST /opd/walk-in` does both inside one transaction,
          which is what makes the token and the paper one event — FD-24's printing hangs off the
          visit opening, so a registration that succeeded and a seating that failed would leave a
          patient with a UHID, no token and a slip that never printed.
        */
        const res = await walkIn(
          {
            patient: held === null ? { register: body as unknown as Record<string, unknown> } : { existingId: held.id },
            departmentId,
            doctorId: proposal.doctor.doctor.id,
            ...(acknowledgeDuplicates ? { acknowledgedDuplicates: true } : {}),
          },
          crypto.randomUUID(),
        );
        setIssued({ uhid: held?.uhid ?? "", tokenNo: res.tokenNo });
        note(t("registrationSeat.log.seated", {
          token: res.tokenNo,
          doctor: proposal.doctor.doctor.displayName,
        }), "ok");
        void navigate({ to: "/opd/desk" });
        return;
      }
      const res = await registerPatient(body);
      setIssued({ uhid: res.patient.uhid, tokenNo: null });
      setHeld({
        id: res.patient.id,
        uhid: res.patient.uhid,
        name: res.patient.name,
        facts: [sexLetter(form.sex), age === null ? null : `${String(age)}y`].filter((x) => x !== null).join(" · "),
        hindiName: null,
      });
      setDuplicates(null);
      note(t("registrationSeat.log.registered", { uhid: res.patient.uhid }), "ok");
    } catch (e) {
      /*
        A DUPLICATE IS A WARNING, NOT A REFUSAL. A second real Asha Devi on a shared family phone
        must be registrable, and a desk that cannot register her learns to invent phone numbers
        instead — which is how a patient master rots.
      */
      const candidates = duplicateCandidates(e);
      if (candidates !== null) {
        setDuplicates(candidates);
        note(t("registrationSeat.log.duplicate", { count: candidates.length }), "warn");
      } else {
        const message = opdErrorMessage(e);
        setError(message);
        note(message, "err");
      }
    } finally {
      setBusy(false);
    }
  }, [ready, busy, form, willOpenVisit, proposal, departmentId, held, age, note, t, navigate]);

  /* ── keyboard ────────────────────────────────────────────────────────────────────────────── */

  const startEnrolment = useCallback((): void => {
    setHeld(null);
    setIssued(null);
    setDuplicates(null);
    setError(null);
    /* The query is not thrown away — a clerk who typed a name then found nobody has already typed it. */
    setForm({
      ...EMPTY_FORM,
      name: query.replace(/\d/g, "").trim(),
      phone: /^\d{6,}$/.test(query.replace(/\s/g, "")) ? query.replace(/\s/g, "") : "",
    });
  }, [query]);

  const backToSearch = useCallback((): void => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  /**
   * ═══ F4 IS BOUND LOCALLY AND STOPS THE GLOBAL ONE, OR THIS SEAT LOSES ITS PATIENT ═══
   *
   * `lib/keyboard.tsx` binds `F4` globally to `navigate({ to: "/counter", search: { new: true } })`
   * — "a new patient is in front of me", from anywhere in the application. That is correct
   * everywhere except here, where `F4` is the artboard's own "Register new" button: a clerk halfway
   * through a registration who presses it would be thrown onto Desk One with their form gone.
   *
   * Bound in the CAPTURE phase with `stopPropagation`, so it wins over the provider's window
   * listener without that listener needing to know this screen exists. The global handler and its
   * test are untouched — the key means the same thing in both places, and here the door is already
   * open.
   *
   * `Esc` returns the cursor to the search box, which is what the artboard's header button claims,
   * and a keycap that lies is worse than none.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "F4") {
        e.preventDefault();
        e.stopPropagation();
        startEnrolment();
      } else if (e.key === "Escape") {
        e.preventDefault();
        /*
          ═══ CLOSE PASS 2 — THE FIX LANDED ON THE CLICK HANDLER AND NOT ON THE KEY ═══

          Pass 1 made the Cancel BUTTON clear `held` and `issued`. This key did not move, and the
          button draws an `Esc` keycap — so the screen's own rule ("a keycap that lies is worse than
          none") was broken by the fix rather than before it, and the CRITICAL stayed reachable on
          the keyboard this seat is built around:

            register Asha with no doctor (sets `held`, does not navigate) → she leaves → Sunita
            arrives → the clerk presses Esc, the key printed on the button → the cursor moves and
            `held` is still Asha → they overwrite the form and commit → Asha gets the token.

          Narrower than the click road, because Esc does not blank the form and a clerk may notice
          the old values. "May notice" is not a guard.
        */
        setForm(EMPTY_FORM); setDuplicates(null); setError(null); setHeld(null); setIssued(null);
        backToSearch();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        /* Ctrl+Enter commits. A CHORD deliberately: Keymap law 4 is "nothing destructive on a bare key". */
        e.preventDefault();
        void commit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); };
  }, [startEnrolment, backToSearch, commit]);

  /* ── the co-pilot, answering only from what is on this screen ─────────────────────────────── */

  const ask = useCallback((question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    if (q.includes("guardian") || q.includes("minor") || q.includes("child")) {
      setAnswer(
        age === null
          ? t("registrationSeat.agent.guardianUnknownAge")
          : needsGuardian
            ? t("registrationSeat.agent.guardianNeeded", { age })
            : t("registrationSeat.agent.guardianNotNeeded", { age }),
      );
    } else if (q.includes("doctor") || q.includes("route") || q.includes("wait")) {
      setAnswer(
        proposal?.doctor == null
          ? t("registrationSeat.agent.noRoute")
          : t("registrationSeat.agent.route", {
            doctor: proposal.doctor.doctor.displayName,
            rule: proposal.rule,
            minutes: proposal.waitMinutes ?? 0,
          }),
      );
    } else if (q.includes("duplicate") || q.includes("same")) {
      setAnswer(
        duplicates === null
          ? t("registrationSeat.agent.noDuplicates", { count: hits.data?.length ?? 0 })
          : t("registrationSeat.agent.duplicates", { count: duplicates.length }),
      );
    } else if (q.includes("uhid") || q.includes("number") || q.includes("card")) {
      setAnswer(
        issued === null
          ? t("registrationSeat.agent.uhidPending")
          : t("registrationSeat.agent.uhidIssued", { uhid: issued.uhid }),
      );
    } else {
      /* Saying plainly what it cannot see is the whole contract — a dock that bluffs is worse than none. */
      setAnswer(t("registrationSeat.agent.scope"));
    }
  }, [age, needsGuardian, proposal, duplicates, hits.data, issued, t]);

  /* ── render ──────────────────────────────────────────────────────────────────────────────── */

  const hitRows: WirePatientHit[] = hits.data ?? [];
  const discriminating = matchReasonsDiscriminate(hitRows);

  return (
    <PaperScreen testId="registration-seat">
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", padding: "18px 22px", gap: 14, minWidth: 0 }}>
        <ScreenTitle
          title={t("registrationSeat.header.title")}
          route="/registration"
          actions={
            <>
              {/* The artboard's pill. It is true: this seat takes no money and has no drawer. */}
              <span className="pill on">{t("registrationSeat.header.noDrawer")}</span>
              {/*
                ═══ FOUND BY LOOKING — THIS BUTTON SAID EXACTLY WHAT THE SHELL'S ALREADY SAYS ═══

                The artboard's header carries "Search — the cursor starts here [Esc]", and it was
                right to: on a standalone canvas that bar was the ONLY search affordance. Inside the
                app shell it is not. `router.tsx` puts a global search button in the header reading
                `t("shell.search")` — the identical sentence — bound to F8, about a centimetre away.

                Two buttons, the same words, two different keys, side by side. That is FD-1's
                two-doors defect in miniature, and no test could see it: both render, both work, and
                each is correct about itself. Only a screenshot puts them next to each other.

                So this one says what it actually does, which is a different thing from the global
                search: it returns the cursor to THIS screen's find box.
              */}
              <button className="sec" type="button" data-testid="focus-search" onClick={backToSearch} style={{ gap: 9 }}>
                <span>{t("registrationSeat.header.backToSearch")}</span>
                <span className="kb">Esc</span>
              </button>
            </>
          }
        />

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* ═══ THE RAIL ═══ */}
          <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column", gap: 13 }}>
            <div className="box" style={{ padding: 14 }}>
              <span className="tag">{t("registrationSeat.rail.inHand")}</span>
              {/*
                ═══ FOUND BY LOOKING — THE RAIL WAS DEAD WEIGHT DURING THE COMMONEST OPERATION ═══

                It said "Nobody at the counter yet" while the clerk was typing that very person's
                name into the form beside it. Literally true — there is no UHID yet — and useless:
                the rail is the column that answers WHO IS THIS, and during a registration the
                answer is on screen and simply was not being shown.

                So an unregistered person appears here as soon as they have a name, marked as not
                yet registered. It is the same card, not a second one, because a clerk should not
                have to learn two places to look for the same fact — and the moment the UHID exists
                the card gains it without moving.
              */}
              {held === null && form.name.trim() === "" ? (
                <p data-testid="rail-empty" style={{ margin: "9px 0 0", color: "var(--faint)", fontSize: 12.5 }}>
                  {t("registrationSeat.rail.nobodyYet")}
                </p>
              ) : held === null ? (
                <div data-testid="rail-drafting">
                  <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span data-testid="rail-name" style={{ fontSize: 16, fontWeight: 600, lineHeight: "20px" }}>
                      {form.name.trim()}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--dim)" }}>
                      {[form.sex === "" ? null : t(`registrationSeat.form.${form.sex}`), age === null ? null : `${String(age)}y`]
                        .filter((x) => x !== null).join(" · ")}
                    </span>
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    <span className="pill gd">{t("registrationSeat.rail.notYetRegistered")}</span>
                    {needsGuardian ? <span className="pill gd">{t("registrationSeat.rail.guardianNeeded")}</span> : null}
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span data-testid="rail-name" style={{ fontSize: 16, fontWeight: 600, lineHeight: "20px" }}>{held.name}</span>
                    {held.hindiName === null ? null : (
                      <span className="dev" style={{ fontSize: 12.5, color: "var(--dim)" }}>{held.hindiName}</span>
                    )}
                    <span className="mo" style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3 }}>{held.uhid}</span>
                    <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{held.facts}</span>
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {form.guardianName.trim() === ""
                      ? null
                      : <span className="pill on">{t("registrationSeat.rail.guardianOnFile")}</span>}
                    {form.abhaAddress.trim() === "" && form.abhaNumber.trim() === ""
                      ? <span className="pill">{t("registrationSeat.rail.noAbha")}</span>
                      : null}
                  </div>
                </>
              )}
            </div>
            <TheirCard uhid={issued?.uhid ?? held?.uhid ?? null} onPhoto={() => { setOpenFold("photo"); }} />
          </div>

          {/* ═══ THE WORKSPACE ═══ */}
          <div style={{ flexGrow: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 14 }}>

            {/* ── SEARCH FIRST. The owner's ruling, and the helper says why in the same breath. ── */}
            <div className="box" style={{ padding: "15px 16px" }}>
              <label
                htmlFor="reg-search"
                style={{ fontSize: 15, fontWeight: 600, display: "block", marginBottom: 9 }}
              >
                {t("registrationSeat.search.heading")}
              </label>
              <input
                id="reg-search"
                ref={searchRef}
                className="in"
                data-testid="reg-search"
                autoFocus
                value={query}
                placeholder={t("registrationSeat.search.placeholder")}
                onChange={(e) => { setQuery(e.target.value); }}
              />
              <p style={{ margin: "7px 0 0", fontSize: 11.5, color: "var(--faint)" }}>
                {t("registrationSeat.search.helper")}
              </p>

              {debounced.length >= 2 ? (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
                  {hitRows.map((hit) => (
                    <button
                      key={hit.id}
                      className="hit box"
                      type="button"
                      data-testid={`hit-${hit.id}`}
                      onClick={() => {
                        setHeld({
                          id: hit.id, uhid: hit.uhid, name: hit.name,
                          facts: [sexLetter(hit.administrativeGender), ageOf(hit.dob)].filter((x) => x !== "" && x !== null).join(" · "),
                          hindiName: null,
                        });
                        note(t("registrationSeat.log.tookHit", { uhid: hit.uhid }));
                      }}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", width: "100%" }}
                    >
                      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flexGrow: 1 }}>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{hit.name}</span>
                          <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{hit.uhid}</span>
                        </span>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>
                            {[sexLetter(hit.administrativeGender), ageOf(hit.dob)].filter((x) => x !== "" && x !== null).join(" · ")}
                          </span>
                          <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{hit.phone ?? "—"}</span>
                        </span>
                      </span>
                      {/*
                        THE PILL IS THE *WHY*. `matchReasonsDiscriminate` is what stops it becoming
                        furniture: when every row matched for the same reason, saying so on all three
                        tells the clerk nothing and the pills are dropped.
                      */}
                      {discriminating ? (
                        <span className="pill">{matchReasonKeys(hit.matchedOn).map((k) => t(k)).join(" · ")}</span>
                      ) : null}
                    </button>
                  ))}
                  <div style={{ display: "flex", alignItems: "center", gap: 11, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                    <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
                      {hitRows.length === 0
                        ? t("registrationSeat.hits.noneFound")
                        : t("registrationSeat.hits.noneOfThese")}
                    </span>
                    <button className="sec grn" type="button" data-testid="register-new" onClick={startEnrolment}>
                      {t("registrationSeat.hits.registerNew")} <span className="kb">F4</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/*
              ═══ THE FORM IS ALWAYS ON SCREEN — THE ARTBOARD'S OWN LAYOUT, AND A SCREENSHOT SAID SO ═══

              This screen first rendered the form only after "Register new" was pressed, reasoning
              that search-first meant form-later. The artboard does not: it draws the search box and
              the form together, with no conditional around the form, and the first screenshot of the
              built screen showed why that matters — a 1440×980 counter monitor with one search box
              at the top and roughly six hundred pixels of empty paper below it.

              Search-first is preserved by the things that actually enforce it: the find box takes
              focus on arrival, the helper says why in the same breath, and the hits land ABOVE the
              form. What is gone is the extra press between a clerk and the four fields they were
              always going to fill.
            */}
            <div className="box" data-testid="reg-form" style={{ padding: "15px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t("registrationSeat.form.newPatient")}</span>
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("registrationSeat.form.fourFields")}</span>
              </div>

              <div style={GRID2}>
                <div style={{ gridColumn: "span 2" }}>
                  {/*
                    NO `autoFocus` HERE — THE FIND BOX OWNS ARRIVAL, AND TWO OF THEM IS A RACE.

                    The Keymap pins the tab order as 1 Search, 2 Name, and the search box carries
                    `autoFocus` for that reason. Once the form became unconditionally visible this
                    field's own `autoFocus` started competing for the cursor on mount, and which one
                    wins is decided by mount order rather than by anything the design says.

                    It is not cosmetic: a clerk who arrives to a cursor already in the NAME box has
                    been silently invited to skip the search that exists to stop duplicates — the
                    exact ruling this screen is built around, undone by an attribute.
                  */}
                  <Field
                    id="reg-name-input" testId="reg-name" label={t("registrationCounter.register.fullName")}
                    value={form.name} onChange={(v) => { set({ name: v }); }}
                  />
                </div>
                <Field
                  id="reg-phone-input" testId="reg-phone" label={t("registrationCounter.register.mobile")} mono
                  inputMode="numeric" value={form.phone} onChange={(v) => { set({ phone: v }); }}
                />
                <Field
                  id="reg-age-input" testId="reg-age" label={t("registrationCounter.register.age")} mono
                  inputMode="numeric" value={form.age} onChange={(v) => { set({ age: v }); }}
                />
                <div style={{ gridColumn: "span 2" }}>
                  <Segmented
                    id="reg-sex-label" testId="reg-sex" label={t("registrationCounter.register.sex")}
                    value={form.sex}
                    onChange={(v) => { set({ sex: v }); }}
                    options={[
                      ["female", t("registrationSeat.form.female")],
                      ["male", t("registrationSeat.form.male")],
                      ["other", t("registrationSeat.form.other")],
                    ] as const}
                  />
                </div>
              </div>

              {/* ── THE TWO DOORS, INLINE. Neither is the fallback. ── */}
              <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 13 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 9 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("registrationSeat.doors.heading")}</span>
                  <span style={{ fontSize: 11, color: "var(--faint)" }}>{t("registrationSeat.doors.hint")}</span>
                </div>
                <div style={GRID2}>
                  <div>
                    <Field
                      id="reg-doctor-input" testId="reg-doctor" label={t("registrationSeat.doors.byName")}
                      value={doctorQuery}
                      placeholder={t("registrationSeat.doors.byNamePlaceholder")}
                      onChange={(v) => { setDoctorQuery(v); setPickedDoctorId(null); }}
                    />
                    {doctorMatches.length > 0 && pickedDoctorId === null ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        {doctorMatches.map((d) => (
                          <button
                            key={d.id}
                            className="sec"
                            type="button"
                            data-testid={`doctor-${d.id}`}
                            onClick={() => { setPickedDoctorId(d.id); setDoctorQuery(d.displayName); }}
                            style={{ justifyContent: "flex-start" }}
                          >
                            {d.displayName}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <Field
                    id="reg-complaint-input" testId="reg-complaint" label={t("registrationSeat.doors.complaint")}
                    value={complaint}
                    placeholder={t("registrationSeat.doors.complaintPlaceholder")}
                    onChange={(v) => { setComplaint(v); }}
                  />
                </div>

                {proposal === null ? null : <Proposal proposal={proposal} departmentName={departmentName} />}
              </div>

              {/* ── THE GUARDIAN. Appears on the age, never before, and the server agrees. ── */}
              {needsGuardian ? (
                <div
                  data-testid="guardian-block"
                  style={{
                    border: "1px solid var(--gold-line)", background: "var(--gold-soft)",
                    borderRadius: 8, padding: "13px 14px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#dd8f1c" strokeWidth="1.7" aria-hidden>
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                    </svg>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>
                      {t("registrationSeat.guardian.required", { age: age ?? 0 })}
                    </span>
                    <span className="pill gd" style={{ marginLeft: "auto" }}>DPDP §9</span>
                  </div>
                  <div style={GRID2}>
                    <Field
                      id="guardian-name-input" testId="guardian-name" label={t("registrationCounter.register.guardian.name")}
                      value={form.guardianName} onChange={(v) => { set({ guardianName: v }); }}
                    />
                    <Segmented
                      id="guardian-rel-label" testId="guardian-relationship"
                      label={t("registrationCounter.register.guardian.relationship")}
                      value={form.guardianRelationship}
                      onChange={(v) => { set({ guardianRelationship: v }); }}
                      options={[
                        ["father", t("registrationCounter.register.guardian.father")],
                        ["mother", t("registrationCounter.register.guardian.mother")],
                        ["other", t("registrationCounter.register.guardian.other")],
                      ] as const}
                    />
                    <Field
                      id="guardian-phone-input" testId="guardian-phone" label={t("registrationCounter.register.mobile")}
                      mono inputMode="numeric" value={form.guardianPhone} onChange={(v) => { set({ guardianPhone: v }); }}
                    />
                    <TogglePills
                      testId="guardian-authority"
                      label={t("registrationCounter.register.guardian.authority")}
                      value={{
                        messages: form.guardianAuthorityMessages,
                        bills: form.guardianAuthorityBills,
                        consents: form.guardianAuthorityConsents,
                        records: form.guardianAuthorityRecords,
                      }}
                      onChange={(k, next) => {
                        set(k === "messages" ? { guardianAuthorityMessages: next }
                          : k === "bills" ? { guardianAuthorityBills: next }
                            : k === "consents" ? { guardianAuthorityConsents: next }
                              : { guardianAuthorityRecords: next });
                      }}
                      options={[
                        ["messages", t("registrationCounter.register.guardian.authorityMessages")],
                        ["bills", t("registrationCounter.register.guardian.authorityBills")],
                        ["consents", t("registrationCounter.register.guardian.authorityConsents")],
                        ["records", t("registrationCounter.register.guardian.authorityRecords")],
                      ] as const}
                    />
                  </div>
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("registrationCounter.register.guardian.authorityWhy")}
                  </p>
                </div>
              ) : null}

              {/* ── THE OTHER THREE, FOLDED. A form that shows everything to every walk-in is a form nobody finishes. ── */}
              <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 13 }}>
                <Fold
                  title={t("registrationCounter.register.abha.title")}
                  hint={t("registrationSeat.folds.abhaHint")}
                  state={openFold === "abha" ? t("registrationSeat.folds.open") : t("registrationSeat.folds.notLinked")}
                  stateTone={openFold === "abha" ? "on" : "plain"}
                  open={openFold === "abha"}
                  onToggle={() => { setOpenFold((p) => (p === "abha" ? null : "abha")); }}
                  testId="fold-abha"
                >
                  <div style={{ ...GRID2, marginTop: 11 }}>
                    <Field
                      id="abha-address-input" testId="abha-address" label={t("registrationCounter.register.abha.address")}
                      mono value={form.abhaAddress} onChange={(v) => { set({ abhaAddress: v }); }}
                    />
                    <Field
                      id="abha-number-input" testId="abha-number" label={t("registrationCounter.register.abha.number")}
                      mono value={form.abhaNumber} onChange={(v) => { set({ abhaNumber: v }); }}
                    />
                  </div>
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("registrationSeat.folds.abhaBody")}
                  </p>
                  {/*
                    THE CAPABILITY IS ASKED BEFORE THE BUTTONS ARE DRAWN, never discovered from a
                    failed request. This hospital is not connected to ABDM, so what the fold can
                    honestly do is RECORD what the patient reads off their card — and it says so
                    rather than showing a live-looking "Verify" that only fails when pressed.
                  */}
                  {abha.data?.canVerify === false ? (
                    <p data-testid="abha-why" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--gold)" }}>
                      {abha.data.reason}
                    </p>
                  ) : null}
                </Fold>

                <Fold
                  title={t("registrationSeat.folds.photo")}
                  hint={t("registrationSeat.folds.photoHint")}
                  state={t("registrationSeat.folds.noneOnFile")}
                  open={openFold === "photo"}
                  onToggle={() => { setOpenFold((p) => (p === "photo" ? null : "photo")); }}
                  testId="fold-photo"
                >
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("registrationSeat.folds.photoBody")}
                  </p>
                </Fold>

                <Fold
                  title={t("registrationSeat.folds.confidential")}
                  hint={t("registrationSeat.folds.confidentialHint")}
                  state={form.isConfidential ? t("registrationSeat.folds.sealed") : t("registrationSeat.folds.ordinary")}
                  stateTone={form.isConfidential ? "gd" : "plain"}
                  open={openFold === "confidential"}
                  onToggle={() => { setOpenFold((p) => (p === "confidential" ? null : "confidential")); }}
                  testId="fold-confidential"
                >
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, marginTop: 11 }}>
                    <input
                      type="checkbox"
                      data-testid="reg-confidential"
                      checked={form.isConfidential}
                      onChange={(e) => { set({ isConfidential: e.target.checked }); }}
                    />
                    <span>{t("registrationCounter.register.flags.confidential")}</span>
                  </label>
                  {/*
                    THE ALIAS APPEARS WITH THE DECISION IT BELONGS TO. The server throws
                    `alias_required` for the flag without one — a refusal Desk One shipped into for
                    months because it had no field to satisfy it with.
                  */}
                  {form.isConfidential ? (
                    <div style={{ marginTop: 11 }}>
                      <Field
                        id="reg-alias-input" testId="reg-alias"
                        label={t("registrationCounter.register.flags.alias")}
                        placeholder={t("registrationCounter.register.flags.aliasPlaceholder")}
                        value={form.alias} onChange={(v) => { set({ alias: v }); }}
                      />
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, marginTop: 9 }}>
                        <input
                          type="checkbox"
                          data-testid="reg-sensitive-context"
                          checked={form.sensitiveContext}
                          onChange={(e) => { set({ sensitiveContext: e.target.checked }); }}
                        />
                        <span>{t("registrationCounter.register.flags.sensitiveContext")}</span>
                      </label>
                    </div>
                  ) : null}
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("registrationSeat.folds.confidentialBody")}
                  </p>
                </Fold>
              </div>

              {/* ── THE DUPLICATE WARNING. A warning the clerk may override, never a refusal. ── */}
              {duplicates === null ? null : (
                <div
                  data-testid="duplicate-warning"
                  style={{
                    border: "1px solid var(--gold-line)", background: "var(--gold-soft)",
                    borderRadius: 8, padding: "13px 14px",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>
                    {t("registrationSeat.duplicate.heading", { count: duplicates.length })}
                  </span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
                    {duplicates.map((d) => (
                      <div key={d.id} style={{ display: "flex", gap: 9, alignItems: "baseline", fontSize: 12 }}>
                        <span style={{ fontWeight: 600 }}>{d.name}</span>
                        <span className="mo" style={{ color: "var(--dim)" }}>{d.uhid}</span>
                        <span className="mo" style={{ color: "var(--dim)" }}>{d.phone ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("registrationSeat.duplicate.why")}
                  </p>
                  <button
                    className="sec grn"
                    type="button"
                    data-testid="duplicate-override"
                    style={{ marginTop: 9 }}
                    onClick={() => { void commit(true); }}
                  >
                    {t("registrationSeat.duplicate.override")}
                  </button>
                </div>
              )}

              {error === null ? null : (
                <p data-testid="reg-error" className="pill rd" style={{ height: "auto", padding: "8px 11px" }}>{error}</p>
              )}

              {/* ── THE FOOTER ── */}
              <div style={{ display: "flex", alignItems: "center", gap: 11, borderTop: "1px solid var(--line2)", paddingTop: 13, flexWrap: "wrap" }}>
                {/*
                  `.pri`, the design language's own primary, exactly as Desk One's submit is —
                  NOT `SubmitButton`, which renders a shadcn `<Button>` and would put the one
                  control the eye lands on in the look this screen exists to replace. What
                  `SubmitButton` genuinely contributes is the in-flight REF guard (state alone
                  loses a double-click inside one React tick) and a minted idempotency key;
                  `commit` carries both itself, and `walkIn` is the caller that needs the key.
                */}
                <button
                  className="pri"
                  type="button"
                  data-testid="reg-submit"
                  disabled={!ready || busy}
                  onClick={() => { void commit(); }}
                >
                  {willOpenVisit
                    ? t("registrationSeat.footer.registerAndOpen")
                    : t("registrationSeat.footer.registerOnly")}
                  <span className="kb" style={{ borderColor: "rgba(255,255,255,.3)", background: "transparent", color: "#cfe8dc" }}>
                    Ctrl ⏎
                  </span>
                </button>
                {/*
                  ═══ CLOSE PASS 1, CRITICAL — CANCEL MUST DROP THE PATIENT, NOT JUST THE FORM ═══

                  This cleared `form`, `duplicates` and `error` and left `held` set. `commit()`
                  chooses `held === null ? {register: body} : {existingId: held.id}`, and a
                  register-only commit SETS `held` and does not navigate — so the screen sits there
                  with the previous patient in hand and an empty form.

                  The road: register Asha Devi with no doctor, she leaves; Sunita steps up; the clerk
                  presses the button that says "clear this form", types Sunita's name, sex, age and
                  complaint, and presses "Register and open the visit". The walk-in posts
                  `{existingId: <Asha's id>}`. ASHA GETS THE TOKEN, ASHA'S NAME PRINTS ON THE SLIP,
                  AND SUNITA IS NEVER REGISTERED — with everything the clerk just typed discarded
                  silently, because a body built from the form is not sent when `held` is set.

                  `startEnrolment` (F4) always cleared `held`; this button did not, and it is the one
                  a clerk reaches for between patients because it is the one on the form.
                */}
                <button
                  className="sec" type="button" data-testid="reg-cancel"
                  onClick={() => { setForm(EMPTY_FORM); setDuplicates(null); setError(null); setHeld(null); setIssued(null); backToSearch(); }}
                >
                  {t("registrationSeat.footer.cancel")} <span className="kb">Esc</span>
                </button>
                {/*
                  WHAT THE BUTTON WILL ACTUALLY DO, and it says only what is true. The artboard's
                  "prints the card and the token" is half a sentence this hospital can keep: the
                  token slip is a real `PrintDocument` kind that FD-24 queues on visit-open; there
                  is NO patient-card document — four kinds are declared and a card is not among
                  them. Promising paper that no printer will ever produce is the kind of copy that
                  teaches a clerk to distrust the screen.
                */}
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--faint)" }}>
                  {willOpenVisit ? t("registrationSeat.footer.issuesAndPrints") : t("registrationSeat.footer.issuesOnly")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("registrationSeat.agent.placeholder")}
        idle={t("registrationSeat.agent.idle")}
      />
    </PaperScreen>
  );
}
