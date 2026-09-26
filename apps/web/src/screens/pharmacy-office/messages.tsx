import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchMessagesOffice, recordMessagesContact, recordTemplateIds } from "../../lib/messages-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WireMessagesOffice } from "../../lib/messages-api";

/**
 * ═══ PHARMACY P6 (patient messages) — THE OFFICE'S MESSAGES SIDE (`?view=messages`) ═══
 *
 * What stands between this hospital and a message on a patient's phone, in the order to do it: the
 * provider (the owner's procurement — shown here, set in the environment), the two messages' exact text to
 * register on the DLT portal with a `{#var#}` in each variable's place, the ids the portals issue, and the
 * pharmacy's phone the reminder names. Below it, what the last thirty days sent, and how many patients have
 * said yes to reminders or asked for no messages at all.
 */
export function MessagesView(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pharmacy", "office", "messages"], queryFn: fetchMessagesOffice });
  const [notice, setNotice] = useState<string | null>(null);
  const put = (d: WireMessagesOffice): void => { qc.setQueryData(["pharmacy", "office", "messages"], d); setNotice(t("pharmacyOffice.messages.saved")); };
  const d = q.data;
  const live = d === undefined ? [] : [...(d.provider.sms ? ["SMS"] : []), ...(d.provider.whatsapp ? ["WhatsApp"] : [])];

  return (
    <div className="space-y-5" data-testid="messages-view">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {d !== undefined && (
        <>
          <section
            className={`rounded border p-3 ${live.length === 0 ? "border-amber-400 bg-amber-50/60" : "border-emerald-700/40 bg-emerald-50/40"}`}
            data-testid="messages-provider" data-live={live.length > 0 ? "yes" : "no"}
          >
            <div className="text-sm font-medium">
              {live.length === 0 ? t("pharmacyOffice.messages.providerOff") : t("pharmacyOffice.messages.providerOn", { channels: live.join(" · ") })}
            </div>
          </section>

          <section className="rounded border p-3" data-testid="messages-needs">
            <div className="text-sm font-medium">
              {d.needs.length === 0 ? t("pharmacyOffice.messages.allClear") : t("pharmacyOffice.messages.needsTitle", { count: d.needs.length })}
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {d.needs.map((n) => <li key={n} data-testid={`messages-need-${n}`}>• {t(`pharmacyOffice.messages.needs.${n}`)}</li>)}
            </ul>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("pharmacyOffice.messages.counts")}</h2>
            <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8" data-testid="messages-counts">
              {(["sent", "loggedOnly", "queued", "failed", "suppressed", "expired"] as const).map((k) => (
                <div key={k} className="rounded border p-2" data-testid={`messages-count-${k}`}>
                  <div className="text-xl font-semibold tabular-nums">{d.counts[k]}</div>
                  <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.messages.count.${k}`)}</div>
                </div>
              ))}
              <div className="rounded border p-2" data-testid="messages-reminders-on">
                <div className="text-xl font-semibold tabular-nums">{d.patients.remindersOn}</div>
                <div className="text-xs text-muted-foreground">{t("pharmacyOffice.messages.remindersOn")}</div>
              </div>
              <div className="rounded border p-2" data-testid="messages-stopped">
                <div className="text-xl font-semibold tabular-nums">{d.patients.stopped}</div>
                <div className="text-xs text-muted-foreground">{t("pharmacyOffice.messages.stopped")}</div>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("pharmacyOffice.messages.templates")}</h2>
            {d.templates.map((tpl) => <TemplateCard key={tpl.key} tpl={tpl} whatsappLive={d.provider.whatsapp} onSaved={put} />)}
            <p className="text-xs text-muted-foreground">{t("pharmacyOffice.messages.namesOff")}</p>
          </section>

          <ContactCard current={d.contactPhone} onSaved={put} />
        </>
      )}
    </div>
  );
}

function TemplateCard({ tpl, whatsappLive, onSaved }: {
  tpl: WireMessagesOffice["templates"][number]; whatsappLive: boolean; onSaved: (d: WireMessagesOffice) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [dlt, setDlt] = useState(tpl.dltTemplateId ?? "");
  const [wa, setWa] = useState(tpl.whatsappTemplateName ?? "");
  const m = useMutation({
    mutationFn: () => recordTemplateIds({ templateKey: tpl.key, dltTemplateId: dlt.trim() === "" ? null : dlt.trim(), whatsappTemplateName: wa.trim() === "" ? null : wa.trim() }),
    onSuccess: onSaved,
  });
  return (
    <div className={`rounded border p-3 ${tpl.dltTemplateId === null ? "border-amber-400" : ""}`} data-testid={`messages-template-${tpl.key}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{t(`pharmacyOffice.messages.purpose.${tpl.purpose}`)}</span>
        <span className="font-mono text-xs text-muted-foreground">{tpl.key}</span>
        <span className="ml-auto text-xs text-muted-foreground">{t("pharmacyOffice.messages.variables", { count: tpl.variables })}</span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{t("pharmacyOffice.messages.dltText")}</div>
      <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-testid={`messages-text-en-${tpl.key}`}>{tpl.text.en}</pre>
      <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-testid={`messages-text-hi-${tpl.key}`}>{tpl.text.hi}</pre>
      <form className="mt-2 grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <label className="text-sm">{t("pharmacyOffice.messages.dltId")}
          <Input data-testid={`messages-dlt-${tpl.key}`} inputMode="numeric" autoComplete="off" placeholder={t("pharmacyOffice.messages.notRecorded")} value={dlt} onChange={(e) => setDlt(e.target.value)} />
        </label>
        <label className="text-sm">{t("pharmacyOffice.messages.waName")}{whatsappLive && tpl.whatsappTemplateName === null ? " *" : ""}
          <Input data-testid={`messages-wa-${tpl.key}`} autoComplete="off" placeholder={t("pharmacyOffice.messages.notRecorded")} value={wa} onChange={(e) => setWa(e.target.value)} />
        </label>
        <Button type="submit" data-testid={`messages-save-${tpl.key}`} disabled={m.isPending}>{t("pharmacyOffice.messages.save")}</Button>
      </form>
      {m.error !== null && <p role="alert" className="mt-1 text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
    </div>
  );
}

function ContactCard({ current, onSaved }: { current: string | null; onSaved: (d: WireMessagesOffice) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [phone, setPhone] = useState(current ?? "");
  const m = useMutation({ mutationFn: () => recordMessagesContact(phone), onSuccess: onSaved });
  return (
    <section className={`rounded border p-3 ${current === null ? "border-amber-400" : ""}`} data-testid="messages-contact">
      <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <label className="text-sm">{t("pharmacyOffice.messages.contact")}
          <Input data-testid="messages-contact-phone" inputMode="tel" autoComplete="off" placeholder={t("pharmacyOffice.messages.notRecorded")} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <span className="text-xs text-muted-foreground">{t("pharmacyOffice.messages.contactHint")}</span>
        </label>
        <Button type="submit" data-testid="messages-contact-save" disabled={m.isPending || phone.trim() === ""}>{t("pharmacyOffice.messages.save")}</Button>
      </form>
      {m.error !== null && <p role="alert" className="mt-1 text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
    </section>
  );
}
