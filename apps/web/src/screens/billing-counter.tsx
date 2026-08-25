import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PatientPicker } from "../components/patient-picker";
import { SubmitButton } from "../components/submit-button";
import type { PatientPickerHit } from "../components/patient-picker";
import { InvoicePrint } from "../components/invoice-print";
import { MoneyInput } from "../components/money-input";
import { TenderEditor } from "../components/tender-editor";
import { fmtPaise, useDebounced } from "../lib/format";
import {
  billingErrorCode, billingErrorMessage, fetchFeeQuote, fetchInvoicePrint, issueInvoice, listDues,
  listServices, previewInvoice,
} from "../lib/billing-api";
import type {
  WireDiscountCategory, WireInvoiceLineInput, WireIssueInvoiceBody, WireIssueInvoiceResult, WireTender,
} from "../lib/billing-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * THE BILLING COUNTER (Plan 08 §11 / D2 / D3 / D7 / D8) — the cashier's one screen: pick the
 * patient, pull the visit's fee quote, build the lines, watch the priced preview, take mixed
 * tenders, extend credit when the money is short, and print.
 *
 * Four standing rules shape this file:
 *  · MONEY IS INTEGER PAISE, END TO END. `MoneyInput` and `TenderEditor` yield integers and the
 *    request body carries integers; no float is constructed anywhere on the path (K38).
 *  · THE SERVER IS AUTHORITATIVE. No status code is branched on beyond `api()`'s 2xx split — the
 *    screen reads `code` out of the ratified `{ statusCode, message, code, detail? }` body. There is
 *    NO client permission model: a 403 renders inline where the cashier can read it.
 *  · THE FEE BRANCH IS NEVER RE-DERIVED HERE. `GET /billing/visits/:encounterId/fee-quote` is the
 *    single source (pipeline-B carried item 5: two server copies of that branch already disagree,
 *    and a third in the browser would be the worst of them).
 *  · THIS SCREEN OWNS THE 15 s POLLING CONVENTION'S TEETH (K39). Its ONE polling read is the dues
 *    sidebar — the only thing on the counter that changes underneath the cashier while she works.
 *    T14/T15/T16 assert the interval's PRESENCE; the assertion that it actually re-fetches lives
 *    here, on fake timers.
 */
const POLL_MS = 15_000;

/** The preview is priced by the server on every edit; debounce so a keystroke is not a request. */
const PREVIEW_DEBOUNCE_MS = 250;

/** The fee line's id, mirroring `charge-rules.ts`'s `FEE_LINE_ID` so quote and invoice agree. */
const FEE_LINE_ID = "fee";

const DISCOUNT_CATEGORIES: WireDiscountCategory[] = ["charity", "scheme", "negotiated_corporate", "employee"];

type LineDiscount = { category: WireDiscountCategory; valuePaise: number | undefined; reason: string };
type CounterLine = {
  lineId: string;
  serviceId: string;
  serviceName: string;
  qty: number;
  discount: LineDiscount | null;
};

/** A client-supplied draft id: the subject every pre-invoice approval binds to (D2 / `issueInvoice`). */
function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A line becomes a wire line input. A manual discount travels ONLY when it is complete — a
 * category with no value and no reason is a half-typed thought, and the server would refuse it.
 */
function toLineInput(line: CounterLine): WireInvoiceLineInput {
  const input: WireInvoiceLineInput = { lineId: line.lineId, serviceId: line.serviceId, qty: line.qty };
  const discount = line.discount;
  if (discount !== null && discount.valuePaise !== undefined && discount.reason.trim() !== "") {
    input.manualDiscount = {
      discountCategory: discount.category,
      kind: "flat_paise", // the counter's manual knock-off is a rupee amount; percent rules are the engine's
      value: discount.valuePaise,
      reason: discount.reason.trim(),
    };
  }
  return input;
}

function ErrorLine({ message, testId }: { message: string | null; testId: string }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" data-testid={testId} className="text-sm text-red-600">{message}</p>;
}

export function BillingCounter(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { encounterId?: string };

  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [encounterId, setEncounterId] = useState(search.encounterId ?? "");
  const [lines, setLines] = useState<CounterLine[]>([]);
  const [serviceQuery, setServiceQuery] = useState("");
  const [tenders, setTenders] = useState<WireTender[]>([]);
  const [discountApprovals, setDiscountApprovals] = useState<Record<string, string>>({});
  const [panNumber, setPanNumber] = useState("");
  const [form60, setForm60] = useState(false);
  const [panRequired, setPanRequired] = useState(false);
  const [creditReason, setCreditReason] = useState("");
  const [creditApprovalId, setCreditApprovalId] = useState("");
  const [creditApprovalRequired, setCreditApprovalRequired] = useState(false);
  const [draftId, setDraftId] = useState(newDraftId);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [issued, setIssued] = useState<WireIssueInvoiceResult | null>(null);
  // Line ids are per-counter and sequential: they are the key `discountApprovals` binds an approval
  // to, so they must be stable for the life of the draft and must not leak across bills.
  const lineSeq = useRef(0);
  const nextLineId = (): string => {
    lineSeq.current += 1;
    return `line-${String(lineSeq.current)}`;
  };

  // ——— reads ———————————————————————————————————————————————————————————————————————————————

  // Debounced: an encounter id typed by hand must not fire a quote per keystroke.
  const debouncedEncounterId = useDebounced(encounterId.trim(), PREVIEW_DEBOUNCE_MS);
  const feeQuote = useQuery({
    queryKey: ["billing", "fee-quote", debouncedEncounterId],
    queryFn: () => fetchFeeQuote(debouncedEncounterId),
    enabled: debouncedEncounterId !== "",
  });

  /** THE screen's one polling read (K39). Dues move while the cashier is on another patient. */
  const dues = useQuery({
    queryKey: ["billing", "dues", patient?.id ?? ""],
    queryFn: () => listDues(patient?.id ?? ""),
    enabled: patient !== null,
    refetchInterval: POLL_MS,
  });

  const debouncedServiceQuery = useDebounced(serviceQuery, PREVIEW_DEBOUNCE_MS);
  const services = useQuery({
    queryKey: ["billing", "services"],
    queryFn: listServices,
    enabled: debouncedServiceQuery.trim().length >= 2,
  });

  const lineInputs = lines.map(toLineInput);
  /**
   * The preview is priced by the SERVER on the debounced draft, and the request is built from the
   * debounced key itself — not from `lines` — so the body can never be one keystroke ahead of the
   * key it is cached under (an `enabled` that flipped on the live lines would fire the first
   * request with the previous, empty draft).
   */
  const previewKey = useDebounced(JSON.stringify({ encounterId: encounterId.trim(), lines: lineInputs }), PREVIEW_DEBOUNCE_MS);
  const previewBody = JSON.parse(previewKey) as { encounterId: string; lines: WireInvoiceLineInput[] };
  const preview = useQuery({
    queryKey: ["billing", "preview", previewKey],
    queryFn: () =>
      previewInvoice(
        previewBody.encounterId === ""
          ? { lines: previewBody.lines }
          : { encounterId: previewBody.encounterId, lines: previewBody.lines },
      ),
    enabled: previewBody.lines.length > 0,
  });

  const print = useQuery({
    queryKey: ["billing", "print", issued?.invoiceId ?? ""],
    queryFn: () => fetchInvoicePrint(issued?.invoiceId ?? ""),
    enabled: issued !== null,
  });

  // The fee line is SEEDED from the quote, once, and stays editable afterwards — a cashier who
  // removed it has removed it on purpose (a revisit carries no fee line at all, D8).
  const quote = feeQuote.data;
  useEffect(() => {
    if (quote === undefined || quote.free) return;
    const feeServiceId = quote.feeServiceId;
    if (feeServiceId === null) return;
    const priced = quote.draft?.lines[0];
    setLines((current) => {
      if (current.some((line) => line.lineId === FEE_LINE_ID)) return current;
      return [
        { lineId: FEE_LINE_ID, serviceId: feeServiceId, serviceName: priced?.serviceName ?? feeServiceId, qty: 1, discount: null },
        ...current,
      ];
    });
  }, [quote]);

  // ——— derived money ————————————————————————————————————————————————————————————————————————

  const totals = preview.data?.totals ?? null;
  const netPayablePaise = totals?.netPayablePaise ?? 0;
  const tenderedPaise = tenders.reduce((sum, tender) => sum + tender.amountPaise, 0);
  const remainderPaise = Math.max(netPayablePaise - tenderedPaise, 0);
  const approvalLines = (preview.data?.lines ?? []).filter((line) =>
    line.candidates.some((candidate) => candidate.requiresApproval),
  );

  // ——— the write ————————————————————————————————————————————————————————————————————————————

  const submit = async (idemKey: string): Promise<void> => {
    if (patient === null) {
      setError(t("billing.counter.pickPatientFirst"));
      setErrorCode(null);
      return;
    }
    if (lines.length === 0) {
      setError(t("billing.counter.noLines"));
      setErrorCode(null);
      return;
    }
    // D2 step 3 / owner ruling 2, mirrored at the counter: unsettled without a REASON is refused
    // before anything leaves the browser, so "no request was sent" has exactly one cause (K45's
    // shape). The button is deliberately not disabled.
    if (remainderPaise > 0 && creditReason.trim() === "") {
      setError(t("billing.counter.creditReasonRequired"));
      setErrorCode(null);
      return;
    }
    setError(null);
    setErrorCode(null);

    const body: WireIssueInvoiceBody = {
      draftId,
      patientId: patient.id,
      lines: lineInputs,
    };
    if (encounterId.trim() !== "") body.encounterId = encounterId.trim();
    if (tenders.length > 0) {
      const receipt: NonNullable<WireIssueInvoiceBody["receipt"]> = { tenders };
      if (panNumber.trim() !== "") receipt.panNumber = panNumber.trim();
      if (form60) receipt.form60 = true;
      body.receipt = receipt;
    }
    if (remainderPaise > 0) {
      const credit: NonNullable<WireIssueInvoiceBody["credit"]> = { reason: creditReason.trim() };
      if (creditApprovalId.trim() !== "") credit.approvalId = creditApprovalId.trim();
      body.credit = credit;
    }
    const approvals = Object.fromEntries(
      Object.entries(discountApprovals).filter(([, id]) => id.trim() !== "").map(([lineId, id]) => [lineId, id.trim()]),
    );
    if (Object.keys(approvals).length > 0) body.discountApprovals = approvals;

    try {
      setIssued(await issueInvoice(body, idemKey));
    } catch (e) {
      const code = billingErrorCode(e);
      setErrorCode(code);
      setError(billingErrorMessage(e));
      // The two refusals that ASK FOR SOMETHING rather than just refusing: reveal the control the
      // cashier now needs. Everything else is read and acted on outside this screen.
      if (code === "pan_required") setPanRequired(true);
      if (code === "credit_approval_required") setCreditApprovalRequired(true);
    }
  };

  // ——— the printed invoice REPLACES the counter (exactly one `.print-doc` is ever mounted) ———

  if (issued !== null) {
    return (
      <div className="space-y-4 p-6">
        <div className="no-print space-y-2">
          <p data-testid="issued-invoice-no" className="font-mono text-sm">
            {t("billing.counter.issued", { invoiceNo: issued.invoiceNo })}
          </p>
          {issued.unallocatedPaise > 0 && (
            <p data-testid="unallocated-banner" className="text-sm font-medium text-emerald-700">
              {t("billing.counter.unallocated", { amount: fmtPaise(issued.unallocatedPaise) })}
            </p>
          )}
          {issued.warnings.map((warning) => (
            <p key={warning} data-testid={`warning-${warning}`} className="text-sm text-amber-700">
              {t(`billing.warning.${warning}`)}
            </p>
          ))}
        </div>
        {print.data !== undefined && <InvoicePrint data={print.data} />}
        <Button
          variant="outline"
          className="no-print"
          onClick={() => {
            setIssued(null);
            setDraftId(newDraftId()); // a new bill is a new approval subject (D2)
            lineSeq.current = 0;
            setLines([]);
            setTenders([]);
            setPatient(null);
            setEncounterId("");
            setCreditReason("");
            setCreditApprovalId("");
            setCreditApprovalRequired(false);
            setPanNumber("");
            setForm60(false);
            setPanRequired(false);
            setDiscountApprovals({});
          }}
        >
          {t("billing.counter.nextBill")}
        </Button>
      </div>
    );
  }

  const serviceMatches = (services.data?.items ?? []).filter((service) => {
    const needle = debouncedServiceQuery.trim().toLowerCase();
    return needle !== "" && (service.name.toLowerCase().includes(needle) || service.code.toLowerCase().includes(needle));
  });

  return (
    <div className="space-y-4 p-6">
      <div className="no-print flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">{t("billing.counter.title")}</h1>
        {/*
          PLAN 09 T3 / DD8 — THE ONE THING THE COUNTER NEEDS BEFORE BENEFITS ARE ARMED.
          Recognition deploys BEFORE `MEMBER_BENEFITS_ENABLED`, so for the whole of that window a
          cashier who is handed a card has to be able to look it up somewhere; without this link
          that somewhere is the partner's WhatsApp group. It shows NO figure of any kind (E-32).

          A PLAIN ANCHOR, NOT `<Link>`, AND THAT IS A TEST CONSTRAINT RATHER THAN A PREFERENCE:
          this screen's own suite renders it outside a `RouterProvider` (it mocks only `useSearch`),
          so a router-aware component here would throw in a file this task may not edit. The cost is
          one full page load on a click that leaves the counter anyway; `/api/*` path separation
          (11g DD1) is what makes the plain href land on the SPA rather than on the API.
        */}
        <a className="text-sm underline" href="/counter/instruments">{t("nav.counterInstruments")}</a>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* (a) who is paying, for which visit, and what they already owe */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t("billing.counter.pickPatient")}</h2>
          <PatientPicker onPick={setPatient} />
          {patient !== null && (
            <div className="rounded border p-2">
              <p className="text-sm">{t("billing.counter.selectedPatient")}: {patient.name ?? "—"}</p>
              <p className="font-mono text-xs text-neutral-600">{patient.uhid}</p>
            </div>
          )}

          <label className="block text-sm font-medium" htmlFor="counter-encounter">{t("billing.counter.encounter")}</label>
          <input
            id="counter-encounter"
            value={encounterId}
            onChange={(e) => setEncounterId(e.target.value)}
            className="w-full rounded border px-2 py-1 font-mono text-sm"
          />

          {quote !== undefined && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge data-testid="fee-branch" variant={quote.free ? "default" : "outline"}>
                {t(`billing.visitType.${quote.visitType}`)}
              </Badge>
              {quote.free ? (
                <span data-testid="fee-free" className="text-sm text-emerald-700">{t("billing.counter.freeVisit")}</span>
              ) : (
                <span data-testid="fee-amount" className="text-sm">
                  {fmtPaise(quote.draft?.totals.netPayablePaise ?? 0)}
                </span>
              )}
            </div>
          )}

          <h2 className="pt-2 text-sm font-semibold">{t("billing.counter.dues")}</h2>
          <div data-testid="dues-sidebar" className="space-y-1">
            {patient === null && <p className="text-sm text-neutral-500">{t("billing.counter.pickPatientFirst")}</p>}
            {patient !== null && (dues.data?.items ?? []).length === 0 && (
              <p className="text-sm text-neutral-500">{t("billing.counter.noDues")}</p>
            )}
            {(dues.data?.items ?? []).map((due) => (
              <p key={due.invoiceId} data-testid={`dues-row-${due.invoiceId}`} className="text-sm">
                <span className="font-mono">{due.invoiceNo}</span> · {due.serviceDay} · {fmtPaise(due.outstandingPaise)}
              </p>
            ))}
          </div>
        </div>

        {/* (b) the lines and the server-priced preview */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t("billing.counter.lines")}</h2>
          <label className="block text-sm font-medium" htmlFor="counter-service-search">
            {t("billing.counter.addService")}
          </label>
          <input
            id="counter-service-search"
            value={serviceQuery}
            onChange={(e) => setServiceQuery(e.target.value)}
            className="w-full rounded border px-2 py-1"
          />
          <div className="space-y-1">
            {serviceMatches.map((service) => (
              <button
                key={service.id}
                type="button"
                data-testid={`add-service-${service.id}`}
                onClick={() => {
                  setLines((current) => [
                    ...current,
                    { lineId: nextLineId(), serviceId: service.id, serviceName: service.name, qty: 1, discount: null },
                  ]);
                  setServiceQuery("");
                }}
                className="block w-full rounded border p-1 text-left text-sm hover:bg-neutral-50"
              >
                {service.name} <span className="font-mono text-xs text-neutral-600">{service.code}</span>
              </button>
            ))}
          </div>

          {lines.map((line) => (
            <div key={line.lineId} data-testid={`line-row-${line.lineId}`} className="space-y-2 rounded border p-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm">{line.serviceName}</span>
                <label className="sr-only" htmlFor={`line-qty-${line.lineId}`}>{t("billing.counter.qty")}</label>
                <input
                  id={`line-qty-${line.lineId}`}
                  type="number"
                  min={1}
                  value={line.qty}
                  onChange={(e) =>
                    setLines((current) =>
                      current.map((l) => (l.lineId === line.lineId ? { ...l, qty: Number(e.target.value) } : l)),
                    )
                  }
                  className="w-16 rounded border px-2 py-1 text-right tabular-nums"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`line-discount-${line.lineId}`}
                  onClick={() =>
                    setLines((current) =>
                      current.map((l) =>
                        l.lineId === line.lineId
                          ? {
                            ...l,
                            discount: l.discount === null
                              ? { category: "charity", valuePaise: undefined, reason: "" }
                              : null,
                          }
                          : l,
                      ),
                    )
                  }
                >
                  {t("billing.counter.discount")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`line-remove-${line.lineId}`}
                  onClick={() => setLines((current) => current.filter((l) => l.lineId !== line.lineId))}
                >
                  {t("billing.counter.removeLine")}
                </Button>
              </div>

              {line.discount !== null && (
                <div className="space-y-2 border-t pt-2">
                  <label className="block text-sm font-medium" htmlFor={`discount-category-${line.lineId}`}>
                    {t("billing.counter.discountCategory")}
                  </label>
                  <select
                    id={`discount-category-${line.lineId}`}
                    value={line.discount.category}
                    onChange={(e) =>
                      setLines((current) =>
                        current.map((l) =>
                          l.lineId === line.lineId && l.discount !== null
                            ? { ...l, discount: { ...l.discount, category: e.target.value as WireDiscountCategory } }
                            : l,
                        ),
                      )
                    }
                    className="w-full rounded border px-2 py-1"
                  >
                    {DISCOUNT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>{t(`billing.discountCategory.${category}`)}</option>
                    ))}
                  </select>
                  <MoneyInput
                    id={`discount-value-${line.lineId}`}
                    label={t("billing.counter.discountValue")}
                    onChange={(paise) =>
                      setLines((current) =>
                        current.map((l) =>
                          l.lineId === line.lineId && l.discount !== null
                            ? { ...l, discount: { ...l.discount, valuePaise: paise } }
                            : l,
                        ),
                      )
                    }
                  />
                  <label className="block text-sm font-medium" htmlFor={`discount-reason-${line.lineId}`}>
                    {t("billing.counter.discountReason")}
                  </label>
                  <input
                    id={`discount-reason-${line.lineId}`}
                    value={line.discount.reason}
                    onChange={(e) =>
                      setLines((current) =>
                        current.map((l) =>
                          l.lineId === line.lineId && l.discount !== null
                            ? { ...l, discount: { ...l.discount, reason: e.target.value } }
                            : l,
                        ),
                      )
                    }
                    className="w-full rounded border px-2 py-1"
                  />
                </div>
              )}

              {/* The engine's contest, as it came back: which adjustment won this line and why. */}
              {(preview.data?.lines ?? [])
                .filter((priced) => priced.lineId === line.lineId)
                .map((priced) => (
                  <div key={priced.lineId} className="border-t pt-2 text-xs text-neutral-600">
                    <p data-testid={`line-contest-${line.lineId}`}>
                      {priced.winner === null
                        ? t("billing.counter.noAdjustment")
                        : `${priced.winner.reason} · ${fmtPaise(priced.winner.amountPaise)}`}
                    </p>
                    <p data-testid={`line-net-${line.lineId}`}>{fmtPaise(priced.netPaise)}</p>
                  </div>
                ))}
            </div>
          ))}

          {approvalLines.map((line) => (
            <div key={line.lineId} data-testid={`approval-required-${line.lineId}`} className="space-y-1 rounded border border-amber-400 p-2">
              <p className="text-sm text-amber-700">{t("billing.counter.approvalRequired", { line: line.serviceName })}</p>
              <label className="block text-sm font-medium" htmlFor={`discount-approval-${line.lineId}`}>
                {t("billing.counter.approvalId")}
              </label>
              <input
                id={`discount-approval-${line.lineId}`}
                value={discountApprovals[line.lineId] ?? ""}
                onChange={(e) =>
                  setDiscountApprovals((current) => ({ ...current, [line.lineId]: e.target.value }))
                }
                className="w-full rounded border px-2 py-1 font-mono text-sm"
              />
            </div>
          ))}

          {totals !== null && (
            <div className="space-y-1 rounded border p-2 text-sm">
              <p data-testid="preview-gross">{t("billing.print.grossTotal")}: {fmtPaise(totals.grossPaise)}</p>
              <p data-testid="preview-discount">{t("billing.print.discountTotal")}: {fmtPaise(totals.discountPaise)}</p>
              <p data-testid="preview-tax">{t("billing.print.tax")}: {fmtPaise(totals.cgstPaise + totals.sgstPaise)}</p>
              <p data-testid="preview-rounding">{t("billing.print.rounding")}: {fmtPaise(totals.roundingPaise)}</p>
              <p data-testid="preview-net" className="font-semibold">
                {t("billing.print.netPayable")}: {fmtPaise(totals.netPayablePaise)}
              </p>
            </div>
          )}
        </div>

        {/* (c) the money: tenders, the cash-law fields the server asks for, the credit lane */}
        <div className="space-y-3">
          <TenderEditor payablePaise={netPayablePaise} onChange={setTenders} />

          {panRequired && (
            <div className="space-y-1 rounded border border-amber-400 p-2">
              <label className="block text-sm font-medium" htmlFor="counter-pan">{t("billing.counter.pan")}</label>
              <input
                id="counter-pan"
                value={panNumber}
                onChange={(e) => setPanNumber(e.target.value)}
                className="w-full rounded border px-2 py-1 font-mono text-sm uppercase"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="counter-form60"
                  type="checkbox"
                  checked={form60}
                  onChange={(e) => setForm60(e.target.checked)}
                />
                {t("billing.counter.form60")}
              </label>
            </div>
          )}

          {remainderPaise > 0 && (
            <div className="space-y-1 rounded border p-2">
              <p data-testid="credit-remainder" className="text-sm font-medium">
                {t("billing.counter.remainder", { amount: fmtPaise(remainderPaise) })}
              </p>
              <label className="block text-sm font-medium" htmlFor="counter-credit-reason">
                {t("billing.counter.creditReason")}
              </label>
              <input
                id="counter-credit-reason"
                value={creditReason}
                onChange={(e) => setCreditReason(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
              {creditApprovalRequired && (
                <div data-testid="credit-approval-wait" className="space-y-1 border-t pt-2">
                  <p className="text-sm text-amber-700">{t("billing.counter.creditApprovalWait")}</p>
                  <label className="block text-sm font-medium" htmlFor="counter-credit-approval">
                    {t("billing.counter.approvalId")}
                  </label>
                  <input
                    id="counter-credit-approval"
                    value={creditApprovalId}
                    onChange={(e) => setCreditApprovalId(e.target.value)}
                    className="w-full rounded border px-2 py-1 font-mono text-sm"
                  />
                </div>
              )}
            </div>
          )}

          <ErrorLine message={error} testId="counter-error" />
          {errorCode !== null && (
            <p data-testid="counter-error-code" className="font-mono text-xs text-neutral-500">{errorCode}</p>
          )}

          <SubmitButton data-testid="submit-invoice" onClick={(k) => submit(k)}>
            {t("billing.counter.issue")}
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}
