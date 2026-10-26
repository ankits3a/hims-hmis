import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import type React from "react";
import type { IpdCockpitBed, IpdWardCockpit } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import { useLiveLoad } from "./ipd-nursing-shared";
import { assignNurse, getCockpit, wardErrorOf } from "../lib/ipd-ward-api";
import type { WardError } from "../lib/ipd-ward-api";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import "./ipd-nursing.css";
import "./ipd-ward-desk.css";

/**
 * WM-1 (#982, decision 0089) — THE WARD IN-CHARGE COCKPIT (1440; board "Ward in-charge cockpit"). Left: census, staff
 * on duty and the ratio against the ward's table. Centre: every bed with its nurse's initials, early-warning score,
 * risk chips and the next thing due; an occupied bed nobody holds is red until assigned (one tap gives it to the
 * lowest-load nurse). Below: load per nurse (acuity points). Right: "Needs you". A bed that already has a nurse is
 * reassigned with a reason (both nurses are told). Sealed patients show no bed text (the server's identity rule).
 */

export function WardDeskHeader({ cockpit, active, onPick }: { cockpit: IpdWardCockpit; active: "cockpit" | "assign"; onPick: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const wardId = cockpit.ward?.id;
  return (
    <header className="ipdw-head">
      <b className="ipdw-ward">{cockpit.ward?.name ?? t("ipdWard.title")}</b>
      <nav className="ipdw-nav" aria-label={t("ipdWard.title")}>
        <Link to="/ipd/ward/cockpit" search={wardId === undefined ? {} : { ward: wardId }} className="ipdw-tab" aria-current={active === "cockpit" ? "page" : undefined}>{t("ipdWard.tab.cockpit")}</Link>
        <Link to="/ipd/ward/assign" search={wardId === undefined ? {} : { ward: wardId }} className="ipdw-tab" aria-current={active === "assign" ? "page" : undefined}>{t("ipdWard.tab.assign")}</Link>
      </nav>
      <span className="grow" />
      {cockpit.wards.length > 1 ? <WardPicker wards={cockpit.wards} value={cockpit.ward?.id ?? null} onChange={onPick} /> : null}
      <span className="mono dim">{t(`ipdNursing.shift.${cockpit.shift.key}`)} · {fmtIst(cockpit.shift.startsAt)}–{fmtIst(cockpit.shift.endsAt)}</span>
    </header>
  );
}

export function IpdWardCockpit({ ward }: { ward?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const pick = useWardChoice(ward ?? null);
  const [c, setC] = useState<IpdWardCockpit | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [moving, setMoving] = useState<IpdCockpitBed | null>(null);
  const [err, setErr] = useState<WardError | null>(null);
  const load = useCallback(() => getCockpit(pick.wardId).then(setC, (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) { setForbidden(true); return; }
    throw e;
  }), [pick.wardId]);
  useLiveLoad(load);

  if (forbidden) return <main className="ipdn ipdw" role="alert">{t("ipdWard.forbidden")}</main>;
  if (c !== null && pick.needsPick(c.wards)) {
    return (
      <main className="ipdn ipdw" data-testid="ipd-ward-cockpit">
        <WardPicker wards={c.wards} value={null} onChange={pick.choose} />
        <PickWardPrompt className="ipdw-empty" />
      </main>
    );
  }
  if (c === null) return <main className="ipdn ipdw" aria-busy="true" data-testid="ipd-ward-cockpit">{t("ipdWard.loading")}</main>;

  const give = async (bed: IpdCockpitBed, nurseId: string, reason?: string): Promise<void> => {
    setErr(null);
    try { await assignNurse(bed.bedId, nurseId, reason); setMoving(null); await load(); } catch (e) { const w = wardErrorOf(e); if (w === null) throw e; setErr(w); }
  };
  const initials = (id: string | null): string => c.loads.find((l) => l.userId === id)?.initials ?? "—";
  const r = c.ratio;
  return (
    <main className="ipdn ipdw" data-testid="ipd-ward-cockpit">
      <WardDeskHeader cockpit={c} active="cockpit" onPick={pick.choose} />
      <div className="ipdw-cock">
        <aside className="ipdw-left">
          <span className="ipdw-tag">{t("ipdWard.cockpit.census")}</span>
          <div className="ipdw-kv"><span>{t("ipdWard.cockpit.occupied")}</span><b className="mono">{t("ipdWard.cockpit.ofBeds", { n: c.census.occupied, of: c.census.beds })}</b></div>
          <span className="ipdw-tag">{t("ipdWard.cockpit.staffNow")}</span>
          <div className="ipdw-kv"><span>{t("ipdWard.cockpit.nursesOnDuty")}</span><b className="mono">{r.rnsOnDuty}</b></div>
          <div className="ipdw-kv" data-testid="ipdw-ratio"><span>{t("ipdWard.cockpit.ratio")}</span>
            <b className={`mono${r.breach ? " hot" : ""}`}>{t("ipdWard.cockpit.ratioValue", { have: r.rnsOnDuty, need: r.rnsNeeded, per: r.patientsPerRn })}</b>
          </div>
          <div className="ipdw-kv"><span>{t("ipdWard.cockpit.unit")}</span><b>{t(`ipdWard.unit.${r.unit}`)}{r.night ? ` · ${t("ipdNursing.night")}` : ""}</b></div>
          <div className="ipdw-kv"><span>{t("ipdWard.cockpit.ventilated")}</span><b className="mono">{r.ventilated}</b></div>
          <div className="ipdw-kv"><span>{t("ipdWard.cockpit.map")}</span><b>{c.map === null ? t("ipdWard.assign.noMap") : t(`ipdWard.status.${c.map.status}`)}{c.map?.late === true ? ` · ${t("ipdWard.cockpit.late")}` : ""}</b></div>
          <ul className="ipdw-staff">
            {c.staff.map((s) => (
              <li key={s.userId} className={s.endedAt === null ? "" : "dim"}>
                <b className="mono">{s.initials}</b> {s.name} · {t(`ipdWard.kind.${s.kind}`)}{s.endedAt === null ? "" : ` · ${t("ipdWard.cockpit.ended", { time: fmtIst(s.endedAt) })}`}
              </li>
            ))}
          </ul>
        </aside>

        <section className="ipdw-centre">
          <div className="ipdw-bar"><h1>{t("ipdWard.cockpit.title")}</h1><span className="dim">{t("ipdWard.cockpit.legend")}</span></div>
          {err !== null ? <div className="ipdn-refusal" role="alert">{t(`ipdWard.err.${err.code}`, { defaultValue: t("ipdWard.err.other") })}</div> : null}
          <div className="ipdw-beds">
            {c.beds.map((b) => {
              const body = (
                <>
                <b>{b.code ?? t("ipdWard.bed")}</b>
                {b.admissionId === null ? <span className="dim">{t("ipdWard.cockpit.free")}</span> : (
                  <>
                    <span>
                      {b.unassigned ? <span className="hot">{t("ipdWard.cockpit.noNurse")}</span> : <span className="mono">{b.nurse?.initials ?? "—"}</span>}
                      {b.score === null ? null : <span className={`mono ews ${b.score.band}`}> · {b.score.value}</span>}
                    </span>
                    <span>{b.chips.map((k) => <i key={k} className="ipdw-ic" title={t(`ipdNursing.chip.${k}`)}>{t(`ipdWard.chipLetter.${k}`)}</i>)}{b.acuity?.ventilated === true ? <i className="ipdw-ic">V</i> : null}</span>
                    {b.next === null ? null : <span className={b.next.overdue ? "hot" : "dim"}>{t(`ipdWard.next.${b.next.kind}`)} {fmtIst(b.next.dueAt)}</span>}
                    {b.unassigned && b.suggestedNurseId !== null ? (
                      <button type="button" className="ipdn-btn sm pri" onClick={() => void give(b, b.suggestedNurseId!)} data-testid={`ipdw-give-${b.bedId}`}>{t("ipdWard.cockpit.give", { who: initials(b.suggestedNurseId) })}</button>
                    ) : null}
                  </>
                )}
                </>
              );
              const cls = `ipdw-bed${b.unassigned ? " red" : ""}${b.admissionId === null ? " empty" : ""}`;
              // A bed with a nurse is itself the button that opens "Move" (a reason, both nurses told); no button in a button.
              return b.nurse !== null ? (
                <button key={b.bedId} type="button" className={`${cls} tap`} onClick={() => setMoving(b)} aria-label={t("ipdWard.cockpit.reassignTitle", { bed: b.code ?? t("ipdWard.bed") })} data-testid={`ipdw-bed-${b.bedId}`}>{body}</button>
              ) : (
                <div key={b.bedId} className={cls} data-testid={`ipdw-bed-${b.bedId}`}>{body}</div>
              );
            })}
          </div>
          <div className="ipdw-box ipdw-loads" data-testid="ipdw-loads">
            <b>{t("ipdWard.cockpit.loads")}</b>
            {c.loads.map((l) => <span key={l.userId} className={l.overloaded ? "hot" : ""}>{l.initials} <b className="mono">{t("ipdWard.cockpit.load", { beds: l.beds, points: l.points })}</b></span>)}
          </div>
          {moving !== null ? <Reassign bed={moving} cockpit={c} onCancel={() => setMoving(null)} onGive={(id, why) => void give(moving, id, why)} /> : null}
        </section>

        <aside className="ipdw-right">
          <div className="ipdw-box" data-testid="ipdw-needs">
            <b>{t("ipdWard.cockpit.needsYou")} <span className="mono hot">{c.needsYou.length}</span></b>
            {c.needsYou.length === 0 ? <span className="dim">{t("ipdWard.cockpit.nothing")}</span> : c.needsYou.map((n, i) => {
              const red = n.kind === "unassigned_bed" ? c.beds.find((b) => b.bedId === n.bedId) : undefined;
              return (
                <div key={`${n.kind}:${n.bedId ?? n.userId ?? String(i)}`} className="ipdw-need">
                  <span>{n.text}</span>
                  {red?.suggestedNurseId != null ? <button type="button" className="ipdn-btn sm pri" onClick={() => void give(red, red.suggestedNurseId!)}>{t("ipdWard.cockpit.give", { who: initials(red.suggestedNurseId) })}</button> : null}
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}

function Reassign({ bed, cockpit, onCancel, onGive }: {
  bed: IpdCockpitBed; cockpit: IpdWardCockpit; onCancel: () => void; onGive: (nurseId: string, reason: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [to, setTo] = useState("");
  const [why, setWhy] = useState("");
  const options = cockpit.staff.filter((s) => s.endedAt === null && s.kind !== "student" && s.userId !== bed.nurse?.userId);
  return (
    <form className="ipdw-box ipdw-reassign" onSubmit={(e) => { e.preventDefault(); if (to !== "" && why.trim().length >= 3) onGive(to, why); }} data-testid="ipdw-reassign">
      <b>{t("ipdWard.cockpit.reassignTitle", { bed: bed.code ?? t("ipdWard.bed") })}</b>
      <label>{t("ipdWard.cockpit.to")}
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t("ipdWard.cockpit.choose")}</option>
          {options.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
        </select>
      </label>
      <label>{t("ipdWard.cockpit.reason")}<input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      <div className="ipdw-row">
        <button type="submit" className="ipdn-btn pri" disabled={to === "" || why.trim().length < 3}>{t("ipdWard.cockpit.reassign")}</button>
        <button type="button" className="ipdn-btn" onClick={onCancel}>{t("ipdWard.cockpit.cancel")}</button>
      </div>
    </form>
  );
}
