import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAttendantMessages, recordAttendantConsent, stopAttendantMessages } from "../lib/ipd-attendant-api";
import type React from "react";
import type { IpdAttendantMessages } from "@hmis/contracts";

/*
 * #761 — THE DAILY TOTALS MESSAGE, ON THE INTERIM BILL. Who the day's totals go to (the registered attendant, phone masked —
 * no number is typed here), what happens to tomorrow's message in words ("Not sent: template not configured", "Not sent: no
 * consent recorded", …), the last day's line, and the two acts on the attendant's word: Record consent, Stop messages
 * (`ipd.family.issue`). A reader without that permission sees the card and no buttons.
 */

const RELATIONS = ["spouse", "parent", "child", "sibling", "relative", "guardian", "self", "other"] as const;

export function AttendantMessagesCard({ admissionId }: { admissionId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [card, setCard] = useState<IpdAttendantMessages | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [by, setBy] = useState("");
  const [relation, setRelation] = useState<(typeof RELATIONS)[number]>("spouse");
  const [method, setMethod] = useState<"verbal" | "paper">("verbal");

  useEffect(() => {
    let live = true;
    getAttendantMessages(admissionId).then((c) => { if (live) setCard(c); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [admissionId]);

  if (failed) return null;
  if (card === null) return null;

  const act = (p: Promise<IpdAttendantMessages>): void => {
    setBusy(true);
    setError(null);
    p.then((c) => setCard(c), () => setError(t("ipdAttendant.actFailed"))).finally(() => setBusy(false));
  };
  const hot = card.state !== "will_send";

  return (
    <section className="ipdb-card ipdam" aria-label={t("ipdAttendant.label")}>
      <h2>{t("ipdAttendant.title")}</h2>
      <p className={`ipdam-state ${hot ? "warn" : "ok"}`}>{card.words}</p>
      <div className="row small">
        <span className="dim">{t("ipdAttendant.to")}</span>
        <span>{card.attendant === null ? "—" : <><span className="mono">{card.attendant.phoneMasked}</span> · {t(`ipdAttendant.kind.${card.attendant.kind}`)}</>}</span>
      </div>
      <div className="row small">
        <span className="dim">{t("ipdAttendant.consent")}</span>
        <span>
          {card.consent !== null ? `${card.consent.consentedBy} · ${card.consent.relation} · ${card.consent.method}`
            : card.viaFamilyLink ? t("ipdAttendant.viaFamilyLink") : "—"}
        </span>
      </div>
      {card.last === null ? null : (
        <div className="row small"><span className="dim">{t("ipdAttendant.last", { date: card.last.billDate })}</span><span>{card.last.words}</span></div>
      )}
      {error === null ? null : <p role="alert" className="ipdb-error small">{error}</p>}
      {!card.canManage || card.attendant === null ? null : (
        <div className="ipdam-acts">
          {card.consent === null || card.stoppedAt !== null || card.state === "number_changed" ? (
            <form onSubmit={(e) => { e.preventDefault(); act(recordAttendantConsent(admissionId, { consent: { consentedBy: by.trim(), relation, method } })); }}>
              <label>{t("ipdAttendant.consentedBy")}<input value={by} onChange={(e) => setBy(e.target.value)} minLength={2} maxLength={120} required /></label>
              <label>{t("ipdAttendant.relation")}
                <select value={relation} onChange={(e) => setRelation(e.target.value as (typeof RELATIONS)[number])}>
                  {RELATIONS.map((r) => <option key={r} value={r}>{t(`ipdAttendant.rel.${r}`)}</option>)}
                </select>
              </label>
              <label>{t("ipdAttendant.method")}
                <select value={method} onChange={(e) => setMethod(e.target.value as "verbal" | "paper")}>
                  <option value="verbal">{t("ipdAttendant.verbal")}</option>
                  <option value="paper">{t("ipdAttendant.paper")}</option>
                </select>
              </label>
              <button type="submit" className="ipdb-btn" disabled={busy || by.trim().length < 2}>{t("ipdAttendant.record")}</button>
            </form>
          ) : null}
          {card.stoppedAt === null ? (
            <button type="button" className="ipdb-btn" disabled={busy} onClick={() => act(stopAttendantMessages(admissionId))}>{t("ipdAttendant.stop")}</button>
          ) : null}
        </div>
      )}
    </section>
  );
}
