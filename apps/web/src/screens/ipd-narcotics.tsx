import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdNarcoticDrug, IpdNarcoticException, IpdNarcoticWard, IpdRefusalBody } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { getNarcoticWard, recordNarcoticCount, resolveNarcoticException } from "../lib/ipd-emar-api";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import { LiveLine, useLiveLoad } from "./ipd-nursing-shared";
import "./ipd-emar.css";
import "./ipd-narcotics.css";

/**
 * 2026-10-14 — THE WARD NARCOTIC REGISTER (NDPS / NABH) for the ward nurse and the nursing supervisor. One ward at a time:
 * each controlled drug's running balance since the last agreed count (opening, received, given, wasted, returned, moved
 * with a patient, expected); the SHIFT COUNT — two nurses count the cabinet together, the second nurse types their own
 * username and PIN; a count that differs from the register is an exception the supervisor (or the pharmacist) closes with
 * a note; the newest register lines. Every quantity is in the drug's register unit. No money (0058).
 */
const qty = (n: number): string => String(Math.round(n * 1000) / 1000);

export function IpdNarcotics(): React.ReactElement {
  const { t } = useTranslation();
  const [view, setView] = useState<IpdNarcoticWard | null>(null);
  const pick = useWardChoice();
  const wardId = pick.wardId;
  const [error, setError] = useState<"forbidden" | null>(null);
  const load = useCallback(() => getNarcoticWard(wardId).then((v) => { setView(v); setError(null); }, (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) setError("forbidden");
    throw e;
  }), [wardId]);
  const live = useLiveLoad(load);
  const reload = (): void => { void load().catch(() => {}); };
  // Nothing remembered and more than one ward: ask, never count the server's first ward's cabinet.
  const asking = view !== null && pick.needsPick(view.wards);
  return (
    <main className="ipde ipdk" data-testid="ipd-narcotics">
      <header className="ipde-head">
        <h1>{t("ipdNarcotic.title")}{view?.ward && !asking ? ` · ${view.ward.name}` : ""}</h1>
        {view !== null ? <span className="ipde-tag">{t(`ipdNarcotic.shift.${view.shift}`)}</span> : null}
        {view?.countDue === true && !asking ? <span className="ipde-tag red" data-testid="ipdk-count-due">⚠ {t("ipdNarcotic.countDue")}</span> : null}
        <LiveLine online={live.online} lastUpdate={live.lastUpdate} />
        {view !== null && view.wards.length > 1 ? (
          <WardPicker wards={view.wards} value={asking ? null : view.ward?.id ?? null} onChange={pick.choose} />
        ) : null}
        <button type="button" className="ipde-btn noprint" onClick={() => window.print()}>{t("ipdNarcotic.print")}</button>
      </header>
      {error === "forbidden" ? <div className="ipde-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {asking ? <PickWardPrompt className="ipde-empty" /> : null}
      {view !== null && !asking && view.ward === null ? <div className="ipde-empty">{t("ipdNarcotic.noWard")}</div> : null}
      {view !== null && !asking && view.ward !== null ? (
        <>
          <section className="ipdk-sec" aria-labelledby="ipdk-bal">
            <h2 id="ipdk-bal">{t("ipdNarcotic.balance")}</h2>
            {view.drugs.length === 0 ? <div className="ipde-empty">{t("ipdNarcotic.empty")}</div> : <Balances drugs={view.drugs} />}
          </section>
          {view.drugs.length > 0 ? <CountForm key={view.ward.id} wardId={view.ward.id} drugs={view.drugs} online={live.online} onDone={reload} /> : null}
          <Exceptions items={view.exceptions} canResolve={view.canResolve} online={live.online} onDone={reload} />
          <section className="ipdk-sec" aria-labelledby="ipdk-lines">
            <h2 id="ipdk-lines">{t("ipdNarcotic.lines")}</h2>
            {view.lines.length === 0 ? <div className="ipde-empty">{t("ipdNarcotic.noLines")}</div> : (
              <ul className="ipdk-lines" data-testid="ipdk-lines">
                {view.lines.map((l) => (
                  <li key={l.entryId}>
                    <span className="mono">{fmtIst(l.at)}</span>
                    <b className={`ipdk-kind k-${l.kind}`}>{t(`ipdNarcotic.kind.${l.kind}`)}</b>
                    <span>{l.medicineName} · {qty(l.qty)} {l.unit}</span>
                    <span className="dim">{l.bedCode !== null ? `${l.bedCode} · ` : ""}{l.patient}</span>
                    <span className="dim">{t("ipdNarcotic.by", { name: l.byName })}{l.witnessName !== null ? ` · ${t("ipdNarcotic.witness", { name: l.witnessName })}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

function Balances({ drugs }: { drugs: IpdNarcoticDrug[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ipde-grid-wrap">
      <table className="ipdk-table" data-testid="ipdk-balance">
        <thead>
          <tr>
            <th className="l">{t("ipdNarcotic.col.drug")}</th>
            <th>{t("ipdNarcotic.col.expected")}</th>
            <th>{t("ipdNarcotic.col.opening")}</th>
            <th>{t("ipdNarcotic.col.received")}</th>
            <th>{t("ipdNarcotic.col.given")}</th>
            <th>{t("ipdNarcotic.col.wasted")}</th>
            <th>{t("ipdNarcotic.col.returned")}</th>
            <th>{t("ipdNarcotic.col.moved")}</th>
            <th className="l">{t("ipdNarcotic.col.lastCount")}</th>
          </tr>
        </thead>
        <tbody>
          {drugs.map((d) => (
            <tr key={`${d.medicineId}-${d.unit}`} data-testid={`ipdk-drug-${d.medicineId}`}>
              <th scope="row" className="l"><b>{d.name}</b> <span className="dim">({d.unit})</span></th>
              <td className="ipdk-exp" data-testid={`ipdk-expected-${d.medicineId}`}><b>{qty(d.expected)}</b></td>
              <td>{qty(d.opening)}</td>
              <td>{qty(d.received)}</td>
              <td>{qty(d.given)}</td>
              <td>{qty(d.wasted)}</td>
              <td>{qty(d.returned)}</td>
              <td>{d.transferredIn === 0 && d.transferredOut === 0 ? "—" : `+${qty(d.transferredIn)} / −${qty(d.transferredOut)}`}</td>
              <td className="l dim">
                {d.lastCount === null ? t("ipdNarcotic.neverCounted") : (
                  <>{fmtIst(d.lastCount.at)} · {qty(d.lastCount.counted)}{d.lastCount.variance !== 0 ? <b className="ipdk-bad"> ✕ {qty(d.lastCount.variance)}</b> : " ✓"}</>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The shift count: one counted box per drug, then the second nurse's own username and PIN. */
function CountForm({ wardId, drugs, online, onDone }: { wardId: string; drugs: IpdNarcoticDrug[]; online: boolean; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const k = (d: IpdNarcoticDrug): string => `${d.medicineId}|${d.unit}`;
  const values = drugs.map((d) => ({ d, raw: (counted[k(d)] ?? "").trim() }));
  const valid = values.every(({ raw }) => raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0);
  return (
    <form className="ipdk-sec ipdk-count noprint" data-testid="ipdk-count" onSubmit={(e) => {
      e.preventDefault(); setRefusal(null); setSaid(null); setBusy(true);
      recordNarcoticCount(wardId, values.map(({ d, raw }) => ({ medicineId: d.medicineId, unit: d.unit, counted: Number(raw) })), { username: username.trim(), pin })
        .then((r) => {
          setBusy(false); setPin(""); setCounted({});
          setSaid(r.mismatches === 0 ? t("ipdNarcotic.countOk") : t("ipdNarcotic.countBad", { count: r.mismatches }));
          onDone();
        }, (er: unknown) => { setBusy(false); setPin(""); setRefusal(refusalOf(er)); });
    }}>
      <h2>{t("ipdNarcotic.count.title")}</h2>
      <p className="dim">{t("ipdNarcotic.count.hint")}</p>
      <div className="ipdk-count-grid">
        {drugs.map((d) => (
          <label key={k(d)} className="ipdk-field">
            <span>{d.name} <span className="dim">({d.unit})</span></span>
            <input inputMode="decimal" value={counted[k(d)] ?? ""} onChange={(e) => setCounted({ ...counted, [k(d)]: e.target.value })} data-testid={`ipdk-counted-${d.medicineId}`} aria-label={t("ipdNarcotic.count.counted", { name: d.name })} />
          </label>
        ))}
      </div>
      <fieldset className="ipdk-second">
        <legend>{t("ipdEmar.second.title")}</legend>
        <label>{t("ipdEmar.second.username")}<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="ipdk-second-user" /></label>
        <label>{t("ipdEmar.second.pin")}<input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="off" data-testid="ipdk-second-pin" /></label>
      </fieldset>
      {refusal !== null ? <div className="ipdk-refusal" role="alert" data-testid="ipdk-refusal">{refusal.rule} <b>{refusal.fix}</b></div> : null}
      {said !== null ? <p className="ipdk-said" role="status" data-testid="ipdk-said">{said}</p> : null}
      <button type="submit" className="ipde-btn pri" disabled={!online || busy || !valid || username.trim() === "" || pin.length < 4} data-testid="ipdk-count-save">
        {t("ipdNarcotic.count.save")}
      </button>
    </form>
  );
}

function Exceptions({ items, canResolve, online, onDone }: { items: IpdNarcoticException[]; canResolve: boolean; online: boolean; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="ipdk-sec" aria-labelledby="ipdk-exc">
      <h2 id="ipdk-exc">{t("ipdNarcotic.exceptions")}</h2>
      {items.length === 0 ? <div className="ipde-empty">{t("ipdNarcotic.noExceptions")}</div> : (
        <ul className="ipdk-exc" data-testid="ipdk-exceptions">
          {items.map((x) => <ExceptionRow key={x.countId} x={x} canResolve={canResolve} online={online} onDone={onDone} />)}
        </ul>
      )}
    </section>
  );
}

function ExceptionRow({ x, canResolve, online, onDone }: { x: IpdNarcoticException; canResolve: boolean; online: boolean; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  return (
    <li className={x.resolution === null ? "open" : "closed"} data-testid={`ipdk-exc-${x.countId}`}>
      <div>
        <b>{x.resolution === null ? `✕ ${t("ipdNarcotic.open")}` : `✓ ${t("ipdNarcotic.resolved")}`}</b> · {x.medicineName} ·{" "}
        {t("ipdNarcotic.expectedCounted", { expected: qty(x.expected), counted: qty(x.counted), unit: x.unit })}
      </div>
      <div className="dim">{fmtIst(x.at)} · {t("ipdNarcotic.by", { name: x.byName })} · {t("ipdNarcotic.witness", { name: x.witnessName })}</div>
      {x.resolution !== null ? <div className="dim">{t("ipdNarcotic.resolvedBy", { name: x.resolution.byName })}: {x.resolution.note}</div> : null}
      {x.resolution === null && canResolve ? (
        <div className="ipdk-resolve noprint">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ipdNarcotic.findings")} aria-label={t("ipdNarcotic.findings")} data-testid={`ipdk-note-${x.countId}`} />
          <button type="button" className="ipde-btn" disabled={!online || note.trim() === ""} data-testid={`ipdk-resolve-${x.countId}`} onClick={() => {
            setRefusal(null);
            resolveNarcoticException(x.countId, note.trim()).then(() => { setNote(""); onDone(); }, (e: unknown) => setRefusal(refusalOf(e)));
          }}>{t("ipdNarcotic.resolve")}</button>
        </div>
      ) : null}
      {refusal !== null ? <div className="ipdk-refusal" role="alert">{refusal.rule}</div> : null}
    </li>
  );
}
