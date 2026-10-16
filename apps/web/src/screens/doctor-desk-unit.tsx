import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchUnitBoard, moveOwedRow, nudgeRow } from "../lib/doctor-desk-api";
import type { WirePersonWeek, WireUnitBoard, WireUnitOwedRow } from "../lib/doctor-desk-api";
import { owedClock } from "../../../../packages/contracts/src/doctor-desk";
import { spanText } from "./doctor-desk-tower";
import "./doctor-desk.css";

/**
 * ═══ DD-1.2 — THE UNIT BOARD (`docs/design/2026-09-18-doctor-desk/UnitBoard.dc.html`), left column ═══
 *
 * "What Unit II owes, and who owes it" — oldest first, Nudge and Move — and "Your people · this week".
 * The board's BED column and its inpatient rows are ABSENT until DD-IPD; the right column (the unit
 * report) is DD-report. A HOD or the MS sees the units side by side above, counts only. Every row of
 * the owed list names no patient and no test (the Clocks rule). No money anywhere (decision 0058).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export function DoctorDeskUnit(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const q = useQuery({ queryKey: ["doctor-desk", "unit"], queryFn: fetchUnitBoard, refetchInterval: 60_000 });
  const b = q.data;
  const context = b === undefined || b.unit === null
    ? (b?.scope.departmentName !== undefined && b.scope.departmentName !== null ? t("doctorDesk.unit.contextDept", { dept: b.scope.departmentName }) : t("doctorDesk.contextOwn"))
    : t("doctorDesk.unit.context", { dept: b.unit.departmentName, unit: b.unit.short });
  return (
    <DoctorDeskFrame
      active="unitBoard" testId="doctor-desk-unit" context={context}
      pill={b === undefined ? undefined : { tag: t(`doctorDesk.scope.${b.scope.level}`), text: b.scope.officiating ? t("doctorDesk.scope.officiating") : (b.unit?.short ?? b.scope.departmentName ?? "") }}
      who={b === undefined ? (q.isError ? { name: username ?? "", role: null } : undefined) : { name: b.you.name || (username ?? ""), role: b.you.grade === null ? null : t(`doctorDesk.grade.${b.you.grade}`, { defaultValue: b.you.grade }) }}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {b !== undefined && b.units.length > 0 && <Units b={b} />}
      {b !== undefined && b.unit !== null && <Owes b={b} />}
      {b !== undefined && <People b={b} />}
    </DoctorDeskFrame>
  );
}

function Units({ b }: { b: WireUnitBoard }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="dd-card" data-testid="dd-units">
      <div className="dd-card-head">
        <h2 className="dd-h2">{b.scope.level === "hospital" ? t("doctorDesk.unit.unitsHospital") : t("doctorDesk.unit.unitsDept", { dept: b.scope.departmentName ?? "" })}</h2>
        <span className="dd-note">{t("doctorDesk.unit.unitsNote")}</span>
      </div>
      <div className="dd-grid dd-grid-units dd-grid-head">
        <span>{t("doctorDesk.unit.col.unit")}</span><span>{t("doctorDesk.unit.col.members")}</span><span>{t("doctorDesk.unit.col.open")}</span>
        <span>{t("doctorDesk.unit.col.past")}</span><span>{t("doctorDesk.unit.col.seen")}</span><span>{t("doctorDesk.unit.col.act")}</span>
      </div>
      {b.units.map((u) => (
        <div key={u.teamId} className="dd-grid dd-grid-units" data-testid={`dd-unitsum-${u.teamId}`}>
          <span className="dd-strong">{b.scope.level === "hospital" ? `${u.departmentName} · ${u.short}` : u.short}</span>
          <span className="dd-mono">{u.members}</span>
          <span className="dd-mono dd-strong">{u.open}</span>
          <span className="dd-mono">{u.past}</span>
          <span className="dd-mono">{u.seenToday}</span>
          <span className="dd-mono">{u.criticalToActMedian === null ? "—" : spanText(u.criticalToActMedian, t)}</span>
        </div>
      ))}
    </section>
  );
}

export function ageText(r: Pick<WireUnitOwedRow, "since" | "dueAt">, at: string, t: T): { text: string; over: boolean } {
  const c = owedClock(r.dueAt, at);
  if (c.key === "over") return { text: t("doctorDesk.clock.over", { span: spanText(c.minutes, t) }), over: true };
  const age = Math.max(0, Math.round((Date.parse(at) - Date.parse(r.since)) / 60_000));
  return { text: spanText(age, t), over: false };
}

function Owes({ b }: { b: WireUnitBoard }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const done = (): void => { setRefusal(null); setMoving(null); setTo(""); void qc.invalidateQueries({ queryKey: ["doctor-desk"] }); };
  const push = useMutation({ mutationFn: (key: string) => nudgeRow(key), onSuccess: done, onError: (e) => setRefusal(deskErrorText(e, t)) });
  const move = useMutation({ mutationFn: (v: { key: string; to: string }) => moveOwedRow(v.key, v.to), onSuccess: done, onError: (e) => setRefusal(deskErrorText(e, t)) });
  const unit = b.unit!;
  return (
    <section className="dd-card" data-testid="dd-owes">
      <div className="dd-card-head">
        <h1 className="dd-h1" style={{ fontSize: 20 }}>{t("doctorDesk.unit.owesTitle", { unit: unit.short })}</h1>
        <span className="dd-mono">{t("doctorDesk.unit.owesCount", { count: b.owed.length })}</span>
      </div>
      {refusal !== null && <p role="alert" className="dd-alert" data-testid="dd-owes-error">{refusal}</p>}
      <div className="dd-grid dd-grid-owes dd-grid-head">
        <span>{t("doctorDesk.unit.col.what")}</span><span>{t("doctorDesk.unit.col.with")}</span><span>{t("doctorDesk.unit.col.age")}</span><span />
      </div>
      {b.owed.length === 0 && <div className="dd-empty" data-testid="dd-owes-empty">{t("doctorDesk.clocks.none", { unit: unit.short })}</div>}
      {b.owed.map((o) => {
        const age = ageText(o, b.at, t);
        const mine = o.holder.userId === b.you.userId;
        return (
          <div key={o.key} className="dd-grid-wrap" data-testid={`dd-owe-${o.key}`}>
            <div className="dd-grid dd-grid-owes">
              <span className="dd-owe-what">
                <span className="dd-strong">{t(`doctorDesk.owed.${o.what}`, { defaultValue: t("doctorDesk.owed.other") })}</span>
                <span className="dd-note">
                  {[o.acked === true ? t("doctorDesk.unit.acked") : null, o.movedBy !== undefined && o.movedBy !== null ? t("doctorDesk.unit.movedBy", { name: o.movedBy.name }) : null, t("doctorDesk.unit.since", { at: fmtIst(o.since) })].filter((x) => x !== null).join(" · ")}
                </span>
              </span>
              <span className="dd-strong">{mine ? t("doctorDesk.clocks.you") : o.holder.name}</span>
              <span className={`dd-mono${age.over ? " dd-red" : ""}`}>{age.text}</span>
              <span className="dd-owe-btns">
                {!mine && (
                  <button
                    type="button" className={`dd-clock-btn${o.nudgedByMe ? " dd-clock-btn-done" : ""}`} data-testid={`dd-unudge-${o.key}`}
                    disabled={o.nudgedByMe || push.isPending} onClick={() => push.mutate(o.key)}
                  >{o.nudgedByMe ? t("doctorDesk.clocks.nudged") : t("doctorDesk.clocks.nudge")}</button>
                )}
                {o.mayMove && (
                  <button type="button" className="dd-clock-btn" data-testid={`dd-move-${o.key}`} aria-expanded={moving === o.key} onClick={() => { setMoving(moving === o.key ? null : o.key); setTo(""); }}>
                    {t("doctorDesk.unit.move")}
                  </button>
                )}
              </span>
            </div>
            {moving === o.key && (
              <div className="dd-move" data-testid={`dd-move-form-${o.key}`}>
                <label htmlFor={`move-to-${o.key}`} className="dd-note">{t("doctorDesk.unit.moveTo")}</label>
                <select id={`move-to-${o.key}`} value={to} data-testid={`dd-move-to-${o.key}`} onChange={(e) => setTo(e.target.value)}>
                  <option value="">{t("doctorDesk.unit.choose")}</option>
                  {b.moveTo.filter((m) => m.userId !== o.holder.userId).map((m) => {
                    // DD-1b — a restricted test goes only to someone who may see it (the server refuses otherwise).
                    const no = o.cannotTake?.includes(m.userId) === true;
                    const label = `${m.name} · ${t(`doctorDesk.role.${m.role}`, { defaultValue: m.role })}`;
                    return <option key={m.userId} value={m.userId} disabled={no}>{no ? `${label} · ${t("doctorDesk.unit.cannotTake")}` : label}</option>;
                  })}
                </select>
                <button type="button" className="dd-clock-btn" data-testid={`dd-move-go-${o.key}`} disabled={to === "" || move.isPending} onClick={() => move.mutate({ key: o.key, to })}>{t("doctorDesk.unit.moveGo")}</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="dd-note">{t("doctorDesk.unit.nudgeNote")}</div>
    </section>
  );
}

function nowText(p: WirePersonWeek, t: T): string {
  return p.onDutyUntil === null ? t("doctorDesk.team.off") : t("doctorDesk.team.on", { at: fmtIst(p.onDutyUntil) });
}

function People({ b }: { b: WireUnitBoard }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="dd-card" data-testid="dd-people">
      <div className="dd-card-head">
        <h2 className="dd-h2">{t("doctorDesk.unit.people")}</h2>
        <span className="dd-note">{t("doctorDesk.unit.peopleNote")}</span>
      </div>
      <div className="dd-grid dd-grid-people dd-grid-head">
        <span>{t("doctorDesk.unit.col.doctor")}</span><span>{t("doctorDesk.unit.col.now")}</span><span>{t("doctorDesk.unit.col.open")}</span>
        <span>{t("doctorDesk.unit.col.visits")}</span><span>{t("doctorDesk.unit.col.act")}</span><span>{t("doctorDesk.unit.col.word")}</span>
      </div>
      {b.people.map((p) => (
        <div key={p.userId} className="dd-grid dd-grid-people" data-testid={`dd-person-${p.userId}`}>
          <span className="dd-owe-what">
            <span className="dd-strong">{p.name}</span>
            <span className="dd-note">{p.officiating ? t("doctorDesk.role.officiating", { role: t(`doctorDesk.role.${p.role}`, { defaultValue: p.role }) }) : t(`doctorDesk.role.${p.role}`, { defaultValue: p.role })}</span>
          </span>
          <span>{nowText(p, t)}</span>
          <span className="dd-mono dd-strong">{p.open}</span>
          <span className="dd-mono">{p.visitsDone}</span>
          <span className="dd-mono">{p.criticalToActMedian === null ? "—" : t("doctorDesk.unit.actLine", { span: spanText(p.criticalToActMedian, t), count: p.criticalActs })}</span>
          <span className="dd-note">{p.lastWord === null ? "" : t("doctorDesk.unit.word", { rating: t(`doctorDesk.rate.r.${p.lastWord.rating}`), date: p.lastWord.workDate })}</span>
        </div>
      ))}
    </section>
  );
}
