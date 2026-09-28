import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Status, fetchVisitSections, useSection } from "./opd-eye-sections";

/**
 * ═══ THE CHILD TAB — THE PAEDIATRICS SECTIONS (01-CONSULT-ENGINE.md §6.2) ═══
 *
 * The consult engine's second specialty, drawn in the Ophthal board's language (the approved
 * template: white cards, mono section heads, 30 px chips). The server decides WHICH sections a
 * visit shows, from its department (`GET /opd/visits/:id/sections` → `profile: "paediatrics"`),
 * and COMPUTES everything this tab shows as a number — the z-scores and centiles (WHO 2006 under
 * five), and the IAP 2023 timetable's due and overdue. This file draws them and saves each section
 * when the doctor leaves it; every save is a new versioned row on the server (append-only, D7).
 *
 * NOT HERE, AND WHY:
 *   · Weight-based dosing (§11.1) — the IAP Drug Formulary and BNFc are paid; the licence is an
 *     owner ruling. Nothing on this tab reads as a dose, and a test holds it to that.
 *   · IAP 2015 z-scores from 5 years — the LMS values were never published (see core paeds.ts).
 *   · The vaccination-card print — a later slice.
 */

export type WireIndicator = {
  key: "wfa" | "lhfa" | "hcfa" | "bfa";
  value: number | null; z: number | null; percentile: number | null; implausible: boolean;
  reference: "WHO 2006" | "IAP 2015" | null;
  reason: string | null;
};
export type WireDose = {
  id: string; vaccine: string; label: string;
  status: "given" | "given_today" | "due" | "overdue" | "upcoming" | "optional" | "waiting" | "not_applicable";
  dueOn: string | null; overdueFrom: string | null; givenOn: string | null; givenWhere: "today" | "here" | "earlier" | null;
  note: string | null; uip: string | null;
};
export type WirePaeds = {
  dob: string | null; dobEstimated: boolean; sex: "boy" | "girl" | null;
  age: { years: number; months: number; days: number; totalDays: number } | null;
  adult: boolean;
  weight: { kg: number; recordedAt: string; today: boolean; daysAgo: number } | null;
  lengthSource: "section" | "vitals" | null;
  growth: WireIndicator[];
  immunisation: { source: string; today: string; doses: WireDose[] } | null;
};

// ——— age: a mirror of core paeds.ts `ageYmd`, for the consult header (any department) ———

const IST_MS = 5.5 * 3_600_000;
function istToday(at: Date): Date {
  const ist = new Date(at.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
function addMonths(d: Date, months: number): Date {
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), m, Math.min(d.getUTCDate(), last)));
}
/** Completed years, months and days on the IST calendar — the same rule as the server's. */
export function ageYmd(dobIso: string, at: Date): { years: number; months: number; days: number } {
  const today = istToday(at);
  const birth = new Date(`${dobIso.slice(0, 10)}T00:00:00Z`);
  if (today < birth) return { years: 0, months: 0, days: 0 };
  let months = (today.getUTCFullYear() - birth.getUTCFullYear()) * 12 + today.getUTCMonth() - birth.getUTCMonth();
  if (addMonths(birth, months) > today) months -= 1;
  const days = Math.round((today.getTime() - addMonths(birth, months).getTime()) / 86_400_000);
  return { years: Math.floor(months / 12), months: months % 12, days };
}
/** "1 y 3 m 13 d" for a child (under 18), null for an adult — the header keeps "34 years" for them. */
export function childAgeText(dobIso: string, at: Date): string | null {
  const a = ageYmd(dobIso, at);
  if (a.years >= 18) return null;
  return `${String(a.years)} y ${String(a.months)} m ${String(a.days)} d`;
}

// ——— the look (board `Ophthal`) ———

const head: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, fontWeight: 600, letterSpacing: ".12em", color: "var(--dim)", textTransform: "uppercase" };
const card: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 };
const cell: React.CSSProperties = { height: 32, width: "100%", minWidth: 0, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, boxSizing: "border-box" };
const select: React.CSSProperties = { ...cell, fontFamily: "inherit" };
const label: React.CSSProperties = { fontSize: 12.5, color: "var(--dim)" };
const chip = (on: boolean): React.CSSProperties => ({
  height: 30, display: "inline-flex", alignItems: "center", padding: "0 11px", borderRadius: 15, fontSize: 12.5,
  border: on ? "1px solid var(--green)" : "1px solid var(--line)", background: on ? "var(--green)" : "var(--card)",
  color: on ? "#fff" : "inherit", fontWeight: on ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap",
});
const badge = (tone: "red" | "gold" | "green" | "dim"): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", height: 21, padding: "0 7px", borderRadius: 4, fontSize: 10.5, fontWeight: 600, letterSpacing: ".04em", whiteSpace: "nowrap",
  color: tone === "dim" ? "var(--dim)" : `var(--${tone})`,
  background: tone === "dim" ? "transparent" : `var(--${tone}-soft)`,
  border: `1px solid ${tone === "dim" ? "var(--line)" : `var(--${tone})`}`,
});

const fmtDate = (iso: string | null): string => (iso === null ? "—"
  : new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }));
const fmtZ = (z: number): string => `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z).toFixed(2)}`;
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const RELATIONS = ["mother", "father", "both_parents", "grandparent", "guardian", "self", "other"] as const;
const DELIVERY = ["normal_vaginal", "assisted_vaginal", "lscs_elective", "lscs_emergency"] as const;
const DOMAINS = ["grossMotor", "fineMotor", "language", "social"] as const;
const FEEDING = ["exclusive_breast", "breast_and_formula", "formula", "complementary_with_breast", "complementary_no_breast", "family_diet"] as const;
const SITES = ["left_thigh", "right_thigh", "left_deltoid", "right_deltoid", "left_upper_arm", "right_upper_arm", "oral"] as const;

type Informant = { relation: string | null; name: string; note: string };
type Growth = { lengthCm: number | null; measure: "length" | "height" | null; headCircCm: number | null; note: string };
type GivenToday = { id?: string; dose: string; batch: string; site: string; brand: string; errorReason: string | null };
type Earlier = { dose: string; on: string | null; where: string };
type Immunisation = { givenToday: GivenToday[]; earlier: Earlier[]; note: string };
type Birth = { gestationWeeks: number | null; birthWeightKg: number | null; delivery: string | null; nicu: "yes" | "no" | null; nicuDays: number | null; note: string };
type Milestone = { status: "achieved" | "delayed" | null; note: string };
type Milestones = Record<(typeof DOMAINS)[number], Milestone> & { note: string };
type Feeding = { mode: string | null; complementaryFromMonths: number | null; note: string };

const emptyInformant = (): Informant => ({ relation: null, name: "", note: "" });
const emptyGrowth = (): Growth => ({ lengthCm: null, measure: null, headCircCm: null, note: "" });
const emptyImm = (): Immunisation => ({ givenToday: [], earlier: [], note: "" });
const emptyBirth = (): Birth => ({ gestationWeeks: null, birthWeightKg: null, delivery: null, nicu: null, nicuDays: null, note: "" });
const emptyMilestones = (): Milestones => ({ grossMotor: { status: null, note: "" }, fineMotor: { status: null, note: "" }, language: { status: null, note: "" }, social: { status: null, note: "" }, note: "" });
const emptyFeeding = (): Feeding => ({ mode: null, complementaryFromMonths: null, note: "" });

/** A number input that saves when left — typed as text so "9." is not lost mid-keystroke. */
function NumberField({ testId, value, onCommit, aria, placeholder, disabled }: {
  testId: string; value: number | null; onCommit: (n: number | null) => void; aria: string; placeholder?: string; disabled: boolean;
}): React.ReactElement {
  return (
    <input data-testid={testId} aria-label={aria} inputMode="decimal" placeholder={placeholder} style={cell} disabled={disabled}
      defaultValue={value === null ? "" : String(value)} key={`${testId}-${String(value)}`}
      onBlur={(e) => { const n = numOrNull(e.target.value); if (n !== value) onCommit(n); }} />
  );
}

export function PaedsSections({ encounterId, leaseBody, readOnly }: {
  encounterId: string; leaseBody: () => Record<string, string>; readOnly: boolean;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["opd", "sections", encounterId], queryFn: () => fetchVisitSections(encounterId) });
  /* Growth and the timetable are the server's arithmetic: after a save that feeds them, read them again. */
  const reread = (): void => { void qc.invalidateQueries({ queryKey: ["opd", "sections", encounterId] }); };
  const informant = useSection(encounterId, "paeds.informant", q.data, emptyInformant, leaseBody);
  const growth = useSection(encounterId, "paeds.growth", q.data, emptyGrowth, leaseBody, { onSaved: reread });
  const imm = useSection(encounterId, "paeds.immunisation", q.data, emptyImm, leaseBody, { adopt: true, onSaved: reread });
  const birth = useSection(encounterId, "paeds.birth", q.data, emptyBirth, leaseBody);
  const miles = useSection(encounterId, "paeds.milestones", q.data, emptyMilestones, leaseBody);
  const feeding = useSection(encounterId, "paeds.feeding", q.data, emptyFeeding, leaseBody);
  const [giving, setGiving] = useState<{ dose: string; batch: string; site: string; brand: string } | null>(null);
  const [erroring, setErroring] = useState<{ id: string; reason: string } | null>(null);
  const [earlierDraft, setEarlierDraft] = useState<Earlier | null>(null);

  const p = q.data?.paeds;
  if (q.data === undefined || q.data.profile !== "paediatrics" || p === undefined) return null;
  const shown = new Set(q.data.sections.map((s) => s.key));
  const doses = p.immunisation?.doses ?? [];
  const labelOf = (id: string): string => doses.find((d) => d.id === id)?.label ?? id;

  const title = (text: string, status?: React.ReactNode, extra?: React.ReactNode): React.ReactElement => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ ...head, fontWeight: 700, color: "var(--green)" }}>{text}</span>
      <span style={{ flexGrow: 1 }} />{status}{extra}
    </div>
  );

  // ——— growth ———
  const reasonText = (r: string | null): string => (r === null ? "" : t(`opdPaeds.reason.${r}`));
  const zTone = (z: number): string => (Math.abs(z) >= 3 ? "var(--red)" : Math.abs(z) >= 2 ? "var(--gold)" : "inherit");
  const unitOf = (k: WireIndicator["key"]): string => (k === "wfa" ? "kg" : k === "bfa" ? "kg/m²" : "cm");

  // ——— immunisation ———
  const saveImm = (next: Immunisation): void => { imm.setValue(next); imm.flush(next); };
  const due = doses.filter((d) => d.status === "overdue" || d.status === "due").sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));
  const upcoming = doses.filter((d) => d.status === "upcoming").slice(0, 6);
  const given = doses.filter((d) => d.status === "given");
  const todays = imm.value.givenToday;
  const doseRow = (d: WireDose): React.ReactElement => (
    <div key={d.id} data-testid={`paeds-imm-dose-${d.id}`} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderTop: "1px solid var(--line2, var(--line))" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>{d.label}</strong>
        <span style={badge(d.status === "overdue" ? "red" : "gold")}>{t(`opdPaeds.status.${d.status}`)}</span>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdPaeds.dueOn", { date: fmtDate(d.dueOn) })}</span>
        <span style={{ flexGrow: 1 }} />
        <button type="button" className="sec" data-testid={`paeds-imm-give-${d.id}`} disabled={readOnly || giving !== null}
          style={{ height: 28, padding: "0 10px", fontSize: 12 }}
          onClick={() => { setGiving({ dose: d.id, batch: "", site: "", brand: "" }); }}>{t("opdPaeds.giveToday")}</button>
      </div>
      {d.note !== null && <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{d.note}</span>}
      {d.uip !== null && <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{d.uip}</span>}
      {giving?.dose === d.id && (
        <div data-testid="paeds-imm-give-form" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 8, alignItems: "center", padding: 8, borderRadius: 6, background: "var(--green-soft)" }}>
          <input data-testid="paeds-imm-batch" aria-label={t("opdPaeds.batch")} placeholder={t("opdPaeds.batch")} style={cell} maxLength={40}
            value={giving.batch} onChange={(e) => { setGiving({ ...giving, batch: e.target.value }); }} />
          <select data-testid="paeds-imm-site" aria-label={t("opdPaeds.site")} style={select} value={giving.site}
            onChange={(e) => { setGiving({ ...giving, site: e.target.value }); }}>
            <option value="">{t("opdPaeds.site")}</option>
            {SITES.map((s) => <option key={s} value={s}>{t(`opdPaeds.sites.${s}`)}</option>)}
          </select>
          <input data-testid="paeds-imm-brand" aria-label={t("opdPaeds.brand")} placeholder={t("opdPaeds.brand")} style={{ ...cell, fontFamily: "inherit" }} maxLength={60}
            value={giving.brand} onChange={(e) => { setGiving({ ...giving, brand: e.target.value }); }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" data-testid="paeds-imm-save" disabled={giving.batch.trim() === "" || giving.site === ""} style={{ height: 32, padding: "0 12px", fontSize: 12.5 }}
              onClick={() => {
                saveImm({ ...imm.value, givenToday: [...todays, { dose: giving.dose, batch: giving.batch.trim(), site: giving.site, brand: giving.brand.trim(), errorReason: null }] });
                setGiving(null);
              }}>{t("opdPaeds.recordGiven")}</button>
            <button type="button" className="sec" style={{ height: 32, padding: "0 10px", fontSize: 12.5 }} onClick={() => { setGiving(null); }}>{t("opdPaeds.cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div data-testid="paeds-sections" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* THE CHILD STRIP — age in Y-M-D, and the facts every number below is computed from. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
        <span style={{ ...head, fontWeight: 700, color: "var(--green)" }}>{t("opdPaeds.childTitle")}</span>
        <span data-testid="paeds-age" className="mo" style={{ fontWeight: 700, fontSize: 14 }}>
          {p.age === null ? t("opdPaeds.noDob") : t("opdPaeds.ageYmd", { y: p.age.years, m: p.age.months, d: p.age.days })}
        </span>
        {p.dob !== null && <span style={{ color: "var(--dim)", fontSize: 12 }}>{t("opdPaeds.dob", { date: fmtDate(p.dob) })}</span>}
        {p.sex !== null && <span style={{ color: "var(--dim)", fontSize: 12 }}>{t(`opdPaeds.sex.${p.sex}`)}</span>}
        {p.dobEstimated && <span data-testid="paeds-dob-estimated" style={badge("gold")}>{t("opdPaeds.dobEstimated")}</span>}
        {p.adult && <span style={badge("dim")}>{t("opdPaeds.adult")}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {shown.has("paeds.informant") && (
            <section style={card} aria-label={t("opdPaeds.informantTitle")}>
              {title(t("opdPaeds.informantTitle"), <Status save={informant.save} savedAt={informant.savedAt} testId="paeds-informant-status" />)}
              <div role="group" aria-label={t("opdPaeds.informantTitle")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {RELATIONS.map((r) => {
                  const on = informant.value.relation === r;
                  return (
                    <button key={r} type="button" data-testid={`paeds-informant-${r}`} aria-pressed={on} disabled={readOnly} style={chip(on)}
                      onClick={() => { const next = { ...informant.value, relation: on ? null : r }; informant.setValue(next); informant.flush(next); }}>
                      {t(`opdPaeds.relation.${r}`)}
                    </button>
                  );
                })}
              </div>
              <input data-testid="paeds-informant-name" aria-label={t("opdPaeds.informantName")} placeholder={t("opdPaeds.informantName")} maxLength={80}
                style={{ ...cell, fontFamily: "inherit" }} value={informant.value.name} disabled={readOnly}
                onChange={(e) => { informant.setValue({ ...informant.value, name: e.target.value }); }} onBlur={() => { informant.flush(); }} />
            </section>
          )}

          {shown.has("paeds.growth") && (
            <section style={card} aria-label={t("opdPaeds.growthTitle")}>
              {title(t("opdPaeds.growthTitle"), <Status save={growth.save} savedAt={growth.savedAt} testId="paeds-growth-status" />)}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
                <span style={label}>{t("opdPaeds.weight")}</span>
                <span data-testid="paeds-weight" className="mo" style={{ fontWeight: 600 }}>
                  {p.weight === null ? t("opdPaeds.noWeight") : `${String(p.weight.kg)} kg`}
                </span>
                {p.weight !== null && p.weight.today && <span style={badge("green")}>{t("opdPaeds.weightToday")}</span>}
                {p.weight !== null && !p.weight.today && (
                  <span data-testid="paeds-weight-stale" style={badge("gold")}>{t("opdPaeds.weightStale", { days: p.weight.daysAgo, date: fmtDate(p.weight.recordedAt) })}</span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={label}>{t("opdPaeds.lengthCm")}</span>
                  <NumberField testId="paeds-growth-length" aria={t("opdPaeds.lengthCm")} value={growth.value.lengthCm} disabled={readOnly}
                    placeholder={p.lengthSource === "vitals" ? t("opdPaeds.fromVitals") : "cm"}
                    onCommit={(n) => {
                      const measure = growth.value.measure ?? (n === null ? null : (p.age?.totalDays ?? 0) < 731 ? "length" : "height");
                      const next = { ...growth.value, lengthCm: n, measure: n === null ? growth.value.measure : measure };
                      growth.setValue(next); growth.flush(next);
                    }} />
                </label>
                <div role="group" aria-label={t("opdPaeds.measuredHow")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["length", "height"] as const).map((m) => (
                    <button key={m} type="button" data-testid={`paeds-growth-measure-${m}`} aria-pressed={growth.value.measure === m} disabled={readOnly} style={chip(growth.value.measure === m)}
                      onClick={() => { const next = { ...growth.value, measure: m }; growth.setValue(next); if (next.lengthCm !== null) growth.flush(next); }}>
                      {t(`opdPaeds.measure.${m}`)}
                    </button>
                  ))}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={label}>{t("opdPaeds.headCircCm")}</span>
                  <NumberField testId="paeds-growth-hc" aria={t("opdPaeds.headCircCm")} value={growth.value.headCircCm} disabled={readOnly} placeholder="cm"
                    onCommit={(n) => { const next = { ...growth.value, headCircCm: n }; growth.setValue(next); growth.flush(next); }} />
                </label>
              </div>
              {growth.save.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{t("opdPaeds.growthRule")}</p>}
              <div data-testid="paeds-growth" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, .8fr) minmax(0, .8fr)", fontSize: 13 }}>
                {["indicator", "measurement", "z", "centile"].map((h) => <span key={h} style={{ ...head, padding: "6px 6px", background: "var(--bg, #eef3ef)" }}>{t(`opdPaeds.col.${h}`)}</span>)}
                {p.growth.map((g) => (
                  <div key={g.key} data-testid={`paeds-growth-row-${g.key}`} style={{ display: "contents" }}>
                    <span style={{ padding: "7px 6px", borderTop: "1px solid var(--line)" }}>{t(`opdPaeds.indicator.${g.key}`)}</span>
                    <span className="mo" style={{ padding: "7px 6px", borderTop: "1px solid var(--line)" }}>{g.value === null ? "—" : `${g.value.toFixed(g.key === "wfa" ? 2 : 1)} ${unitOf(g.key)}`}</span>
                    {g.z === null ? (
                      <span style={{ gridColumn: "span 2", padding: "7px 6px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--dim)" }}>{reasonText(g.reason)}</span>
                    ) : (
                      <>
                        <span className="mo" style={{ padding: "7px 6px", borderTop: "1px solid var(--line)", color: zTone(g.z), fontWeight: 700 }}>
                          {fmtZ(g.z)}{g.implausible && <span title={t("opdPaeds.implausible")}> ⚠</span>}
                        </span>
                        <span className="mo" style={{ padding: "7px 6px", borderTop: "1px solid var(--line)" }}>
                          {g.percentile === null ? "—" : g.percentile < 0.1 ? "<0.1" : g.percentile > 99.9 ? ">99.9" : g.percentile.toFixed(1)}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdPaeds.growthSource")}</span>
            </section>
          )}

          {shown.has("paeds.birth") && (
            <section style={card} aria-label={t("opdPaeds.birthTitle")}>
              {title(t("opdPaeds.birthTitle"), <Status save={birth.save} savedAt={birth.savedAt} testId="paeds-birth-status" />)}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={label}>{t("opdPaeds.gestationWeeks")}</span>
                  <NumberField testId="paeds-birth-gestation" aria={t("opdPaeds.gestationWeeks")} value={birth.value.gestationWeeks} disabled={readOnly}
                    onCommit={(n) => { const next = { ...birth.value, gestationWeeks: n === null ? null : Math.round(n) }; birth.setValue(next); birth.flush(next); }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={label}>{t("opdPaeds.birthWeightKg")}</span>
                  <NumberField testId="paeds-birth-weight" aria={t("opdPaeds.birthWeightKg")} value={birth.value.birthWeightKg} disabled={readOnly}
                    onCommit={(n) => { const next = { ...birth.value, birthWeightKg: n }; birth.setValue(next); birth.flush(next); }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={label}>{t("opdPaeds.delivery")}</span>
                  <select data-testid="paeds-birth-delivery" aria-label={t("opdPaeds.delivery")} style={select} value={birth.value.delivery ?? ""} disabled={readOnly}
                    onChange={(e) => { const next = { ...birth.value, delivery: e.target.value === "" ? null : e.target.value }; birth.setValue(next); birth.flush(next); }}>
                    <option value="">—</option>
                    {DELIVERY.map((d) => <option key={d} value={d}>{t(`opdPaeds.deliveryMode.${d}`)}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={label}>{t("opdPaeds.nicu")}</span>
                {(["no", "yes"] as const).map((v) => (
                  <button key={v} type="button" data-testid={`paeds-birth-nicu-${v}`} aria-pressed={birth.value.nicu === v} disabled={readOnly} style={chip(birth.value.nicu === v)}
                    onClick={() => { const next = { ...birth.value, nicu: birth.value.nicu === v ? null : v, nicuDays: v === "no" ? null : birth.value.nicuDays }; birth.setValue(next); birth.flush(next); }}>
                    {t(`opdPaeds.yesNo.${v}`)}
                  </button>
                ))}
                {birth.value.nicu === "yes" && (
                  <span style={{ width: 120 }}>
                    <NumberField testId="paeds-birth-nicu-days" aria={t("opdPaeds.nicuDays")} placeholder={t("opdPaeds.nicuDays")} value={birth.value.nicuDays} disabled={readOnly}
                      onCommit={(n) => { const next = { ...birth.value, nicuDays: n === null ? null : Math.round(n) }; birth.setValue(next); birth.flush(next); }} />
                  </span>
                )}
              </div>
              <input data-testid="paeds-birth-note" aria-label={t("opdPaeds.note")} placeholder={t("opdPaeds.birthNote")} maxLength={300} style={{ ...cell, fontFamily: "inherit" }}
                value={birth.value.note} disabled={readOnly} onChange={(e) => { birth.setValue({ ...birth.value, note: e.target.value }); }} onBlur={() => { birth.flush(); }} />
              {birth.save.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{t("opdPaeds.birthRule")}</p>}
            </section>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {shown.has("paeds.immunisation") && (
            <section style={card} aria-label={t("opdPaeds.immTitle")}>
              {title(t("opdPaeds.immTitle"), <Status save={imm.save} savedAt={imm.savedAt} testId="paeds-imm-status" />)}
              {p.immunisation === null ? (
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdPaeds.immNoDob")}</p>
              ) : (
                <>
                  {imm.save.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{t("opdPaeds.immFailed", { reason: imm.save.error instanceof Error ? imm.save.error.message : "" })}</p>}
                  <div data-testid="paeds-imm-due">
                    <span style={head}>{t("opdPaeds.dueNow", { n: due.length })}</span>
                    {due.length === 0 && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--dim)" }}>{t("opdPaeds.nothingDue")}</p>}
                    {due.map(doseRow)}
                  </div>
                  {todays.length > 0 && (
                    <div data-testid="paeds-imm-today">
                      <span style={head}>{t("opdPaeds.givenTodayTitle")}</span>
                      {todays.map((g) => (
                        <div key={g.id ?? g.dose} data-testid={`paeds-imm-today-${g.dose}`} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
                          <strong style={{ textDecoration: g.errorReason !== null ? "line-through" : "none" }}>{labelOf(g.dose)}</strong>
                          <span className="mo" style={{ color: "var(--dim)" }}>{t("opdPaeds.batchSite", { batch: g.batch, site: t(`opdPaeds.sites.${g.site}`) })}</span>
                          {g.errorReason !== null && <span style={badge("red")}>{t("opdPaeds.inError", { reason: g.errorReason })}</span>}
                          <span style={{ flexGrow: 1 }} />
                          {g.errorReason === null && g.id !== undefined && erroring?.id !== g.id && (
                            <button type="button" className="sec" data-testid={`paeds-imm-error-${g.dose}`} disabled={readOnly} style={{ height: 26, padding: "0 8px", fontSize: 11.5 }}
                              onClick={() => { setErroring({ id: g.id!, reason: "" }); }}>{t("opdPaeds.markError")}</button>
                          )}
                          {erroring !== null && erroring.id === g.id && (
                            <span style={{ display: "flex", gap: 6, flex: "1 1 220px" }}>
                              <input data-testid="paeds-imm-error-reason" aria-label={t("opdPaeds.errorReason")} placeholder={t("opdPaeds.errorReason")} maxLength={200}
                                style={{ ...cell, fontFamily: "inherit" }} value={erroring.reason} onChange={(e) => { setErroring({ ...erroring, reason: e.target.value }); }} />
                              <button type="button" data-testid="paeds-imm-error-save" disabled={erroring.reason.trim().length < 3} style={{ height: 32, padding: "0 10px", fontSize: 12 }}
                                onClick={() => {
                                  saveImm({ ...imm.value, givenToday: todays.map((x) => (x.id === erroring.id ? { ...x, errorReason: erroring.reason.trim() } : x)) });
                                  setErroring(null);
                                }}>{t("opdPaeds.markErrorSave")}</button>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {upcoming.length > 0 && (
                    <div data-testid="paeds-imm-upcoming" style={{ fontSize: 12.5 }}>
                      <span style={head}>{t("opdPaeds.upcoming")}</span>
                      {upcoming.map((d) => (
                        <div key={d.id} style={{ display: "flex", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                          <span style={{ flexGrow: 1 }}>{d.label}</span><span className="mo" style={{ color: "var(--dim)" }}>{fmtDate(d.dueOn)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <details data-testid="paeds-imm-given" style={{ fontSize: 12.5 }}>
                    <summary style={{ cursor: "pointer" }}><span style={head}>{t("opdPaeds.givenEarlier", { n: given.length })}</span></summary>
                    {given.map((d) => (
                      <div key={d.id} style={{ display: "flex", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                        <span style={{ flexGrow: 1 }}>{d.label}</span>
                        <span style={{ color: "var(--dim)" }}>{t(`opdPaeds.where.${d.givenWhere ?? "here"}`)}</span>
                        <span className="mo" style={{ color: "var(--dim)" }}>{fmtDate(d.givenOn)}</span>
                      </div>
                    ))}
                    {earlierDraft === null ? (
                      <button type="button" className="sec" data-testid="paeds-imm-earlier-add" disabled={readOnly} style={{ height: 28, padding: "0 10px", fontSize: 12, marginTop: 6 }}
                        onClick={() => { setEarlierDraft({ dose: "", on: null, where: "" }); }}>{t("opdPaeds.addFromCard")}</button>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 120px), 1fr))", gap: 6, marginTop: 6 }}>
                        <select data-testid="paeds-imm-earlier-dose" aria-label={t("opdPaeds.dose")} style={select} value={earlierDraft.dose}
                          onChange={(e) => { setEarlierDraft({ ...earlierDraft, dose: e.target.value }); }}>
                          <option value="">{t("opdPaeds.dose")}</option>
                          {doses.filter((d) => d.status !== "given" && d.status !== "given_today" && d.status !== "not_applicable").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                        </select>
                        <input type="date" data-testid="paeds-imm-earlier-on" aria-label={t("opdPaeds.givenOn")} style={cell} value={earlierDraft.on ?? ""}
                          onChange={(e) => { setEarlierDraft({ ...earlierDraft, on: e.target.value === "" ? null : e.target.value }); }} />
                        <input data-testid="paeds-imm-earlier-where" aria-label={t("opdPaeds.givenWhere")} placeholder={t("opdPaeds.givenWhere")} maxLength={80} style={{ ...cell, fontFamily: "inherit" }}
                          value={earlierDraft.where} onChange={(e) => { setEarlierDraft({ ...earlierDraft, where: e.target.value }); }} />
                        <button type="button" data-testid="paeds-imm-earlier-save" disabled={earlierDraft.dose === ""} style={{ height: 32, fontSize: 12 }}
                          onClick={() => { saveImm({ ...imm.value, earlier: [...imm.value.earlier, earlierDraft] }); setEarlierDraft(null); }}>{t("opdPaeds.add")}</button>
                      </div>
                    )}
                  </details>
                  <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdPaeds.immSource", { source: p.immunisation.source })}</span>
                </>
              )}
            </section>
          )}

          {shown.has("paeds.milestones") && (
            <section style={card} aria-label={t("opdPaeds.milestonesTitle")}>
              {title(t("opdPaeds.milestonesTitle"), <Status save={miles.save} savedAt={miles.savedAt} testId="paeds-milestones-status" />)}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {DOMAINS.map((d) => (
                  <div key={d} style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{t(`opdPaeds.domain.${d}`)}</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
                      {(["achieved", "delayed"] as const).map((st) => {
                        const on = miles.value[d].status === st;
                        return (
                          <button key={st} type="button" data-testid={`paeds-milestone-${d}-${st}`} aria-pressed={on} disabled={readOnly} style={chip(on)}
                            onClick={() => { const next = { ...miles.value, [d]: { ...miles.value[d], status: on ? null : st } }; miles.setValue(next); miles.flush(next); }}>
                            {t(`opdPaeds.milestone.${st}`)}
                          </button>
                        );
                      })}
                      <input data-testid={`paeds-milestone-${d}-note`} aria-label={`${t(`opdPaeds.domain.${d}`)} · ${t("opdPaeds.note")}`} placeholder={t("opdPaeds.note")} maxLength={160}
                        style={{ ...cell, flex: "1 1 120px", width: "auto", fontFamily: "inherit" }} value={miles.value[d].note} disabled={readOnly}
                        onChange={(e) => { miles.setValue({ ...miles.value, [d]: { ...miles.value[d], note: e.target.value } }); }} onBlur={() => { miles.flush(); }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {shown.has("paeds.feeding") && (
            <section style={card} aria-label={t("opdPaeds.feedingTitle")}>
              {title(t("opdPaeds.feedingTitle"), <Status save={feeding.save} savedAt={feeding.savedAt} testId="paeds-feeding-status" />)}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 8 }}>
                <select data-testid="paeds-feeding-mode" aria-label={t("opdPaeds.feedingMode")} style={select} value={feeding.value.mode ?? ""} disabled={readOnly}
                  onChange={(e) => { const next = { ...feeding.value, mode: e.target.value === "" ? null : e.target.value }; feeding.setValue(next); feeding.flush(next); }}>
                  <option value="">{t("opdPaeds.feedingMode")}</option>
                  {FEEDING.map((f) => <option key={f} value={f}>{t(`opdPaeds.feeding.${f}`)}</option>)}
                </select>
                <NumberField testId="paeds-feeding-from" aria={t("opdPaeds.complementaryFrom")} placeholder={t("opdPaeds.complementaryFrom")} value={feeding.value.complementaryFromMonths} disabled={readOnly}
                  onCommit={(n) => { const next = { ...feeding.value, complementaryFromMonths: n === null ? null : Math.round(n) }; feeding.setValue(next); feeding.flush(next); }} />
              </div>
              <input data-testid="paeds-feeding-note" aria-label={t("opdPaeds.note")} placeholder={t("opdPaeds.feedingNote")} maxLength={300} style={{ ...cell, fontFamily: "inherit" }}
                value={feeding.value.note} disabled={readOnly} onChange={(e) => { feeding.setValue({ ...feeding.value, note: e.target.value }); }} onBlur={() => { feeding.flush(); }} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
