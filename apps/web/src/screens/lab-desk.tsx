import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  duplicateWarnings, istToday, labErrorText, placeLabOrder, previewLabOrder, searchOrderables,
} from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import type {
  WireDeskOrder, WireDuplicateWarning, WireOrderable, WirePricedDraft,
} from "../lib/lab-api";

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
  const [serviceDate, setServiceDate] = useState(() => istToday());
  const [clinicianId, setClinicianId] = useState("");
  const [query, setQuery] = useState("");
  const [basket, setBasket] = useState<WireOrderable[]>([]);
  const [consents, setConsents] = useState<Record<string, string>>({});
  const [reflexConsent, setReflexConsent] = useState(false);
  const [priority, setPriority] = useState<"routine" | "urgent" | "stat">("routine");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<WireDuplicateWarning[] | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());
  const [placed, setPlaced] = useState<WireDeskOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * ═══ CLOSE REVIEW (web) C4 — THE COUNTER CAN TAKE THE MONEY ═══
   *
   * This screen shipped sending `credit: { reason: "counter order" }` on EVERY order, so every lab
   * bill became an unpaid credit invoice and the delivery interlock then held EVERY report — for
   * money that was in the drawer. A control that fires on 100% of reports is a control a counter
   * learns to release without reading, which is DD6 inverted.
   *
   * The price comes from BILLING's own `previewInvoice` through `/lab/desk/preview`, so the number
   * quoted and the number charged are the same arithmetic. "Bill later" remains available and is
   * what a credit patient, a ward order and a walk-in with no cash actually need.
   */
  const [payNow, setPayNow] = useState(true);
  const [tender, setTender] = useState<"cash" | "card" | "upi">("cash");
  const [priced, setPriced] = useState<WirePricedDraft | null>(null);

  const catalogue = useQuery({
    queryKey: ["lab", "catalogue", query],
    queryFn: () => searchOrderables(query),
  });

  const check = useMutation({
    mutationFn: async () => ({
      warnings: await duplicateWarnings(patientId, basket.map((b) => b.serviceId)),
      /** The duplicate check and the price are one question at the counter: "what am I placing?" */
      priced: await previewLabOrder(patientId, encounterNo, basket.map((b) => b.serviceId)),
    }),
    onSuccess: (r) => { setWarnings(r.warnings); setPriced(r.priced); setError(null); },
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
      /**
       * PAID NOW ⇒ a receipt for exactly the priced net, and NO credit block: `issueInvoice`
       * refuses a remainder without one, so a tender that does not cover the bill is refused by the
       * server rather than quietly extended as credit. BILL LATER ⇒ the credit block, which is what
       * DD6 exists for — the tube is drawn either way.
       */
      /**
       * A ZERO BILL TAKES NO TENDER (pass 2, F15). `amountPaise` is `.int().positive()` at the
       * route, so a fully-covered basket sent `{ amountPaise: 0 }` and got a zod 400 — with
       * "Pay now" ticked by default, the clerk had to work out that UNticking it was the way
       * through a bill of ₹0. Nothing is owed, so nothing is tendered and no credit is extended.
       */
      ...(priced !== null && priced.totals.netPayablePaise === 0
        ? {}
        : payNow && priced !== null
          ? { receipt: { tenders: [{ mode: tender, amountPaise: priced.totals.netPayablePaise }] } }
          : { credit: { reason: t("lab.desk.creditReason") } }),
    }, idempotencyKey),
    onSuccess: (order) => {
      setPlaced(order);
      setError(null);
      setBasket([]);
      setWarnings(null);
      setAcknowledged([]);
      setPriced(null);
      /** A NEW key for the NEXT attempt — the one just used belongs to the order that landed. */
      setIdempotencyKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ["lab"] });
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  /**
   * ═══ ONE KEY PER ATTEMPT, NOT PER CLICK (close review, web MAJOR) ═══
   *
   * A fresh key at every click makes a double-click two DISTINCT requests, which is the exact case
   * `withIdempotency` exists to absorb. The key is minted once and reused until an order lands, so
   * a second click on the same basket REPLAYS the first rather than placing a second order. It is
   * rotated on success.
   */
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
                /**
                 * THE PRICE DIES WITH THE BASKET (pass 2, F14). It did not, so a clerk who priced
                 * CBC+LFT at ₹550 and then added a vitamin D sent a tender of ₹550 against an
                 * ₹1,450 invoice — refused by billing with a number the clerk never chose, and the
                 * only escape was to press Check again, which nothing on the screen said.
                 */
                setWarnings(null);
                setPriced(null);
                setAcknowledged([]);
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

      {priced !== null && (
        <section className="space-y-1 rounded border p-2 text-sm">
          <p className="font-semibold">
            {t("lab.desk.netPayable")}: ₹{(priced.totals.netPayablePaise / 100).toFixed(2)}
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} />
            {t("lab.desk.payNow")}
          </label>
          {payNow ? (
            <label className="text-sm">
              {t("lab.desk.tender")}
              <select className="ml-2 rounded border px-2 py-1" value={tender}
                onChange={(e) => setTender(e.target.value as typeof tender)}>
                <option value="cash">{t("lab.desk.cash")}</option>
                <option value="card">{t("lab.desk.card")}</option>
                <option value="upi">{t("lab.desk.upi")}</option>
              </select>
            </label>
          ) : (
            <p className="text-xs">{t("lab.desk.billLaterNote")}</p>
          )}
        </section>
      )}

      <div className="flex gap-2">
        <Button type="button" disabled={basket.length === 0} onClick={() => check.mutate()}>
          {t("lab.desk.checkDuplicates")}
        </Button>
        <Button
          type="button"
          disabled={
            basket.length === 0 || missingConsent.length > 0 || unacknowledged.length > 0
            /** Taking money needs a PRICE, and the price is the server's. */
            || (payNow && priced === null) || place.isPending || check.isPending
          }
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
