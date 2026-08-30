import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { duplicateWarnings, labErrorText, placeLabOrder, searchOrderables } from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import type { WireDeskOrder, WireDuplicateWarning, WireOrderable } from "../lib/lab-api";

/**
 * PLAN 17b T8 — **THE LAB DESK**: what a doctor advised becomes an order and an invoice.
 *
 * ═══ THE DUPLICATE WARNING IS SHOWN BEFORE THE ORDER IS SENT, NOT AFTER IT IS REFUSED ═══
 *
 * `deskOrder` refuses the WHOLE order when the detector finds something the clerk did not
 * acknowledge (`duplicate_unacknowledged`), and it refuses it whole on purpose — "place the two you
 * did not query and drop the third" is a basket the counter never saw. So the screen asks first, the
 * clerk reads what was already ordered and when, and acknowledges it deliberately. A screen that met
 * the refusal instead would train a clerk to re-send with every id ticked, which is the warning
 * turned into a keystroke.
 *
 * ═══ CONSENT IS A NAME, NOT A CHECKBOX (DD14 / 02 E1) ═══
 *
 * A `consent_required` orderable — HIV, and the NACO/ICTC class with it — takes the name of the
 * person who recorded the consent. A tick would record that somebody clicked; a name records who
 * is answerable, and the server refuses the order without it.
 *
 * ═══ THE IDEMPOTENCY KEY IS MINTED ONCE PER ATTEMPT ═══
 *
 * `newIdempotencyKey()` at the moment the clerk presses the button, reused for a retry of the SAME
 * attempt. A reload, a second tab or a duplicated request on a flaky counter uplink replays the
 * original order rather than placing a second one (DD19).
 */
export function LabDesk(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [patientId, setPatientId] = useState("");
  const [encounterNo, setEncounterNo] = useState("");
  const [serviceDate, setServiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [clinicianId, setClinicianId] = useState("");
  const [query, setQuery] = useState("");
  const [basket, setBasket] = useState<WireOrderable[]>([]);
  const [consents, setConsents] = useState<Record<string, string>>({});
  const [reflexConsent, setReflexConsent] = useState(false);
  const [priority, setPriority] = useState<"routine" | "urgent" | "stat">("routine");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<WireDuplicateWarning[] | null>(null);
  const [placed, setPlaced] = useState<WireDeskOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalogue = useQuery({
    queryKey: ["lab", "catalogue", query],
    queryFn: () => searchOrderables(query),
  });

  const check = useMutation({
    mutationFn: () => duplicateWarnings(patientId, basket.map((b) => b.serviceId)),
    onSuccess: (found) => { setWarnings(found); setError(null); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const place = useMutation({
    mutationFn: () => placeLabOrder({
      patientId, encounterNo, serviceDate, orderingClinicianId: clinicianId, priority,
      reflexConsent,
      acknowledgedDuplicates: acknowledged,
      items: basket.map((b) => (
        b.consentRequired && consents[b.serviceId]
          ? { serviceId: b.serviceId, consent: { recordedBy: consents[b.serviceId]! } }
          : { serviceId: b.serviceId }
      )),
      credit: { reason: t("lab.desk.creditReason") },
    }, newIdempotencyKey()),
    onSuccess: (order) => {
      setPlaced(order);
      setError(null);
      setBasket([]);
      setWarnings(null);
      setAcknowledged([]);
      void qc.invalidateQueries({ queryKey: ["lab"] });
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const missingConsent = basket.filter((b) => b.consentRequired && !consents[b.serviceId]);
  const unacknowledged = (warnings ?? []).filter((w) => !acknowledged.includes(w.duplicateOfItemId));

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("lab.desk.title")}</h1>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-sm">
          {t("lab.desk.patientId")}
          <input className="mt-1 w-full rounded border px-2 py-1" value={patientId}
            onChange={(e) => setPatientId(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.desk.encounterNo")}
          <input className="mt-1 w-full rounded border px-2 py-1" value={encounterNo}
            onChange={(e) => setEncounterNo(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.desk.serviceDate")}
          <input type="date" className="mt-1 w-full rounded border px-2 py-1" value={serviceDate}
            onChange={(e) => setServiceDate(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.desk.clinician")}
          <input className="mt-1 w-full rounded border px-2 py-1" value={clinicianId}
            onChange={(e) => setClinicianId(e.target.value)} />
        </label>
      </section>

      <section className="space-y-2">
        <label className="text-sm">
          {t("lab.desk.search")}
          <input className="mt-1 w-full rounded border px-2 py-1" value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </label>
        <ul className="max-h-40 space-y-1 overflow-auto text-sm">
          {(catalogue.data ?? []).slice(0, 12).map((o) => (
            <li key={o.serviceId} className="flex items-center justify-between gap-2">
              <span>
                {o.code} · {o.nameEn}
                {o.consentRequired && <span className="ml-1 font-semibold">{t("lab.desk.consentTag")}</span>}
                {o.sensitive && <span className="ml-1 font-semibold">{t("lab.desk.sensitiveTag")}</span>}
              </span>
              <Button type="button" onClick={() => {
                setBasket((b) => (b.some((x) => x.serviceId === o.serviceId) ? b : [...b, o]));
                setWarnings(null);
              }}>{t("lab.desk.add")}</Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold">{t("lab.desk.basket")}</h2>
        <ul className="space-y-1 text-sm">
          {basket.map((b) => (
            <li key={b.serviceId} className="flex items-center gap-2">
              <span>{b.code}</span>
              {b.consentRequired && (
                <input
                  className="rounded border px-2 py-0.5"
                  placeholder={t("lab.desk.consentRecordedBy")}
                  aria-label={`${t("lab.desk.consentRecordedBy")} ${b.code}`}
                  value={consents[b.serviceId] ?? ""}
                  onChange={(e) => setConsents((c) => ({ ...c, [b.serviceId]: e.target.value }))}
                />
              )}
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={reflexConsent}
            onChange={(e) => setReflexConsent(e.target.checked)} />
          {t("lab.desk.reflexConsent")}
        </label>
        <label className="text-sm">
          {t("lab.desk.priority")}
          <select className="ml-2 rounded border px-2 py-1" value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="routine">{t("lab.desk.routine")}</option>
            <option value="urgent">{t("lab.desk.urgent")}</option>
            <option value="stat">{t("lab.desk.stat")}</option>
          </select>
        </label>
      </section>

      {warnings !== null && warnings.length > 0 && (
        <section className="space-y-1 rounded border border-amber-500 p-2 text-sm">
          <h2 className="font-semibold">{t("lab.desk.duplicates")}</h2>
          {warnings.map((w) => (
            <label key={w.duplicateOfItemId} className="flex items-start gap-2">
              <input type="checkbox" checked={acknowledged.includes(w.duplicateOfItemId)}
                onChange={(e) => setAcknowledged((a) => (
                  e.target.checked ? [...a, w.duplicateOfItemId] : a.filter((x) => x !== w.duplicateOfItemId)
                ))} />
              <span>{w.reason}</span>
            </label>
          ))}
        </section>
      )}

      <div className="flex gap-2">
        <Button type="button" disabled={basket.length === 0} onClick={() => check.mutate()}>
          {t("lab.desk.checkDuplicates")}
        </Button>
        <Button
          type="button"
          disabled={basket.length === 0 || missingConsent.length > 0 || unacknowledged.length > 0}
          onClick={() => place.mutate()}
        >
          {t("lab.desk.place")}
        </Button>
      </div>

      {missingConsent.length > 0 && (
        <p className="text-sm font-semibold">
          {t("lab.desk.consentNeeded")}: {missingConsent.map((b) => b.code).join(", ")}
        </p>
      )}
      {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}
      {placed !== null && (
        <section className="space-y-1 rounded border p-2 text-sm">
          <p className="font-semibold">{t("lab.desk.placed")}: {placed.orderNo}</p>
          <p>{t("lab.desk.invoice")}: {placed.invoice.invoiceNo}</p>
          <p>{t("lab.desk.groupId")}: {placed.orderGroupId}</p>
        </section>
      )}
    </div>
  );
}
