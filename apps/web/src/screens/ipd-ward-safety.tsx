import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdCrashCartView, IpdRestraintRegister, IpdRestraintView, IpdWardQuality, IpdWardSafety, IpdWardStock } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import { useLiveLoad } from "./ipd-nursing-shared";
import { wardErrorOf } from "../lib/ipd-ward-api";
import type { WardError } from "../lib/ipd-ward-api";
import {
  checkCart, endRestraint, getRestraintRegister, getWardQuality, getWardSafety, getWardStock, istMonth, raiseWardIndent, recordCareCheck,
  recordFamilyTold, recordRestraintCheck, takeKeys, markCartUsed,
} from "../lib/ipd-ward-safety-api";
import type { CartLine, RestraintTicks } from "../lib/ipd-ward-safety-api";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import { WardDeskHeader } from "./ipd-ward-cockpit";
import "./ipd-nursing.css";
import "./ipd-ward-desk.css";

/**
 * WM-2 (#983, decisions 0089 / 0091) — THE WARD SAFETY SCREEN (1440; in the in-charge's cockpit family). Three panes:
 * - SAFETY: care plans with their next timed check (red and "overdue" until done), restraints (status, next check, the
 *   doctor's review due, family told; check / family / take off), lines in with their day count and due-out.
 * - CART & STOCK: each crash cart against its seal (a changed seal or a used cart asks for a full recount), who holds the
 *   narcotic keys, ward stock against par with one "Raise indent", and lots to send back (expiring within 30 days).
 * - QUALITY: the month's seven indicators and the restraint register.
 * Red always comes with a word. Sealed patients show no bed text (the server's identity rule).
 */

type Pane = "safety" | "stock" | "quality";

export function IpdWardSafetyScreen({ ward }: { ward?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const pick = useWardChoice(ward ?? null);
  const [s, setS] = useState<IpdWardSafety | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [pane, setPane] = useState<Pane>("safety");
  const [err, setErr] = useState<WardError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => getWardSafety(pick.wardId).then(setS, (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) { setForbidden(true); return; }
    throw e;
  }), [pick.wardId]);
  useLiveLoad(load);

  if (forbidden) return <main className="ipdn ipdw" role="alert">{t("ipdWard.forbidden")}</main>;
  if (s !== null && pick.needsPick(s.wards)) {
    return (
      <main className="ipdn ipdw" data-testid="ipd-ward-safety">
        <WardPicker wards={s.wards} value={null} onChange={pick.choose} />
        <PickWardPrompt className="ipdw-empty" />
      </main>
    );
  }
  if (s === null) return <main className="ipdn ipdw" aria-busy="true" data-testid="ipd-ward-safety">{t("ipdWard.loading")}</main>;

  const act = async (fn: () => Promise<unknown>, words: string): Promise<boolean> => {
    setErr(null); setDone(null);
    try { await fn(); setDone(words); await load(); return true; } catch (e) { const w = wardErrorOf(e); if (w === null) throw e; setErr(w); return false; }
  };
  const overdue = s.carePlans.filter((p) => p.overdue).length + s.restraints.filter((r) => r.checkOverdue || r.status === "lapsed").length;
  return (
    <main className="ipdn ipdw" data-testid="ipd-ward-safety">
      <WardDeskHeader cockpit={s} active="safety" onPick={pick.choose} />
      <div className="ipdw-body">
        <div className="ipdw-bar">
          <h1>{t("ipdSafety.title")}</h1>
          {overdue > 0 ? <span className="hot" data-testid="ipds-overdue">{t("ipdSafety.overdueCount", { count: overdue })}</span> : <span className="ok">{t("ipdSafety.allOnTime")}</span>}
          <span className="grow" />
          <nav className="ipdw-seg" aria-label={t("ipdSafety.title")}>
            {(["safety", "stock", "quality"] as const).map((p) => (
              <button key={p} type="button" className={`ipdn-btn sm${pane === p ? " pri" : ""}`} aria-pressed={pane === p} onClick={() => setPane(p)} data-testid={`ipds-pane-${p}`}>{t(`ipdSafety.pane.${p}`)}</button>
            ))}
          </nav>
        </div>
        {err !== null ? <div className="ipdn-refusal" role="alert">{t(`ipdSafety.err.${err.code}`, { defaultValue: t("ipdWard.err.other") })}</div> : null}
        {done !== null ? <div className="ipdn-ok" role="status">{done}</div> : null}
        {pane === "safety" ? <SafetyPane s={s} act={act} /> : null}
        {pane === "stock" && s.ward !== null ? <StockPane s={s} wardId={s.ward.id} act={act} /> : null}
        {pane === "quality" && s.ward !== null ? <QualityPane wardId={s.ward.id} /> : null}
      </div>
    </main>
  );
}

type Act = (fn: () => Promise<unknown>, words: string) => Promise<boolean>;

function SafetyPane({ s, act }: { s: IpdWardSafety; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [checking, setChecking] = useState<IpdRestraintView | null>(null);
  const bed = (code: string | null): string => code ?? t("ipdWard.bed");
  return (
    <div className="ipds-grid">
      <section className="ipdw-box" data-testid="ipds-plans">
        <b>{t("ipdSafety.plans.title")} <span className="mono dim">{s.carePlans.length}</span></b>
        {s.carePlans.length === 0 ? <span className="dim">{t("ipdSafety.plans.none")}</span> : s.carePlans.map((p) => (
          <div key={p.planId} className={`ipds-row${p.overdue ? " red" : ""}`}>
            <span className="mono">{bed(p.bedCode)}</span>
            <span className="nm">{p.name}</span>
            <span>{t(`ipdSafety.plan.${p.kind}`)} <span className="dim mono">{p.kind === "fall" ? `Morse ${String(p.score)}` : `Braden ${String(p.score)}`}</span></span>
            <span className={p.overdue ? "hot" : "dim"}>{p.overdue ? t("ipdSafety.overdueSince", { time: fmtIst(p.nextDueAt) }) : t("ipdSafety.dueAt", { time: fmtIst(p.nextDueAt) })}</span>
            <button type="button" className="ipdn-btn sm pri" onClick={() => void act(() => recordCareCheck(p.planId), t("ipdSafety.plans.saved"))} data-testid={`ipds-check-${p.planId}`}>{t("ipdSafety.plans.done")}</button>
          </div>
        ))}
      </section>

      <section className="ipdw-box" data-testid="ipds-restraints">
        <b>{t("ipdSafety.restraint.title")} <span className="mono dim">{s.restraints.length}</span></b>
        {s.restraints.length === 0 ? <span className="dim">{t("ipdSafety.restraint.none")}</span> : s.restraints.map((r) => {
          const red = r.checkOverdue || r.status === "lapsed";
          return (
            <div key={r.restraintId} className={`ipds-row${red ? " red" : ""}`}>
              <span className="mono">{bed(r.bedCode)}</span>
              <span className="nm">{r.name}</span>
              <span>{t(`ipdSafety.restraint.kind.${r.kind}`)} · <span className={r.status === "lapsed" ? "hot" : ""}>{t(`ipdSafety.restraint.status.${r.status}`)}</span>{r.psychiatric ? ` · ${t("ipdSafety.restraint.mhca")}` : ""}</span>
              <span className={r.checkOverdue ? "hot" : "dim"}>
                {r.nextCheckAt === null ? "" : r.checkOverdue ? t("ipdSafety.restraint.checkOverdue", { time: fmtIst(r.nextCheckAt) }) : t("ipdSafety.restraint.nextCheck", { time: fmtIst(r.nextCheckAt) })}
                {" · "}{t("ipdSafety.restraint.review", { time: fmtIst(r.reviewDueAt) })}
              </span>
              <span className={r.familyTold === null ? "warn" : "dim"}>{r.familyTold === null ? t("ipdSafety.restraint.familyNotTold") : t("ipdSafety.restraint.familyTold", { name: r.familyTold.name })}</span>
              {r.status === "active" ? <button type="button" className="ipdn-btn sm pri" onClick={() => setChecking(r)} data-testid={`ipds-rcheck-${r.restraintId}`}>{t("ipdSafety.restraint.check")}</button> : null}
            </div>
          );
        })}
        {checking !== null ? <RestraintForm r={checking} act={act} onClose={() => setChecking(null)} /> : null}
      </section>

      <section className="ipdw-box" data-testid="ipds-lines">
        <b>{t("ipdSafety.lines.title")} <span className="mono dim">{s.lines.length}</span></b>
        {s.lines.length === 0 ? <span className="dim">{t("ipdSafety.lines.none")}</span> : s.lines.map((l) => (
          <div key={l.lineId} className={`ipds-row${l.overdue ? " red" : ""}`}>
            <span className="mono">{bed(l.bedCode)}</span>
            <span className="nm">{l.name}</span>
            <span>{t(`ipdSafety.lines.kind.${l.kind}`)} · <span className="dim">{l.site}</span></span>
            <span className="mono">{t("ipdSafety.lines.day", { n: l.days })}</span>
            <span className={l.overdue ? "hot" : "dim"}>{l.overdue ? t("ipdSafety.lines.overdue") : t("ipdSafety.lines.dueOut", { time: fmtIst(l.dueRemovalAt) })}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

const TICKS = ["circulation", "skin", "hydration", "toileting"] as const;

function RestraintForm({ r, act, onClose }: { r: IpdRestraintView; act: Act; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [ticks, setTicks] = useState<RestraintTicks>({ circulation: false, skin: false, hydration: false, toileting: false });
  const [who, setWho] = useState("");
  const [relation, setRelation] = useState("");
  const [rep, setRep] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <div className="ipds-form" data-testid="ipds-rform">
      <b>{t("ipdSafety.restraint.formTitle", { bed: r.bedCode ?? t("ipdWard.bed") })}</b>
      <fieldset className="ipds-ticks">
        <legend>{t("ipdSafety.restraint.check")}</legend>
        {TICKS.map((k) => (
          <label key={k}><input type="checkbox" checked={ticks[k]} onChange={(e) => setTicks({ ...ticks, [k]: e.target.checked })} /> {t(`ipdSafety.restraint.tick.${k}`)}</label>
        ))}
      </fieldset>
      <div className="ipdw-row">
        <button type="button" className="ipdn-btn pri" onClick={() => void act(() => recordRestraintCheck(r.restraintId, ticks), t("ipdSafety.restraint.checkSaved")).then((ok) => { if (ok) onClose(); })} data-testid="ipds-rcheck-save">{t("ipdSafety.restraint.saveCheck")}</button>
        <button type="button" className="ipdn-btn" onClick={onClose}>{t("ipdWard.cockpit.cancel")}</button>
      </div>
      {r.familyTold === null ? (
        <div className="ipds-family">
          <label>{t("ipdSafety.restraint.toldName")}<input value={who} onChange={(e) => setWho(e.target.value)} /></label>
          <label>{t("ipdSafety.restraint.relation")}<input value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
          {r.psychiatric ? <label><input type="checkbox" checked={rep} onChange={(e) => setRep(e.target.checked)} /> {t("ipdSafety.restraint.representative")}</label> : null}
          <button type="button" className="ipdn-btn" disabled={who.trim() === "" || relation.trim() === ""} onClick={() => void act(() => recordFamilyTold(r.restraintId, who.trim(), relation.trim(), rep), t("ipdSafety.restraint.familySaved"))}>{t("ipdSafety.restraint.saveFamily")}</button>
        </div>
      ) : null}
      <div className="ipds-family">
        <label>{t("ipdSafety.restraint.endReason")}<input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
        <button type="button" className="ipdn-btn" disabled={why.trim().length < 3} onClick={() => void act(() => endRestraint(r.restraintId, why.trim()), t("ipdSafety.restraint.ended")).then((ok) => { if (ok) onClose(); })}>{t("ipdSafety.restraint.end")}</button>
      </div>
    </div>
  );
}

function StockPane({ s, wardId, act }: { s: IpdWardSafety; wardId: string; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [stock, setStock] = useState<IpdWardStock | null>(null);
  const [cart, setCart] = useState<IpdCrashCartView | null>(null);
  const loadStock = useCallback(() => getWardStock(wardId).then(setStock), [wardId]);
  useEffect(() => { void loadStock(); }, [loadStock]);
  const short = stock?.items.filter((i) => i.shortfall > 0) ?? [];
  return (
    <div className="ipds-grid">
      <section className="ipdw-box" data-testid="ipds-carts">
        <b>{t("ipdSafety.cart.title")}</b>
        {s.carts.length === 0 ? <span className="dim">{t("ipdSafety.cart.none")}</span> : s.carts.map((c) => {
          const red = c.status === "needs_restock" || !c.checkedThisShift;
          return (
            <div key={c.cartId} className={`ipds-row${red ? " red" : ""}`}>
              <span className="mono">{c.code}</span>
              <span>{t("ipdSafety.cart.seal", { seal: c.sealNo })}</span>
              <span className={c.status === "needs_restock" ? "hot" : c.checkedThisShift ? "ok" : "warn"}>
                {c.status === "needs_restock" ? t("ipdSafety.cart.restock") : c.checkedThisShift ? t("ipdSafety.cart.checked") : t("ipdSafety.cart.due")}
              </span>
              <button type="button" className="ipdn-btn sm pri" onClick={() => setCart(c)} data-testid={`ipds-cart-${c.cartId}`}>{t("ipdSafety.cart.check")}</button>
              <button type="button" className="ipdn-btn sm" onClick={() => void act(() => markCartUsed(c.cartId), t("ipdSafety.cart.usedSaved"))}>{t("ipdSafety.cart.used")}</button>
            </div>
          );
        })}
        {cart !== null ? <CartForm c={cart} act={act} onClose={() => setCart(null)} /> : null}
      </section>

      <section className="ipdw-box" data-testid="ipds-keys">
        <b>{t("ipdSafety.keys.title")}</b>
        <span>{s.keys === null ? <span className="warn">{t("ipdSafety.keys.nobody")}</span> : t("ipdSafety.keys.held", { name: s.keys.name, time: fmtIst(s.keys.takenAt) })}</span>
        <div className="ipdw-row"><button type="button" className="ipdn-btn sm" onClick={() => void act(() => takeKeys(wardId), t("ipdSafety.keys.taken"))}>{t("ipdSafety.keys.take")}</button></div>
        {s.incidents.length > 0 ? (
          <>
            <b>{t("ipdSafety.incidents")}</b>
            {s.incidents.map((i) => <span key={i.incidentId} className="ipds-inc"><span className="hot">{t("ipdSafety.incident")}</span> {i.text} <span className="dim mono">{fmtIst(i.raisedAt)}</span></span>)}
          </>
        ) : null}
      </section>

      <section className="ipdw-box ipds-wide" data-testid="ipds-stock">
        <div className="ipdw-bar">
          <b>{t("ipdSafety.stock.title")}</b>
          <span className="grow" />
          <button type="button" className="ipdn-btn sm pri" disabled={short.length === 0}
            onClick={() => void act(() => raiseWardIndent(wardId), t("ipdSafety.stock.raised", { count: short.length })).then(() => loadStock())} data-testid="ipds-indent">
            {t("ipdSafety.stock.indent", { count: short.length })}
          </button>
        </div>
        {stock === null ? <span className="dim">{t("ipdWard.loading")}</span> : stock.storeId === null ? <span className="dim">{t("ipdSafety.stock.noStore")}</span> : (
          <table className="ipds-table">
            <thead><tr><th>{t("ipdSafety.stock.item")}</th><th>{t("ipdSafety.stock.par")}</th><th>{t("ipdSafety.stock.onHand")}</th><th>{t("ipdSafety.stock.short")}</th></tr></thead>
            <tbody>
              {stock.items.map((i) => (
                <tr key={i.itemId} className={i.shortfall > 0 ? "short" : ""}>
                  <td>{i.name}</td><td className="mono">{i.par}</td><td className="mono">{i.onHand}</td>
                  <td className={`mono${i.shortfall > 0 ? " warn" : ""}`}>{i.shortfall > 0 ? i.shortfall : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {stock !== null && stock.expiring.length > 0 ? (
          <>
            <b>{t("ipdSafety.stock.returnTitle")}</b>
            {stock.expiring.map((l) => (
              <span key={l.batchId} className="ipds-inc">
                {l.name} <span className="mono dim">{l.batchNo}</span> · <span className={l.daysRemaining < 0 ? "hot" : "warn"}>{l.daysRemaining < 0 ? t("ipdSafety.stock.expired") : t("ipdSafety.stock.expiresIn", { count: l.daysRemaining })}</span> · <span className="mono">{l.onHand}</span>
              </span>
            ))}
          </>
        ) : null}
      </section>
    </div>
  );
}

function CartForm({ c, act, onClose }: { c: IpdCrashCartView; act: Act; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [seal, setSeal] = useState(c.status === "needs_restock" ? "" : c.sealNo);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const needsCount = c.status === "needs_restock" || (seal.trim() !== "" && seal.trim() !== c.sealNo);
  const recount: CartLine[] | undefined = needsCount ? c.contents.map((l) => ({ item: l.item, qty: Number(counts[l.item] ?? "") })) : undefined;
  const complete = !needsCount || c.contents.every((l) => (counts[l.item] ?? "").trim() !== "" && Number.isInteger(Number(counts[l.item])));
  return (
    <div className="ipds-form" data-testid="ipds-cartform">
      <label>{t("ipdSafety.cart.sealNo")}<input value={seal} onChange={(e) => setSeal(e.target.value)} data-testid="ipds-seal" /></label>
      {needsCount ? (
        <>
          <span className="warn">{c.status === "needs_restock" ? t("ipdSafety.cart.restockHint") : t("ipdSafety.cart.changedHint")}</span>
          <div className="ipds-count">
            {c.contents.map((l) => (
              <label key={l.item}><span>{l.item} <span className="dim mono">/ {l.qty}</span></span>
                <input inputMode="numeric" value={counts[l.item] ?? ""} onChange={(e) => setCounts({ ...counts, [l.item]: e.target.value })} />
              </label>
            ))}
          </div>
        </>
      ) : null}
      <div className="ipdw-row">
        <button type="button" className="ipdn-btn pri" disabled={seal.trim() === "" || !complete}
          onClick={() => void act(() => checkCart(c.cartId, seal.trim(), recount), t("ipdSafety.cart.saved")).then((ok) => { if (ok) onClose(); })} data-testid="ipds-cart-save">{t("ipdSafety.cart.save")}</button>
        <button type="button" className="ipdn-btn" onClick={onClose}>{t("ipdWard.cockpit.cancel")}</button>
      </div>
    </div>
  );
}

const INDICATORS = ["falls", "pressureInjuries", "medicationErrors", "lineInfections", "ewsAnsweredInTime", "handoversOnTime", "shiftsRatioKept"] as const;

function QualityPane({ wardId }: { wardId: string }): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => istMonth(new Date()));
  const [q, setQ] = useState<IpdWardQuality | null>(null);
  const [reg, setReg] = useState<IpdRestraintRegister | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([getWardQuality(wardId, month), getRestraintRegister(wardId, month)]).then(([a, b]) => { if (live) { setQ(a); setReg(b); } });
    return () => { live = false; };
  }, [wardId, month]);
  return (
    <div className="ipds-quality" data-testid="ipds-quality">
      <div className="ipdw-bar">
        <label>{t("ipdSafety.quality.month")} <input type="month" value={month} onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); }} /></label>
        {q !== null ? <span className="dim mono">{t("ipdSafety.quality.denoms", { bedDays: q.bedDays, lineDays: q.lineDays })}</span> : null}
      </div>
      {q === null ? <span className="dim">{t("ipdWard.loading")}</span> : (
        <div className="ipds-tiles">
          {INDICATORS.map((k) => {
            const i = q.indicators[k];
            return (
              <div key={k} className="ipds-tile" data-testid={`ipds-ind-${k}`}>
                <span className="dim">{t(`ipdSafety.quality.ind.${k}`)}</span>
                <b className="mono">{i.value === null ? "—" : i.unit === "percent" ? `${String(i.value)}%` : String(i.value)}</b>
                <span className="dim mono">{i.unit === "percent" ? t("ipdSafety.quality.ofOver", { count: i.count, over: i.over }) : t(`ipdSafety.quality.unit.${i.unit}`, { count: i.count })}</span>
              </div>
            );
          })}
        </div>
      )}
      {q !== null && q.presentOnAdmission.length > 0 ? <span className="dim">{t("ipdSafety.quality.poa", { count: q.presentOnAdmission.length })}</span> : null}
      <section className="ipdw-box" data-testid="ipds-register">
        <b>{t("ipdSafety.register.title")} <span className="mono dim">{reg?.episodes.length ?? 0}</span></b>
        {reg === null || reg.episodes.length === 0 ? <span className="dim">{t("ipdSafety.register.none")}</span> : (
          <table className="ipds-table">
            <thead><tr><th>{t("ipdSafety.register.ordered")}</th><th>{t("ipdSafety.stock.item")}</th><th>{t("ipdSafety.register.status")}</th><th>{t("ipdSafety.register.checks")}</th><th>{t("ipdSafety.register.family")}</th></tr></thead>
            <tbody>
              {reg.episodes.map((e) => (
                <tr key={e.restraintId}>
                  <td className="mono">{fmtIst(e.orderedAt)}</td>
                  <td>{t(`ipdSafety.restraint.kind.${e.kind}`)} · {e.orderedBy}</td>
                  <td className={e.status === "lapsed" ? "hot" : ""}>{t(`ipdSafety.restraint.status.${e.status}`)}</td>
                  <td className="mono">{e.checks}{e.missedChecks > 0 ? <span className="hot"> · {t("ipdSafety.register.missed", { count: e.missedChecks })}</span> : null}</td>
                  <td>{e.familyTold === null ? <span className="warn">{t("ipdSafety.restraint.familyNotTold")}</span> : `${e.familyTold.name} (${e.familyTold.relation})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {reg !== null && reg.mhca.episodes > 0 ? <span className="dim">{t("ipdSafety.register.mhca", { count: reg.mhca.episodes, late: reg.mhca.representativeLate })}</span> : null}
      </section>
    </div>
  );
}
