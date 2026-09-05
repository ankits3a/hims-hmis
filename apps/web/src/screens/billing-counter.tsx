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
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { listCoverages } from "../lib/patients-api";
import type { WireCoverage } from "../lib/patients-api";
import { fetchCurrentSession } from "../lib/billing-api";
import type { TenderMode } from "../lib/billing-api";

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
  /*
   * ═══ FD-7 T6 — THE SCHEME RAIL FINALLY HAS A CASHIER ═══
   *
   * `couponCodes` and `attributionCode` have been on `WireIssueInvoiceBody` and on the preview
   * helper since RC-2, and on the server since T2 — and NOTHING ON THIS SCREEN COULD SET EITHER.
   * A coupon the patient handed over could not be typed in, and the partner slip they carried in
   * could not be recorded. The whole benefit engine underneath — memberships, coupon rules,
   * entitlement counters, redemptions and their reversal — has been reachable only by a caller
   * writing JSON by hand.
   *
   * They are held as ONE text field each and split on commit rather than as chips: a cashier types
   * what is printed on the paper, and a coupon that fails its rule must fail visibly (the server
   * names the rule) rather than be silently dropped by a parser on this side.
   */
  const [couponText, setCouponText] = useState("");
  const [attributionCode, setAttributionCode] = useState("");
  /**
   * FD-7 T9 — THE SLIP IS PRE-FILLED FROM WHAT THE DESK CAPTURED, and it has to be.
   *
   * The quote now falls back to `opd_encounters.attribution_code`, so without this the cashier would
   * see a price that a stored slip had already discounted, in a screen whose own slip field was
   * blank — and issuing from that blank field would send NO code and produce a different invoice.
   * That is exactly the quote/invoice disagreement RC-2's review named, arriving from the opposite
   * direction. Pre-filling makes the stored value visible, and makes any edit — including CLEARING
   * it — an explicit act that travels.
   *
   * Seeded ONCE PER ENCOUNTER, exactly like the fee line above: a cashier who cleared the field
   * cleared it on purpose, and a re-seed on every quote refetch would undo them mid-correction.
   *
   * HONESTLY LABELLED: the ENCOUNTER KEY is tested (switching patients re-seeds — a mutant that
   * drops it turns that row red). The "do not re-seed the SAME encounter" half is NOT, because this
   * suite cannot make the quote refetch: React Query hands back a stable `data` reference, so the
   * effect never re-runs and deleting the guard changes nothing observable here. It stays because
   * the defect it prevents is real — a refetch mid-correction silently restoring a slip the cashier
   * had just removed — and it is recorded as untested rather than counted as covered.
   */
  const [slipSeededFor, setSlipSeededFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [issued, setIssued] = useState<WireIssueInvoiceResult | null>(null);
  /* FD-25 — the artboard's three keyed lanes; a nonce so pressing the same lane twice re-seeds. */
  const [lane, setLane] = useState<{ mode: TenderMode; amountPaise: number; nonce: number } | null>(null);
  const [log, setLog] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
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
  /** Comma- or space-separated, trimmed, blanks dropped, order preserved — what the paper says. */
  const couponCodes = couponText.split(/[,\s]+/).map((c) => c.trim()).filter((c) => c !== "");
  const referral = attributionCode.trim();
  /**
   * The preview is priced by the SERVER on the debounced draft, and the request is built from the
   * debounced key itself — not from `lines` — so the body can never be one keystroke ahead of the
   * key it is cached under (an `enabled` that flipped on the live lines would fire the first
   * request with the previous, empty draft).
   */
  /*
   * FD-7 T6 — THE CODES ARE PART OF THE KEY, and that is the whole guard against the defect RC-2's
   * own review named: "a seat that quoted ₹450 through `fetchFeeQuote(id, codes)` would still have
   * issued at ₹500". The preview and the invoice must be asked in the SAME terms or the money
   * disagrees, so the coupon text and the slip travel inside the debounced key rather than beside it.
   */
  const previewKey = useDebounced(
    JSON.stringify({ encounterId: encounterId.trim(), lines: lineInputs, couponCodes, referral }),
    PREVIEW_DEBOUNCE_MS,
  );
  const previewBody = JSON.parse(previewKey) as {
    encounterId: string; lines: WireInvoiceLineInput[]; couponCodes: string[]; referral: string;
  };
  const preview = useQuery({
    queryKey: ["billing", "preview", previewKey],
    queryFn: () =>
      previewInvoice({
        ...(previewBody.encounterId === "" ? {} : { encounterId: previewBody.encounterId }),
        lines: previewBody.lines,
        ...(previewBody.couponCodes.length > 0 ? { couponCodes: previewBody.couponCodes } : {}),
        ...(previewBody.referral === "" ? {} : { attributionCode: previewBody.referral }),
      }),
    enabled: previewBody.lines.length > 0,
  });

  /**
   * FD-25 — THE COVERAGE READ, and it is what closes a write-only table.
   *
   * `patient_coverages` has been collected at registration since FD-12 and read back by nothing.
   * This is the Corporate/TPA card's whole content — `payerName` and `employeeId`, exactly the
   * artboard's "East Central Railway · employee 41129" — and until now the build spec's conclusion
   * that the data did not exist was the reasonable reading, because nothing could reach it.
   */
  const coverages = useQuery({
    queryKey: ["patient-coverages", patient?.id ?? ""],
    queryFn: () => listCoverages(patient?.id ?? ""),
    enabled: patient !== null,
    staleTime: 60_000,
  });

  /* The header's drawer pill. `billing.session.own`, which the cashier holds. */
  const session = useQuery({
    queryKey: ["cash-session"],
    queryFn: fetchCurrentSession,
    staleTime: 30_000,
    retry: false,
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
    if (quote === undefined) return;
    if (slipSeededFor === quote.encounterId) return;
    setSlipSeededFor(quote.encounterId);
    setAttributionCode(quote.attributionCode ?? "");
  }, [quote, slipSeededFor]);
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
    // The SAME terms the preview above was priced with — see the preview key's comment.
    if (couponCodes.length > 0) body.couponCodes = couponCodes;
    if (referral !== "") body.attributionCode = referral;

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

  // ——— the printed invoice REPLACES the counter (exactly one `.print-doc` is ever mounted) ———

  if (issued !== null) {
    return (
      <PaperScreen testId="billing-issued">
        <div style={{ flexGrow: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="no-print" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <ScreenTitle title={t("billing.counter.title")} route="/billing" />
            <p data-testid="issued-invoice-no" className="mo" style={{ fontSize: 15, fontWeight: 600 }}>
              {t("billing.counter.issued", { invoiceNo: issued.invoiceNo })}
            </p>
            {/*
              THE SURPLUS IS NOT AN ERROR, and it never was. `unallocatedPaise` is money the patient
              handed over beyond this bill; it sits on their account as an advance. Green, stated,
              and in the same words the cash-lane banner promised before the money was taken.
            */}
            {issued.unallocatedPaise > 0 && (
              <p data-testid="unallocated-banner" className="pill on" style={{ height: "auto", padding: "8px 11px" }}>
                {t("billing.counter.unallocated", { amount: fmtPaise(issued.unallocatedPaise) })}
              </p>
            )}
            {issued.warnings.map((warning) => (
              <p key={warning} data-testid={`warning-${warning}`} className="pill gd" style={{ height: "auto", padding: "8px 11px" }}>
                {t(`billing.warning.${warning}`)}
              </p>
            ))}
          </div>
          {print.data !== undefined && <InvoicePrint data={print.data} />}
          <button
            className="sec no-print"
            type="button"
            style={{ alignSelf: "flex-start" }}
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
              setLane(null);
            }}
          >
            {t("billing.counter.nextBill")}
          </button>
        </div>
      </PaperScreen>
    );
  }

  const serviceMatches = (services.data?.items ?? []).filter((service) => {
    const needle = debouncedServiceQuery.trim().toLowerCase();
    return needle !== "" && (service.name.toLowerCase().includes(needle) || service.code.toLowerCase().includes(needle));
  });

  const pricedLines = preview.data?.lines ?? [];
  /*
    ═══ THE CONTEST'S LOSERS, AND THE ONE THING THEY ARE NOT ═══

    A candidate with `rejected !== null` is NOT a losing contestant — it is an adjustment that could
    not apply at all (`over_cap`, `unknown_category`). Drawing it struck-through beside the winner
    would tell a cashier "your camp slip lost to the membership" when the truth is "your camp slip
    was never eligible", and those are different sentences to say to a patient. Only genuine
    contestants are shown as losers.
  */
  const contested = pricedLines.filter((line) => line.winner !== null
    && line.candidates.some((c) => c !== line.winner && c.rejected === null));
  const benefitPaise = (preview.data?.totals?.discountPaise ?? 0);

  /* The panel arrangement, if registration recorded one. See `listCoverages` for why it is new. */
  const panel: WireCoverage | null = (coverages.data?.items ?? [])
    .find((c) => c.kind === "corporate" || c.kind === "tpa" || c.kind === "cghs" || c.kind === "esic") ?? null;
  const panelPays = quote?.intendedPayer !== undefined && quote.intendedPayer !== "self";

  const takeLane = (mode: TenderMode): void => {
    setLane({ mode, amountPaise: netPayablePaise, nonce: Date.now() });
    setLog((prev) => logged(prev, t("billingSeat.log.lane", { mode: t(`billing.tender.modes.${mode}`), amount: fmtPaise(netPayablePaise) })));
  };

  const ask = (question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    if (q.includes("benefit") || q.includes("discount") || q.includes("why")) {
      setAnswer(benefitPaise === 0
        ? t("billingSeat.agent.noBenefit")
        : t("billingSeat.agent.benefit", { amount: fmtPaise(benefitPaise) }));
    } else if (q.includes("panel") || q.includes("corporate") || q.includes("tpa")) {
      setAnswer(panel === null
        ? t("billingSeat.agent.noPanel")
        : t("billingSeat.agent.panel", { payer: panel.payerName ?? "—", id: panel.employeeId ?? panel.beneficiaryId ?? "—" }));
    } else if (q.includes("owe") || q.includes("due") || q.includes("outstanding")) {
      setAnswer(t("billingSeat.agent.dues", { count: (dues.data?.items ?? []).length }));
    } else {
      setAnswer(t("billingSeat.agent.scope"));
    }
  };

  return (
    <PaperScreen testId="billing-seat">
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", padding: "18px 22px", gap: 14, minWidth: 0 }}>
        <ScreenTitle
          title={t("billing.counter.title")}
          route="/billing"
          actions={
            <>
              <span className={session.data?.session == null ? "pill" : "pill on"} data-testid="drawer-pill">
                {session.data?.session == null
                  ? t("billingSeat.header.noDrawer")
                  : t("billingSeat.header.drawerOpen", { float: fmtPaise(session.data.session.openingFloatPaise) })}
              </span>
              {/*
                A PLAIN ANCHOR, NOT `<Link>`, and the reason is a test constraint recorded by FD-7:
                this screen's suite renders it outside a `RouterProvider`, so a router-aware
                component here throws. `/api/*` path separation is what makes the plain href land on
                the SPA rather than the API.
              */}
              <a className="sec" style={{ textDecoration: "none" }} href="/counter/instruments">
                {t("nav.counterInstruments")}
              </a>
            </>
          }
        />

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* ═══ LEFT RAIL — who is paying, and what they already owe ═══ */}
          <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column", gap: 13 }}>
            <div className="box" style={{ padding: 14 }}>
              <span className="tag">{t("billingSeat.rail.paying")}</span>
              {patient === null ? (
                <div style={{ marginTop: 9 }}>
                  <p style={{ margin: "0 0 9px", color: "var(--faint)", fontSize: 12.5 }}>
                    {t("billing.counter.pickPatientFirst")}
                  </p>
                  <PatientPicker autoFocus onPick={setPatient} />
                </div>
              ) : (
                <div data-testid="paying-name" style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 16, fontWeight: 600, lineHeight: "20px" }}>{patient.name ?? "—"}</span>
                  <span className="mo" style={{ fontSize: 12.5, color: "var(--dim)" }}>{patient.uhid}</span>
                </div>
              )}
              {/*
                ═══ THE VISIT CARD IS NOT NESTED UNDER THE PATIENT, AND THE SUITE CAUGHT THAT ═══

                The artboard draws them together because its fixture has both. This screen is
                ENTERED as `/billing?encounterId=…` from the OPD desk — that hand-off is the route's
                whole `validateSearch` — so a quote routinely exists before a patient is picked, and
                nesting the fee branch inside `patient !== null` hid it on exactly the road the
                screen is reached by. Found by `fee-branch` going missing, not by looking.
              */}
              {quote === undefined ? null : (
                <>
                    <div style={{ marginTop: 12, padding: "11px 12px", background: "var(--wash)", borderRadius: 6 }}>
                      <span className="tag">{t("billingSeat.rail.thisVisit")}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7, flexWrap: "wrap" }}>
                        <span className="pill" data-testid="fee-branch">{t(`billing.visitType.${quote.visitType}`)}</span>
                        {quote.free ? (
                          <span data-testid="fee-free" className="pill on">{t("billing.counter.freeVisit")}</span>
                        ) : (
                          <span data-testid="fee-amount" className="mo" style={{ fontSize: 13, fontWeight: 600 }}>
                            {fmtPaise(quote.draft?.totals.netPayablePaise ?? 0)}
                          </span>
                        )}
                      </div>
                      {/*
                        THE STAMP IS OUTLINED, NEVER FILLED — desk-one.css §3. A filled stamp reads
                        as a button; this is a state, and a patient sees it upside down across a
                        counter. PANEL when somebody else is paying, UNPAID until the money lands.
                      */}
                      <div style={{ marginTop: 9 }}>
                        <span className={panelPays ? "stamp pd" : "stamp un"} data-testid="token-stamp">
                          {panelPays ? t("billingSeat.rail.panelStamp") : t("billingSeat.rail.unpaidStamp")}
                        </span>
                      </div>
                    </div>
                </>
              )}
            </div>

            <div className="box" style={{ padding: 14 }}>
              <span className="tag">{t("billingSeat.rail.onTheirAccount")}</span>
              <div data-testid="dues-sidebar" style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 5 }}>
                {patient === null && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--faint)" }}>{t("billing.counter.pickPatientFirst")}</p>
                )}
                {patient !== null && (dues.data?.items ?? []).length === 0 && (
                  <>
                    <span className="mo" style={{ fontSize: 19, fontWeight: 600 }}>{fmtPaise(0)}</span>
                    <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("billing.counter.noDues")}</span>
                    <p style={{ margin: "5px 0 0", fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>
                      {t("billingSeat.rail.nothingCarried")}
                    </p>
                  </>
                )}
                {(dues.data?.items ?? []).map((due) => (
                  <div key={due.invoiceId} data-testid={`dues-row-${due.invoiceId}`} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
                    <span className="mo" style={{ color: "var(--dim)" }}>{due.invoiceNo}</span>
                    <span style={{ color: "var(--faint)", fontSize: 11 }}>{due.serviceDay}</span>
                    <span className="mo" style={{ marginLeft: "auto", fontWeight: 600 }}>{fmtPaise(due.outstandingPaise)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="box" style={{ padding: 14 }}>
              <label className="tag" htmlFor="counter-encounter" style={{ display: "block", marginBottom: 5 }}>
                {t("billing.counter.encounter")}
              </label>
              <input
                id="counter-encounter"
                className="in mo"
                value={encounterId}
                onChange={(e) => setEncounterId(e.target.value)}
              />
            </div>
          </div>

          {/* ═══ CENTRE — the bill, the contest, and the money ═══ */}
          <div style={{ flexGrow: 1, minWidth: 380, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="box" style={{ padding: "15px 16px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t("billingSeat.bill.heading")}</span>
                {/* The screen's whole thesis, said out loud where a cashier reads it. */}
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("billingSeat.bill.subtitle")}</span>
              </div>

              <div style={{ display: "flex", gap: 11, padding: "7px 0", marginTop: 11, borderBottom: "1px solid var(--line)" }}>
                <span className="tag" style={{ flexGrow: 1 }}>{t("billingSeat.bill.service")}</span>
                <span className="tag" style={{ width: 38, textAlign: "right" }}>{t("billing.counter.qty")}</span>
                <span className="tag" style={{ width: 88, textAlign: "right" }}>{t("billingSeat.bill.gross")}</span>
                <span className="tag" style={{ width: 88, textAlign: "right" }}>{t("billingSeat.bill.benefit")}</span>
                <span className="tag" style={{ width: 88, textAlign: "right" }}>{t("billingSeat.bill.net")}</span>
              </div>

              {lines.length === 0 ? (
                <p style={{ margin: "11px 0 0", fontSize: 12, color: "var(--faint)" }}>{t("billing.counter.noLines")}</p>
              ) : lines.map((line) => {
                const priced = pricedLines.find((x) => x.lineId === line.lineId);
                return (
                  <div key={line.lineId} data-testid={`line-row-${line.lineId}`} style={{ borderTop: "1px solid var(--line2)", padding: "9px 0" }}>
                    <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
                      <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 13 }}>{line.serviceName}</span>
                        {priced?.gst === undefined ? null : (
                          <span className="mo" style={{ fontSize: 10, color: "var(--faint)" }}>
                            {t("billingSeat.bill.sac", { code: priced.gst.sacCode })}
                            {priced.gst.exempt ? ` · ${t("billingSeat.bill.exempt")}` : ""}
                          </span>
                        )}
                      </span>
                      <label className="sr-only" htmlFor={`line-qty-${line.lineId}`}>{t("billing.counter.qty")}</label>
                      <input
                        id={`line-qty-${line.lineId}`}
                        className="in mo"
                        type="number"
                        min={1}
                        value={line.qty}
                        onChange={(e) =>
                          setLines((current) =>
                            current.map((l) => (l.lineId === line.lineId ? { ...l, qty: Number(e.target.value) } : l)),
                          )
                        }
                        style={{ width: 38, height: 28, padding: "0 5px", textAlign: "right" }}
                      />
                      <span className="mo" style={{ width: 88, textAlign: "right", fontSize: 12.5 }}>
                        {priced === undefined ? "—" : fmtPaise(priced.grossPaise)}
                      </span>
                      {/* Benefit is GREEN when it exists and a faint dash when it does not — never 0.00. */}
                      <span
                        className="mo"
                        style={{
                          width: 88, textAlign: "right", fontSize: 12.5,
                          color: (priced?.discountPaise ?? 0) > 0 ? "var(--green)" : "var(--faint)",
                        }}
                      >
                        {priced === undefined || priced.discountPaise === 0 ? "—" : `−${fmtPaise(priced.discountPaise)}`}
                      </span>
                      <span className="mo" data-testid={`line-net-${line.lineId}`} style={{ width: 88, textAlign: "right", fontSize: 12.5, fontWeight: 600 }}>
                        {priced === undefined ? "—" : fmtPaise(priced.netPaise)}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: 7, marginTop: 7, alignItems: "center", flexWrap: "wrap" }}>
                      <span data-testid={`line-contest-${line.lineId}`} style={{ fontSize: 11, color: "var(--dim)", flexGrow: 1 }}>
                        {priced === undefined || priced.winner === null
                          ? t("billing.counter.noAdjustment")
                          : `${priced.winner.reason} · ${fmtPaise(priced.winner.amountPaise)}`}
                      </span>
                      <button
                        className="sec" type="button" data-testid={`line-discount-${line.lineId}`} style={{ height: 26 }}
                        onClick={() =>
                          setLines((current) =>
                            current.map((l) =>
                              l.lineId === line.lineId
                                ? { ...l, discount: l.discount === null ? { category: "charity", valuePaise: undefined, reason: "" } : null }
                                : l,
                            ),
                          )
                        }
                      >
                        {t("billing.counter.discount")}
                      </button>
                      <button
                        className="sec" type="button" data-testid={`line-remove-${line.lineId}`} style={{ height: 26 }}
                        onClick={() => setLines((current) => current.filter((l) => l.lineId !== line.lineId))}
                      >
                        {t("billing.counter.removeLine")}
                      </button>
                    </div>

                    {line.discount !== null && (
                      <div style={{ marginTop: 9, padding: "11px 12px", background: "var(--wash)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 9 }}>
                        <div>
                          <label className="tag" htmlFor={`discount-category-${line.lineId}`} style={{ display: "block", marginBottom: 5 }}>
                            {t("billing.counter.discountCategory")}
                          </label>
                          <select
                            id={`discount-category-${line.lineId}`}
                            className="in"
                            style={{ height: 36 }}
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
                          >
                            {DISCOUNT_CATEGORIES.map((category) => (
                              <option key={category} value={category}>{t(`billing.discountCategory.${category}`)}</option>
                            ))}
                          </select>
                        </div>
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
                        <div>
                          <label className="tag" htmlFor={`discount-reason-${line.lineId}`} style={{ display: "block", marginBottom: 5 }}>
                            {t("billing.counter.discountReason")}
                          </label>
                          <input
                            id={`discount-reason-${line.lineId}`}
                            className="in"
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
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ═══ WHY THIS PRICE — only when a benefit actually applied ═══ */}
              {contested.length > 0 && (
                <div
                  data-testid="why-this-price"
                  style={{ marginTop: 12, border: "1px solid var(--green-line)", background: "var(--green-soft)", borderRadius: 7, padding: "11px 13px" }}
                >
                  <span className="tag" style={{ color: "var(--green)" }}>{t("billingSeat.contest.heading")}</span>
                  {contested.map((line) => (
                    <div key={line.lineId} style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 9, fontSize: 12 }}>
                        <span style={{ color: "var(--green)", fontWeight: 600, flexGrow: 1 }}>{line.winner?.reason}</span>
                        <span className="mo" style={{ color: "var(--green)", fontWeight: 600 }}>−{fmtPaise(line.winner?.amountPaise ?? 0)}</span>
                      </div>
                      {/*
                        THE LOSER IS NAMED, STRUCK THROUGH, AND THAT IS THE POINT OF THE PANEL: the
                        clerk can answer "what about my camp slip?" without opening another screen.
                        A hidden loser is a question the counter cannot answer.
                      */}
                      {line.candidates.filter((c) => c !== line.winner && c.rejected === null).map((loser) => (
                        <div key={loser.reason} data-testid={`contest-loser-${line.lineId}`} style={{ display: "flex", alignItems: "baseline", gap: 9, fontSize: 11.5, color: "var(--faint)" }}>
                          <span style={{ textDecoration: "line-through", flexGrow: 1 }}>{loser.reason}</span>
                          <span className="mo" style={{ textDecoration: "line-through" }}>−{fmtPaise(loser.amountPaise)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <p style={{ margin: "9px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                    {t("billingSeat.contest.noStacking")}
                  </p>
                </div>
              )}

              {approvalLines.map((line) => (
                <div
                  key={line.lineId}
                  data-testid={`approval-required-${line.lineId}`}
                  style={{ marginTop: 11, border: "1px solid var(--gold-line)", background: "var(--gold-soft)", borderRadius: 7, padding: "11px 13px" }}
                >
                  <p style={{ margin: 0, fontSize: 12, color: "var(--gold)", fontWeight: 600 }}>
                    {t("billing.counter.approvalRequired", { line: line.serviceName })}
                  </p>
                  <label className="tag" htmlFor={`discount-approval-${line.lineId}`} style={{ display: "block", margin: "9px 0 5px" }}>
                    {t("billing.counter.approvalId")}
                  </label>
                  <input
                    id={`discount-approval-${line.lineId}`}
                    className="in mo"
                    value={discountApprovals[line.lineId] ?? ""}
                    onChange={(e) => setDiscountApprovals((current) => ({ ...current, [line.lineId]: e.target.value }))}
                  />
                </div>
              ))}

              {totals !== null && (
                <div style={{ marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 11, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{t("billing.print.netPayable")}</span>
                    <span style={{ fontSize: 11, color: "var(--faint)" }}>
                      {t("billingSeat.bill.gstNote")}
                    </span>
                    <span className="mo" data-testid="preview-net" style={{ marginLeft: "auto", fontSize: 22, fontWeight: 700 }}>
                      {fmtPaise(totals.netPayablePaise)}
                    </span>
                  </div>
                  {/* The server's own four figures, kept because a cashier asked to explain a total needs them. */}
                  <div style={{ display: "flex", gap: 14, marginTop: 7, flexWrap: "wrap", fontSize: 11, color: "var(--dim)" }}>
                    <span data-testid="preview-gross">{t("billing.print.grossTotal")}: {fmtPaise(totals.grossPaise)}</span>
                    <span data-testid="preview-discount">{t("billing.print.discountTotal")}: {fmtPaise(totals.discountPaise)}</span>
                    <span data-testid="preview-tax">{t("billing.print.tax")}: {fmtPaise(totals.cgstPaise + totals.sgstPaise)}</span>
                    <span data-testid="preview-rounding">{t("billing.print.rounding")}: {fmtPaise(totals.roundingPaise)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* ═══ ADD A LINE ═══ */}
            <div className="box" style={{ padding: "15px 16px" }}>
              <label className="tag" htmlFor="counter-service-search" style={{ display: "block", marginBottom: 5 }}>
                {t("billing.counter.addService")}
              </label>
              <input
                id="counter-service-search"
                className="in"
                value={serviceQuery}
                onChange={(e) => setServiceQuery(e.target.value)}
              />
              {serviceMatches.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 7 }}>
                  {serviceMatches.map((service) => (
                    <button
                      key={service.id}
                      type="button"
                      className="sec"
                      data-testid={`add-service-${service.id}`}
                      style={{ justifyContent: "flex-start", gap: 9 }}
                      onClick={() => {
                        setLines((current) => [
                          ...current,
                          { lineId: nextLineId(), serviceId: service.id, serviceName: service.name, qty: 1, discount: null },
                        ]);
                        setServiceQuery("");
                      }}
                    >
                      {service.name}
                      <span className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>{service.code}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ═══ TAKE PAYMENT ═══ */}
            <div className="box" style={{ padding: "15px 16px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t("billingSeat.pay.heading")}</span>
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("billingSeat.pay.laneHint")}</span>
              </div>

              {/*
                THE THREE LANES SEED THE EDITOR BELOW, they do not replace it. The artboard draws the
                common bill — one payment, the exact payable — and a cashier should not assemble that
                by hand. Mixed tenders are real and stay reachable; see `TenderEditor`'s `lane` prop.
              */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9, marginTop: 12 }}>
                {(["cash", "upi", "card"] as const).map((mode, i) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`lane-${mode}`}
                    className={lane?.mode === mode ? "sec grn" : "sec"}
                    style={{ height: 44, gap: 9, justifyContent: "flex-start" }}
                    onClick={() => { takeLane(mode); }}
                    disabled={netPayablePaise === 0}
                  >
                    <span className="kb">{String(i + 1)}</span>
                    <span style={{ fontWeight: lane?.mode === mode ? 600 : 500 }}>{t(`billing.tender.modes.${mode}`)}</span>
                    <span className="mo" style={{ marginLeft: "auto", fontSize: 11.5 }}>
                      {lane?.mode === mode ? fmtPaise(netPayablePaise) : "—"}
                    </span>
                  </button>
                ))}
              </div>

              <div style={{ marginTop: 12 }}>
                <TenderEditor payablePaise={netPayablePaise} onChange={setTenders} lane={lane} />
              </div>

              {/*
                THE SURPLUS BANNER, BEFORE THE MONEY IS TAKEN rather than after. "Whatever is not
                handed back stays on the patient's account as an advance" is a promise the drawer is
                counted on, so the cashier has to read it while they still have the notes in hand.
              */}
              {tenderedPaise > netPayablePaise && netPayablePaise > 0 && (
                <p data-testid="surplus-banner" className="pill gd" style={{ height: "auto", padding: "9px 11px", marginTop: 11 }}>
                  {t("billingSeat.pay.surplus", { amount: fmtPaise(tenderedPaise - netPayablePaise) })}
                </p>
              )}

              {panRequired && (
                <div style={{ marginTop: 11, border: "1px solid var(--gold-line)", background: "var(--gold-soft)", borderRadius: 7, padding: "11px 13px" }}>
                  <label className="tag" htmlFor="counter-pan" style={{ display: "block", marginBottom: 5 }}>{t("billing.counter.pan")}</label>
                  <input
                    id="counter-pan"
                    className="in mo"
                    style={{ textTransform: "uppercase" }}
                    value={panNumber}
                    onChange={(e) => setPanNumber(e.target.value)}
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 9 }}>
                    <input id="counter-form60" type="checkbox" checked={form60} onChange={(e) => setForm60(e.target.checked)} />
                    {t("billing.counter.form60")}
                  </label>
                </div>
              )}

              {remainderPaise > 0 && (
                <div style={{ marginTop: 11, border: "1px solid var(--line)", borderRadius: 7, padding: "11px 13px" }}>
                  <p data-testid="credit-remainder" style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>
                    {t("billing.counter.remainder", { amount: fmtPaise(remainderPaise) })}
                  </p>
                  <label className="tag" htmlFor="counter-credit-reason" style={{ display: "block", margin: "9px 0 5px" }}>
                    {t("billing.counter.creditReason")}
                  </label>
                  <input id="counter-credit-reason" className="in" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
                  {creditApprovalRequired && (
                    <div data-testid="credit-approval-wait" style={{ marginTop: 11, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                      <p style={{ margin: 0, fontSize: 12, color: "var(--gold)" }}>{t("billing.counter.creditApprovalWait")}</p>
                      <label className="tag" htmlFor="counter-credit-approval" style={{ display: "block", margin: "9px 0 5px" }}>
                        {t("billing.counter.approvalId")}
                      </label>
                      <input id="counter-credit-approval" className="in mo" value={creditApprovalId} onChange={(e) => setCreditApprovalId(e.target.value)} />
                    </div>
                  )}
                </div>
              )}

              <ErrorLine message={error} testId="counter-error" />
              {errorCode !== null && (
                <p data-testid="counter-error-code" className="mo" style={{ fontSize: 11, color: "var(--faint)", margin: "5px 0 0" }}>{errorCode}</p>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--line2)", flexWrap: "wrap" }}>
                {/* The LIVE PAYABLE is in the label, because a button that says "Issue" is a button
                    a cashier presses without reading the figure they are about to take. */}
                {/*
                  THE BUTTON SAYS THE FIGURE, AND SAYS SOMETHING ELSE WHEN THERE IS NO FIGURE.

                  A button reading "Issue" is one a cashier presses without reading the amount they
                  are about to take, so the live payable is in the label. But a screenshot of the
                  empty counter showed the consequence: "Take ₹0.00", enabled, on a bill with no
                  lines. Offering to take nothing is not a smaller version of taking money, it is a
                  different act, and pressing it produces a refusal the cashier could have been
                  spared.

                  A PANEL BILL IS THE EXCEPTION and it is why this is not simply disabled at zero:
                  when the payer covers the whole amount the payable IS ₹0.00 and the invoice still
                  has to be issued. So the label distinguishes the two — nothing to bill yet, versus
                  nothing to collect — and only the first is refused.
                */}
                <SubmitButton
                  data-testid="submit-invoice"
                  className="pri"
                  disabled={lines.length === 0}
                  onClick={(k) => submit(k)}
                >
                  {lines.length === 0
                    ? t("billingSeat.pay.nothingToBill")
                    : netPayablePaise === 0
                      ? t("billingSeat.pay.issueNoCollection")
                      : t("billingSeat.pay.take", { amount: fmtPaise(netPayablePaise) })}
                </SubmitButton>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--faint)" }}>
                  {t("billingSeat.pay.printsNote")}
                </span>
              </div>
            </div>
          </div>

          {/* ═══ SCHEME RAIL ═══ */}
          <div style={{ width: 296, flexShrink: 0, display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
              <span className="tag">{t("billingSeat.schemes.heading")}</span>
              <span style={{ fontSize: 11, color: "var(--faint)" }}>{t("billingSeat.schemes.hint")}</span>
            </div>

            <div className="box" style={{ padding: 13 }}>
              <label className="tag" htmlFor="counter-coupons" style={{ display: "block", marginBottom: 5 }}>
                {t("billing.counter.coupons")}
              </label>
              <input
                id="counter-coupons" data-testid="counter-coupons" className="in"
                value={couponText} onChange={(e) => setCouponText(e.target.value)}
                placeholder={t("billing.counter.couponsHint")}
              />
              <label className="tag" htmlFor="counter-referral" style={{ display: "block", margin: "11px 0 5px" }}>
                {t("billing.counter.partnerSlip")}
              </label>
              <input
                id="counter-referral" data-testid="counter-referral" className="in mo"
                value={attributionCode} onChange={(e) => setAttributionCode(e.target.value)}
              />
            </div>

            {/* ═══ THE PANEL CARD — the first surface ever to read `patient_coverages` ═══ */}
            <div className="box" style={{ padding: 13 }} data-testid="panel-card">
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("billingSeat.schemes.corporate")}</span>
                <span className={panelPays ? "pill on" : "pill"} style={{ marginLeft: "auto" }}>
                  {panelPays ? t("billingSeat.schemes.panelPayer") : t("billingSeat.schemes.selfPay")}
                </span>
              </div>
              <p style={{ margin: "7px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>
                {panel === null
                  ? t("billingSeat.schemes.noPanel")
                  : [panel.payerName, panel.employeeId === null ? null : t("billingSeat.schemes.employee", { id: panel.employeeId })]
                    .filter((x) => x !== null).join(" · ")}
              </p>
              {panelPays && (
                <p className="mo" style={{ margin: "7px 0 0", fontSize: 12, fontWeight: 600, color: "var(--green)" }}>
                  {t("billingSeat.schemes.nothingToCollect")}
                </p>
              )}
            </div>

            {/* What is left on a bundle — the question a patient actually asks. */}
            {(preview.data?.balances ?? []).length > 0 && (
              <div className="box" data-testid="counter-balances" style={{ padding: 13 }}>
                <span className="tag">{t("billingSeat.schemes.package")}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {(preview.data?.balances ?? []).map((b) => (
                    <div key={b.benefitKey} data-testid={`balance-${b.benefitKey}`} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
                      <span style={{ fontWeight: 500, flexGrow: 1 }}>{b.title}</span>
                      <span data-testid={`balance-left-${b.benefitKey}`} className="mo" style={{ color: "var(--dim)" }}>
                        {b.unit === "paise"
                          ? t("billing.counter.balanceMoney", { left: fmtPaise(b.remainingQty), granted: fmtPaise(b.grantedQty) })
                          : t("billing.counter.balanceCount", { left: b.remainingQty, granted: b.grantedQty })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p style={{ margin: 0, fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>
              {t("billingSeat.schemes.footer")}
            </p>
          </div>
        </div>
      </div>

      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("billingSeat.agent.placeholder")}
        idle={t("billingSeat.agent.idle")}
      />
    </PaperScreen>
  );
}
