import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdBedClass, IpdRefusalBody, IpdTransferOptions } from "@hmis/contracts";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import {
  CANCEL_REASONS, SWAP_REASONS, TRANSFER_REASONS, cancelTransfer, changeClass, getTransferOptions, startTransfer, swapBeds,
} from "../lib/ipd-transfer-api";
import type { CancelReason, ClassConsent, SwapReason, TransferReason } from "../lib/ipd-transfer-api";
import "./ipd-transfer.css";

/**
 * E3.1 (#729) — THE TRANSFER PANEL in the Beds board drawer (spec §4.4, §4.9 A). Opens on an occupied bed: start a
 * transfer (rule-valid targets only, SBAR handover), swap with another patient, or change the billing class in place
 * (consent, effective at the next noon). Every act is the server's intent; the list here is a proposal and the act
 * re-checks every rule — a refusal shows its rule and, for a bed just taken, the next free beds that fit.
 */

const IN_PLACE_RANK: Partial<Record<IpdBedClass, number>> = { general: 1, semi_private: 2, private: 3, deluxe: 4, suite: 5 };
type Mode = null | "transfer" | "swap" | "class" | "cancel";

const istDay = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

export function TransferPanel(p: {
  admissionId: string; mayTransfer: boolean; mayClass: boolean; onDone: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<IpdTransferOptions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [pickBed, setPickBed] = useState<string | null>(null);

  const load = useCallback(() => {
    getTransferOptions(p.admissionId).then((o) => { setOpts(o); setLoadFailed(false); }, () => setLoadFailed(true));
  }, [p.admissionId]);
  useEffect(() => { load(); }, [load]);

  const run = <T,>(work: Promise<T>, done: (r: T) => string): void => {
    setBusy(true); setRefusal(null); setFailed(false); setOk(null);
    work.then(
      (r) => { setBusy(false); setMode(null); setOk(done(r)); load(); p.onDone(); },
      (e: unknown) => { setBusy(false); const r = refusalOf(e); if (r) setRefusal(r); else setFailed(true); },
    );
  };

  if (loadFailed) return <div className="ipdt-panel" role="alert">{t("ipdTransfer.panel.loadFailed")}</div>;
  if (opts === null) return <div className="ipdt-panel dim">{t("ipdTransfer.panel.loading")}</div>;

  const cls = (c: IpdBedClass): string => t(`ipdBeds.class.${c}`);
  const nextBeds = (refusal?.code === "bed_not_available" ? (refusal.detail?.nextBeds as { bedId: string; code: string }[] | undefined) : undefined) ?? [];

  return (
    <div className="ipdt-panel" data-testid="ipd-transfer-panel">
      <div className="ipdt-head">
        <b>{opts.patient.name ?? opts.patient.initials}</b>
        <span className="dim">{[opts.patient.ageSex, opts.patient.uhid, opts.admissionNo].filter(Boolean).join(" · ")}</span>
      </div>
      {opts.billedClass !== null ? (
        <span className="ipdt-line">
          {t("ipdTransfer.panel.billsAs", { cls: cls(opts.billedClass) })}
          {opts.pendingClassChange !== null ? ` · ${t("ipdTransfer.panel.pendingClass", { cls: cls(opts.pendingClassChange.toClass), time: fmtIst(opts.pendingClassChange.effectiveFrom) })}` : ""}
        </span>
      ) : null}

      {opts.openTransfer !== null ? (
        <div className="ipdt-waiting" role="status" data-testid="ipd-transfer-waiting">
          <span aria-hidden="true">⇢</span>
          <span>{t("ipdTransfer.panel.waitingAt", { bed: opts.openTransfer.toBedCode, time: fmtIst(opts.openTransfer.startedAt) })}</span>
          {p.mayTransfer && mode === null ? (
            <button type="button" className="ipdb-btn sm" onClick={() => setMode("cancel")}>{t("ipdTransfer.panel.cancelTransfer")}</button>
          ) : null}
        </div>
      ) : null}

      {mode === null && opts.state === "admitted" ? (
        <div className="row">
          {p.mayTransfer ? <button type="button" className="ipdb-btn sm" onClick={() => setMode("transfer")} data-testid="ipd-transfer-start">{t("ipdTransfer.panel.transfer")}</button> : null}
          {p.mayTransfer ? <button type="button" className="ipdb-btn sm" onClick={() => setMode("swap")}>{t("ipdTransfer.panel.swap")}</button> : null}
          {p.mayClass && opts.classes.length > 0 ? <button type="button" className="ipdb-btn sm" onClick={() => setMode("class")}>{t("ipdTransfer.panel.changeClass")}</button> : null}
        </div>
      ) : null}

      {mode === "transfer" ? (
        <TransferForm opts={opts} busy={busy} preset={pickBed} onCancel={() => { setMode(null); setPickBed(null); }}
          onSubmit={(b) => run(startTransfer({ admissionId: opts.admissionId, ...b }), () => t("ipdTransfer.done.started"))} />
      ) : null}
      {mode === "swap" ? (
        <SwapForm opts={opts} busy={busy} onCancel={() => setMode(null)}
          onSubmit={(other, reason) => run(swapBeds(opts.admissionId, other, reason), () => t("ipdTransfer.done.swapped"))} />
      ) : null}
      {mode === "class" ? (
        <ClassForm opts={opts} busy={busy} onCancel={() => setMode(null)}
          onSubmit={(b) => run(changeClass({ admissionId: opts.admissionId, ...b }), (r) => effectiveWords(r.effectiveFrom, t))} />
      ) : null}
      {mode === "cancel" && opts.openTransfer !== null ? (
        <CancelForm busy={busy} onCancel={() => setMode(null)}
          onSubmit={(reason) => run(cancelTransfer(opts.openTransfer!.transferId, reason), () => t("ipdTransfer.done.cancelled"))} />
      ) : null}

      {refusal !== null ? (
        <div className="ipdb-refusal" role="alert" data-testid="ipd-transfer-refusal">
          {refusal.bedRule ? <b>{refusal.bedRule}</b> : null}
          <span>{refusal.rule}</span>
          {nextBeds.length > 0 ? (
            <div className="row" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span className="dim" style={{ fontSize: 12 }}>{t("ipdTransfer.panel.nextBeds")}</span>
              {nextBeds.map((n) => (
                <button key={n.bedId} type="button" className="ipdb-btn sm" onClick={() => { setRefusal(null); setPickBed(n.bedId); setMode("transfer"); load(); }}>{n.code}</button>
              ))}
            </div>
          ) : (
            <div><button type="button" className="ipdb-btn sm" onClick={() => { setRefusal(null); load(); }}>{refusal.fix}</button></div>
          )}
        </div>
      ) : null}
      {failed ? <span role="alert" style={{ color: "var(--red)", fontSize: 13 }}>{t("ipdTransfer.panel.actFailed")}</span> : null}
      {ok !== null ? <span className="ipdb-ok" role="status">✓ {ok}</span> : null}
    </div>
  );
}

function effectiveWords(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const day = istDay(new Date(iso));
  const today = istDay(new Date());
  const tomorrow = istDay(new Date(Date.now() + 86_400_000));
  if (day === today) return t("ipdTransfer.panel.effectiveToday");
  if (day === tomorrow) return t("ipdTransfer.panel.effectiveTomorrow");
  return t("ipdTransfer.panel.effectiveOn", { time: fmtIst(iso) });
}

function TransferForm(p: {
  opts: IpdTransferOptions; busy: boolean; preset: string | null; onCancel: () => void;
  onSubmit: (b: { toBedId: string; reason: TransferReason; handover: { situation: string; background: string; assessment: string; recommendation: string } }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [bed, setBed] = useState<string>(p.preset ?? "");
  const [reason, setReason] = useState<TransferReason>("bed_management");
  const [sbar, setSbar] = useState({ situation: "", background: "", assessment: "", recommendation: "" });
  const ready = bed !== "" && Object.values(sbar).every((v) => v.trim() !== "");
  if (p.opts.targets.length === 0) {
    return (
      <div className="ipdt-form">
        <span className="dim">{t("ipdTransfer.panel.noTargets")}</span>
        <div><button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button></div>
      </div>
    );
  }
  return (
    <form className="ipdt-form" onSubmit={(e) => {
      e.preventDefault();
      if (!ready) return;
      p.onSubmit({ toBedId: bed, reason, handover: {
        situation: sbar.situation.trim(), background: sbar.background.trim(), assessment: sbar.assessment.trim(), recommendation: sbar.recommendation.trim(),
      } });
    }}>
      <fieldset className="ipdt-targets">
        <legend>{t("ipdTransfer.panel.targetsLabel")}</legend>
        {p.opts.targets.map((b) => (
          <label key={b.bedId} className={`ipdt-target${bed === b.bedId ? " on" : ""}`}>
            <input type="radio" name="target" value={b.bedId} checked={bed === b.bedId} onChange={() => setBed(b.bedId)} />
            <span className="mono">{b.code}</span>
            <span>{t(`ipdBeds.class.${b.class}`)}{b.wardName ? ` · ${b.wardName}` : ""}</span>
            <span className="dim">{b.reasons.join(" · ")}</span>
          </label>
        ))}
      </fieldset>
      <label>{t("ipdTransfer.panel.reasonLabel")}
        <select value={reason} onChange={(e) => setReason(e.target.value as TransferReason)}>
          {TRANSFER_REASONS.map((r) => <option key={r} value={r}>{t(`ipdTransfer.reason.${r}`)}</option>)}
        </select>
      </label>
      {(["situation", "background", "assessment", "recommendation"] as const).map((k) => (
        <label key={k}>{t(`ipdTransfer.sbar.${k}`)}
          <textarea rows={2} maxLength={1000} value={sbar[k]} onChange={(e) => setSbar({ ...sbar, [k]: e.target.value })} />
        </label>
      ))}
      <div className="ipdt-actions">
        <button type="submit" className="ipdb-btn sm pri" disabled={!ready || p.busy}>{t("ipdTransfer.panel.start")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}

function SwapForm(p: { opts: IpdTransferOptions; busy: boolean; onCancel: () => void; onSubmit: (other: string, reason: SwapReason) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [other, setOther] = useState("");
  const [reason, setReason] = useState<SwapReason>("gender_fix");
  if (p.opts.swapWith.length === 0) {
    return (
      <div className="ipdt-form">
        <span className="dim">{t("ipdTransfer.panel.noSwap")}</span>
        <div><button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button></div>
      </div>
    );
  }
  return (
    <form className="ipdt-form" onSubmit={(e) => { e.preventDefault(); if (other !== "") p.onSubmit(other, reason); }}>
      <label>{t("ipdTransfer.panel.swapWith")}
        <select value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">{t("ipdTransfer.panel.pick")}</option>
          {p.opts.swapWith.map((s) => (
            <option key={s.admissionId} value={s.admissionId}>{`${s.bedCode} · ${s.initials} · ${t(`ipdBeds.class.${s.class}`)}${s.wardName ? ` · ${s.wardName}` : ""}`}</option>
          ))}
        </select>
      </label>
      <label>{t("ipdTransfer.panel.reasonLabel")}
        <select value={reason} onChange={(e) => setReason(e.target.value as SwapReason)}>
          {SWAP_REASONS.map((r) => <option key={r} value={r}>{t(`ipdTransfer.swapReason.${r}`)}</option>)}
        </select>
      </label>
      <span className="dim" style={{ fontSize: 12 }}>{t("ipdTransfer.panel.swapNote")}</span>
      <div className="ipdt-actions">
        <button type="submit" className="ipdb-btn sm pri" disabled={other === "" || p.busy}>{t("ipdTransfer.panel.doSwap")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}

function ClassForm(p: {
  opts: IpdTransferOptions; busy: boolean; onCancel: () => void;
  onSubmit: (b: { toClass: IpdBedClass; consent: ClassConsent; roomRentCapAcknowledged: boolean }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [toClass, setToClass] = useState<IpdBedClass>(p.opts.classes[0]!);
  const [signedBy, setSignedBy] = useState<ClassConsent["signedBy"]>("patient");
  const [signerName, setSignerName] = useState("");
  const [relation, setRelation] = useState("");
  const [method, setMethod] = useState<"paper" | "tablet_signature">("paper");
  const [witnessName, setWitnessName] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [why, setWhy] = useState("");
  const [cap, setCap] = useState(false);
  const from = p.opts.pendingClassChange?.toClass ?? p.opts.billedClass ?? "general";
  const upgrade = (IN_PLACE_RANK[toClass] ?? 0) > (IN_PLACE_RANK[from] ?? 0);
  const ready = (signedBy === "patient" || (signerName.trim() !== "" && relation.trim() !== ""))
    && (signedBy !== "representative" || why.trim() !== "")
    && (method === "paper" ? witnessName.trim() !== "" : documentId.trim() !== "")
    && (!upgrade || cap);
  return (
    <form className="ipdt-form" onSubmit={(e) => {
      e.preventDefault();
      if (!ready) return;
      const consent: ClassConsent = { signedBy, method };
      if (signedBy !== "patient") { consent.signerName = signerName.trim(); consent.relation = relation.trim(); }
      if (signedBy === "representative") consent.representativeReason = why.trim();
      if (method === "paper") consent.witnessName = witnessName.trim(); else consent.documentId = documentId.trim();
      p.onSubmit({ toClass, consent, roomRentCapAcknowledged: cap });
    }}>
      <label>{t("ipdTransfer.panel.toClass")}
        <select value={toClass} onChange={(e) => setToClass(e.target.value as IpdBedClass)}>
          {p.opts.classes.map((c) => <option key={c} value={c}>{t(`ipdBeds.class.${c}`)}</option>)}
        </select>
      </label>
      <span className="dim" style={{ fontSize: 12 }}>{upgrade ? t("ipdTransfer.panel.upgradeNote") : t("ipdTransfer.panel.downgradeNote")}</span>
      <label>{t("ipdTransfer.panel.signedBy")}
        <select value={signedBy} onChange={(e) => setSignedBy(e.target.value as ClassConsent["signedBy"])}>
          {(["patient", "guardian", "representative"] as const).map((s) => <option key={s} value={s}>{t(`ipdTransfer.signer.${s}`)}</option>)}
        </select>
      </label>
      {signedBy !== "patient" ? (
        <div className="ipdt-pair">
          <label>{t("ipdTransfer.panel.signerName")}<input value={signerName} onChange={(e) => setSignerName(e.target.value)} maxLength={120} /></label>
          <label>{t("ipdTransfer.panel.relation")}<input value={relation} onChange={(e) => setRelation(e.target.value)} maxLength={40} /></label>
        </div>
      ) : null}
      {signedBy === "representative" ? (
        <label>{t("ipdTransfer.panel.representativeReason")}<input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} /></label>
      ) : null}
      <label>{t("ipdTransfer.panel.method")}
        <select value={method} onChange={(e) => setMethod(e.target.value as "paper" | "tablet_signature")}>
          <option value="paper">{t("ipdTransfer.panel.methodPaper")}</option>
          <option value="tablet_signature">{t("ipdTransfer.panel.methodDocument")}</option>
        </select>
      </label>
      {method === "paper" ? (
        <label>{t("ipdTransfer.panel.witnessName")}<input value={witnessName} onChange={(e) => setWitnessName(e.target.value)} maxLength={120} /></label>
      ) : (
        <label>{t("ipdTransfer.panel.documentId")}<input value={documentId} onChange={(e) => setDocumentId(e.target.value)} /></label>
      )}
      {upgrade ? (
        <label className="ipdt-check"><input type="checkbox" checked={cap} onChange={(e) => setCap(e.target.checked)} />{t("ipdTransfer.panel.capAck")}</label>
      ) : null}
      <div className="ipdt-actions">
        <button type="submit" className="ipdb-btn sm pri" disabled={!ready || p.busy}>{t("ipdTransfer.panel.applyClass")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}

function CancelForm(p: { busy: boolean; onCancel: () => void; onSubmit: (r: CancelReason) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState<CancelReason>("patient_deteriorated");
  return (
    <form className="ipdt-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit(reason); }}>
      <label>{t("ipdTransfer.panel.reasonLabel")}
        <select value={reason} onChange={(e) => setReason(e.target.value as CancelReason)}>
          {CANCEL_REASONS.map((r) => <option key={r} value={r}>{t(`ipdTransfer.cancelReason.${r}`)}</option>)}
        </select>
      </label>
      <div className="ipdt-actions">
        <button type="submit" className="ipdb-btn sm pri" disabled={p.busy}>{t("ipdTransfer.panel.cancelTransfer")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}
