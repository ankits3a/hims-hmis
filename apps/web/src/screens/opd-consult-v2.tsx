import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { VisitTypeBadge } from "../components/visit-type-badge";
import { clearReminder, fetchDoctorStock, fetchReminder, putReminder } from "../lib/opd-api";
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

// ——— a side column's open/closed state, remembered for the browser session ———

export function useSessionToggle(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const read = (): boolean => {
    try {
      const v = window.sessionStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  };
  const [open, setOpen] = useState<boolean>(read);
  const set = (next: boolean): void => {
    setOpen(next);
    try { window.sessionStorage.setItem(key, next ? "1" : "0"); } catch { /* storage refused: the toggle still works for this page */ }
  };
  return [open, set];
}

const RAIL = 52;

/** The left column: the hospital's mark and name at the top, then the line. Full height, like a chat app's sidebar. */
export function ConsultSidebar({ open, onToggle, waiting, sessionStatus, children }: {
  open: boolean; onToggle: (next: boolean) => void; waiting: number; sessionStatus: string | null; children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const dot = sessionStatus === "in" ? "var(--green)" : sessionStatus === "out" ? "var(--gold)" : sessionStatus === "closed" ? "var(--red)" : "var(--faint)";
  if (!open) {
    return (
      <aside data-testid="consult-sidebar" data-state="closed" className="no-print"
        style={{ width: RAIL, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0", background: "var(--card)", borderRight: "1px solid var(--line)" }}>
        <Link to="/" aria-label={t("app.title")} className="brand"><span className="mark" /></Link>
        <button type="button" className="sec" data-testid="sidebar-open" aria-label={t("opdConsultV2.showLine")} onClick={() => { onToggle(true); }}
          style={{ width: 36, height: 36, padding: 0 }}>»</button>
        <span data-testid="sidebar-waiting" className="mo" style={{ fontSize: 15, fontWeight: 700 }}>{waiting}</span>
        <span aria-label={t("opdConsult.sessionStatus")} title={sessionStatus ?? ""} style={{ width: 10, height: 10, borderRadius: 5, background: dot }} />
        <span className="mo" style={{ fontSize: 9, letterSpacing: ".1em", color: "var(--dim)", writingMode: "vertical-rl" }}>{t("opdConsultV2.waitingVertical")}</span>
      </aside>
    );
  }
  return (
    <aside data-testid="consult-sidebar" data-state="open" className="no-print"
      style={{ width: 244, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column", background: "var(--card)", borderRight: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 10px", borderBottom: "1px solid var(--line2)" }}>
        <Link to="/" className="brand" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
          <span className="mark" />{t("app.title")}
        </Link>
        <span style={{ flexGrow: 1 }} />
        <button type="button" className="sec" data-testid="sidebar-close" aria-label={t("opdConsultV2.hideLine")} onClick={() => { onToggle(false); }}
          style={{ width: 30, height: 30, padding: 0 }}>«</button>
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </aside>
  );
}

/** The right column: the copilot. Its F2 ask box is docked at the bottom; minimised it keeps a mark, «, and an amber dot when an alternative waits. */
export function CopilotPanel({ open, onToggle, alert, children, dock }: {
  open: boolean; onToggle: (next: boolean) => void; alert: boolean; children?: React.ReactNode; dock: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  if (!open) {
    return (
      <aside data-testid="copilot-panel" data-state="closed" className="no-print"
        style={{ width: RAIL, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0", background: "var(--agent)", color: "var(--agent-fg)" }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: "var(--mint)" }} />
        <button type="button" data-testid="copilot-open" aria-label={t("opdConsultV2.showCopilot")} onClick={() => { onToggle(true); }}
          style={{ width: 36, height: 36, borderRadius: 6, border: "1px solid #24413655", background: "transparent", color: "var(--agent-fg)" }}>«</button>
        {alert && <span data-testid="copilot-alert" aria-label={t("opdConsultV2.altWaiting")} style={{ width: 10, height: 10, borderRadius: 5, background: "var(--gold)" }} />}
        <span className="mo" style={{ fontSize: 9, letterSpacing: ".12em", color: "var(--agent-dim)", writingMode: "vertical-rl" }}>COPILOT · F2</span>
      </aside>
    );
  }
  return (
    <aside data-testid="copilot-panel" data-state="open" className="no-print"
      style={{ width: 320, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column", background: "var(--agent)", color: "var(--agent-fg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid #24413655" }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--mint)" }} />
        <span className="mo" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".14em" }}>COPILOT</span>
        <span style={{ flexGrow: 1 }} />
        <button type="button" data-testid="copilot-close" aria-label={t("opdConsultV2.hideCopilot")} onClick={() => { onToggle(false); }}
          style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #24413655", background: "transparent", color: "var(--agent-fg)" }}>»</button>
      </div>
      {children === undefined ? null : <div style={{ padding: "12px 14px 0", display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>}
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
  return (rx.lines as unknown as { drug: string; dose?: string; frequency?: string }[])
    .map((l) => [l.drug, l.dose, l.frequency].filter((x) => typeof x === "string" && x !== "").join(" · "));
}

/**
 * THE BRIEF — shown after Call next, before Start consultation (owner, 2026-09-23; D16). Every line is
 * something already RECORDED — the desk's words, the bay's vitals, the last visit, what was prescribed —
 * read through the same gated routes the consult already uses, so the permission and the PHI log are
 * theirs. Nothing on it is a suggestion; the copilot's suggestions stay in the right column.
 */
export function PatientBrief({ encounterId, patientId, patientName, onStart }: {
  encounterId: string; patientId: string; patientName: string; onStart: () => void;
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
        <VisitTypeBadge visitType={vt} testId="brief-visit-type" />
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{patientName}</h2>
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
            <div data-testid="brief-vitals" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
              {tiles.map((x) => (
                <div key={x.k} style={{ padding: "10px 12px", borderRadius: 8, background: "var(--wash)" }}>
                  <div className="mo" style={{ fontSize: 9.5, letterSpacing: ".12em", color: "var(--dim)" }}>{x.k}</div>
                  <div className="mo" style={warn(x.warn)}>{x.v}</div>
                </div>
              ))}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--dim)" }}>{t("opdConsultV2.vitalsBy", { by: v.recordedByName ?? "—", at: fmtTime(v.recordedAt) })}</p>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18, borderTop: "1px solid var(--line2)", paddingTop: 12 }}>
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
          <button type="button" className="pri" data-testid="brief-start" style={{ height: 44, padding: "0 20px", fontSize: 14 }} onClick={onStart}>
            {t("opdConsult.start")}
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
    <section data-testid="work-strip" aria-label={t("opdConsultV2.workSoFar")}
      style={{ padding: "8px 12px", borderRadius: 8, background: "var(--wash)", border: "1px solid var(--line)" }}>
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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
            <form style={{ display: "flex", gap: 6 }} onSubmit={(e) => {
              e.preventDefault();
              const text = (drafts[g] ?? "").trim();
              if (text === "" || has(g, text)) return;
              onChange([...value, { group: g, text }]);
              setDrafts((d) => ({ ...d, [g]: "" }));
            }}>
              <label htmlFor={`exam-own-${g}`} style={{ position: "absolute", left: -9999 }}>{t("opdConsultV2.exam.own", { group: t(`opdConsultV2.exam.${g}`) })}</label>
              <input id={`exam-own-${g}`} className="in" value={drafts[g] ?? ""} placeholder={t("opdConsultV2.exam.ownPlaceholder")}
                onChange={(e) => { setDrafts((d) => ({ ...d, [g]: e.target.value })); }} style={{ flexGrow: 1, height: 32, fontSize: 12.5 }} />
              <button type="submit" className="sec" style={{ padding: "0 12px", fontSize: 12 }}>{t("opdConsultV2.add")}</button>
            </form>
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
  const [draft, setDraft] = useState("");
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
      <form style={{ display: "flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); const x = draft.trim(); if (x === "" || value.includes(x)) return; onChange([...value, x]); setDraft(""); }}>
        <label htmlFor="treatment-own" style={{ position: "absolute", left: -9999 }}>{t("opdConsultV2.treatmentOwn")}</label>
        <input id="treatment-own" className="in" value={draft} onChange={(e) => { setDraft(e.target.value); }} placeholder={t("opdConsultV2.treatmentOwn")} style={{ flexGrow: 1, height: 32, fontSize: 12.5 }} />
        <button type="submit" className="sec" style={{ padding: "0 12px", fontSize: 12 }}>{t("opdConsultV2.add")}</button>
      </form>
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
        position: "absolute", top: -9, right: 8, height: 18, padding: "0 7px", borderRadius: 9, fontSize: 10.5, fontWeight: 600, lineHeight: "18px",
        ...(zero
          ? { background: "rgba(221,143,28,.14)", border: "1px solid rgba(221,143,28,.5)", color: "var(--gold)" }
          : { background: "rgba(14,107,78,.07)", border: "1px solid rgba(14,107,78,.22)", color: "var(--dim)" }),
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
    <div data-testid={`stock-alt-${stock.medicineId}`} style={{ padding: 12, borderRadius: 8, border: "1.5px solid rgba(221,143,28,.6)", background: "rgba(221,143,28,.10)", color: "var(--agent-fg)", display: "flex", flexDirection: "column", gap: 7 }}>
      <span className="mo" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", color: "#f0c26a" }}>{t("opdConsultV2.altHead", { drug })}</span>
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
