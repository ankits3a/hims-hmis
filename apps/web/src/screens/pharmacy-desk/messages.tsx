import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { fetchPatientMessages, recordPatientMessages } from "../../lib/messages-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import type { MessageChange, WireBillMessageState, WirePatientMessages } from "../../lib/messages-api";

const IST = { timeZone: "Asia/Kolkata" } as const;
const when = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { ...IST, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const clock = (iso: string): string => new Intl.DateTimeFormat("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/**
 * ═══ PHARMACY P6 (patient messages) — THE CONSENT CHIP ON THE LEFT RAIL ═══
 *
 * One tap, after asking. The bill needs no consent (it is the receipt of what they just paid); the refill
 * reminder needs the patient's yes, and the chip records who asked and when. "Stop all messages" is the
 * DPDP withdrawal — as easy as the yes, and it stops every department's messages, not only ours. Read by
 * everybody at the desk; recorded only under `pharmacy.messages.consent`.
 */
export function MessagesChip({ dispenseId }: { dispenseId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const key = ["pharmacy", "messages", dispenseId];
  const q = useQuery({ queryKey: key, queryFn: () => fetchPatientMessages(dispenseId), staleTime: 60_000, retry: false });
  const m = useMutation({
    mutationFn: (change: MessageChange) => recordPatientMessages(dispenseId, change),
    onSuccess: (view) => { qc.setQueryData<WirePatientMessages>(key, view); },
  });
  const d = q.data;
  if (d === undefined) return null;
  const mayRecord = can("pharmacy.messages.consent");
  const wa = d.channel === "whatsapp";
  const busy = m.isPending;
  const tap = (change: MessageChange): void => { if (mayRecord && !busy) m.mutate(change); };

  return (
    <div data-testid="desk-messages" style={{ marginTop: 18 }}>
      <div className="tag">{t("pharmacyDesk.messages.title")}</div>
      {!d.hasPhone ? (
        <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "var(--dim)" }} data-testid="desk-messages-nophone">{t("pharmacyDesk.messages.noPhone")}</p>
      ) : d.stopped !== null ? (
        <div style={{ marginTop: 7 }}>
          <span className="pill gd" data-testid="desk-messages-stopped">{t("pharmacyDesk.messages.stoppedPill")}</span>
          <p style={{ margin: "5px 0 0 0", fontSize: 11.5, lineHeight: "16px", color: "var(--dim)" }}>
            {t("pharmacyDesk.messages.stoppedBy", { when: when(d.stopped.at), who: d.stopped.byName ?? "—" })}
          </p>
          {mayRecord ? (
            <button className="sec" style={{ marginTop: 6, height: 26, fontSize: 12 }} data-testid="desk-messages-resume" disabled={busy} onClick={() => tap({ change: "resume" })}>
              {t("pharmacyDesk.messages.resume")}
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 7 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {d.refillReminders ? (
              <>
                <span className="pill on" data-testid="desk-reminders-on">{t(wa ? "pharmacyDesk.messages.remindersOnWa" : "pharmacyDesk.messages.remindersOn")}</span>
                {mayRecord ? (
                  <button style={{ fontSize: 11.5, color: "var(--dim)", textDecoration: "underline" }} data-testid="desk-reminders-off" disabled={busy} onClick={() => tap({ change: "reminders_off" })}>
                    {t("pharmacyDesk.messages.turnOff")}
                  </button>
                ) : null}
              </>
            ) : (
              <button className="pill" data-testid="desk-reminders-turn-on" disabled={!mayRecord || busy} onClick={() => tap({ change: "reminders_on" })}
                title={t("pharmacyDesk.messages.askFirst")}>
                {t(wa ? "pharmacyDesk.messages.remindersOffWa" : "pharmacyDesk.messages.remindersOff")}
              </button>
            )}
          </div>
          {d.refillReminders && d.remindersConsent !== null ? (
            <p style={{ margin: "5px 0 0 0", fontSize: 11, color: "var(--faint)" }} data-testid="desk-reminders-consent">
              {t("pharmacyDesk.messages.consentBy", { when: when(d.remindersConsent.at), who: d.remindersConsent.byName ?? "—" })}
            </p>
          ) : mayRecord ? (
            <p style={{ margin: "5px 0 0 0", fontSize: 11, lineHeight: "15px", color: "var(--faint)" }}>{t("pharmacyDesk.messages.askFirst")}</p>
          ) : null}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }} data-testid="desk-messages-language">
            <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.messages.language")}</span>
            {(["hi", "en"] as const).map((lang) => (
              <button key={lang} className={d.language === lang ? "pill on" : "pill"} aria-pressed={d.language === lang}
                data-testid={`desk-messages-lang-${lang}`} disabled={!mayRecord || busy || d.language === lang}
                onClick={() => tap({ change: "language", language: lang })}>
                {t(`pharmacyDesk.messages.${lang}`)}
              </button>
            ))}
          </div>
          {mayRecord ? (
            <button style={{ marginTop: 8, fontSize: 11.5, color: "var(--dim)", textDecoration: "underline" }} data-testid="desk-messages-stop" disabled={busy} onClick={() => tap({ change: "stop" })}>
              {t("pharmacyDesk.messages.stop")}
            </button>
          ) : (
            <p style={{ margin: "6px 0 0 0", fontSize: 11, color: "var(--faint)" }}>{t("pharmacyDesk.messages.readOnly")}</p>
          )}
        </div>
      )}
      {m.error !== null ? <p role="alert" style={{ margin: "6px 0 0 0", fontSize: 11.5, color: "var(--red)" }}>{pharmacyErrorText(m.error, t)}</p> : null}
    </div>
  );
}

/** States the hand-over keeps asking about — the message is still on its way. */
const MOVING: readonly WireBillMessageState[] = ["pending", "queued", "sending"];

/**
 * THE HAND-OVER'S QUIET LINE — where the bill's message is. The consumer queues it a few seconds after
 * the hand-over, so the line asks again every few seconds while it is still moving, and stops.
 */
export function BillMessageLine({ dispenseId }: { dispenseId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["pharmacy", "messages", dispenseId],
    queryFn: () => fetchPatientMessages(dispenseId),
    retry: false,
    refetchInterval: (query) => (query.state.data !== undefined && MOVING.includes(query.state.data.bill.state) ? 4_000 : false),
  });
  const b = q.data?.bill;
  if (b === undefined || b.state === "not_yet") return null;
  const key = b.state === "sent" ? `sent_${b.channel === "whatsapp" ? "whatsapp" : "sms"}` : b.state;
  return (
    <p data-testid="desk-bill-message" data-state={b.state} style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>
      {t(`pharmacyDesk.messages.bill.${key}`, { time: b.at === null ? "08:00" : clock(b.at) })}
    </p>
  );
}
