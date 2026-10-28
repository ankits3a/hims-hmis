import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdLineView, IpdRestraintView, IpdWardLots, IpdWardStock, IpdWardStockCatalogue } from "@hmis/contracts";
import { wardErrorOf } from "../lib/ipd-ward-api";
import {
  applyRestraint, getStockCatalogue, insertLine, istNowHhmm, istTodayAt, orderRestraint, recordRiskScore, recordSafetyEvent, registerCart,
  removeLine, reviewRestraint, setWardPar,
} from "../lib/ipd-ward-safety-api";
import type { LineKind, RestraintKind, SafetyEventKind, StockOutcome } from "../lib/ipd-ward-safety-api";
import { getWardLots, recordStockUse } from "../lib/ipd-ward-safety-api";
import { useAuth } from "../lib/auth";
import "./ipd-nursing.css";
import "./ipd-ward-desk.css";

/**
 * #1007 (WM-2 #983) — THE ENTRY FORMS, shared by the ward safety screen (in-charge, 1440), My shift (nurse, 390) and the
 * round page (doctor): the daily Morse / Braden score, a line in and out, a safety event, a restraint ordered / applied /
 * reviewed, a crash cart registered, ward par set. Each form runs its own act and shows the server's refusal in words
 * (`ipdSafety.err.<code>`); `onSaved` gets the words to show and refetches.
 */

export type Saved = (words: string) => void;

function useAct(onSaved: Saved): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>, words: string) => Promise<boolean> } {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, words: string): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); if (words !== "") onSaved(words); return true; } catch (e) {
      const w = wardErrorOf(e);
      setError(w === null ? t("ipdWard.err.other") : t(`ipdSafety.err.${w.code}`, { defaultValue: t("ipdWard.err.other") }));
      return false;
    } finally { setBusy(false); }
  };
  return { busy, error, run };
}

function Refusal({ error }: { error: string | null }): React.ReactElement | null {
  return error === null ? null : <div className="ipdn-refusal" role="alert">{error}</div>;
}

const intIn = (v: string, lo: number, hi: number): boolean => /^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi;

/** The daily safety round: Morse (0–125) and Braden (6–23). */
export function RiskScoreForm({ admissionId, onSaved }: { admissionId: string; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [morse, setMorse] = useState("");
  const [braden, setBraden] = useState("");
  const { busy, error, run } = useAct(onSaved);
  const ok = intIn(morse, 0, 125) && intIn(braden, 6, 23);
  return (
    <div className="ipds-form" data-testid="ipds-score-form">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.morse")}<input inputMode="numeric" value={morse} onChange={(e) => setMorse(e.target.value)} data-testid="ipds-morse" /></label>
        <label>{t("ipdSafety.forms.braden")}<input inputMode="numeric" value={braden} onChange={(e) => setBraden(e.target.value)} data-testid="ipds-braden" /></label>
      </div>
      <span className="dim">{t("ipdSafety.forms.scoreHint")}</span>
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={!ok || busy} data-testid="ipds-score-save"
        onClick={() => void run(() => recordRiskScore(admissionId, Number(morse), Number(braden)), t("ipdSafety.forms.scoreSaved"))}>{t("ipdSafety.forms.save")}</button>
    </div>
  );
}

const LINE_KINDS: LineKind[] = ["cannula", "urinary_catheter", "central_line"];

/** A line in: kind, site, time in (today, IST). */
export function LineInsertForm({ admissionId, onSaved }: { admissionId: string; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LineKind>("cannula");
  const [site, setSite] = useState("");
  const [time, setTime] = useState(() => istNowHhmm());
  const { busy, error, run } = useAct(onSaved);
  return (
    <div className="ipds-form" data-testid="ipds-line-form">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.lineKind")}
          <select value={kind} onChange={(e) => setKind(e.target.value as LineKind)} data-testid="ipds-line-kind">
            {LINE_KINDS.map((k) => <option key={k} value={k}>{t(`ipdSafety.lines.kind.${k}`)}</option>)}
          </select>
        </label>
        <label>{t("ipdSafety.forms.site")}<input value={site} onChange={(e) => setSite(e.target.value)} data-testid="ipds-line-site" /></label>
        <label>{t("ipdSafety.forms.timeIn")}<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      </div>
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={site.trim() === "" || !/^\d{2}:\d{2}$/.test(time) || busy} data-testid="ipds-line-save"
        onClick={() => void run(() => insertLine(admissionId, kind, site.trim(), istTodayAt(time)), t("ipdSafety.forms.lineSaved"))}>{t("ipdSafety.forms.save")}</button>
    </div>
  );
}

/** Take a line out, with a reason. */
export function LineRemoveForm({ line, onSaved, onCancel }: { line: IpdLineView; onSaved: Saved; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [why, setWhy] = useState("");
  const { busy, error, run } = useAct(onSaved);
  return (
    <div className="ipds-form" data-testid="ipds-line-remove">
      <b>{t("ipdSafety.forms.removeTitle", { kind: t(`ipdSafety.lines.kind.${line.kind}`), site: line.site })}</b>
      <label>{t("ipdSafety.forms.reason")}<input value={why} onChange={(e) => setWhy(e.target.value)} data-testid="ipds-line-why" /></label>
      <Refusal error={error} />
      <div className="ipdw-row">
        <button type="button" className="ipdn-btn pri" disabled={why.trim().length < 3 || busy} data-testid="ipds-line-out"
          onClick={() => void run(() => removeLine(line.lineId, why.trim()), t("ipdSafety.forms.lineOut"))}>{t("ipdSafety.forms.takeOut")}</button>
        <button type="button" className="ipdn-btn" onClick={onCancel}>{t("ipdWard.cockpit.cancel")}</button>
      </div>
    </div>
  );
}

const EVENT_KINDS: SafetyEventKind[] = ["fall", "pressure_injury", "medication_error", "line_infection"];

/** A fall, a pressure injury, a medication error or a line infection (which names its line). */
export function SafetyEventForm({ admissionId, lines, onSaved }: { admissionId: string; lines: readonly IpdLineView[]; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SafetyEventKind>("fall");
  const [poa, setPoa] = useState(false);
  const [lineId, setLineId] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useAct(onSaved);
  const needsLine = kind === "line_infection";
  return (
    <div className="ipds-form" data-testid="ipds-event-form">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.eventKind")}
          <select value={kind} onChange={(e) => setKind(e.target.value as SafetyEventKind)} data-testid="ipds-event-kind">
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{t(`ipdSafety.forms.event.${k}`)}</option>)}
          </select>
        </label>
        {needsLine ? (
          <label>{t("ipdSafety.forms.whichLine")}
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">{t("ipdSafety.forms.choose")}</option>
              {lines.map((l) => <option key={l.lineId} value={l.lineId}>{t(`ipdSafety.lines.kind.${l.kind}`)} · {l.site}</option>)}
            </select>
          </label>
        ) : null}
        <label>{t("ipdSafety.forms.note")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {kind === "fall" || kind === "pressure_injury" ? (
        <label className="ipds-check"><input type="checkbox" checked={poa} onChange={(e) => setPoa(e.target.checked)} /> {t("ipdSafety.forms.poa")}</label>
      ) : null}
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={(needsLine && lineId === "") || busy} data-testid="ipds-event-save"
        onClick={() => void run(() => recordSafetyEvent({ admissionId, kind, presentOnAdmission: poa && (kind === "fall" || kind === "pressure_injury"), ...(needsLine ? { lineId } : {}), note }), t("ipdSafety.forms.eventSaved"))}>
        {t("ipdSafety.forms.save")}
      </button>
    </div>
  );
}

const OUTCOMES: StockOutcome[] = ["used", "issued", "wasted", "refused"];

/**
 * #1019 — one ward-stock item on a patient (decisions 0089 / 0091): a lot on the ward's shelf, how many, and what happened.
 * Wasted needs a reason; staff error and the in-charge's waiver are not charged; refused (unopened) stays on the shelf. An
 * expired lot is shown but cannot be picked (return it to stores). The answer says whether it went on the bill.
 */
export function StockUseForm({ admissionId, onSaved }: { admissionId: string; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [lots, setLots] = useState<IpdWardLots | null>(null);
  const [batchId, setBatchId] = useState("");
  const [qty, setQty] = useState("1");
  const [outcome, setOutcome] = useState<StockOutcome>("used");
  const [reason, setReason] = useState("");
  const [staffError, setStaffError] = useState(false);
  const [inPackage, setInPackage] = useState(false);
  const [waive, setWaive] = useState("");
  const { busy, error, run } = useAct(onSaved);
  useEffect(() => { let live = true; void getWardLots(admissionId).then((l) => { if (live) setLots(l); }); return () => { live = false; }; }, [admissionId]);
  const lot = lots?.lots.find((l) => l.batchId === batchId);
  const wasted = outcome === "wasted";
  const ok = lot !== undefined && !lot.expired && intIn(qty, 1, Math.max(1, Math.floor(lot.onHand))) && (!wasted || reason.trim().length >= 3);
  if (lots !== null && lots.lots.length === 0) return <div className="ipds-form" data-testid="ipds-stock-form"><span className="dim">{t("ipdSafety.forms.noLots")}</span></div>;
  return (
    <div className="ipds-form" data-testid="ipds-stock-form">
      <div className="ipds-fields">
        <label className="ipds-wide-field">{t("ipdSafety.forms.lot")}
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} data-testid="ipds-stock-lot">
            <option value="">{t("ipdSafety.forms.choose")}</option>
            {(lots?.lots ?? []).map((l) => (
              <option key={l.batchId} value={l.batchId} disabled={l.expired}>
                {l.name} · {l.batchNo} · {l.expired ? t("ipdSafety.forms.lotExpired") : t("ipdSafety.forms.lotLeft", { n: l.onHand })}
              </option>
            ))}
          </select>
        </label>
        <label>{t("ipdSafety.forms.qty")}<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="ipds-stock-qty" /></label>
        <label className="ipds-wide-field">{t("ipdSafety.forms.outcome")}
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as StockOutcome)} data-testid="ipds-stock-outcome">
            {OUTCOMES.map((o) => <option key={o} value={o}>{t(`ipdSafety.forms.out.${o}`)}</option>)}
          </select>
        </label>
      </div>
      <span className="dim">{t(`ipdSafety.forms.outHint.${outcome}`)}</span>
      {wasted ? (
        <div className="ipds-fields">
          <label>{t("ipdSafety.forms.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ipds-stock-reason" /></label>
          {can("ipd.nursing.assign") ? <label>{t("ipdSafety.forms.waive")}<input value={waive} onChange={(e) => setWaive(e.target.value)} data-testid="ipds-stock-waive" /></label> : null}
        </div>
      ) : null}
      {wasted ? <label className="ipds-check"><input type="checkbox" checked={staffError} onChange={(e) => setStaffError(e.target.checked)} /> {t("ipdSafety.forms.staffError")}</label> : null}
      {outcome !== "refused" ? <label className="ipds-check"><input type="checkbox" checked={inPackage} onChange={(e) => setInPackage(e.target.checked)} /> {t("ipdSafety.forms.inPackage")}</label> : null}
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={!ok || busy} data-testid="ipds-stock-save"
        onClick={() => void run(async () => {
          const r = await recordStockUse({
            admissionId, itemId: lot!.itemId, batchId, qty: Number(qty), outcome, reason, staffError: wasted && staffError, inPackage, ...(wasted ? { waiveReason: waive } : {}),
          });
          onSaved(r.charged ? t("ipdSafety.forms.charged") : t("ipdSafety.forms.notCharged", { why: t(`ipdSafety.forms.why.${r.notChargedWhy ?? "refused"}`) }));
          setBatchId(""); setQty("1"); setReason(""); setWaive(""); setStaffError(false); setInPackage(false);
          void getWardLots(admissionId).then(setLots);
        }, "")}>{t("ipdSafety.forms.save")}</button>
    </div>
  );
}

type PatientTab = "score" | "line" | "event" | "stock";

/** One patient's three nurse entries, as tabs: the daily score, a line in, a safety event. */
export function PatientSafetyForms({ admissionId, lines, onSaved }: { admissionId: string; lines: readonly IpdLineView[]; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<PatientTab>("score");
  const tabs: PatientTab[] = can("ipd.ward_stock.use") ? ["score", "line", "event", "stock"] : ["score", "line", "event"];
  return (
    <div className="ipds-patient" data-testid="ipds-patient-forms">
      <div className="ipdw-seg">
        {tabs.map((k) => (
          <button key={k} type="button" className={`ipdn-btn sm${tab === k ? " pri" : ""}`} aria-pressed={tab === k} onClick={() => setTab(k)} data-testid={`ipds-ptab-${k}`}>{t(`ipdSafety.forms.tab.${k}`)}</button>
        ))}
      </div>
      {tab === "score" ? <RiskScoreForm key={admissionId} admissionId={admissionId} onSaved={onSaved} /> : null}
      {tab === "line" ? <LineInsertForm key={admissionId} admissionId={admissionId} onSaved={onSaved} /> : null}
      {tab === "stock" ? <StockUseForm key={admissionId} admissionId={admissionId} onSaved={onSaved} /> : null}
      {tab === "event" ? <SafetyEventForm key={admissionId} admissionId={admissionId} lines={lines.filter((l) => l.admissionId === admissionId)} onSaved={onSaved} /> : null}
    </div>
  );
}

const RESTRAINT_KINDS: RestraintKind[] = ["physical", "chemical", "seclusion"];

/** The doctor's restraint order: kind and reason. It lapses 24 hours after the doctor's last sign. */
export function RestraintOrderForm({ admissionId, onSaved }: { admissionId: string; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RestraintKind>("physical");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAct(onSaved);
  return (
    <div className="ipds-form" data-testid="ipds-restraint-order">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.restraintKind")}
          <select value={kind} onChange={(e) => setKind(e.target.value as RestraintKind)}>
            {RESTRAINT_KINDS.map((k) => <option key={k} value={k}>{t(`ipdSafety.restraint.kind.${k}`)}</option>)}
          </select>
        </label>
        <label>{t("ipdSafety.forms.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ipds-restraint-reason" /></label>
      </div>
      <span className="dim">{t("ipdSafety.forms.orderHint")}</span>
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={reason.trim().length < 3 || busy} data-testid="ipds-restraint-sign"
        onClick={() => void run(() => orderRestraint(admissionId, kind, reason.trim()), t("ipdSafety.forms.ordered"))}>{t("ipdSafety.forms.signOrder")}</button>
    </div>
  );
}

/** A restraint's row action: the nurse applies an ordered one; the doctor continues (signs again) or removes. */
export function RestraintActions({ r, role, onSaved }: { r: IpdRestraintView; role: "nurse" | "doctor"; onSaved: Saved }): React.ReactElement | null {
  const { t } = useTranslation();
  const { busy, error, run } = useAct(onSaved);
  if (role === "nurse" && r.status !== "ordered") return null;
  if (role === "doctor" && r.status !== "ordered" && r.status !== "active") return null;
  return (
    <span className="ipds-acts">
      {role === "nurse" ? (
        <button type="button" className="ipdn-btn sm pri" disabled={busy} data-testid={`ipds-apply-${r.restraintId}`}
          onClick={() => void run(() => applyRestraint(r.restraintId), t("ipdSafety.forms.applied"))}>{t("ipdSafety.forms.apply")}</button>
      ) : (
        <>
          <button type="button" className="ipdn-btn sm pri" disabled={busy} data-testid={`ipds-continue-${r.restraintId}`}
            onClick={() => void run(() => reviewRestraint(r.restraintId, "continue"), t("ipdSafety.forms.continued"))}>{t("ipdSafety.forms.continue")}</button>
          <button type="button" className="ipdn-btn sm" disabled={busy}
            onClick={() => void run(() => reviewRestraint(r.restraintId, "remove"), t("ipdSafety.restraint.ended"))}>{t("ipdSafety.forms.removeRestraint")}</button>
        </>
      )}
      {error === null ? null : <span className="hot" role="alert">{error}</span>}
    </span>
  );
}

/** The in-charge registers a crash cart with its seal; the contents are the hospital's standard list. */
export function CartRegisterForm({ wardId, onSaved }: { wardId: string; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [seal, setSeal] = useState("");
  const { busy, error, run } = useAct(onSaved);
  return (
    <div className="ipds-form" data-testid="ipds-cart-register">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.cartCode")}<input value={code} onChange={(e) => setCode(e.target.value)} data-testid="ipds-cart-code" /></label>
        <label>{t("ipdSafety.cart.sealNo")}<input value={seal} onChange={(e) => setSeal(e.target.value)} data-testid="ipds-cart-seal" /></label>
      </div>
      <span className="dim">{t("ipdSafety.forms.cartHint")}</span>
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={code.trim() === "" || seal.trim() === "" || busy} data-testid="ipds-cart-add"
        onClick={() => void run(() => registerCart(wardId, code.trim(), seal.trim()), t("ipdSafety.forms.cartAdded"))}>{t("ipdSafety.forms.addCart")}</button>
    </div>
  );
}

/** The in-charge sets par: the supply store, then items found by name with their par. Existing par rows show as set. */
export function ParForm({ wardId, stock, onSaved }: { wardId: string; stock: IpdWardStock | null; onSaved: Saved }): React.ReactElement {
  const { t } = useTranslation();
  const [cat, setCat] = useState<IpdWardStockCatalogue | null>(null);
  const [search, setSearch] = useState("");
  const [store, setStore] = useState(stock?.supplyStoreId ?? "");
  const [pars, setPars] = useState<Record<string, { name: string; par: string }>>({});
  const { busy, error, run } = useAct(onSaved);
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => { void getStockCatalogue(search).then((c) => { if (live) setCat(c); }); }, 250);
    return () => { live = false; clearTimeout(h); };
  }, [search]);
  const rows = Object.entries(pars).filter(([, v]) => intIn(v.par, 0, 100000));
  return (
    <div className="ipds-form" data-testid="ipds-par-form">
      <div className="ipds-fields">
        <label>{t("ipdSafety.forms.supplyStore")}
          <select value={store} onChange={(e) => setStore(e.target.value)} data-testid="ipds-par-store">
            <option value="">{t("ipdSafety.forms.choose")}</option>
            {(cat?.stores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>{t("ipdSafety.forms.findItem")}<input value={search} onChange={(e) => setSearch(e.target.value)} data-testid="ipds-par-search" /></label>
      </div>
      <div className="ipds-picks">
        {(cat?.items ?? []).filter((i) => pars[i.itemId] === undefined).slice(0, 8).map((i) => (
          <button key={i.itemId} type="button" className="ipdn-btn sm" onClick={() => setPars({ ...pars, [i.itemId]: { name: i.name, par: String(stock?.items.find((x) => x.itemId === i.itemId)?.par ?? "") } })}
            data-testid={`ipds-par-pick-${i.itemId}`}>+ {i.name}</button>
        ))}
      </div>
      {Object.entries(pars).map(([itemId, v]) => (
        <label key={itemId} className="ipds-parrow"><span>{v.name}</span>
          <input inputMode="numeric" value={v.par} onChange={(e) => setPars({ ...pars, [itemId]: { ...v, par: e.target.value } })} data-testid={`ipds-par-${itemId}`} />
        </label>
      ))}
      <Refusal error={error} />
      <button type="button" className="ipdn-btn pri" disabled={store === "" || rows.length === 0 || busy} data-testid="ipds-par-save"
        onClick={() => void run(() => setWardPar(wardId, store, rows.map(([itemId, v]) => ({ itemId, par: Number(v.par) }))), t("ipdSafety.forms.parSaved", { count: rows.length })).then((ok) => { if (ok) setPars({}); })}>
        {t("ipdSafety.forms.savePar", { count: rows.length })}
      </button>
    </div>
  );
}
