import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdConditionWord, IpdFamilyLinkIssued, IpdFamilyPanel } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import {
  closeFamilyCallback, getFamilyPanel, issueFamilyLink, revokeFamilyLink, setCondition,
} from "../lib/ipd-family-api";
import type { FamilyOffReason, FamilyRelation } from "../lib/ipd-family-api";
import "./ipd-family-desk.css";

/*
 * E3.3 (#731) — THE FAMILY CARD on the discharge desk's admission view (staff side of board G). The doctor sets the
 * condition word the family sees (and can turn the link off for a sensitive admission); the desk records the consent and
 * issues the attendant's link — shown once as a QR and a copyable address, never stored in the clear — or revokes it;
 * the family's callback requests for this admission are listed with "Called back". Only what the server's `can` allows.
 */

const WORDS: IpdConditionWord[] = ["stable", "improving", "serious", "critical"];
const RELATIONS: FamilyRelation[] = ["self", "spouse", "parent", "child", "sibling", "relative", "guardian", "other"];
const OFF: FamilyOffReason[] = ["psychiatric", "hiv", "mtp", "pocso", "patient_request", "other"];

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return String((e.body as { message?: string } | null)?.message ?? `HTTP ${String(e.status)}`);
  return "failed";
}

export function FamilyCard({ admissionId }: { admissionId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [p, setP] = useState<IpdFamilyPanel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IpdFamilyLinkIssued | null>(null);
  const [who, setWho] = useState("");
  const [relation, setRelation] = useState<FamilyRelation>("spouse");
  const [method, setMethod] = useState<"verbal" | "paper">("verbal");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const reload = useCallback(() => {
    // A reply without the panel's shape (an older server) hides the card rather than breaking the discharge view.
    getFamilyPanel(admissionId).then((x) => { if (typeof x === "object" && x !== null && "condition" in x && "can" in x) setP(x); else setHidden(true); }, (e: unknown) => { if (e instanceof ApiError && e.status === 403) setHidden(true); else setErr(messageOf(e)); });
  }, [admissionId]);
  useEffect(() => { reload(); }, [reload]);
  if (hidden || p === null) return null;
  const run = (work: Promise<unknown>, then?: (x: unknown) => void) => {
    setBusy(true); setErr(null);
    work.then((x) => { setBusy(false); then?.(x); reload(); }, (e: unknown) => { setBusy(false); setErr(messageOf(e)); });
  };
  const url = issued === null ? null : `${window.location.origin}${issued.path}`;
  return (
    <article className="ipdd-card ipdf" data-testid="family-card">
      <h2>{t("ipdFamilyDesk.title")}</h2>

      <div className="row">
        <span className="dim">{t("ipdFamilyDesk.condition")}</span>
        <b data-testid="family-condition">{p.condition.word === null ? t("ipdFamilyDesk.notSet") : t(`ipdFamilyDesk.word.${p.condition.word}`)}</b>
        {p.condition.setAt !== null ? <span className="dim">{t("ipdFamilyDesk.setBy", { name: p.condition.setBy ?? "", time: fmtIst(p.condition.setAt) })}</span> : null}
      </div>
      {p.can.setCondition ? (
        <div className="row" role="group" aria-label={t("ipdFamilyDesk.setCondition")}>
          {WORDS.map((w) => (
            <button key={w} type="button" className={`ipdd-btn${p.condition.word === w ? " pri" : ""}`} aria-pressed={p.condition.word === w} disabled={busy}
              onClick={() => run(setCondition(admissionId, w))}>{t(`ipdFamilyDesk.word.${w}`)}</button>
          ))}
          <select aria-label={t("ipdFamilyDesk.familyOff")} value={p.familyOff ?? ""} disabled={busy}
            onChange={(e) => run(setCondition(admissionId, p.condition.word, e.target.value === "" ? null : (e.target.value as FamilyOffReason)))}>
            <option value="">{t("ipdFamilyDesk.linkOn")}</option>
            {OFF.map((o) => <option key={o} value={o}>{t("ipdFamilyDesk.offFor", { reason: t(`ipdFamilyDesk.off.${o}`) })}</option>)}
          </select>
        </div>
      ) : null}

      <div className="row">
        <span className="dim">{t("ipdFamilyDesk.link")}</span>
        {p.link?.status === "active" ? (
          <span data-testid="family-link-status">{t("ipdFamilyDesk.active", { phone: p.link.phoneMasked, time: fmtIst(p.link.issuedAt) })}</span>
        ) : p.blocked !== null ? (
          <span className="warn" data-testid="family-link-status">{t(`ipdFamilyDesk.blocked.${p.blocked}`)}</span>
        ) : (
          <span data-testid="family-link-status">{t("ipdFamilyDesk.none", { phone: p.attendantPhoneMasked ?? "" })}</span>
        )}
        {p.can.revoke && p.link !== null ? (
          <button type="button" className="ipdd-btn" disabled={busy} onClick={() => run(revokeFamilyLink(p.link!.id), () => setIssued(null))}>{t("ipdFamilyDesk.revoke")}</button>
        ) : null}
      </div>

      {url !== null ? (
        <div className="ipdf-issued" data-testid="family-issued">
          <QRCodeSVG value={url} size={132} />
          <div className="col">
            <span>{t("ipdFamilyDesk.handOver", { phone: issued!.phoneMasked })}</span>
            <code className="url">{url}</code>
            <button type="button" className="ipdd-btn" onClick={() => { void navigator.clipboard?.writeText(url); }}>{t("ipdFamilyDesk.copy")}</button>
          </div>
        </div>
      ) : null}

      {p.can.issue ? (
        <form className="ipdf-issue" onSubmit={(e) => { e.preventDefault(); if (who.trim().length < 2) return; run(issueFamilyLink(admissionId, { consentedBy: who.trim(), relation, method }), (x) => setIssued(x as IpdFamilyLinkIssued)); }}>
          <span className="dim">{t("ipdFamilyDesk.consent")}</span>
          <div className="row">
            <input value={who} onChange={(e) => setWho(e.target.value)} placeholder={t("ipdFamilyDesk.consentedBy")} aria-label={t("ipdFamilyDesk.consentedBy")} />
            <select value={relation} onChange={(e) => setRelation(e.target.value as FamilyRelation)} aria-label={t("ipdFamilyDesk.relation")}>
              {RELATIONS.map((r) => <option key={r} value={r}>{t(`ipdFamilyDesk.rel.${r}`)}</option>)}
            </select>
            <select value={method} onChange={(e) => setMethod(e.target.value as "verbal" | "paper")} aria-label={t("ipdFamilyDesk.method")}>
              <option value="verbal">{t("ipdFamilyDesk.verbal")}</option>
              <option value="paper">{t("ipdFamilyDesk.paper")}</option>
            </select>
            <button type="submit" className="ipdd-btn pri" disabled={busy || who.trim().length < 2}>{p.link?.status === "active" ? t("ipdFamilyDesk.reissue") : t("ipdFamilyDesk.issue")}</button>
          </div>
          <span className="dim small">{t("ipdFamilyDesk.purpose")}</span>
        </form>
      ) : null}

      {p.callbacks.length > 0 ? (
        <div className="ipdf-calls">
          <span className="dim">{t("ipdFamilyDesk.calls")}</span>
          {p.callbacks.map((c) => (
            <div key={c.id} className={`ipdf-call ${c.status}`}>
              <span className="mono">{fmtIst(c.createdAt)} · {c.phoneMasked}</span>
              <q>{c.text}</q>
              {c.status === "open" && p.can.closeCallback ? (
                <div className="row">
                  <input value={notes[c.id] ?? ""} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} placeholder={t("ipdFamilyDesk.callNote")} aria-label={t("ipdFamilyDesk.callNote")} />
                  <button type="button" className="ipdd-btn" disabled={busy || (notes[c.id] ?? "").trim() === ""} onClick={() => run(closeFamilyCallback(c.id, (notes[c.id] ?? "").trim()))}>{t("ipdFamilyDesk.calledBack")}</button>
                </div>
              ) : c.status === "done" ? <span className="dim">✓ {t("ipdFamilyDesk.closedBy", { name: c.closedBy ?? "", note: c.note ?? "" })}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {err !== null ? <div className="ipdd-refusal" role="alert">{err}</div> : null}
    </article>
  );
}
