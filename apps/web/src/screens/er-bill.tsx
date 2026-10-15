import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErBill, ErBillDesk, ErRefusalBody } from "@hmis/contracts";
import { fmtIst, fmtPaise } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_BOARD_TOPIC, ER_PAYER_KINDS, advanceApi, erRefusalOf, fetchErBill, fetchErBillDesk, newKey, priceLinesApi, setPayerApi, settleApi,
} from "../lib/er-api";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 6 (#813, decision 0076) — THE ER BILL DESK. Money lives on this screen (and billing's) only — never on a
 * clinical one (0058). Left: patients who have left the ER and are not settled, then those still in the department with
 * their running total. Right: one bill — its lines (the visit lines, tests, drugs at MRP), the payer, an advance (only
 * after "stabilised"), and the settlement: paid, dues against a signed undertaking (the invoice held, never credit), or
 * nothing payable (PM-JAY, road-accident cashless, BNSS s.397, a mass-casualty event).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return (
    <div className="erd-refusal" role="alert" data-testid="er-bill-refusal">
      <b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b>
      <span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span>
    </div>
  );
}

function Row({ b, t, on, pick }: { b: ErBill; t: T; on: boolean; pick: () => void }): React.ReactElement {
  return (
    <button type="button" className={`ert-row erm-row${on ? " on" : ""}`} onClick={pick} aria-pressed={on} data-testid="er-bill-row">
      <span className="ert-row-main">
        <b>{b.patientLabel}</b>
        <span className="dim"><span className="mono">{b.episodeNo}</span> · {t(`erBill.payer.${b.payer}`)}{b.outcome !== null ? ` · ${t(`erBill.outcome.${b.outcome}`, { defaultValue: b.outcome })}` : ""}</span>
      </span>
      <span className="mono erb-bill-amt">{fmtPaise(b.balancePaise)}</span>
    </button>
  );
}

export function ErBillScreen(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { episode?: string };
  const navigate = useNavigate();
  const picked = typeof search.episode === "string" && search.episode !== "" ? search.episode : null;
  const [desk, setDesk] = useState<ErBillDesk | null>(null);
  const [bill, setBill] = useState<ErBill | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchErBillDesk().then(setDesk, () => setDesk(null));
    if (picked !== null) fetchErBill(picked).then(setBill, () => setBill(null)); else setBill(null);
  }, [picked]);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  const act = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true); setRefusal(null); setNote(null);
    try { const said = await work(); if (said !== null) setNote(said); load(); }
    catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };
  const pick = (id: string) => { setRefusal(null); setNote(null); void navigate({ to: "/er/bill", search: { episode: id } as never }); };
  return (
    <div className="erx erd erm" data-testid="er-bill">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erBill.title")}</h1></div>
        <div className="erb-tools"><Link to="/er/desk" className="erx-btn">{t("erBoard.desk")}</Link><Link to="/" className="erx-btn">{t("erBoard.home")}</Link></div>
      </header>
      <div className="erd-cols">
        <section className="erd-list erm-list" aria-label={t("erBill.toSettle")}>
          <h2>{t("erBill.toSettle")} <span className="erb-badge">{desk?.toSettle.length ?? 0}</span></h2>
          {desk === null ? <div className="erb-empty">{t("erTriage.loading")}</div>
            : desk.toSettle.length === 0 ? <div className="erb-empty">{t("erBill.noneToSettle")}</div>
              : desk.toSettle.map((b) => <Row key={b.episodeId} b={b} t={t} on={b.episodeId === picked} pick={() => pick(b.episodeId)} />)}
          {desk !== null && desk.inDepartment.length > 0 ? (
            <>
              <h2>{t("erBill.inDepartment")}</h2>
              {desk.inDepartment.map((b) => <Row key={b.episodeId} b={b} t={t} on={b.episodeId === picked} pick={() => pick(b.episodeId)} />)}
            </>
          ) : null}
        </section>
        <section className="erd-new erm-case" data-testid="er-bill-case">
          {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
          {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
          {bill === null ? <div className="erb-empty">{t("erBill.pick")}</div> : <Bill b={bill} t={t} busy={busy} act={act} />}
        </section>
      </div>
    </div>
  );
}

function Bill({ b, t, busy, act }: { b: ErBill; t: T; busy: boolean; act: (w: () => Promise<string | null>) => Promise<void> }): React.ReactElement {
  const [payer, setPayer] = useState<string>(b.payer);
  const [ref, setRef] = useState("");
  const [cash, setCash] = useState("");
  const [tender, setTender] = useState<"cash" | "upi" | "card">("cash");
  const [signer, setSigner] = useState("");
  const [relation, setRelation] = useState("");
  const [doc, setDoc] = useState("");
  const [attempt, setAttempt] = useState(() => newKey());
  const rupees = Math.round(Number(cash || "0") * 100);
  const departed = b.state === "departed" || b.state === "brought_dead";
  const free = b.patientPaise === 0;
  const settle = (settlement: "paid" | "dues" | "nothing_payable") => act(async () => {
    try {
      const r = await settleApi({
        episodeId: b.episodeId, settlement,
        ...(rupees > 0 ? { tenders: [{ tender, amountPaise: rupees }] } : {}),
        ...(settlement === "dues" ? { undertaking: { signerName: signer.trim(), relation: relation.trim(), documentRef: doc.trim() } } : {}),
      }, attempt);
      setAttempt(newKey());
      return r.duesPaise > 0 ? t("erBill.settledDues", { dues: fmtPaise(r.duesPaise) }) : t("erBill.settled", { no: r.invoiceNo ?? "—" });
    } catch (e) { if (erRefusalOf(e) !== null) setAttempt(newKey()); throw e; }
  });
  return (
    <div className="erm-detail">
      <div className="erd-ep-top">
        <div className="erd-ep-name"><b>{b.patientLabel}</b><span className="mono">{b.uhid}</span><span className="mono">{b.episodeNo}</span></div>
        <span className="erd-state">{b.stabilised ? t("erBill.stabilised") : t("erBill.notStabilised")}</span>
      </div>
      <table className="erb-bill-lines" data-testid="er-bill-lines">
        <tbody>
          {b.lines.map((l) => (
            <tr key={l.lineId}>
              <td>{t(`erBill.source.${l.source}`, { defaultValue: l.name })}{l.qty > 1 ? ` × ${String(l.qty)}` : ""}<span className="dim"> · {fmtIst(l.postedAt)}</span></td>
              <td className="mono num">{l.amountPaise === null ? t("erBill.unpriced") : fmtPaise(l.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="erb-meta">
        <span>{t("erBill.total")}: <b className="mono">{fmtPaise(b.totalPaise)}</b></span>
        <span>{t("erBill.payerShare")}: <b className="mono">{fmtPaise(b.payerPaise)}</b></span>
        <span>{t("erBill.patientShare")}: <b className="mono">{fmtPaise(b.patientPaise)}</b></span>
        <span>{t("erBill.advance")}: <b className="mono">{fmtPaise(b.advancePaise)}</b></span>
        <span data-testid="er-bill-balance">{t("erBill.balance")}: <b className="mono">{fmtPaise(b.balancePaise)}</b></span>
      </div>
      {b.unpriced > 0 ? (
        <button type="button" className="erx-btn" disabled={busy} data-testid="er-bill-price"
          onClick={() => void act(async () => { const r = await priceLinesApi(b.episodeId); return t("erBill.priced", { n: r.priced }); })}>{t("erBill.price")}</button>
      ) : null}
      {b.settled !== null ? (
        <p className="erp-text" data-testid="er-bill-settled">{t(`erBill.settlement.${b.settled.settlement}`)} · {b.settled.invoiceNo ?? "—"} · {fmtIst(b.settled.at)}</p>
      ) : (
        <>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erBill.payerLabel")}</span>
              <select value={payer} onChange={(e) => setPayer(e.target.value)} data-testid="er-bill-payer">
                {ER_PAYER_KINDS.filter((p) => p !== "mci_event").map((p) => <option key={p} value={p}>{t(`erBill.payer.${p}`)}</option>)}
              </select></label>
            <label className="erd-field"><span>{t("erBill.schemeRef")}</span><input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
          </div>
          {payer !== b.payer ? (
            <button type="button" className="erx-btn" disabled={busy} onClick={() => void act(async () => {
              await setPayerApi({ episodeId: b.episodeId, payer, ...(ref.trim() !== "" ? { schemeRef: ref.trim() } : {}) });
              return t("erBill.payerSet");
            })}>{t("erBill.setPayer")}</button>
          ) : null}
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erBill.amount")}</span><input value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" data-testid="er-bill-amount" /></label>
            <label className="erd-field"><span>{t("erBill.tender")}</span>
              <select value={tender} onChange={(e) => setTender(e.target.value as "cash")}>{(["cash", "upi", "card"] as const).map((x) => <option key={x} value={x}>{t(`erBill.tenderOf.${x}`)}</option>)}</select></label>
          </div>
          {!departed ? (
            <button type="button" className="erx-btn" disabled={busy || rupees <= 0 || !b.stabilised || free} data-testid="er-bill-advance"
              onClick={() => void act(async () => { const r = await advanceApi({ episodeId: b.episodeId, tender: { tender, amountPaise: rupees }, payerName: signer.trim() || "Patient" }); return t("erBill.advanceTaken", { no: r.receiptNo }); })}>
              {t("erBill.takeAdvance")}</button>
          ) : (
            <>
              <div className="erd-row">
                {free ? <button type="button" className="erx-btn pri" disabled={busy} data-testid="er-bill-zero" onClick={() => void settle("nothing_payable")}>{t("erBill.settleZero")}</button>
                  : <button type="button" className="erx-btn pri" disabled={busy || b.unpriced > 0} data-testid="er-bill-paid" onClick={() => void settle("paid")}>{t("erBill.settlePaid")}</button>}
              </div>
              {!free ? (
                <details className="erd-newpatient erm-form" data-testid="er-bill-dues">
                  <summary>{t("erBill.dues")}</summary>
                  <div className="erd-pair">
                    <label className="erd-field"><span>{t("erBill.signer")}</span><input value={signer} onChange={(e) => setSigner(e.target.value)} /></label>
                    <label className="erd-field"><span>{t("erBill.relation")}</span><input value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
                  </div>
                  <label className="erd-field"><span>{t("erBill.undertakingRef")}</span><input value={doc} onChange={(e) => setDoc(e.target.value)} /></label>
                  <button type="button" className="erx-btn" disabled={busy || signer.trim() === "" || relation.trim() === "" || doc.trim() === ""} data-testid="er-bill-dues-save"
                    onClick={() => void settle("dues")}>{t("erBill.recordDues")}</button>
                </details>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
