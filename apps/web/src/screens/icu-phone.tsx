import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ICU_POLL_MS, ackIcuAlarm, fetchIcuMyBeds, fetchIcuNight, icuRefusal, istHHMM, num, bpOf } from "../lib/icu-api";
import { tileState } from "./icu-station";
import type React from "react";
import type { IcuTile } from "@hmis/contracts";
import "./icu.css";

/**
 * ═══ ICU IC-1 (#984) — THE PHONES (design board "ICU nurse phone · my beds" and "Intensivist · night view") ═══
 *
 * 390 px first. The nurse's phone: every occupied ICU bed, the ones with an open alarm on top, a red card with
 * "Open bed · I'm there" (acknowledges in HMIS — who and when — and opens the bed; it never silences the monitor), and
 * the bed's due work: the hour to sign, missed and due bundles. The intensivist's night view: the counts, the beds
 * with an alarm, and the ICU requests waiting for a yes.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

function PhoneNums({ tile, t }: { tile: IcuTile; t: T }): React.ReactElement {
  const bp = bpOf(tile);
  const alarm = tileState(tile) === "alarm";
  return (
    <div className="icu-nums">
      <div><span style={{ color: "var(--i-hr)" }}>{t("icu.p.hr")}</span><b style={{ color: alarm ? "var(--i-alarm)" : "var(--i-hr)" }}>{num(tile.latest.hr?.value)}</b></div>
      <div><span style={{ color: "var(--i-spo2)" }}>{t("icu.p.spo2")}</span><b style={{ color: "var(--i-spo2)" }}>{num(tile.latest.spo2?.value)}</b></div>
      <div><span style={{ color: "var(--i-bp)" }}>{t("icu.p.map")}</span><b style={{ color: "var(--i-bp)" }}>{bp?.map == null ? "—" : num(bp.map)}</b></div>
      <div><span style={{ color: "var(--i-rr)" }}>{t("icu.p.rr")}</span><b style={{ color: "var(--i-rr)" }}>{num(tile.latest.rr?.value)}</b></div>
    </div>
  );
}

/** `/icu/my-beds`. */
export function IcuMyBeds(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["icu", "my-beds"], queryFn: fetchIcuMyBeds, refetchInterval: ICU_POLL_MS });
  const v = q.data;
  const imThere = async (tile: IcuTile) => {
    const first = tile.openAlarms[0];
    if (first !== undefined) { try { await ackIcuAlarm(first.id); } catch { /* already acknowledged by someone: open the bed anyway */ } }
    void navigate({ to: "/icu/bed/$admissionId", params: { admissionId: tile.admissionId } });
  };
  return (
    <div className="icu" data-testid="icu-my-beds">
      <header className="icu-head"><div><h1>{t("icu.myBedsTitle")}</h1><div className="sub mo">{v === undefined ? "" : t("icu.bedsCount", { n: v.tiles.length })}</div></div></header>
      <div className="icu-phone">
        {q.isError ? <p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p> : null}
        {v?.grey === true ? <div className="icu-card" role="status" style={{ borderColor: "var(--i-gold)" }}>{t("icu.phoneGrey")}</div> : null}
        {v?.tiles.length === 0 ? <p>{t("icu.noPatients")}</p> : null}
        {(v?.tiles ?? []).map((tile) => {
          const alarm = tileState(tile) === "alarm";
          const a = tile.openAlarms[0];
          return (
            <div key={tile.admissionId} className={`icu-pbed${alarm ? " alarm" : ""}`} data-testid="icu-phone-bed">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <b style={{ fontSize: 17, whiteSpace: "nowrap" }}>{tile.bedName}</b>
                {a !== undefined
                  ? <span className="mo" style={{ fontSize: 12, color: "var(--i-red)", fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.message} · {istHHMM(a.raisedAt)}</span>
                  : <span className="mo" style={{ fontSize: 12, color: "var(--i-dim)" }}>{t("icu.stable")}</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--i-dim)" }}>{tile.patientName} · {t("icu.day", { n: tile.dayOfStay })}</div>
              <PhoneNums tile={tile} t={t} />
              {alarm ? (
                <button type="button" className="icu-big" style={{ background: "var(--i-red)", color: "#fff" }} onClick={() => { void imThere(tile); }}>{t("icu.openImThere")}</button>
              ) : (
                <Link to="/icu/bed/$admissionId" params={{ admissionId: tile.admissionId }} className="icu-btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>{t("icu.openBed")}</Link>
              )}
              {tile.hourDue ? <div className="icu-due"><span>{t("icu.signHour")}</span><b className="mo" style={{ color: "var(--i-blue)" }}>{t("icu.now")}</b></div> : null}
              {tile.bundlesMissed > 0 ? <div className="icu-due"><span>{t("icu.bundlesMissed", { n: tile.bundlesMissed })}</span><b className="mo" style={{ color: "var(--i-red)" }}>{t("icu.missed")}</b></div> : null}
              {tile.bundlesDue > 0 ? <div className="icu-due"><span>{t("icu.bundlesDue", { n: tile.bundlesDue })}</span><b className="mo" style={{ color: "var(--i-gold)" }}>{t("icu.due")}</b></div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** `/icu/night`. */
export function IcuNight(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["icu", "night"], queryFn: fetchIcuNight, refetchInterval: ICU_POLL_MS });
  const v = q.data;
  const tiles = (v?.halls ?? []).flatMap((h) => h.tiles);
  const worse = tiles.filter((x) => x.openAlarms.length > 0);
  const vented = tiles.filter((x) => x.devices.some((d) => d.type === "ventilator")).length;
  return (
    <div className="icu" data-testid="icu-night">
      <header className="icu-head"><div><h1>{t("icu.nightTitle")}</h1><div className="sub mo">{v === undefined ? "" : t("icu.nightSub", { halls: v.halls.length, at: istHHMM(v.asOf) })}</div></div></header>
      <div className="icu-phone">
        {q.isError ? <p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p> : null}
        <div className="icu-stats">
          <div><span className="tag">{t("icu.beds")}</span><b>{tiles.length}</b></div>
          <div><span className="tag">{t("icu.ventilated")}</span><b>{vented}</b></div>
          <div style={{ borderColor: (v?.requests.length ?? 0) > 0 ? "var(--i-red)" : undefined }}><span className="tag" style={{ color: "var(--i-red)" }}>{t("icu.requests")}</span><b style={{ color: "var(--i-red)" }}>{v?.requests.length ?? 0}</b></div>
        </div>
        <div className="icu-card">
          <span className="tag">{t("icu.alarmsNow")}</span>
          {worse.length === 0 ? <div className="icu-row"><small>{t("icu.noAlarms")}</small></div> : null}
          {worse.map((x) => (
            <Link key={x.admissionId} to="/icu/bed/$admissionId" params={{ admissionId: x.admissionId }} className="icu-row" style={{ textDecoration: "none", color: "inherit" }}>
              <b style={{ width: 80 }}>{x.bedName}</b>
              <div className="grow">{x.openAlarms[0]!.message}<small>{t(`icu.rung.${x.openAlarms[0]!.rung}`)}</small></div>
            </Link>
          ))}
        </div>
        <div className="icu-card">
          <span className="tag">{t("icu.waitingYes")}</span>
          {(v?.requests ?? []).length === 0 ? <div className="icu-row"><small>{t("icu.noRequests")}</small></div> : null}
          {(v?.requests ?? []).map((r) => (
            <div key={r.id} className="icu-row">
              <b style={{ width: 80 }}>{t(`icu.source.${r.source}`)}</b>
              <div className="grow">{r.patientName} · {t("icu.priority", { n: r.priorityClass })}<small>{r.reason}</small></div>
              <Link to="/icu/requests" className="icu-btn pri" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("icu.open")}</Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
