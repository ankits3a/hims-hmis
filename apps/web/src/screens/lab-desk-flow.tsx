import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  bookLab, bookingsForDay, bookingsForPatient, cancelLabBooking, commonOrderables, getBookingHours, labErrorText, labSlots,
  noShowLabBooking, orderableDetail, recentLabOrders, reportsForPatient, saveBookingHours, searchOrderables,
} from "../lib/lab-api";
import { fetchRecognition } from "../lib/membership-api";
import { useAuth } from "../lib/auth";
import { CreditDialog, usePatientCredit } from "../components/patient-credit";
import { fmtPaise } from "../lib/format";
import { sexAge } from "./lab-seat";
import type { WireBookingHours, WireDeskFindHit, WireLabBooking, WireOrderable, WireWalkInReadiness } from "../lib/lab-api";

/**
 * OWNER 2026-10-11 — THE LAB DESK, FROM PICKING THE PATIENT TO THE SAMPLE (spec
 * `SPEC-lab-desk-flow-2026-10-11.md`). The pieces `lab-desk.tsx` composes:
 *
 * - `PatientSummary` — what this person has today (advised tests, an order already placed, or
 *   "No test assigned today"), the two next steps as big buttons, their open bookings and their
 *   lab history.
 * - `TestChooser` — the walk-in's "which tests?": the lab's common tests as tap-chips and one
 *   search box. Used by the order step and by the booking panel.
 * - `TubeDot` / `ParametersOf` — a test's tube colour and, on demand, the parameters it reports.
 * - `BookingPanel` — a future visit by date and time slot.
 * - `TodaysBookings` — the list pane's "Booked for today", each with Arrived.
 *
 * Every piece is drawn in /counter's paper-and-pine (`.pp`) primitives.
 */

const PP_FONT = { fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)" } as const;

/** The cap colour a phlebotomist reaches for, by the catalogue's container word. */
const TUBE_COLOUR: Record<string, string> = {
  edta: "#8e6fc6", sst: "#d9a520", plain: "#c0392b", citrate: "#4aa3df", heparin: "#2e8b57",
  fluoride: "#8a8f8c", blood_culture: "#5b6b73", urine: "#e3c34a", stool: "#8b5a2b", swab: "#3b7a8c",
};

export function TubeDot({ container }: { container: string }): React.ReactElement {
  return (
    <span aria-hidden title={container} style={{
      display: "inline-block", width: 10, height: 10, borderRadius: 5, flexShrink: 0,
      background: TUBE_COLOUR[container] ?? "var(--faint)", boxShadow: "0 0 0 2px var(--card)",
    }} />
  );
}

/** A test's parameters, fetched only when the clerk opens it. */
export function ParametersOf({ serviceId }: { serviceId: string }): React.ReactElement {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey: ["lab", "orderable", serviceId], queryFn: () => orderableDetail(serviceId), staleTime: 10 * 60_000, retry: false });
  if (detail.isLoading) return <span style={{ fontSize: 11.5, color: "var(--faint)" }}>…</span>;
  const names = detail.data?.analytes.map((a) => a.nameEn) ?? [];
  return (
    <span style={{ fontSize: 11.5, color: "var(--dim)" }} data-testid={`params-${serviceId}`}>
      {names.length === 0 ? t("lab.desk.flow.noParameters") : names.join(" · ")}
    </span>
  );
}

const asOrderable = (c: { serviceId: string; code: string; nameEn: string; container: string; specimenType: string }): WireOrderable => ({
  serviceId: c.serviceId, code: c.code, nameEn: c.nameEn, nameHi: null, discipline: "",
  specimenType: c.specimenType, container: c.container, consentRequired: false, sensitive: false, active: true,
});

/**
 * "WHICH TESTS?" — chips for what this lab orders most, then one search. A chip already in the
 * basket is drawn pressed and a second tap takes it out again, so the chips are the basket's
 * fastest editor.
 */
export function TestChooser({ chosen, onAdd, onRemove, autoFocus }: {
  chosen: readonly string[];
  onAdd: (o: WireOrderable) => void;
  onRemove: (serviceId: string) => void;
  autoFocus?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 180); return () => clearTimeout(id); }, [q]);
  const common = useQuery({ queryKey: ["lab", "desk", "common"], queryFn: commonOrderables, staleTime: 5 * 60_000, retry: false });
  const found = useQuery({ queryKey: ["lab", "catalogue", debounced], queryFn: () => searchOrderables(debounced), enabled: debounced.length >= 2 });
  const isChosen = (id: string): boolean => chosen.includes(id);

  return (
    <div className="pp" style={{ ...PP_FONT, display: "flex", flexDirection: "column", gap: 10 }} data-testid="test-chooser">
      {(common.data ?? []).length > 0 && (
        <div>
          <div className="tag" style={{ marginBottom: 6 }}>{t("lab.desk.flow.common")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(common.data ?? []).map((c) => (
              <button key={c.serviceId} type="button"
                className={isChosen(c.serviceId) ? "pill on" : "pill"}
                style={{ height: 30, fontSize: 12, padding: "0 11px" }}
                aria-pressed={isChosen(c.serviceId)}
                onClick={() => (isChosen(c.serviceId) ? onRemove(c.serviceId) : onAdd(asOrderable(c)))}>
                <TubeDot container={c.container} />
                {c.code}
                <span style={{ fontWeight: 400, color: "var(--dim)" }}>{c.nameEn.length > 22 ? `${c.nameEn.slice(0, 21)}…` : c.nameEn}</span>
                {isChosen(c.serviceId) && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <input className="in" style={{ height: 44 }} autoFocus={autoFocus}
        placeholder={t("lab.desk.flow.searchTests")} aria-label={t("lab.desk.search")}
        value={q} onChange={(e) => setQ(e.target.value)} />
      {debounced.length >= 2 && found.data !== undefined && (
        <ul style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
          {found.data.length === 0 && <li style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("lab.desk.flow.noTestFound", { q: debounced })}</li>}
          {found.data.slice(0, 12).map((o) => (
            <li key={o.serviceId} className="box" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
              <TubeDot container={o.container} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{o.code}</span>
                <span style={{ color: "var(--dim)" }}> · {o.nameEn}</span>
                {o.consentRequired && <span className="pill gd" style={{ height: 18, marginLeft: 6 }}>{t("lab.desk.consentTag")}</span>}
              </span>
              {isChosen(o.serviceId) ? (
                <button type="button" className="sec" onClick={() => onRemove(o.serviceId)}>{t("lab.desk.flow.added")} ✓</button>
              ) : (
                <button type="button" className="sec grn" onClick={() => { onAdd(o); setQ(""); }}>{t("lab.desk.add")}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtDay(date: string, lang: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(lang.startsWith("hi") ? "hi-IN" : "en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** The summary the clerk sees the moment they tap "This is them". */
export function PatientSummary({ hit, serviceDate, labFree, walkIn, canOpenReports, onWalkIn, onBook, onOrderAdvised, onArrived, stepOpen, showHistory = true }: {
  hit: WireDeskFindHit;
  /** /lab/counter shows the history in its left lane, so its right column leaves it out. */
  showHistory?: boolean;
  /** Whether this hospital can open a lab walk-in at all; only asked for a patient with no visit today. */
  walkIn?: WireWalkInReadiness;
  serviceDate: string;
  labFree: boolean;
  canOpenReports: boolean;
  onWalkIn: () => void;
  onBook: () => void;
  onOrderAdvised: () => void;
  onArrived: (b: WireLabBooking) => void;
  /** Which next step is open below, so its button reads as chosen. */
  stepOpen: "none" | "order" | "book" | "done";
}): React.ReactElement {
  const { t } = useTranslation();

  const advisedPending = (hit.visit?.advised ?? []).filter((a) => a.alreadyOrderedItemId === null && a.orderable !== null);
  return (
    <div className="pp" style={{ ...PP_FONT, display: "flex", flexDirection: "column", gap: 12 }} data-testid="patient-summary">
      {/* ── today ── */}
      <div className="box" style={{ padding: "14px 16px" }} data-testid="today-status">
        <div className="tag">{t("lab.desk.flow.today")}</div>
        {advisedPending.length > 0 ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {hit.visit?.doctorName ? t("lab.desk.flow.advisedBy", { doctor: hit.visit.doctorName }) : t("lab.desk.flow.advised")}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {advisedPending.map((a) => (
                <span key={a.serviceId} className="pill on" style={{ height: 24 }}>
                  {a.orderable !== null && <TubeDot container={a.orderable.container} />}{a.code}
                </span>
              ))}
            </div>
          </div>
        ) : hit.orders.length > 0 ? (
          <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700 }}>
            {t("lab.desk.flow.orderedToday", { orders: hit.orders.map((o) => `${o.orderNo} (${String(o.itemCount)})`).join(", ") })}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 17, fontWeight: 700, color: "var(--dim)" }} data-testid="no-test-today">
            {t("lab.desk.flow.noTestToday")}
          </div>
        )}
        {labFree && (
          <div className="pill on" style={{ marginTop: 10, height: 24 }} data-testid="lab-free">{t("lab.desk.flow.labFree")}</div>
        )}
      </div>

      {hit.visit === null && walkIn !== undefined && <WalkInBlocked readiness={walkIn} />}

      {/* ── the next step, as one big choice ── */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {advisedPending.length > 0 && (
          <button type="button" className="pri" style={{ height: 48, flex: "1 1 200px" }} onClick={onOrderAdvised}>
            {t("lab.desk.flow.orderAdvised", { count: advisedPending.length })}
          </button>
        )}
        <button type="button" className={advisedPending.length === 0 ? "pri" : "sec"}
          style={{ height: 48, flex: "1 1 160px", ...(stepOpen === "order" && advisedPending.length === 0 ? { boxShadow: "0 0 0 3px var(--green-soft)" } : {}) }}
          disabled={hit.visit === null && walkIn !== undefined && !walkIn.ready}
          onClick={onWalkIn}>
          {t("lab.desk.flow.newWalkIn")}
        </button>
        <button type="button" className="sec"
          style={{ height: 48, flex: "1 1 160px", ...(stepOpen === "book" ? { borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 } : {}) }}
          onClick={onBook}>
          {t("lab.desk.flow.futureAppointment")}
        </button>
      </div>

      {showHistory && <LabHistory hit={hit} serviceDate={serviceDate} canOpenReports={canOpenReports} onArrived={onArrived} />}
    </div>
  );
}

/**
 * THE PERSON'S LAB STORY — bookings still open (Arrived on the day, No-show once the day has come,
 * Cancel), then reports and orders in progress, then past bookings. Drawn in the summary and in the
 * patient lane beside the walk-in and booking screens.
 */
export function LabHistory({ hit, serviceDate, canOpenReports, onArrived, compact = false, bookingsOnly = false }: {
  hit: WireDeskFindHit;
  serviceDate: string;
  canOpenReports: boolean;
  onArrived: (b: WireLabBooking) => void;
  compact?: boolean;
  /** The counter's lane shows its own recent tests; it borrows only the open bookings from here. */
  bookingsOnly?: boolean;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const pid = hit.patient.id;
  const history = useQuery({ queryKey: ["lab", "reports", "patient", pid], queryFn: () => reportsForPatient(pid), retry: false, enabled: !bookingsOnly });
  const bookings = useQuery({ queryKey: ["lab", "bookings", "patient", pid], queryFn: () => bookingsForPatient(pid), retry: false });
  const close = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: "cancel" | "no_show" }) => (outcome === "cancel" ? cancelLabBooking(id) : noShowLabBooking(id)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lab", "bookings"] }); },
  });
  const open = (bookings.data ?? []).filter((b) => b.status === "booked");
  const closed = (bookings.data ?? []).filter((b) => b.status !== "booked").slice(0, 5);
  const reports = history.data?.reports ?? [];
  const pending = history.data?.pending ?? [];
  const nothingYet = !history.isLoading && !bookings.isLoading && reports.length === 0 && pending.length === 0 && (bookings.data ?? []).length === 0;
  const row = { display: "flex", alignItems: "center", gap: compact ? 6 : 10, padding: compact ? "7px 9px" : "9px 12px", flexWrap: "wrap" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {open.length > 0 && (
        <div>
          <div className="tag" style={{ marginBottom: 6 }}>{t("lab.desk.flow.openBookings")}</div>
          <ul style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="open-bookings">
            {open.map((b) => (
              <li key={b.id} className="box" style={{ ...row, borderColor: "var(--gold-line)" }}>
                <span className="mo" style={{ fontWeight: 600, fontSize: 12.5 }}>{fmtDay(b.serviceDate, i18n.language)} · {b.slotStart}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--dim)" }}>{b.tests.map((x) => x.code).join(", ")}</span>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {b.serviceDate === serviceDate && (
                    <button type="button" className="sec grn" onClick={() => onArrived(b)}>{t("lab.desk.flow.arrived")}</button>
                  )}
                  {b.serviceDate <= serviceDate && (
                    <button type="button" className="sec" disabled={close.isPending} onClick={() => close.mutate({ id: b.id, outcome: "no_show" })}>{t("lab.desk.flow.noShow")}</button>
                  )}
                  <button type="button" className="sec" disabled={close.isPending} onClick={() => close.mutate({ id: b.id, outcome: "cancel" })}>{t("lab.desk.flow.cancelBooking")}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!bookingsOnly && <div>
        <div className="tag" style={{ marginBottom: 6 }}>{t("lab.desk.flow.history")}</div>
        {nothingYet && <div style={{ fontSize: 12.5, color: "var(--faint)" }} data-testid="no-history">{t("lab.desk.flow.noHistory")}</div>}
        <ul style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="lab-history">
          {pending.map((p) => (
            <li key={p.orderId} className="box" style={row}>
              <span className="mo" style={{ fontSize: 12, fontWeight: 600 }}>{fmtDay(p.serviceDate, i18n.language)}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{p.orderables.join(", ")}</span>
              <span className="pill gd" style={{ height: 20 }}>
                {t("lab.desk.flow.inProgress", { done: p.completedCount, total: p.itemCount })}
              </span>
            </li>
          ))}
          {reports.map((r) => (
            <li key={r.reportId} className="box" style={row}>
              <span className="mo" style={{ fontSize: 12, fontWeight: 600 }}>{fmtDay(r.serviceDate, i18n.language)}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{r.orderables.join(", ")}</span>
              <span className={r.delivery.allowed ? "pill on" : "pill rd"} style={{ height: 20 }}>
                {r.delivery.allowed ? t("lab.desk.flow.reportReady") : t("lab.desk.flow.reportHeld")}
              </span>
              {canOpenReports && (
                <a className="sec" href={`/lab/reports?${new URLSearchParams({ patientId: pid, uhid: hit.patient.uhid, name: hit.patient.display }).toString()}`}>
                  {t("lab.desk.flow.openReport")}
                </a>
              )}
            </li>
          ))}
          {closed.map((b) => (
            <li key={b.id} style={{ fontSize: 11.5, color: "var(--faint)", paddingLeft: 4 }}>
              {fmtDay(b.serviceDate, i18n.language)} {b.slotStart} · {b.tests.map((x) => x.code).join(", ")} · {t(`lab.desk.flow.bookingStatus.${b.status}`)}
            </li>
          ))}
        </ul>
      </div>}
    </div>
  );
}

const STAGE_PILL: Record<string, string> = {
  awaiting_blood: "pill gd", sample_taken: "pill", draft: "pill gd", report_ready: "pill on", handed_over: "pill", cancelled: "pill rd", in_lab: "pill",
};

/** OWNER 2026-10-11 — the counter's lane: the last three lab orders, then all of them on View more. */
export function RecentTests({ patientId }: { patientId: string }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const recent = useQuery({ queryKey: ["lab", "recent", patientId], queryFn: () => recentLabOrders(patientId), retry: false });
  const rows = recent.data ?? [];
  const shown = all ? rows : rows.slice(0, 3);
  return (
    <div data-testid="recent-tests">
      <div className="tag" style={{ marginBottom: 6 }}>{t("lab.counter.recentTests")}</div>
      {recent.isSuccess && rows.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)" }}>{t("lab.desk.flow.noHistory")}</div>}
      <ul style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((o) => (
          <li key={o.orderId} className="box" style={{ padding: "7px 9px", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="mo" style={{ fontSize: 11.5, fontWeight: 600 }}>{fmtDay(o.placedAt.slice(0, 10), i18n.language)}</span>
              <span className="mo" style={{ fontSize: 11, color: "var(--faint)" }}>{o.orderNo}</span>
              <span className={STAGE_PILL[o.stage] ?? "pill"} style={{ height: 19, marginLeft: "auto" }}>{t(`lab.counter.stage.${o.stage}`)}</span>
            </div>
            <div style={{ fontSize: 12 }}>{o.tests.map((x) => x.nameEn).join(", ")}</div>
          </li>
        ))}
      </ul>
      {rows.length > 3 && (
        <button type="button" className="sec" style={{ marginTop: 6, height: 28 }} onClick={() => setAll((v) => !v)}>
          {all ? t("lab.counter.showLess") : t("lab.counter.viewMore", { count: rows.length - 3 })}
        </button>
      )}
    </div>
  );
}

/**
 * THE PATIENT IN HAND — the left panel beside the walk-in and booking screens, the way Desk One's
 * dossier sits beside its stages: who they are, what they hold with the hospital (credit, the
 * memberships the server recognises) and their lab story.
 */
export function PatientLane({ hit, serviceDate, onBack, onArrived, variant = "desk" }: {
  hit: WireDeskFindHit;
  serviceDate: string;
  onBack: () => void;
  onArrived: (b: WireLabBooking) => void;
  /** `counter` (/lab/counter): the last three tests with View more, then open bookings. */
  variant?: "desk" | "counter";
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const p = hit.patient;
  const mayRecognise = can("membership.instrument.recognise") && !p.restricted;
  const recognition = useQuery({
    queryKey: ["lab", "recognition", p.id], queryFn: () => fetchRecognition({ patientId: p.id }), enabled: mayRecognise, retry: false,
  });
  const memberships = (recognition.data?.memberships ?? []).filter((m) => m.usable);
  const initials = p.display.split(/\s+/).filter((w) => w !== "").slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

  return (
    <div className="pp" style={{ ...PP_FONT, display: "flex", flexDirection: "column", gap: 14, marginTop: 4 }} data-testid="patient-card">
      <button type="button" className="sec" style={{ alignSelf: "flex-start", height: 30 }} onClick={onBack}>← {t("lab.desk.flow.backToSummary")}</button>
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <div aria-hidden style={{
          width: 46, height: 46, borderRadius: 8, background: "var(--green-soft)", color: "var(--green)", display: "flex",
          alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0,
        }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.25 }}>{p.display}</div>
          <div className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{sexAge(p.administrativeGender, p.dob)} · {p.uhid}</div>
          {p.guardian != null && (
            <div style={{ fontSize: 11.5, color: "var(--dim)" }}>
              {p.guardian.relation === null
                ? t("lab.desk.fatherHusband", { name: p.guardian.name })
                : t("lab.desk.guardianOf", { name: p.guardian.name, relation: t(`lab.desk.relation.${p.guardian.relation}`, { defaultValue: p.guardian.relation }) })}
            </div>
          )}
          {p.phoneLast4 != null && <div className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>••••{p.phoneLast4}{p.phoneOf === "guardian" ? ` (${t("lab.desk.guardianMobile")})` : ""}</div>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--dim)" }}>
        {hit.visit !== null
          ? <>{t("lab.desk.visit")} <span className="mo" style={{ color: "var(--ink)", fontWeight: 600 }}>{hit.visit.encounterNo}</span>{hit.visit.doctorName !== null && <> · {hit.visit.doctorName}</>}{hit.visit.tokenNo !== null && <> · <b style={{ color: "var(--ink)" }}>T-{hit.visit.tokenNo}</b></>}</>
          : t("lab.desk.flow.noVisitToday")}
      </div>

      {!p.restricted && (
        <div>
          <div className="tag" style={{ marginBottom: 4 }}>{t("lab.desk.flow.withTheHospital")}</div>
          <LaneCredit patientId={p.id} />
          {mayRecognise && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} data-testid="lane-memberships">
              {memberships.length === 0
                ? <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("lab.desk.flow.noMembership")}</span>
                : memberships.map((m) => <span key={m.instanceId} className="pill on">✓ {m.planTitle}</span>)}
            </div>
          )}
        </div>
      )}

      {variant === "counter" && <RecentTests patientId={p.id} />}
      <LabHistory hit={hit} serviceDate={serviceDate} canOpenReports={can("lab.reports.print")} onArrived={onArrived} compact bookingsOnly={variant === "counter"} />
    </div>
  );
}

/** Credit the hospital holds for this person, one line in the lane; a tap opens the same dialog as everywhere else. */
function LaneCredit({ patientId }: { patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const d = usePatientCredit(patientId);
  if (d === undefined) return null;
  return (
    <>
      <button type="button" data-testid="lane-credit" onClick={() => setOpen(true)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, width: "100%", fontSize: 12.5 }}>
        <span style={{ color: "var(--dim)" }}>{t("profile.credit.tile")}</span>
        <span>
          <b className="mo" style={{ color: d.totalAvailablePaise > 0 ? "var(--green)" : undefined }}>{fmtPaise(d.totalAvailablePaise)}</b>
          <span style={{ color: "var(--dim)", marginLeft: 6 }}>{t("profile.credit.details")} ›</span>
        </span>
      </button>
      <CreditDialog d={d} open={open} setOpen={setOpen} />
    </>
  );
}

/** What stops a walk-in at this hospital, said so the OPD admin can fix it — shown before the button, not after it. */
export function WalkInBlocked({ readiness }: { readiness: WireWalkInReadiness }): React.ReactElement | null {
  const { t } = useTranslation();
  if (readiness.ready || readiness.problem === null) return null;
  return (
    <div className="pp box" role="note" data-testid="walkin-blocked"
      style={{ ...PP_FONT, padding: "12px 14px", borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
      <div style={{ fontWeight: 700, color: "var(--gold)" }}>{t("lab.desk.flow.walkInBlockedTitle")}</div>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>{t(`lab.desk.flow.walkInBlocked.${readiness.problem}`)}</div>
    </div>
  );
}

/** The next fourteen calendar days from today, as the date strip shows them. */
function nextDays(from: string, n: number): string[] {
  const out: string[] = [];
  const base = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export type Chosen = { serviceId: string; code: string; nameEn: string; container: string };

/** A FUTURE VISIT: a day, a slot with room, and the tests. */
export function BookingPanel({ hit, serviceDate, onBooked, onClose }: {
  hit: WireDeskFindHit;
  serviceDate: string;
  onBooked: (message: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const hours = useQuery({ queryKey: ["lab", "booking-hours"], queryFn: getBookingHours, staleTime: 60_000, retry: false });
  const closedDays = hours.data?.closedWeekdays ?? [0];
  const days = useMemo(() => nextDays(serviceDate, Math.min(14, (hours.data?.daysAhead ?? 30) + 1)), [serviceDate, hours.data?.daysAhead]);
  const isClosed = (d: string): boolean => closedDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  const [day, setDay] = useState(() => days.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && d !== serviceDate) ?? days[1]!);
  const [editHours, setEditHours] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [tests, setTests] = useState<Chosen[]>([]);
  const [error, setError] = useState<string | null>(null);
  const slots = useQuery({ queryKey: ["lab", "bookings", "slots", day], queryFn: () => labSlots(day), retry: false });
  const book = useMutation({
    mutationFn: () => bookLab({ patientId: hit.patient.id, serviceDate: day, slotStart: slot!, serviceIds: tests.map((x) => x.serviceId) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lab", "bookings"] });
      onBooked(t("lab.desk.flow.bookedFor", { day: fmtDay(day, i18n.language), slot: slot! }));
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  return (
    <div className="pp box" style={{ ...PP_FONT, padding: 16, display: "flex", flexDirection: "column", gap: 14 }} data-testid="booking-panel">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        {/* The screen's own title sits over the centre (the patient lane's screen); this row holds its tools. */}
        <div style={{ flex: 1 }} />
        {can("lab.catalogue.manage") && (
          <button type="button" className="sec" aria-expanded={editHours} onClick={() => setEditHours((v) => !v)}>⚙ {t("lab.desk.flow.hours.title")}</button>
        )}
        <button type="button" className="sec" onClick={onClose}>{t("lab.desk.flow.close")}</button>
      </div>
      {hours.data !== undefined && (
        <div style={{ fontSize: 11.5, color: "var(--dim)" }} data-testid="hours-line">
          {t("lab.desk.flow.hours.line", { open: hours.data.open, close: hours.data.close, minutes: hours.data.slotMinutes, per: hours.data.perSlot })}
        </div>
      )}
      {editHours && hours.data !== undefined && (
        <BookingHoursEditor initial={hours.data} onSaved={() => { setEditHours(false); void qc.invalidateQueries({ queryKey: ["lab", "booking-hours"] }); void qc.invalidateQueries({ queryKey: ["lab", "bookings", "slots"] }); }} />
      )}

      <div>
        <div className="tag" style={{ marginBottom: 6 }}>1 · {t("lab.desk.flow.pickDay")}</div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
          {days.map((d) => {
            const sunday = isClosed(d);
            return (
              <button key={d} type="button" disabled={sunday}
                className={d === day ? "pill on" : "pill"} aria-pressed={d === day}
                style={{ height: 36, flexShrink: 0, fontSize: 12, ...(sunday ? { opacity: 0.35, textDecoration: "line-through" } : {}) }}
                onClick={() => { setDay(d); setSlot(null); }}>
                {d === serviceDate ? t("lab.desk.flow.todayShort") : fmtDay(d, i18n.language)}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="tag" style={{ marginBottom: 6 }}>2 · {t("lab.desk.flow.pickSlot")}</div>
        {slots.data?.closed != null && <div style={{ fontSize: 12.5, color: "var(--dim)" }}>{t(`lab.desk.flow.dayClosed.${slots.data.closed}`)}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 6 }} data-testid="slot-grid">
          {(slots.data?.slots ?? []).map((s) => {
            const off = s.past || s.free === 0;
            return (
              <button key={s.start} type="button" disabled={off} aria-pressed={slot === s.start}
                className="box"
                style={{
                  padding: "7px 4px", textAlign: "center", opacity: off ? 0.45 : 1,
                  ...(slot === s.start ? { borderColor: "var(--green)", boxShadow: "0 0 0 3px var(--green-soft)", color: "var(--green)" } : {}),
                }}
                onClick={() => setSlot(s.start)}>
                <div className="mo" style={{ fontWeight: 600, fontSize: 13 }}>{s.start}</div>
                <div style={{ fontSize: 10.5, color: "var(--dim)" }}>{s.free === 0 ? t("lab.desk.flow.full") : t("lab.desk.flow.left", { count: s.free })}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="tag" style={{ marginBottom: 6 }}>3 · {t("lab.desk.flow.pickTests")}</div>
        <TestChooser
          chosen={tests.map((x) => x.serviceId)}
          onAdd={(o) => setTests((p) => (p.some((x) => x.serviceId === o.serviceId) ? p : [...p, { serviceId: o.serviceId, code: o.code, nameEn: o.nameEn, container: o.container }]))}
          onRemove={(id) => setTests((p) => p.filter((x) => x.serviceId !== id))}
        />
        {tests.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {tests.map((x) => (
              <span key={x.serviceId} className="pill on" style={{ height: 26 }}>
                <TubeDot container={x.container} />{x.code}
                <button type="button" aria-label={`${t("lab.desk.remove")} ${x.code}`} onClick={() => setTests((p) => p.filter((y) => y.serviceId !== x.serviceId))}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error !== null && <div role="alert" style={{ color: "var(--red)", fontSize: 12.5 }}>{error}</div>}
      <button type="button" className="pri" style={{ height: 46 }}
        disabled={slot === null || tests.length === 0 || book.isPending}
        onClick={() => { setError(null); book.mutate(); }}>
        {slot === null ? t("lab.desk.flow.bookPickSlot") : t("lab.desk.flow.bookConfirm", { day: fmtDay(day, i18n.language), slot })}
      </button>
    </div>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** THE LAB'S BOOKING HOURS — set by whoever holds `lab.catalogue.manage`; bookings already made stand. */
export function BookingHoursEditor({ initial, onSaved }: { initial: WireBookingHours; onSaved: () => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [f, setF] = useState<WireBookingHours>({ ...initial, closedWeekdays: [...initial.closedWeekdays] });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => saveBookingHours(f),
    onSuccess: () => { setError(null); onSaved(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const dayName = (d: number): string => new Date(Date.UTC(2026, 10, 1 + d)).toLocaleDateString(i18n.language.startsWith("hi") ? "hi-IN" : "en-IN", { weekday: "short", timeZone: "UTC" });
  const num = (k: "slotMinutes" | "perSlot" | "daysAhead") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: Number(e.target.value) }));
  const field = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--dim)" } as const;
  return (
    <div className="box" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, background: "var(--wash)" }} data-testid="hours-editor">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
        <label style={field}>{t("lab.desk.flow.hours.open")}
          <input type="time" value={f.open} onChange={(e) => setF((x) => ({ ...x, open: e.target.value }))} /></label>
        <label style={field}>{t("lab.desk.flow.hours.close")}
          <input type="time" value={f.close} onChange={(e) => setF((x) => ({ ...x, close: e.target.value }))} /></label>
        <label style={field}>{t("lab.desk.flow.hours.slot")}
          <select value={f.slotMinutes} onChange={num("slotMinutes")}>
            {[5, 10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select></label>
        <label style={field}>{t("lab.desk.flow.hours.perSlot")}
          <input type="number" min={1} max={100} value={f.perSlot} onChange={num("perSlot")} /></label>
        <label style={field}>{t("lab.desk.flow.hours.daysAhead")}
          <input type="number" min={1} max={365} value={f.daysAhead} onChange={num("daysAhead")} /></label>
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6 }}>{t("lab.desk.flow.hours.closedOn")}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {WEEKDAYS.map((d) => {
            const shut = f.closedWeekdays.includes(d);
            return (
              <button key={d} type="button" className={shut ? "pill rd" : "pill"} aria-pressed={shut} style={{ height: 30 }}
                onClick={() => setF((x) => ({ ...x, closedWeekdays: shut ? x.closedWeekdays.filter((y) => y !== d) : [...x.closedWeekdays, d] }))}>
                {dayName(d)}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("lab.desk.flow.hours.note")}</div>
      {error !== null && <div role="alert" style={{ color: "var(--red)", fontSize: 12.5 }}>{error}</div>}
      <button type="button" className="pri" style={{ alignSelf: "flex-start" }} disabled={save.isPending} onClick={() => save.mutate()}>
        {t("lab.desk.flow.hours.save")}
      </button>
    </div>
  );
}

/** The list pane's "Booked for today" — each with Arrived, which opens the order with the tests in it. */
export function TodaysBookings({ serviceDate, onArrived }: { serviceDate: string; onArrived: (b: WireLabBooking) => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const day = useQuery({ queryKey: ["lab", "bookings", "day", serviceDate], queryFn: () => bookingsForDay(serviceDate), refetchInterval: 60_000, retry: false });
  const noShow = useMutation({
    mutationFn: (id: string) => noShowLabBooking(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lab", "bookings"] }); },
  });
  const rows = (day.data ?? []).filter((b) => b.status === "booked");
  if (day.isError) return null;
  return (
    <section className="space-y-2" aria-label={t("lab.desk.flow.bookedToday")} data-testid="todays-bookings">
      <h2 className="text-sm font-semibold">{t("lab.desk.flow.bookedToday")} <span className="text-muted-foreground">({rows.length})</span></h2>
      <ul className="divide-y divide-border rounded border border-border text-sm">
        {rows.map((b) => (
          <li key={b.id} className="flex items-center gap-2 px-2 py-1.5">
            <span className="w-11 shrink-0 font-mono text-xs font-semibold">{b.slotStart}</span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{b.patient.display}</span>
              <span className="text-muted-foreground"> · {b.tests.map((x) => x.code).join(", ")}</span>
            </span>
            <button type="button" className="shrink-0 rounded border border-input px-2 py-0.5 text-xs font-semibold" onClick={() => onArrived(b)}>
              {t("lab.desk.flow.arrived")}
            </button>
            <button type="button" className="shrink-0 rounded border border-input px-2 py-0.5 text-xs text-muted-foreground"
              aria-label={`${t("lab.desk.flow.noShow")} ${b.patient.display}`}
              disabled={noShow.isPending} onClick={() => noShow.mutate(b.id)}>
              {t("lab.desk.flow.noShow")}
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{t("lab.desk.flow.noneBookedToday")}</li>}
      </ul>
    </section>
  );
}
