import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { VisitTypeBadge } from "../components/visit-type-badge";
import { TermInput, ownTerms } from "./opd-consult-suggest";
import { clearReminder, fetchDoctorStock, fetchReminder, putReminder, referInternally } from "../lib/opd-api";
import type {
  WireDoctorStock, WireExamFinding, WireRxHistoryItem, WireTimelineItem, WireVitals,
} from "../lib/opd-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * CONSULT V2 — THE PIECES OF THE DOCTOR'S NEW SCREEN (owner, 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The design is the canvas in `docs/design/2026-09-23-consult-engine/` (the brief, the consultation,
 * the Summary tab) and the rulings in `01-CONSULT-ENGINE.md` §1.1. Three full-height columns: the line
 * on the left, the work in the centre, the copilot on the right; both side columns fold to a 52 px
 * strip. The pieces live here so `opd-consult.tsx` keeps its logic and only changes its layout.
 */

// ——— a side column's open/closed state, remembered for the browser session, per width band ———

export type WidthBand = "wide" | "mid" | "narrow" | "drawer";

/** ≥1440 wide · 1200–1439 mid · 1024–1199 narrow · <1024 drawer — the bands the defaults are ruled for. */
export function widthBand(vw: number): WidthBand {
  if (vw >= 1440) return "wide";
  if (vw >= 1200) return "mid";
  if (vw >= 1024) return "narrow";
  return "drawer";
}

/*
  A choice is remembered PER BAND (production, 2026-09-24): snapping an open window to half the
  screen kept the wide layout's columns open, cutting the brief's vitals at 1024 and covering a phone
  with the copilot drawer. Crossing a band re-reads that band's own remembered choice, else its default.
*/
export function useSessionToggle(key: string, initial: boolean, band?: WidthBand): [boolean, (next: boolean) => void] {
  const storageKey = band === undefined ? key : `${key}.${band}`;
  const read = (): boolean => {
    try {
      const v = window.sessionStorage.getItem(storageKey);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  };
  const [open, setOpen] = useState<boolean>(read);
  // Re-read only when the band (so the key) changes; `read` closes over the new key and default.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(read()); }, [storageKey]);
  const set = (next: boolean): void => {
    setOpen(next);
    try { window.sessionStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* storage refused: the toggle still works for this page */ }
  };
  return [open, set];
}

/** The viewport's width, live — the consult screen's side-column defaults and drawers follow it. */
export function useViewportWidth(): number {
  const read = (): number => (typeof window === "undefined" ? 1440 : window.innerWidth);
  const [w, setW] = useState<number>(read);
  useEffect(() => {
    const on = (): void => { setW(read()); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); };
  }, []);
  return w;
}

/** The hospital's mark: the app's green diamond in a rounded square, as on the boards' sidebar. */
function Mark({ size = 30 }: { size?: number }): React.ReactElement {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: 7, background: "var(--green)", flexShrink: 0 }}>
      <span style={{ width: size * 0.36, height: size * 0.36, borderRadius: 2, background: "#ffffff", transform: "rotate(45deg)" }} />
    </span>
  );
}

/**
 * The left column: the hospital's mark and name at the top, then the line. Full height, like a chat
 * app's sidebar (owner, 2026-09-23). Height and the <1024 drawer behaviour come from `opd-consult.css`
 * (`.cx-side`); the component only says which side it is and whether it is open.
 */
export function ConsultSidebar({ open, onToggle, waiting, sessionStatus, subtitle, children }: {
  open: boolean; onToggle: (next: boolean) => void; waiting: number; sessionStatus: string | null; subtitle?: string; children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const dot = sessionStatus === "in" ? "var(--green)" : sessionStatus === "out" ? "var(--gold)" : sessionStatus === "closed" ? "var(--red)" : "var(--faint)";
  if (!open) {
    return (
      <aside data-testid="consult-sidebar" data-state="closed" data-side="left" className="no-print cx-side cx-strip-rail" style={{ borderRight: "1px solid var(--line)" }}>
        <Link to="/" aria-label={t("app.title")}><Mark size={32} /></Link>
        <button type="button" className="sec" data-testid="sidebar-open" aria-label={t("opdConsultV2.showLine")} onClick={() => { onToggle(true); }}
          style={{ width: 36, height: 36, padding: 0 }}>»</button>
        <span data-testid="sidebar-waiting" className="mo" style={{ fontSize: 15, fontWeight: 700 }}>{waiting}</span>
        <span aria-label={t("opdConsult.sessionStatus")} title={sessionStatus ?? ""} style={{ width: 10, height: 10, borderRadius: 5, background: dot }} />
        <span className="mo" style={{ fontSize: 8.5, letterSpacing: ".1em", color: "var(--dim)", writingMode: "vertical-rl" }}>{t("opdConsultV2.waitingVertical")}</span>
      </aside>
    );
  }
  return (
    <aside data-testid="consult-sidebar" data-state="open" data-side="left" className="no-print cx-side"
      style={{ width: 244, display: "flex", flexDirection: "column", background: "var(--card)", borderRight: "1px solid var(--line)" }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, height: 52, boxSizing: "border-box", padding: "0 10px 0 14px", borderBottom: "1px solid var(--line2)" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexGrow: 1, color: "var(--ink)", textDecoration: "none" }}>
          <Mark />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, lineHeight: "15px" }}>{t("app.title")}</span>
            {subtitle !== undefined && <span style={{ display: "block", fontSize: 10.5, color: "var(--dim)", lineHeight: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle}</span>}
          </span>
        </Link>
        <button type="button" className="sec" data-testid="sidebar-close" aria-label={t("opdConsultV2.hideLine")} onClick={() => { onToggle(false); }}
          style={{ width: 30, height: 30, padding: 0 }}>«</button>
      </div>
      <div className="cx-side-scroll" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </aside>
  );
}

/**
 * The right column: the copilot — WHITE, as on the boards, with the pine card inside and the F2 ask
 * box docked at its foot. Minimised it keeps a mark, «, and an amber dot when an alternative waits.
 */
export function CopilotPanel({ open, onToggle, alert, dock }: {
  open: boolean; onToggle: (next: boolean) => void; alert: boolean; dock: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  if (!open) {
    return (
      <aside data-testid="copilot-panel" data-state="closed" data-side="right" className="no-print cx-side cx-strip-rail" style={{ borderLeft: "1px solid var(--line)" }}>
        <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 7, background: "var(--agent)" }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: "var(--mint)" }} />
        </span>
        <button type="button" className="sec" data-testid="copilot-open" aria-label={t("opdConsultV2.showCopilot")} onClick={() => { onToggle(true); }}
          style={{ width: 36, height: 36, padding: 0 }}>«</button>
        {alert && <span data-testid="copilot-alert" aria-label={t("opdConsultV2.altWaiting")} style={{ width: 10, height: 10, borderRadius: 5, background: "var(--gold)" }} />}
        <span className="mo" style={{ fontSize: 8.5, letterSpacing: ".1em", color: "var(--dim)", writingMode: "vertical-rl" }}>COPILOT · F2</span>
      </aside>
    );
  }
  return (
    <aside data-testid="copilot-panel" data-state="open" data-side="right" className="no-print cx-side cx-cop">
      <div className="cx-cop-head">
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--mint)" }} />
        <span className="mo" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".14em" }}>COPILOT</span>
        <span style={{ flexGrow: 1 }} />
        <button type="button" className="sec" data-testid="copilot-close" aria-label={t("opdConsultV2.hideCopilot")} onClick={() => { onToggle(false); }}
          style={{ width: 30, height: 30, padding: 0 }}>»</button>
      </div>
      {/* the cards (suggestions, the zero-stock alternative) ride inside the dock's scroll, above its answer */}
      {dock}
    </aside>
  );
}

// ——— the brief: what four desks already recorded, before the patient walks in ———

const vtMeaning = (vt: string): string => `opdConsultV2.vt.${vt === "new" || vt === "revisit" || vt === "renewal" ? vt : "new"}`;

type BriefVisit = {
  encounter: { id: string; visitNo: string; patientId: string; visitType: string };
  deskComplaint?: { text: string; by: string; at: string } | null;
  vitals: WireVitals[];
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
}

function linesOf(rx: WireRxHistoryItem | undefined): string[] {
  if (rx === undefined) return [];
  /* The drug's NAME leads every line — "40 mg · 1-0-0" alone told the doctor nothing (owner's walk). */
  return rx.lines
    .map((l) => [l.drug, l.dose, l.frequency].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" · "))
    .filter((line) => line !== "");
}

/**
 * THE BRIEF — shown after Call next, before Start consultation (owner, 2026-09-23; D16). Every line is
 * something already RECORDED — the desk's words, the bay's vitals, the last visit, what was prescribed —
 * read through the same gated routes the consult already uses, so the permission and the PHI log are
 * theirs. Nothing on it is a suggestion; the copilot's suggestions stay in the right column.
 */
export function PatientBrief({ encounterId, patientId, patientName, onStart, startLabel }: {
  encounterId: string; patientId: string; patientName: string; onStart: () => void;
  /** "Resume consultation" for a patient already in consultation (parked, or back after a reload). */
  startLabel?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const visit = useQuery({ queryKey: ["opd", "brief", "visit", encounterId], queryFn: () => api<BriefVisit>("GET", `/opd/visits/${encounterId}`) });
  const allergyRows = useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => api<{ items: { substance: string; status: string }[] }>("GET", `/patients/${patientId}/allergies`),
  });
  const allergies = (allergyRows.data?.items ?? []).filter((a) => a.status === "active").map((a) => a.substance);
  const timeline = useQuery({
    queryKey: ["opd", "timeline", patientId ?? ""], enabled: patientId !== null,
    queryFn: () => api<{ items: WireTimelineItem[] }>("GET", `/opd/patients/${patientId ?? ""}/timeline`),
  });
  const rxHistory = useQuery({
    queryKey: ["opd", "rx-history", patientId ?? ""], enabled: patientId !== null,
    queryFn: () => api<{ items: WireRxHistoryItem[] }>("GET", `/opd/patients/${patientId ?? ""}/prescriptions`),
  });
  const reminder = useQuery({
    queryKey: ["opd", "reminder", patientId ?? ""], enabled: patientId !== null,
    queryFn: () => fetchReminder(patientId!),
  });

  const vt = visit.data?.encounter.visitType ?? "new";
  const desk = visit.data?.deskComplaint ?? null;
  const v = visit.data?.vitals.filter((x) => x.status !== "superseded").at(-1);
  const last = (timeline.data?.items ?? []).find((i) => i.encounterId !== encounterId && i.status === "completed");
  const lastRx = (rxHistory.data?.items ?? []).find((r) => r.encounterId !== encounterId && r.status === "active");
  const warn = (on: boolean): React.CSSProperties => ({ fontSize: 22, fontWeight: 700, color: on ? "var(--gold)" : "var(--ink)" });
  const tiles: { k: string; v: string; warn: boolean }[] = v === undefined ? [] : [
    { k: "BP", v: v.sbp === null || v.dbp === null ? "—" : `${String(v.sbp)}/${String(v.dbp)}`, warn: (v.sbp ?? 0) >= 140 || (v.dbp ?? 0) >= 90 },
    { k: t("opdConsultV2.pulse"), v: v.pulse === null ? "—" : String(v.pulse), warn: (v.pulse ?? 80) > 100 || (v.pulse ?? 80) < 50 },
    { k: t("opdConsultV2.weight"), v: v.weightKg === null ? "—" : `${String(v.weightKg)} kg`, warn: false },
    { k: t("opdConsultV2.temp"), v: v.tempC === null ? "—" : `${String(v.tempC)} °C`, warn: (v.tempC ?? 37) >= 38 },
    { k: "SpO₂", v: v.spo2 === null ? "—" : String(v.spo2), warn: (v.spo2 ?? 99) < 94 },
  ];

  return (
    <section data-testid="patient-brief" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 12 }}>
        <VisitTypeBadge visitType={vt} testId="brief-visit-type" size="xl" />
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{patientName}</h2>
        <span style={{ flexGrow: 1 }} />
        <span data-testid="brief-allergies" style={{ fontSize: 13, fontWeight: 700, color: allergies.length > 0 ? "var(--red)" : "var(--dim)" }}>
          {allergies.length > 0 ? t("opdConsultV2.allergyList", { list: allergies.join(", ") }) : t("opdConsult.noAllergies")}
        </span>
      </div>
      <p data-testid="brief-visit-meaning" style={{ margin: "-6px 0 0", fontSize: 13.5, fontWeight: 600, color: vt === "renewal" ? "var(--gold)" : "var(--green)" }}>
        {t(vtMeaning(vt), { date: last?.serviceDate ?? "—" })}
      </p>
      {reminder.data != null && (
        <p data-testid="brief-reminder" className="pill" style={{ margin: 0, alignSelf: "flex-start", color: "var(--gold)", fontWeight: 600 }}>
          {t("opdConsultV2.reminderLine", { text: reminder.data.text })}
        </p>
      )}
      <div className="box" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div className="tag">{t("opdConsultV2.whyCame")}</div>
          {desk === null ? (
            <p data-testid="brief-desk-none" style={{ margin: "6px 0 0", fontSize: 13, color: "var(--dim)" }}>{t("opdConsultV2.noDeskWords")}</p>
          ) : (
            <>
              <p data-testid="brief-desk-words" style={{ margin: "6px 0 0", fontSize: 19, fontWeight: 500 }}>“{desk.text}”</p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.typedBy", { by: desk.by, at: fmtTime(desk.at) })}</p>
            </>
          )}
        </div>
        {v !== undefined && (
          <div>
            <div data-testid="brief-vitals" className="cx-brief-tiles" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 10 }}>
              {tiles.map((x) => (
                <div key={x.k} style={{ padding: "10px 12px", borderRadius: 8, background: "var(--wash)" }}>
                  <div className="mo" style={{ fontSize: 9.5, letterSpacing: ".12em", color: "var(--dim)" }}>{x.k}</div>
                  <div className="mo" style={warn(x.warn)}>{x.v}</div>
                </div>
              ))}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--dim)" }}>{v.recordedByName === null || v.recordedByName === undefined || v.recordedByName.trim() === ""
              ? t("opdConsultV2.vitalsAt", { at: fmtTime(v.recordedAt) })
              : t("opdConsultV2.vitalsBy", { by: v.recordedByName, at: fmtTime(v.recordedAt) })}</p>
          </div>
        )}
        <div className="cx-brief-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18, borderTop: "1px solid var(--line2)", paddingTop: 12 }}>
          <div>
            <div className="tag">{t("opdConsultV2.lastConsult")}</div>
            <p data-testid="brief-last" style={{ margin: "6px 0 0", fontSize: 13.5 }}>
              {last === undefined ? t("opdConsultV2.firstVisit") : t("opdConsultV2.lastLine", {
                date: last.serviceDate, doctor: last.doctorName ?? "—", dx: last.diagnosis ?? t("opdConsultV2.noDx"), n: last.prescriptionLineCount,
              })}
            </p>
          </div>
          <div>
            <div className="tag">{t("opdConsultV2.onNow")}</div>
            <ul data-testid="brief-meds" style={{ margin: "6px 0 0", padding: 0, listStyle: "none", fontSize: 13.5 }}>
              {linesOf(lastRx).length === 0 ? <li style={{ color: "var(--dim)" }}>{t("opdConsultV2.noMeds")}</li> : linesOf(lastRx).map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, borderTop: "1px solid var(--line2)", paddingTop: 12 }}>
          <p style={{ margin: 0, flexGrow: 1, fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.nothingSuggestion")}</p>
          <button type="button" className="pri" data-testid="brief-start" style={{ height: 46, padding: "0 22px", fontSize: 14, flexShrink: 0 }} onClick={onStart}>
            {startLabel ?? t("opdConsult.start")}<span aria-hidden="true"> →</span>
          </button>
        </div>
      </div>
    </section>
  );
}

// ——— "your work so far": one line per section, on every tab ———

export type WorkRow = { id: string; label: string; text: string; count: number };

export function WorkStrip({ rows, onGo }: { rows: WorkRow[]; onGo: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section data-testid="work-strip" aria-label={t("opdConsultV2.workSoFar")}>
      <div className="mo" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", color: "var(--green)", marginBottom: 4 }}>{t("opdConsultV2.workSoFar")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 20, rowGap: 2 }}>
        {rows.map((r) => (
          <button key={r.id} type="button" data-testid={`work-${r.id}`} onClick={() => { onGo(r.id); }}
            style={{ display: "flex", gap: 8, textAlign: "left", border: 0, background: "transparent", padding: "1px 0", fontSize: 12.5, color: "var(--ink)", minWidth: 0 }}>
            <span className="mo" style={{ width: 96, flexShrink: 0, fontSize: 9.5, letterSpacing: ".1em", color: "var(--dim)", paddingTop: 2, textTransform: "uppercase" }}>{r.label}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: r.text === "" ? "var(--faint)" : "var(--ink)" }}>
              {r.text === "" ? t("opdConsultV2.notYet") : r.text}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function SummaryView({ rows, onGo }: { rows: WorkRow[]; onGo: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid="summary-view" className="box" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 17 }}>{t("opdConsultV2.summaryTitle")}</h3>
      {rows.map((r) => (
        <div key={r.id} style={{ display: "grid", gridTemplateColumns: "170px minmax(0, 1fr) 70px", gap: 12, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
          <div><div style={{ fontWeight: 700 }}>{r.label}</div><div style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsultV2.count", { n: r.count })}</div></div>
          <div data-testid={`summary-${r.id}`} style={{ fontSize: 13.5, color: r.text === "" ? "var(--faint)" : "var(--ink)", whiteSpace: "pre-wrap" }}>{r.text === "" ? t("opdConsultV2.nothingEntered") : r.text}</div>
          <button type="button" className="sec" style={{ height: 28, fontSize: 12 }} onClick={() => { onGo(r.id); }}>{t("opdConsultV2.edit")}</button>
        </div>
      ))}
    </div>
  );
}

// ——— examination: three groups of chips, and the doctor's own words ———

const EXAM_CHIPS: Record<WireExamFinding["group"], string[]> = {
  general: ["Conscious, oriented", "Pallor absent", "No icterus", "No cyanosis", "No clubbing", "No lymphadenopathy", "No pedal oedema", "Dehydrated"],
  systemic: ["CVS: S1 S2 normal, no murmur", "RS: clear, NVBS", "P/A: soft, non-tender", "CNS: no focal deficit"],
  local: ["Throat congested", "Tonsils enlarged", "Tenderness present", "Swelling present"],
};

export function ExamSection({ value, onChange }: { value: WireExamFinding[]; onChange: (next: WireExamFinding[]) => void }): React.ReactElement {
  const { t } = useTranslation();
  const has = (g: WireExamFinding["group"], text: string): boolean => value.some((f) => f.group === g && f.text === text);
  const toggle = (g: WireExamFinding["group"], text: string): void => {
    onChange(has(g, text) ? value.filter((f) => !(f.group === g && f.text === text)) : [...value, { group: g, text }]);
  };
  return (
    <div data-testid="exam-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(["general", "systemic", "local"] as const).map((g) => {
        const own = value.filter((f) => f.group === g && !EXAM_CHIPS[g].includes(f.text));
        return (
          <div key={g} className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="tag">{t(`opdConsultV2.exam.${g}`)}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {[...EXAM_CHIPS[g], ...own.map((o) => o.text)].map((c) => (
                <button key={c} type="button" data-testid={`exam-${g}-${c}`} aria-pressed={has(g, c)} className={has(g, c) ? "pri" : "sec"}
                  style={{ padding: "3px 11px", fontSize: 12.5, borderRadius: 15 }} onClick={() => { toggle(g, c); }}>{c}</button>
              ))}
            </div>
            <TermInput
              id={`exam-own-${g}`} testId={`exam-own-${g}`}
              label={t("opdConsultV2.exam.own", { group: t(`opdConsultV2.exam.${g}`) })}
              placeholder={t("opdConsultV2.exam.ownPlaceholder")}
              local={EXAM_CHIPS[g]} remote={ownTerms(`exam_${g}`)}
              exclude={value.filter((f) => f.group === g).map((f) => f.text)}
              onAdd={(text) => { if (!has(g, text)) onChange([...value, { group: g, text }]); }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ——— treatment given in the room ———

const TREATMENT_CHIPS = ["BP recheck after 10 min rest", "Nebulisation in OPD", "Wound dressing", "IM injection given", "Physiotherapy referral", "Lifestyle counselling"];

export function TreatmentSection({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }): React.ReactElement {
  const { t } = useTranslation();
  const all = [...TREATMENT_CHIPS, ...value.filter((v) => !TREATMENT_CHIPS.includes(v))];
  return (
    <div data-testid="treatment-section" className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="tag">{t("opdConsultV2.treatmentHead")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {all.map((c) => (
          <button key={c} type="button" aria-pressed={value.includes(c)} className={value.includes(c) ? "pri" : "sec"} style={{ padding: "3px 11px", fontSize: 12.5, borderRadius: 15 }}
            onClick={() => { onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]); }}>{c}</button>
        ))}
      </div>
      <TermInput
        id="treatment-own" testId="treatment-own" label={t("opdConsultV2.treatmentOwn")} placeholder={t("opdConsultV2.treatmentOwn")}
        local={TREATMENT_CHIPS} remote={ownTerms("treatment")} exclude={value}
        onAdd={(x) => { if (!value.includes(x)) onChange([...value, x]); }}
      />
    </div>
  );
}

// ——— the three notes ———

export function NotesSection({ patientId, doctorNote, internalComment, onDoctorNote, onInternalComment, onBlur }: {
  patientId: string; doctorNote: string; internalComment: string;
  onDoctorNote: (v: string) => void; onInternalComment: (v: string) => void; onBlur: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const reminder = useQuery({ queryKey: ["opd", "reminder", patientId], queryFn: () => fetchReminder(patientId) });
  const [reminderDraft, setReminderDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = reminderDraft ?? reminder.data?.text ?? "";
  const saveReminder = async (): Promise<void> => {
    if (reminderDraft === null) return;
    setErr(null);
    try {
      if (reminderDraft.trim() === "") { if (reminder.data != null) await clearReminder(patientId); }
      else if (reminderDraft.trim() !== reminder.data?.text) await putReminder(patientId, reminderDraft.trim());
      setReminderDraft(null);
      await reminder.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const box = (id: string, title: string, who: string, value: string, onChange: (v: string) => void, blur: () => void): React.ReactElement => (
    <div className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor={id} style={{ fontWeight: 700 }}>{title}</label>
      <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{who}</span>
      <textarea id={id} data-testid={id} value={value} onChange={(e) => { onChange(e.target.value); }} onBlur={blur} className="in"
        style={{ height: 120, resize: "vertical", padding: "8px 10px", fontSize: 13 }} />
    </div>
  );
  return (
    <div data-testid="notes-section" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      {box("note-doctor", t("opdConsultV2.doctorNote"), t("opdConsultV2.doctorNoteWho"), doctorNote, onDoctorNote, onBlur)}
      {box("note-internal", t("opdConsultV2.internalComment"), t("opdConsultV2.internalCommentWho"), internalComment, onInternalComment, onBlur)}
      <div>
        {box("note-reminder", t("opdConsultV2.reminder"), t("opdConsultV2.reminderWho"), shown, (v) => { setReminderDraft(v); }, () => { void saveReminder(); })}
        {err === null ? null : <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--red)" }}>{err}</p>}
      </div>
    </div>
  );
}

// ——— stock beside the medicine ———

export function useDoctorStock(medicineIds: string[]): Map<string, WireDoctorStock> {
  const ids = [...new Set(medicineIds.filter((m) => m !== ""))].sort();
  const q = useQuery({
    queryKey: ["pharmacy", "doctor-stock", ids.join(",")], enabled: ids.length > 0,
    queryFn: () => fetchDoctorStock(ids), staleTime: 30_000,
  });
  return new Map((q.data ?? []).map((s) => [s.medicineId, s]));
}

const UNIT_SHORT: Record<string, string> = { tablet: "tab", capsule: "cap", bottle: "btl", piece: "pc", vial: "vial", tube: "tube", ml: "mL" };

/** A small, pale tag at a line's top-right corner: "1,240 tab". Amber with ⇄ at zero; nothing at all when stock is unknown. */
export function StockTag({ stock, testId }: { stock: WireDoctorStock | undefined; testId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  if (stock === undefined || stock.available === null) return null;
  const zero = stock.available === 0;
  const unit = stock.unit === null ? "" : ` ${UNIT_SHORT[stock.unit] ?? stock.unit}`;
  return (
    <span data-testid={testId} className="mo" title={zero ? t("opdConsultV2.stockZeroTitle") : t("opdConsultV2.stockTitle")}
      style={{
        position: "absolute", top: -9, right: 10, height: 18, whiteSpace: "nowrap", padding: "0 7px", borderRadius: 9, fontSize: 10.5, fontWeight: 600, lineHeight: "18px",
        ...(zero
          ? { background: "rgba(221,143,28,.14)", border: "1px solid rgba(221,143,28,.5)", color: "#8a5a10" }
          : { background: "rgba(14,107,78,.07)", border: "1px solid rgba(14,107,78,.22)", color: "#3f6b5b" }),
      }}>
      {zero ? t("opdConsultV2.stockZero") : `${stock.available.toLocaleString("en-IN")}${unit}`}
    </span>
  );
}

/** The right column's card for a zero-stock line: the alternatives, "Use X" or "Keep". The doctor may ignore it (D14). */
export function StockAlternativeCard({ drug, stock, onUse, onKeep }: {
  drug: string; stock: WireDoctorStock; onUse: (medicineId: string, label: string) => void; onKeep: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid={`stock-alt-${stock.medicineId}`} style={{ padding: 12, borderRadius: 8, border: "1.5px solid rgba(221,143,28,.6)", background: "rgba(221,143,28,.08)", color: "var(--ink)", display: "flex", flexDirection: "column", gap: 7 }}>
      <span className="mo" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", color: "#8a5a10" }}>{t("opdConsultV2.altHead", { drug })}</span>
      {stock.alternatives.length === 0 ? (
        <span style={{ fontSize: 12 }}>{t("opdConsultV2.altNone")}</span>
      ) : stock.alternatives.map((a) => (
        <div key={a.medicineId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flexGrow: 1, fontSize: 12.5 }}>{a.brandName}{a.strengthLabel === null ? "" : ` ${a.strengthLabel}`} · {a.available.toLocaleString("en-IN")} {UNIT_SHORT[a.unit] ?? a.unit}</span>
          <button type="button" className="pri" data-testid={`stock-use-${a.medicineId}`} style={{ padding: "2px 10px", fontSize: 12 }}
            onClick={() => { onUse(a.medicineId, `${a.brandName}${a.strengthLabel === null ? "" : ` ${a.strengthLabel}`}`); }}>{t("opdConsultV2.use")}</button>
        </div>
      ))}
      <button type="button" className="sec" data-testid={`stock-keep-${stock.medicineId}`} style={{ alignSelf: "flex-start", padding: "2px 10px", fontSize: 12 }} onClick={onKeep}>{t("opdConsultV2.keep")}</button>
    </div>
  );
}

/** "Autosaved 10:41:07" — the clock of the last successful save, in IST. */
export function SavedClock({ at, draft }: { at: Date | null; draft: boolean }): React.ReactElement | null {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => { tick((n) => n + 1); }, 30_000); return () => { clearInterval(id); }; }, []);
  if (at === null) return null;
  const hhmmss = at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return <span data-testid="saved-clock" className="mo" style={{ fontSize: 11, color: "var(--green)" }}>{draft ? t("opdConsultV2.draftSaved", { at: hhmmss }) : t("opdConsultV2.autosaved", { at: hhmmss })}</span>;
}

// ═══ PART TWO (owner, 2026-09-23, rounds 4–5) ═══

// ——— the Vitals tab: today's reading editable, a correction never overwrites, every earlier reading below ———

type VitalKey = "sbp" | "dbp" | "pulse" | "spo2" | "tempC" | "weightKg" | "heightCm" | "rr";
const VITAL_FIELDS: { key: VitalKey; label: string; unit: string }[] = [
  { key: "sbp", label: "BP sys", unit: "mmHg" }, { key: "dbp", label: "BP dia", unit: "mmHg" }, { key: "pulse", label: "Pulse", unit: "/min" },
  { key: "spo2", label: "SpO₂", unit: "%" }, { key: "tempC", label: "Temp", unit: "°C" }, { key: "rr", label: "RR", unit: "/min" },
  { key: "weightKg", label: "Weight", unit: "kg" }, { key: "heightCm", label: "Height", unit: "cm" },
];
type VitalsLike = Partial<Record<VitalKey, number | null>> & { recordedAt: string; recordedByName?: string; status?: string; amendmentReason?: string | null };

/** Gold, never red: red is the danger-flag rule's own colour, and this is a glance, not a rule. */
export function abnormal(v: Partial<Record<VitalKey, number | null>>): Set<VitalKey> {
  const out = new Set<VitalKey>();
  if ((v.sbp ?? 0) >= 140) out.add("sbp");
  if ((v.dbp ?? 0) >= 90) out.add("dbp");
  if (v.pulse != null && (v.pulse > 100 || v.pulse < 50)) out.add("pulse");
  if (v.spo2 != null && v.spo2 < 94) out.add("spo2");
  if (v.tempC != null && v.tempC >= 38) out.add("tempC");
  return out;
}

function readingLine(v: VitalsLike): React.ReactElement {
  const hi = abnormal(v);
  const parts: [VitalKey | "bp", string][] = [
    ["bp", v.sbp == null ? "BP —" : `BP ${String(v.sbp)}/${String(v.dbp ?? "—")}`],
    ["pulse", `P ${String(v.pulse ?? "—")}`], ["spo2", `SpO₂ ${String(v.spo2 ?? "—")}`], ["tempC", `T ${String(v.tempC ?? "—")}`],
    ...(v.weightKg == null ? [] : [["weightKg", `${String(v.weightKg)} kg`] as [VitalKey, string]]),
  ];
  return (
    <span className="mo" style={{ display: "inline-flex", gap: 12, flexWrap: "wrap" }}>
      {parts.map(([k, text]) => (
        <span key={k} style={{ color: (k === "bp" ? hi.has("sbp") || hi.has("dbp") : hi.has(k as VitalKey)) ? "var(--gold)" : undefined, fontWeight: 600 }}>{text}</span>
      ))}
    </span>
  );
}

export function VitalsTab({ encounterId, patientId, today, onChanged }: {
  encounterId: string; patientId: string; today: (VitalsLike & { id: string })[]; onChanged: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const rows = today;
  const current = rows.filter((r) => r.status !== "superseded").at(-1);
  const seed = (): Record<VitalKey, string> => Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, current?.[f.key] == null ? "" : String(current[f.key])])) as Record<VitalKey, string>;
  const [form, setForm] = useState<Record<VitalKey, string>>(seed);
  const [fixing, setFixing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useQuery({
    queryKey: ["opd", "vitals-history", patientId],
    queryFn: () => api<{ items: (VitalsLike & { vitalsId: string; encounterId: string; serviceDate: string })[] }>("GET", `/opd/patients/${patientId}/vitals`),
  });
  const earlier = (history.data?.items ?? []).filter((h) => h.encounterId !== encounterId).slice().reverse();
  const values = (): Record<string, number | null> => Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, form[f.key].trim() === "" ? null : Number(form[f.key])]));
  const submit = async (): Promise<void> => {
    setErr(null); setBusy(true);
    try {
      if (fixing === null) await api("POST", `/opd/visits/${encounterId}/vitals`, values());
      else await api("POST", `/opd/vitals/${fixing}/amend`, { ...values(), reason: reason.trim() });
      setFixing(null); setReason("");
      onChanged();
      await history.refetch();
    } catch (e) {
      const body = (e as { body?: { message?: unknown } }).body;
      setErr(typeof body?.message === "string" ? body.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="vitals-tab" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="tag">{fixing === null ? t("opdConsultV2.vitals.today") : t("opdConsultV2.vitals.correcting")}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          {VITAL_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, color: "var(--dim)" }}>
              {f.label} ({f.unit})
              <input data-testid={`vital-${f.key}`} className="in mo" inputMode="decimal" value={form[f.key]}
                onChange={(e) => { const v = e.target.value; setForm((cur) => ({ ...cur, [f.key]: v })); }}
                style={{ height: 32, fontSize: 13, color: abnormal({ [f.key]: form[f.key] === "" ? null : Number(form[f.key]) }).has(f.key) ? "var(--gold)" : undefined }} />
            </label>
          ))}
        </div>
        {fixing !== null && (
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
            {t("opdConsultV2.vitals.reason")}
            <input data-testid="vital-reason" className="in" value={reason} onChange={(e) => { setReason(e.target.value); }} style={{ height: 32, fontSize: 13 }} />
          </label>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="pri" data-testid="vital-save" disabled={busy || (fixing !== null && reason.trim() === "")} onClick={() => void submit()}
            style={{ padding: "3px 14px", fontSize: 12.5 }}>{fixing === null ? t("opdConsultV2.vitals.saveNew") : t("opdConsultV2.vitals.saveFix")}</button>
          {fixing !== null && <button type="button" className="sec" onClick={() => { setFixing(null); setReason(""); setForm(seed()); }} style={{ padding: "3px 12px", fontSize: 12 }}>{t("opdConsult.cancel")}</button>}
        </div>
        {err === null ? null : <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p>}
        <ul data-testid="vitals-today" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r) => (
            <li key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, textDecoration: r.status === "superseded" ? "line-through" : undefined, color: r.status === "superseded" ? "var(--faint)" : undefined }}>
              {readingLine(r)}
              <span style={{ color: "var(--dim)", fontSize: 11.5 }}>{t("opdConsultV2.vitalsBy", { by: r.recordedByName ?? "—", at: fmtTime(r.recordedAt) })}</span>
              {r.amendmentReason != null && <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsultV2.vitals.because", { reason: r.amendmentReason })}</span>}
              {r.status !== "superseded" && (
                <button type="button" className="sec" data-testid={`vital-fix-${r.id}`} style={{ marginLeft: "auto", padding: "1px 9px", fontSize: 11.5 }}
                  onClick={() => { setFixing(r.id); setForm(Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, r[f.key] == null ? "" : String(r[f.key])])) as Record<VitalKey, string>); }}>
                  {t("opdConsultV2.vitals.correct")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: 0 }} />
      <div className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="tag">{t("opdConsultV2.vitals.earlier")}</span>
        {earlier.length === 0 ? <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.vitals.none")}</span> : (
          <ul data-testid="vitals-earlier" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
            {earlier.map((h) => (
              <li key={h.vitalsId} style={{ display: "flex", gap: 10, fontSize: 12.5, textDecoration: h.status === "superseded" ? "line-through" : undefined, color: h.status === "superseded" ? "var(--faint)" : undefined }}>
                <span className="mo" style={{ width: 132, flexShrink: 0, color: "var(--dim)" }}>{h.serviceDate} {fmtTime(h.recordedAt)}</span>
                {readingLine(h)}
                <span style={{ color: "var(--dim)", fontSize: 11.5 }}>{h.recordedByName ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ——— refer: to another department's doctor, or out with a letter ———

type WireDept = { id: string; name: string; active?: boolean };
type WireDoc = { id: string; displayName: string; departmentId: string; active: boolean };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function ReferPanel({ encounterId, patientName, doctorName, onInternal, onExternal }: {
  encounterId: string; patientName: string; doctorName: string;
  onInternal: (r: { tokenNo: number; where: string; why: string }) => void;
  onExternal: (to: string, note: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"internal" | "external">("internal");
  const [dept, setDept] = useState("");
  const [doc, setDoc] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const depts = useQuery({ queryKey: ["opd", "departments"], queryFn: () => api<{ items: WireDept[] }>("GET", "/opd/departments") });
  const docs = useQuery({
    queryKey: ["opd", "doctors", dept], enabled: dept !== "",
    queryFn: () => api<{ items: WireDoc[] }>("GET", `/opd/doctors?departmentId=${encodeURIComponent(dept)}&active=true`),
  });
  const refer = async (): Promise<void> => {
    setErr(null); setBusy(true);
    try {
      const r = await referInternally(encounterId, { departmentId: dept, doctorId: doc, reason: reason.trim(), note: note.trim() === "" ? null : note.trim() });
      const d = (depts.data?.items ?? []).find((x) => x.id === dept)?.name ?? "";
      const n = (docs.data?.items ?? []).find((x) => x.id === doc)?.displayName ?? "";
      onInternal({ tokenNo: r.tokenNo, where: `${d} · ${n}`, why: `${reason.trim()}${note.trim() === "" ? "" : ` — ${note.trim()}`}` });
    } catch (e) {
      const body = (e as { body?: { message?: unknown } }).body;
      setErr(typeof body?.message === "string" ? body.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const printLetter = (): void => {
    onExternal(to.trim(), note.trim());
    const w = window.open("", "_blank");
    if (w === null) return;
    const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    w.document.write(`<!doctype html><html><head><title>${esc(t("opdConsultV2.refer.letterTitle"))}</title></head><body style="font-family:serif;max-width:640px;margin:40px auto;line-height:1.6">
<p style="text-align:right">${esc(today)}</p><p>To,<br>${esc(to.trim())}</p>
<p><strong>${esc(t("opdConsultV2.refer.letterRe", { patient: patientName }))}</strong></p>
<p>${esc(note.trim())}</p><p style="margin-top:48px">${esc(doctorName)}</p></body></html>`);
    w.document.close();
    w.print();
  };
  const seg: React.CSSProperties = { padding: "3px 12px", fontSize: 12.5 };
  return (
    <div data-testid="refer-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div role="group" style={{ display: "flex", gap: 6 }}>
        <button type="button" data-testid="refer-internal" aria-pressed={kind === "internal"} className={kind === "internal" ? "pri" : "sec"} style={seg} onClick={() => { setKind("internal"); }}>{t("opdConsultV2.refer.internal")}</button>
        <button type="button" data-testid="refer-external" aria-pressed={kind === "external"} className={kind === "external" ? "pri" : "sec"} style={seg} onClick={() => { setKind("external"); }}>{t("opdConsultV2.refer.external")}</button>
      </div>
      {kind === "internal" ? (
        <>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.department")}
            <select data-testid="refer-dept" className="in" value={dept} onChange={(e) => { setDept(e.target.value); setDoc(""); }} style={{ width: "100%", height: 34 }}>
              <option value="">—</option>
              {(depts.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.doctor")}
            <select data-testid="refer-doctor" className="in" value={doc} onChange={(e) => { setDoc(e.target.value); }} style={{ width: "100%", height: 34 }} disabled={dept === ""}>
              <option value="">—</option>
              {(docs.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.reason")}
            <input data-testid="refer-reason" className="in" value={reason} onChange={(e) => { setReason(e.target.value); }} style={{ width: "100%", height: 34 }} />
          </label>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.note")}
            <input data-testid="refer-note" className="in" value={note} onChange={(e) => { setNote(e.target.value); }} style={{ width: "100%", height: 34 }} />
          </label>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsultV2.refer.feeNote")}</p>
          <button type="button" className="pri" data-testid="refer-send" disabled={busy || dept === "" || doc === "" || reason.trim().length < 3} onClick={() => void refer()} style={{ alignSelf: "flex-start", padding: "3px 14px" }}>
            {t("opdConsultV2.refer.send")}
          </button>
        </>
      ) : (
        <>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.to")}
            <input data-testid="refer-to" className="in" value={to} onChange={(e) => { setTo(e.target.value); }} style={{ width: "100%", height: 34 }} />
          </label>
          <label style={{ fontSize: 12 }}>{t("opdConsultV2.refer.letter")}
            <textarea data-testid="refer-letter" className="in" value={note} onChange={(e) => { setNote(e.target.value); }} style={{ width: "100%", height: 110, padding: 8 }} />
          </label>
          <button type="button" className="pri" data-testid="refer-print" disabled={to.trim() === ""} onClick={printLetter} style={{ alignSelf: "flex-start", padding: "3px 14px" }}>
            {t("opdConsultV2.refer.print")}
          </button>
        </>
      )}
      {err === null ? null : <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p>}
    </div>
  );
}

/** A small alarm-bell mark for the recall button: inline stroke SVG, never an emoji. */
export function BellIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** "Open in a new tab": a box with an arrow leaving it. */
export function NewTabIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v7H3V3h7" />
    </svg>
  );
}

// ═══ ROUND 6 (owner, 2026-09-23) — PATIENT HISTORY BOTH WAYS (D18) ═══
//
// Every past visit is read through `GET /opd/visits/:id` — the route that already gates a sealed record
// and writes one `opd.visit` row to the PHI access log per read. So opening a visit in the browser, or
// expanding a section's history, logs exactly the visits the doctor actually looked at, and no new read
// path exists to audit separately. Nothing here can edit.

export type PastVisit = {
  encounter: {
    id: string; visitNo: string; serviceDate: string; visitType: string;
    chiefComplaint: string | null; diagnosis: string | null; advice: string | null; icd10Code: string | null;
    examination?: WireExamFinding[] | null; treatment?: string[] | null; doctorNote?: string | null; internalComment?: string | null;
    diagnosisKind?: string | null; advisedTests?: { name: string }[] | null; referralTo?: string | null; followUpDays?: number | null;
  };
  deskComplaint?: { text: string } | null;
  vitals: (VitalsLike & { id: string })[];
  prescriptions: { status: string; lines: { drug: string; dose?: string; frequency?: string; durationDays?: number | null }[] }[];
  diagnoses: { text: string; icd10Code: string | null }[];
};

export type HistorySection = "vitals" | "complaints" | "exam" | "dx" | "inv" | "rx" | "treat" | "advice" | "notes";
export const HISTORY_SECTIONS: HistorySection[] = ["vitals", "complaints", "exam", "dx", "inv", "rx", "treat", "advice", "notes"];

/** One section of a past visit, as lines of text. An empty array means the visit recorded nothing there. */
export function sectionLines(v: PastVisit, s: HistorySection): string[] {
  const e = v.encounter;
  const split = (x: string | null | undefined): string[] => (x ?? "").split(" · ").map((y) => y.trim()).filter((y) => y !== "");
  switch (s) {
    case "vitals": return v.vitals.filter((x) => x.status !== "superseded").map((x) => `BP ${String(x.sbp ?? "—")}/${String(x.dbp ?? "—")} · P ${String(x.pulse ?? "—")} · SpO₂ ${String(x.spo2 ?? "—")} · T ${String(x.tempC ?? "—")}${x.weightKg == null ? "" : ` · ${String(x.weightKg)} kg`}`);
    case "complaints": return [...split(e.chiefComplaint), ...(v.deskComplaint == null ? [] : [`(desk) ${v.deskComplaint.text}`])];
    case "exam": return (e.examination ?? []).map((f) => `${f.group}: ${f.text}`);
    case "dx": return v.diagnoses.length > 0
      ? v.diagnoses.map((d) => `${d.text}${d.icd10Code === null ? "" : ` (${d.icd10Code})`}${e.diagnosisKind == null ? "" : ` · ${e.diagnosisKind}`}`)
      : split(e.diagnosis);
    case "inv": return (e.advisedTests ?? []).map((x) => x.name);
    case "rx": return v.prescriptions.filter((p) => p.status === "active").flatMap((p) => p.lines.map((l) => [l.drug, l.dose, l.frequency, l.durationDays == null ? "" : `${String(l.durationDays)} d`].filter((x) => x !== undefined && x !== "").join(" · ")));
    case "treat": return e.treatment ?? [];
    case "advice": return [...(e.advice === null || e.advice.trim() === "" ? [] : [e.advice.trim()]), ...(e.referralTo == null ? [] : [`Referred to ${e.referralTo}`])];
    case "notes": return [e.doctorNote, e.internalComment].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  }
}

function usePastVisit(encounterId: string | null): { data: PastVisit | undefined; isLoading: boolean } {
  const q = useQuery({
    queryKey: ["opd", "past-visit", encounterId ?? ""], enabled: encounterId !== null,
    queryFn: () => api<PastVisit>("GET", `/opd/visits/${encounterId ?? ""}`), staleTime: 5 * 60_000,
  });
  return { data: q.data, isLoading: q.isLoading };
}

function PastVisitSections({ encounterId }: { encounterId: string }): React.ReactElement {
  const { t } = useTranslation();
  const v = usePastVisit(encounterId);
  const [sec, setSec] = useState<HistorySection>("complaints");
  if (v.data === undefined) return <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>;
  const lines = sectionLines(v.data, sec);
  return (
    <div data-testid="history-visit" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div role="tablist" aria-label={t("opdConsultV2.history.sections")} style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {HISTORY_SECTIONS.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={sec === s} data-testid={`history-sec-${s}`} className={sec === s ? "pill on" : "pill"}
            style={{ fontSize: 12 }} onClick={() => { setSec(s); }}>
            {t(`opdConsultV2.history.sec.${s}`)}{sectionLines(v.data!, s).length > 0 ? " ·" : ""}
          </button>
        ))}
      </div>
      <ul data-testid="history-lines" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {lines.length === 0 ? <li style={{ listStyle: "none", marginLeft: -18, color: "var(--faint)" }}>{t("opdConsultV2.nothingEntered")}</li> : lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

/** The History browser — a read-only list of the patient's visits, filtered by year chips or a date. */
/** "2026-09-18" → "18 Sep 2026", the way a doctor reads a date (owner's walk, 2026-09-23). */
export function fmtDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function HistoryBrowser({ visits, currentEncounterId }: {
  visits: WireTimelineItem[]; currentEncounterId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const past = visits.filter((v) => v.encounterId !== currentEncounterId);
  const years = [...new Set(past.map((v) => v.serviceDate.slice(0, 4)))].sort().reverse();
  const [year, setYear] = useState<string>("all");
  const [date, setDate] = useState("");
  const shown = past.filter((v) => (year === "all" || v.serviceDate.startsWith(year)) && (date === "" || v.serviceDate === date));
  const [picked, setPicked] = useState<string | null>(shown[0]?.encounterId ?? null);
  return (
    <div data-testid="history-browser" style={{ display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: 16, minHeight: 360 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {["all", ...years].map((y) => (
            <button key={y} type="button" data-testid={`history-year-${y}`} aria-pressed={year === y} className={year === y ? "pill on" : "pill"} style={{ fontSize: 12 }}
              onClick={() => { setYear(y); setDate(""); }}>{y === "all" ? t("opdConsultV2.history.all") : y}</button>
          ))}
        </div>
        <label style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.history.date")}
          <input type="date" data-testid="history-date" className="in" value={date} onChange={(e) => { setDate(e.target.value); }} style={{ width: "100%", height: 32 }} />
        </label>
        <ul data-testid="history-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", maxHeight: 420 }}>
          {shown.length === 0 && <li style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsultV2.history.none")}</li>}
          {shown.map((v) => (
            <li key={v.encounterId}>
              <button type="button" data-testid={`history-visit-${v.encounterId}`} aria-pressed={picked === v.encounterId} onClick={() => { setPicked(v.encounterId); }}
                style={{ width: "100%", textAlign: "left", padding: "7px 9px", borderRadius: 6, border: `1px solid ${picked === v.encounterId ? "var(--green)" : "var(--line)"}`, background: picked === v.encounterId ? "var(--green-soft)" : "var(--card)", fontSize: 12.5 }}>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="mo">{fmtDay(v.serviceDate)}</span>
                  <VisitTypeBadge visitType={v.visitType} size="sm" testId={`history-vt-${v.encounterId}`} />
                  <span className="mo" style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>{v.visitNo ?? ""}</span>
                </span>
                <span style={{ display: "block", color: "var(--dim)" }}>{v.diagnosis ?? t("opdConsultV2.noDx")}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>{picked === null ? <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("opdConsultV2.history.pick")}</p> : (() => {
        const pv = past.find((v) => v.encounterId === picked);
        return (
          <>
            {pv !== undefined && (
              <h3 data-testid="history-record-head" style={{ margin: "0 0 8px", fontSize: 14 }}>
                {fmtDay(pv.serviceDate)}
                {pv.visitNo !== null && pv.visitNo !== undefined && pv.visitNo !== "" && <> · <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{pv.visitNo}</span></>}
                {" · "}{pv.doctorName ?? "—"}
                {pv.departmentName !== null && pv.departmentName !== undefined ? ` · ${pv.departmentName}` : ""}
              </h3>
            )}
            <PastVisitSections key={picked} encounterId={picked} />
          </>
        );
      })()}</div>
    </div>
  );
}

function PastSectionRow({ item, sections, open }: { item: WireTimelineItem; sections: HistorySection[]; open: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const v = usePastVisit(item.encounterId);
  const lines = v.data === undefined ? null : sections.flatMap((s) => sectionLines(v.data!, s).map((l) => (sections.length > 1 ? `${t(`opdConsultV2.history.sec.${s}`)}: ${l}` : l)));
  return (
    <details open={open} data-testid={`section-history-${item.encounterId}`} style={{ borderTop: "1px solid var(--line2)", padding: "6px 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
        <span className="mo">{fmtDay(item.serviceDate)}</span> · <span className="mo" style={{ color: "var(--dim)" }}>{item.visitNo ?? ""}</span>
      </summary>
      {lines === null ? <p style={{ margin: "4px 0", fontSize: 12, color: "var(--dim)" }}>{t("app.loading")}</p>
        : lines.length === 0 ? <p style={{ margin: "4px 0", fontSize: 12, color: "var(--faint)" }}>{t("opdConsultV2.nothingEntered")}</p>
          : <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 12.5 }}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </details>
  );
}

const SECTION_HISTORY_DEPTH = 8;

/** The foot of a consultation tab: a line, "View history", and this section from earlier visits, newest open. */
export function SectionHistory({ visits, currentEncounterId, sections, testId }: {
  visits: WireTimelineItem[]; currentEncounterId: string; sections: HistorySection[]; testId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const past = visits.filter((v) => v.encounterId !== currentEncounterId).slice(0, SECTION_HISTORY_DEPTH);
  return (
    <div data-testid={testId} style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flexGrow: 1, borderTop: "1px solid var(--line)" }} />
        <button type="button" className="sec" data-testid={`${testId}-toggle`} aria-expanded={open} style={{ padding: "2px 12px", fontSize: 12 }} onClick={() => { setOpen(!open); }}>
          {open ? t("opdConsultV2.history.hide") : t("opdConsultV2.history.view")}
        </button>
        <span style={{ flexGrow: 1, borderTop: "1px solid var(--line)" }} />
      </div>
      {open && (past.length === 0
        ? <p style={{ fontSize: 12.5, color: "var(--dim)", textAlign: "center" }}>{t("opdConsultV2.history.none")}</p>
        : <div style={{ marginTop: 6 }}>{past.map((v, i) => <PastSectionRow key={v.encounterId} item={v} sections={sections} open={i === 0} />)}</div>)}
    </div>
  );
}
