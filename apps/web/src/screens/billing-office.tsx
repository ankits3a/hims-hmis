import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoneyInput } from "../components/money-input";
import { SubmitButton } from "../components/submit-button";
import { fmtPaise } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { api } from "../lib/api";
import { billingErrorMessage } from "../lib/billing-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * THE BACK OFFICE (Plan 08 T16 / D6 / D7 / D9) — four tabs of the work that is NOT the counter:
 * refunds and their corrections, statement reconciliation, the day book, and the GSTR-1 view.
 *
 *  · **THE REPORTS RENDER THE API'S NUMBERS VERBATIM (K46).** The day book prints the figures
 *    `GET /billing/day-book` sends and folds nothing of its own; GSTR-1 prints the STORED head
 *    sums and never re-derives a tax head from a merged base. This is §15.1's rule ("sum the line
 *    heads, never recompute") standing one layer further out, and the plan's self-review item 13
 *    is exactly the observation that a report layer can reintroduce the recompute bug
 *    independently of the persistence layer. The suite's day-book fixture is DELIBERATELY
 *    inconsistent so a recompute lands on a visibly different rupee figure.
 *  · **THE DAY BOOK IS READ LIVE**, from `GET /billing/day-book?day=`, never from the stored
 *    `daily_closes.totals`. `runDailyClose` computes its totals OUTSIDE the `ON CONFLICT DO
 *    NOTHING` claim transaction, so a document that commits inside that window is permanently
 *    absent from the stored close and no re-run repairs it (pipeline B §3.6, carried item 7). The
 *    live query has no such window.
 *  · **GUARD FLAGS ARE WARNINGS, NOT BLOCKS.** `terminal_encounter` and `delivered_line` ride the
 *    approval payload so the approver knows WHY a voucher is escalated (D6 guards 2+3); nothing is
 *    auto-blocked, and a flagged voucher stays fully actionable on this screen.
 *  · **NO PATIENT NAME LOOKUP.** `GET /billing/refunds` carries `patientId` and no name — unlike
 *    every other reader on this surface — and this worklist is CROSS-PATIENT, so rendering names
 *    would mean one `getPatientSummaries` round trip per row. Voucher number, amount and status
 *    are a legitimate back-office worklist; the patient id is rendered as the identifier it is.
 *  · **NO IDENTITY DOCUMENT REFERENCE IS EVER RENDERED.** `GET /billing/refunds` stopped sending
 *    `payeeIdRef` in `30a272d`; `toVoucherRow` below is a second belt that keeps a future
 *    regression off the screen. The pay form COLLECTS a reference — the server requires one at pay
 *    time — but nothing reads one back onto a list. Neither belt is the security boundary: a
 *    caller with the permission can still hit the route directly.
 *  · **THE 403 LANE ASSUMES NOTHING.** This screen holds no permission model: whichever route the
 *    server refuses, the refusal is rendered in ONE shared error state, in the server's own words.
 *    Which permission guards which route is the server's business (§3.5), and a client that
 *    second-guessed the map would be wrong the first time the map changed.
 *
 * The worklists follow the 15 s polling convention; T13's counter owns that convention's teeth
 * (K39/W-3) and this screen follows it.
 */
const POLL_MS = 15_000;

type OfficeTab = "refunds" | "recon" | "daybook" | "gstr1";
const TABS: OfficeTab[] = ["refunds", "recon", "daybook", "gstr1"];

type RefundKind = "invoice_refund" | "advance_refund";
type RefundMethod = "cash" | "bank_transfer";
type ReasonClass = "mistake" | "genuine";

/** The two guards the module computes (D6). An unknown flag is rendered as its own key, never dropped. */
const KNOWN_GUARD_FLAGS = ["terminal_encounter", "delivered_line"];

/** `GET /billing/refunds` — `RefundVoucherListRow`, already `payeeIdRef`-free at the server. */
type WireRefundVoucher = {
  id: string;
  voucherNo: string;
  patientId: string;
  kind: RefundKind;
  creditNoteId: string | null;
  invoiceId: string | null;
  amountPaise: number;
  method: RefundMethod;
  payeeName: string | null;
  payeeIdType: string | null;
  reasonClass: ReasonClass;
  reason: string;
  guardFlags: string[];
  approvalId: string;
  status: "issued" | "paid";
  requestedBy: string;
  issuedAt: string;
  paidBy: string | null;
  paidAt: string | null;
  cashierSessionId: string | null;
};

/** The EIGHT fields of a voucher this worklist renders. Nothing else survives `toVoucherRow`. */
type VoucherRow = {
  id: string; voucherNo: string; patientId: string; kind: RefundKind;
  amountPaise: number; method: RefundMethod; status: "issued" | "paid";
  guardFlags: string[];
};

/**
 * THE PROJECTION. The route answers with a row shaped by the server and this screen takes the eight
 * fields it renders, dropping the rest — including anything a future regression adds back beside
 * the payee columns. `payeeName`/`payeeIdType` are legitimate at PAY time and are typed into the
 * form there; they are not worklist columns, so they do not survive here either.
 */
function toVoucherRow(row: WireRefundVoucher): VoucherRow {
  return {
    id: row.id,
    voucherNo: row.voucherNo,
    patientId: row.patientId,
    kind: row.kind,
    amountPaise: row.amountPaise,
    method: row.method,
    status: row.status,
    guardFlags: Array.isArray(row.guardFlags) ? row.guardFlags.map(String) : [],
  };
}

type WireRequestRefundResult = {
  approvalId: string; instanceId: string; patientId: string;
  invoiceId: string | null; creditNoteId: string | null;
  amountPaise: number; guardFlags: string[];
};

type WireIssueRefundResult = {
  voucherId: string; voucherNo: string; patientId: string; kind: RefundKind;
  invoiceId: string | null; creditNoteId: string | null;
  amountPaise: number; method: RefundMethod; guardFlags: string[]; status: "issued";
};

type WirePayRefundResult = {
  voucherId: string; voucherNo: string; patientId: string;
  amountPaise: number; method: RefundMethod;
  cashierSessionId: string | null; paidAt: string; status: "paid";
};

type WireMarkEnteredInErrorResult = { markId: string; reversedAllocationIds: string[] };

type WireUploadSettlementResult = {
  batchId: string; rowsTotal: number; rowsMatched: number;
  rowsMismatched: number; rowsUnmatched: number; unmatchedRefs: string[];
};

type WireMismatchRow = {
  tenderId: string; receiptId: string; receiptNo: string;
  patientId: string; uhid: string;
  name: string | null; alias: string | null; restricted: boolean;
  mode: "upi" | "card";
  amountPaise: number; expectedNetPaise: number; settledPaise: number;
  mismatchNote: string | null; reconciledAt: string | null;
};

type WireTenderTotals = { cash: number; upi: number; card: number };

/** `GET /billing/day-book?day=` — D9's live day book. Every figure here is rendered as it arrived. */
type WireDayBook = {
  day: string;
  receipts: { count: number; totalPaise: number; byMode: WireTenderTotals };
  degraded: { count: number; totalPaise: number };
  invoices: { count: number; netPayablePaise: number };
  creditNotes: { count: number; netPaise: number };
  vouchersPaid: { count: number; amountPaise: number };
};

/** `GET /billing/gstr1?from=&to=` — one row per (buyer GSTIN, SAC, rate, exempt) group. */
type WireGstr1Row = {
  buyerGstin: string | null;
  sacCode: string; rateBps: number; exempt: boolean;
  taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
};

type Gstr1Group = { key: string; gstin: string | null; rows: WireGstr1Row[] };

/**
 * Groups in the order the SERVER sorted them (B2C first, then each GSTIN) — the client re-sorts
 * nothing. The group subtotals are a fold over the heads the API SENT; no head is ever derived from
 * a base, here or anywhere else on this screen.
 */
function groupGstr1(rows: WireGstr1Row[]): Gstr1Group[] {
  const groups: Gstr1Group[] = [];
  for (const row of rows) {
    const key = row.buyerGstin ?? "b2c";
    const existing = groups.find((g) => g.key === key);
    if (existing === undefined) groups.push({ key, gstin: row.buyerGstin, rows: [row] });
    else existing.rows.push(row);
  }
  return groups;
}

function sumOf(rows: WireGstr1Row[], of: (row: WireGstr1Row) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}

/** A digit shortcut must never fire while the operator is typing an amount or a reason into a field. */
function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function BillingOffice(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [tab, setTab] = useState<OfficeTab>("refunds");

  // ——— refunds: request → issue → pay, and the entered-in-error correction ———
  const [kind, setKind] = useState<RefundKind>("advance_refund");
  const [subject, setSubject] = useState("");
  const [amountPaise, setAmountPaise] = useState<number | undefined>(undefined);
  const [reasonClass, setReasonClass] = useState<ReasonClass>("mistake");
  const [reason, setReason] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ result: WireRequestRefundResult; body: Record<string, unknown> } | null>(null);

  const [method, setMethod] = useState<RefundMethod>("cash");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<WireIssueRefundResult | null>(null);

  const [payVoucherId, setPayVoucherId] = useState<string | null>(null);
  const [payeeName, setPayeeName] = useState("");
  const [payeeIdType, setPayeeIdType] = useState("");
  const [payeeIdRef, setPayeeIdRef] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [paid, setPaid] = useState<WirePayRefundResult | null>(null);

  const [eieReceiptId, setEieReceiptId] = useState("");
  const [eieReason, setEieReason] = useState("");
  const [eieConfirming, setEieConfirming] = useState(false);
  const [eieError, setEieError] = useState<string | null>(null);
  const [eieDone, setEieDone] = useState<WireMarkEnteredInErrorResult | null>(null);

  // ——— recon ———
  const [csv, setCsv] = useState("");
  const [source, setSource] = useState<"upi" | "card">("upi");
  const [reconError, setReconError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<WireUploadSettlementResult | null>(null);

  // ——— reports ———
  /**
   * The day defaults to the IST calendar day (`todayIst`, the shipped export of `lib/opd-api.ts` —
   * imported, never re-implemented: a second copy of a date derivation is how two screens end up
   * disagreeing about which day it is at 01:00 IST, when the UTC date is still yesterday).
   */
  const [day, setDay] = useState<string>(() => todayIst());
  const [fromDraft, setFromDraft] = useState<string>(() => todayIst());
  const [toDraft, setToDraft] = useState<string>(() => todayIst());
  const [range, setRange] = useState<{ from: string; to: string }>(() => ({ from: todayIst(), to: todayIst() }));

  // ——— reads (each gated to its own tab, so a tab nobody opened costs nothing) ———

  const vouchers = useQuery({
    queryKey: ["billing-office", "refunds"],
    queryFn: async () => {
      const res = await api<{ items: WireRefundVoucher[] }>("GET", "/billing/refunds");
      return res.items.map(toVoucherRow);
    },
    enabled: tab === "refunds",
    refetchInterval: POLL_MS,
  });

  const mismatches = useQuery({
    queryKey: ["billing-office", "mismatches"],
    queryFn: async () => {
      const res = await api<{ items: WireMismatchRow[] }>("GET", "/billing/recon/mismatches");
      return res.items;
    },
    enabled: tab === "recon",
    refetchInterval: POLL_MS,
  });

  const dayBook = useQuery({
    queryKey: ["billing-office", "day-book", day],
    queryFn: () => api<WireDayBook>("GET", `/billing/day-book?day=${encodeURIComponent(day)}`),
    enabled: tab === "daybook",
    refetchInterval: POLL_MS,
  });

  const gstr1 = useQuery({
    queryKey: ["billing-office", "gstr1", range.from, range.to],
    queryFn: async () => {
      const res = await api<{ rows: WireGstr1Row[] }>(
        "GET",
        `/billing/gstr1?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      );
      return res.rows;
    },
    enabled: tab === "gstr1",
  });

  /**
   * ONE shared error state, and it is the ACTIVE tab's read that fills it. The screen makes no claim
   * about WHICH permission guards which route — it renders whatever the server refused, in the
   * server's own words, wherever the operator was looking.
   */
  const active = tab === "refunds" ? vouchers : tab === "recon" ? mismatches : tab === "daybook" ? dayBook : gstr1;
  const loadError = active.error === null ? null : billingErrorMessage(active.error);

  const voucherRows = vouchers.data ?? [];
  const mismatchRows = mismatches.data ?? [];
  const gstr1Groups = groupGstr1(gstr1.data ?? []);

  // ——— tab shortcuts (1/2/3/4), screen-local: lib/keyboard.tsx owns the global ones ———

  const tabRef = useRef(setTab);
  tabRef.current = setTab;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
      // "1".."4" → the four tabs. Anything else (including "" and a letter) indexes to undefined.
      const next = TABS[Number(e.key) - 1];
      if (next === undefined) return;
      e.preventDefault();
      tabRef.current(next);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ——— writes ———

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["billing-office"] });
  };

  /** The request body, in the discriminated shape `requestRefundBody` parses (D6). */
  const requestBody = (): Record<string, unknown> | null => {
    if (subject.trim() === "" || amountPaise === undefined || reason.trim() === "") return null;
    const common = { amountPaise, reasonClass, reason: reason.trim() };
    return kind === "advance_refund"
      ? { kind, patientId: subject.trim(), ...common }
      : { kind, creditNoteId: subject.trim(), ...common };
  };

  const fileRequest = async (idemKey: string): Promise<void> => {
    const body = requestBody();
    if (body === null) {
      setRequestError(t("billingOffice.request.required"));
      return;
    }
    setRequestError(null);
    try {
      const result = await api<WireRequestRefundResult>("POST", "/billing/refunds/request", body, idemKey);
      setFiled({ result, body });
      setIssued(null);
      setIssueError(null);
    } catch (e) {
      setRequestError(billingErrorMessage(e));
    }
  };

  /**
   * The voucher is issued against the approval the request filed. The screen sends the approval id
   * it was given and the method the manager chose; the grant itself is checked ON EXECUTE, at the
   * server, which owns it — this screen never decides that an approval is good enough.
   */
  const issueVoucher = async (idemKey: string): Promise<void> => {
    if (filed === null) return;
    setIssueError(null);
    try {
      const result = await api<WireIssueRefundResult>("POST", "/billing/refunds", {
        ...filed.body,
        approvalId: filed.result.approvalId,
        method,
      }, idemKey);
      setIssued(result);
      await refresh();
    } catch (e) {
      setIssueError(billingErrorMessage(e));
    }
  };

  const openPayLane = (voucherId: string): void => {
    setPayVoucherId(voucherId);
    setPayeeName("");
    setPayeeIdType("");
    setPayeeIdRef("");
    setPayError(null);
    setPaid(null);
  };

  const payVoucher = async (idemKey: string): Promise<void> => {
    if (payVoucherId === null) return;
    // The client-side mirror of `payRefundBody`. The SERVER is the authority; this only spares the
    // operator a round trip, and it never decides that an identity is acceptable.
    if (payeeName.trim() === "" || payeeIdType.trim() === "" || payeeIdRef.trim() === "") {
      setPayError(t("billingOffice.pay.required"));
      return;
    }
    setPayError(null);
    try {
      const result = await api<WirePayRefundResult>(
        "POST",
        `/billing/refunds/${encodeURIComponent(payVoucherId)}/pay`,
        { payeeName: payeeName.trim(), payeeIdType: payeeIdType.trim(), payeeIdRef: payeeIdRef.trim() },
        idemKey,
      );
      setPaid(result);
      setPayVoucherId(null);
      await refresh();
    } catch (e) {
      setPayError(billingErrorMessage(e));
    }
  };

  const openEieConfirm = (): void => {
    if (eieReceiptId.trim() === "" || eieReason.trim() === "") {
      setEieError(t("billingOffice.eie.required"));
      return;
    }
    setEieError(null);
    setEieDone(null);
    setEieConfirming(true);
  };

  const markEnteredInError = async (idemKey: string): Promise<void> => {
    setEieConfirming(false);
    try {
      const result = await api<WireMarkEnteredInErrorResult>("POST", "/billing/eie", {
        receiptId: eieReceiptId.trim(),
        reason: eieReason.trim(),
      }, idemKey);
      setEieDone(result);
      setEieReceiptId("");
      setEieReason("");
      await refresh();
    } catch (e) {
      setEieError(billingErrorMessage(e));
    }
  };

  /**
   * E-26. The CSV is a NAMED FIELD of the body, never the body itself: `POST /billing/recon/upload`
   * parses `{ csv, source }`, and `source` names what statement this batch IS (`recon_batches.source`),
   * not a filter on what it may match against.
   */
  const uploadStatement = async (): Promise<void> => {
    if (csv.trim() === "") {
      setReconError(t("billingOffice.recon.required"));
      return;
    }
    setReconError(null);
    try {
      const result = await api<WireUploadSettlementResult>("POST", "/billing/recon/upload", { csv, source });
      setUploaded(result);
      await refresh();
    } catch (e) {
      setReconError(billingErrorMessage(e));
    }
  };

  // ——— render helpers ———

  const flagLabel = (flag: string): string =>
    KNOWN_GUARD_FLAGS.includes(flag) ? t(`billingOffice.guardFlags.${flag}`) : flag;

  const flagChip = (idPrefix: string, flag: string): React.ReactElement => (
    <span
      key={flag}
      role="status"
      data-testid={`${idPrefix}-${flag}`}
      className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
    >
      ⚠ {flagLabel(flag)}
    </span>
  );

  const figure = (id: string, label: string, count: number, paise: number): React.ReactElement => (
    <div className="rounded border p-2">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums" data-testid={`daybook-${id}-total`}>{fmtPaise(paise)}</p>
      <p className="text-xs text-neutral-600">
        {t("billingOffice.dayBook.count")}: <span data-testid={`daybook-${id}-count`}>{count}</span>
      </p>
    </div>
  );

  // ——— tabs ———

  const refundsTab = (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="space-y-2 rounded border p-2">
          <h2 className="text-sm font-semibold">{t("billingOffice.request.title")}</h2>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="refund-kind">{t("billingOffice.request.kind")}</label>
            <select
              id="refund-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as RefundKind);
                setSubject("");
              }}
              className="w-full rounded border px-2 py-1"
            >
              <option value="advance_refund">{t("billingOffice.request.kindAdvance")}</option>
              <option value="invoice_refund">{t("billingOffice.request.kindInvoice")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="refund-subject">
              {kind === "advance_refund" ? t("billingOffice.request.patient") : t("billingOffice.request.creditNote")}
            </label>
            <input
              id="refund-subject"
              value={subject}
              autoComplete="off"
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          <MoneyInput id="refund-amount" label={t("billingOffice.request.amount")} onChange={setAmountPaise} />
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="refund-reason-class">
              {t("billingOffice.request.reasonClass")}
            </label>
            <select
              id="refund-reason-class"
              value={reasonClass}
              onChange={(e) => setReasonClass(e.target.value as ReasonClass)}
              className="w-full rounded border px-2 py-1"
            >
              <option value="mistake">{t("billingOffice.request.mistake")}</option>
              <option value="genuine">{t("billingOffice.request.genuine")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="refund-reason">{t("billingOffice.request.reason")}</label>
            <input
              id="refund-reason"
              value={reason}
              autoComplete="off"
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          {requestError !== null && (
            <p role="alert" data-testid="refund-request-error" className="text-sm text-red-600">{requestError}</p>
          )}
          <SubmitButton data-testid="refund-request-submit" onClick={(k) => fileRequest(k)}>
            {t("billingOffice.request.submit")}
          </SubmitButton>

          {filed !== null && (
            <div className="space-y-2 rounded border border-amber-400 p-2">
              <p role="status" data-testid="refund-request-filed" className="text-sm text-amber-800">
                {t("billingOffice.request.filed", { approvalId: filed.result.approvalId })}
              </p>
              {filed.result.guardFlags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {filed.result.guardFlags.map((flag) => flagChip("request-flag", flag))}
                </div>
              )}
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="issue-method">{t("billingOffice.issue.method")}</label>
                <select
                  id="issue-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as RefundMethod)}
                  className="w-full rounded border px-2 py-1"
                >
                  <option value="cash">{t("billingOffice.issue.cash")}</option>
                  <option value="bank_transfer">{t("billingOffice.issue.bankTransfer")}</option>
                </select>
              </div>
              {issueError !== null && (
                <p role="alert" data-testid="issue-error" className="text-sm text-red-600">{issueError}</p>
              )}
              <SubmitButton data-testid="issue-submit" onClick={(k) => issueVoucher(k)}>
                {t("billingOffice.issue.submit")}
              </SubmitButton>
              {issued !== null && (
                <p role="status" data-testid="issue-done" className="text-sm">
                  {t("billingOffice.issue.done", { voucherNo: issued.voucherNo })}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ——— the correction lane: voiding a receipt reverses everything it settled ——— */}
        <div className="space-y-2 rounded border p-2">
          <h2 className="text-sm font-semibold">{t("billingOffice.eie.title")}</h2>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="eie-receipt">{t("billingOffice.eie.receipt")}</label>
            <input
              id="eie-receipt"
              value={eieReceiptId}
              autoComplete="off"
              onChange={(e) => setEieReceiptId(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="eie-reason">{t("billingOffice.eie.reason")}</label>
            <input
              id="eie-reason"
              value={eieReason}
              autoComplete="off"
              onChange={(e) => setEieReason(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          {eieError !== null && (
            <p role="alert" data-testid="eie-error" className="text-sm text-red-600">{eieError}</p>
          )}
          <Button variant="outline" data-testid="eie-open" onClick={openEieConfirm}>
            {t("billingOffice.eie.submit")}
          </Button>
          {eieDone !== null && (
            <p role="status" data-testid="eie-done" className="text-sm">
              {/* `reversed`, never `count`: i18next reads a `count` variable as a PLURAL selector
                  and would go looking for `done_one` / `done_other` keys that do not exist. */}
              {t("billingOffice.eie.done", { reversed: eieDone.reversedAllocationIds.length })}
            </p>
          )}
        </div>
      </div>

      {/* ——— the voucher worklist ——— */}
      <div className="space-y-2 rounded border p-2">
        <h2 className="text-sm font-semibold">{t("billingOffice.worklist.title")}</h2>
        <p data-testid="guard-flag-note" className="text-xs text-neutral-600">
          {t("billingOffice.guardFlags.note")}
        </p>
        {voucherRows.length === 0 ? (
          <p data-testid="no-vouchers" className="text-sm text-neutral-500">{t("billingOffice.worklist.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {voucherRows.map((row) => (
              <li key={row.id} data-testid={`voucher-row-${row.id}`} className="space-y-1 rounded border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid={`voucher-no-${row.id}`} className="font-semibold">{row.voucherNo}</span>
                  <Badge data-testid={`voucher-status-${row.id}`} variant={row.status === "paid" ? "outline" : "default"}>
                    {t(`billingOffice.status.${row.status}`)}
                  </Badge>
                  <span data-testid={`voucher-amount-${row.id}`} className="tabular-nums">{fmtPaise(row.amountPaise)}</span>
                  <span className="text-neutral-600">{t(`billingOffice.kind.${row.kind}`)}</span>
                  <span className="text-neutral-600">{t(`billingOffice.method.${row.method}`)}</span>
                  {/* patientId, not a name: no lookup per row (carried item 10) */}
                  <span data-testid={`voucher-patient-${row.id}`} className="text-xs text-neutral-500">
                    {t("billingOffice.worklist.patient")}: {row.patientId}
                  </span>
                </div>
                {row.guardFlags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {row.guardFlags.map((flag) => flagChip(`voucher-flag-${row.id}`, flag))}
                  </div>
                )}
                {row.status === "issued" && (
                  <Button size="sm" data-testid={`voucher-pay-${row.id}`} onClick={() => openPayLane(row.id)}>
                    {t("billingOffice.pay.open")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {payVoucherId !== null && (
          <div className="space-y-2 rounded border border-blue-400 p-2">
            <h3 className="text-sm font-semibold">{t("billingOffice.pay.title")}</h3>
            <p className="text-xs text-neutral-600">{t("billingOffice.pay.serverIsAuthority")}</p>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="pay-payee-name">{t("billingOffice.pay.payeeName")}</label>
              <input
                id="pay-payee-name"
                value={payeeName}
                autoComplete="off"
                onChange={(e) => setPayeeName(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="pay-payee-id-type">
                {t("billingOffice.pay.payeeIdType")}
              </label>
              <select
                id="pay-payee-id-type"
                value={payeeIdType}
                onChange={(e) => setPayeeIdType(e.target.value)}
                className="w-full rounded border px-2 py-1"
              >
                <option value="">{t("billingOffice.pay.payeeIdTypePlaceholder")}</option>
                <option value="aadhaar">{t("billingOffice.pay.aadhaar")}</option>
                <option value="pan">{t("billingOffice.pay.pan")}</option>
                <option value="voter_id">{t("billingOffice.pay.voterId")}</option>
                <option value="driving_licence">{t("billingOffice.pay.drivingLicence")}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="pay-payee-id-ref">
                {t("billingOffice.pay.payeeIdRef")}
              </label>
              <input
                id="pay-payee-id-ref"
                value={payeeIdRef}
                autoComplete="off"
                onChange={(e) => setPayeeIdRef(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
            </div>
            {payError !== null && (
              <p role="alert" data-testid="pay-error" className="text-sm text-red-600">{payError}</p>
            )}
            <div className="flex gap-2">
              <SubmitButton data-testid="pay-submit" onClick={(k) => payVoucher(k)}>{t("billingOffice.pay.submit")}</SubmitButton>
              <Button variant="outline" onClick={() => setPayVoucherId(null)}>{t("billingOffice.cancel")}</Button>
            </div>
          </div>
        )}
        {paid !== null && (
          <p role="status" data-testid="pay-done" className="text-sm">
            {t("billingOffice.pay.done", { voucherNo: paid.voucherNo })}
          </p>
        )}
      </div>
    </div>
  );

  const reconTab = (
    <div className="space-y-3">
      <div className="space-y-2 rounded border p-2">
        <h2 className="text-sm font-semibold">{t("billingOffice.recon.title")}</h2>
        <p className="text-xs text-neutral-600">{t("billingOffice.recon.degradedNote")}</p>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="recon-csv">{t("billingOffice.recon.csv")}</label>
          <textarea
            id="recon-csv"
            value={csv}
            rows={6}
            onChange={(e) => setCsv(e.target.value)}
            className="w-full rounded border px-2 py-1 font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="recon-source">{t("billingOffice.recon.source")}</label>
          <select
            id="recon-source"
            value={source}
            onChange={(e) => setSource(e.target.value as "upi" | "card")}
            className="rounded border px-2 py-1"
          >
            <option value="upi">{t("billingOffice.recon.upi")}</option>
            <option value="card">{t("billingOffice.recon.card")}</option>
          </select>
        </div>
        {reconError !== null && (
          <p role="alert" data-testid="recon-error" className="text-sm text-red-600">{reconError}</p>
        )}
        <SubmitButton data-testid="recon-submit" onClick={() => uploadStatement()}>
          {t("billingOffice.recon.submit")}
        </SubmitButton>
      </div>

      {uploaded !== null && (
        <div className="grid gap-2 rounded border p-2 text-sm sm:grid-cols-4">
          <p>{t("billingOffice.recon.rowsTotal")}: <span data-testid="recon-rows-total" className="font-semibold">{uploaded.rowsTotal}</span></p>
          <p>{t("billingOffice.recon.rowsMatched")}: <span data-testid="recon-rows-matched" className="font-semibold">{uploaded.rowsMatched}</span></p>
          <p>{t("billingOffice.recon.rowsMismatched")}: <span data-testid="recon-rows-mismatched" className="font-semibold">{uploaded.rowsMismatched}</span></p>
          <p>{t("billingOffice.recon.rowsUnmatched")}: <span data-testid="recon-rows-unmatched" className="font-semibold">{uploaded.rowsUnmatched}</span></p>
          {/* Unmatched refs are REPORTED, never guessed onto a tender (D7). */}
          <p className="sm:col-span-4">
            {t("billingOffice.recon.unmatchedRefs")}:{" "}
            <span data-testid="recon-unmatched-refs" className="font-mono text-xs">
              {uploaded.unmatchedRefs.length === 0 ? "—" : uploaded.unmatchedRefs.join(", ")}
            </span>
          </p>
        </div>
      )}

      <div className="space-y-2 rounded border p-2">
        <h2 className="text-sm font-semibold">{t("billingOffice.recon.worklist")}</h2>
        {mismatchRows.length === 0 ? (
          <p data-testid="no-mismatches" className="text-sm text-neutral-500">{t("billingOffice.recon.noMismatches")}</p>
        ) : (
          <ul className="space-y-2">
            {mismatchRows.map((row) => (
              <li key={row.tenderId} data-testid={`mismatch-row-${row.tenderId}`} className="rounded border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span data-testid={`mismatch-receipt-${row.tenderId}`} className="font-semibold">{row.receiptNo}</span>
                  <span className="text-neutral-600">{t(`billingOffice.method.${row.mode}`)}</span>
                  <span>
                    {t("billingOffice.recon.expected")}:{" "}
                    <span data-testid={`mismatch-expected-${row.tenderId}`} className="tabular-nums">
                      {fmtPaise(row.expectedNetPaise)}
                    </span>
                  </span>
                  <span>
                    {t("billingOffice.recon.settled")}:{" "}
                    <span data-testid={`mismatch-settled-${row.tenderId}`} className="tabular-nums text-red-600">
                      {fmtPaise(row.settledPaise)}
                    </span>
                  </span>
                </div>
                {row.mismatchNote !== null && <p className="text-xs text-neutral-500">{row.mismatchNote}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const book = dayBook.data ?? null;
  const dayBookTab = (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="day-book-day">{t("billingOffice.dayBook.day")}</label>
        <input
          id="day-book-day"
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border px-2 py-1 tabular-nums"
        />
      </div>
      <p className="text-xs text-neutral-600">{t("billingOffice.dayBook.liveNote")}</p>
      {book !== null && (
        <>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {figure("receipts", t("billingOffice.dayBook.receipts"), book.receipts.count, book.receipts.totalPaise)}
            {figure("invoices", t("billingOffice.dayBook.invoices"), book.invoices.count, book.invoices.netPayablePaise)}
            {figure("credit-notes", t("billingOffice.dayBook.creditNotes"), book.creditNotes.count, book.creditNotes.netPaise)}
            {figure("vouchers", t("billingOffice.dayBook.vouchersPaid"), book.vouchersPaid.count, book.vouchersPaid.amountPaise)}
            {figure("degraded", t("billingOffice.dayBook.degraded"), book.degraded.count, book.degraded.totalPaise)}
          </div>
          <div className="flex flex-wrap gap-4 rounded border p-2 text-sm">
            <span>
              {t("billingOffice.method.cash")}:{" "}
              <span data-testid="daybook-mode-cash" className="tabular-nums">{fmtPaise(book.receipts.byMode.cash)}</span>
            </span>
            <span>
              {t("billingOffice.method.upi")}:{" "}
              <span data-testid="daybook-mode-upi" className="tabular-nums">{fmtPaise(book.receipts.byMode.upi)}</span>
            </span>
            <span>
              {t("billingOffice.method.card")}:{" "}
              <span data-testid="daybook-mode-card" className="tabular-nums">{fmtPaise(book.receipts.byMode.card)}</span>
            </span>
            <span className="text-neutral-500" data-testid="daybook-day">{book.day}</span>
          </div>
        </>
      )}
    </div>
  );

  const gstr1Tab = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="gstr1-from">{t("billingOffice.gstr1.from")}</label>
          <input
            id="gstr1-from"
            type="date"
            value={fromDraft}
            onChange={(e) => setFromDraft(e.target.value)}
            className="rounded border px-2 py-1 tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="gstr1-to">{t("billingOffice.gstr1.to")}</label>
          <input
            id="gstr1-to"
            type="date"
            value={toDraft}
            onChange={(e) => setToDraft(e.target.value)}
            className="rounded border px-2 py-1 tabular-nums"
          />
        </div>
        <Button data-testid="gstr1-run" onClick={() => setRange({ from: fromDraft, to: toDraft })}>
          {t("billingOffice.gstr1.run")}
        </Button>
      </div>
      <p className="text-xs text-neutral-600">{t("billingOffice.gstr1.verbatimNote")}</p>
      {gstr1Groups.length === 0 ? (
        <p data-testid="gstr1-empty" className="text-sm text-neutral-500">{t("billingOffice.gstr1.empty")}</p>
      ) : (
        gstr1Groups.map((group) => (
          <div key={group.key} className="space-y-1 rounded border p-2">
            <h3 data-testid={`gstr1-head-${group.key}`} className="text-sm font-semibold">
              {group.gstin === null ? t("billingOffice.gstr1.b2c") : t("billingOffice.gstr1.b2b", { gstin: group.gstin })}
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500">
                  <th>{t("billingOffice.gstr1.sac")}</th>
                  <th>{t("billingOffice.gstr1.rate")}</th>
                  <th className="text-right">{t("billingOffice.gstr1.base")}</th>
                  <th className="text-right">{t("billingOffice.gstr1.cgst")}</th>
                  <th className="text-right">{t("billingOffice.gstr1.sgst")}</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row, i) => (
                  <tr key={`${row.sacCode}-${String(row.rateBps)}-${String(row.exempt)}`} data-testid={`gstr1-row-${group.key}-${String(i)}`}>
                    <td className="tabular-nums">{row.sacCode}</td>
                    <td>
                      {row.exempt ? (
                        <Badge data-testid={`gstr1-exempt-${group.key}-${String(i)}`} variant="outline">
                          {t("billingOffice.gstr1.exempt")}
                        </Badge>
                      ) : (
                        <span className="tabular-nums">{t("billingOffice.gstr1.ratePct", { pct: row.rateBps / 100 })}</span>
                      )}
                    </td>
                    {/* VERBATIM: the stored head sums, never re-derived from the merged base (K46/K35). */}
                    <td data-testid={`gstr1-base-${group.key}-${String(i)}`} className="text-right tabular-nums">
                      {fmtPaise(row.taxableBasePaise)}
                    </td>
                    <td data-testid={`gstr1-cgst-${group.key}-${String(i)}`} className="text-right tabular-nums">
                      {fmtPaise(row.cgstPaise)}
                    </td>
                    <td data-testid={`gstr1-sgst-${group.key}-${String(i)}`} className="text-right tabular-nums">
                      {fmtPaise(row.sgstPaise)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td colSpan={2}>{t("billingOffice.gstr1.total")}</td>
                  <td data-testid={`gstr1-total-base-${group.key}`} className="text-right tabular-nums">
                    {fmtPaise(sumOf(group.rows, (r) => r.taxableBasePaise))}
                  </td>
                  <td data-testid={`gstr1-total-cgst-${group.key}`} className="text-right tabular-nums">
                    {fmtPaise(sumOf(group.rows, (r) => r.cgstPaise))}
                  </td>
                  <td data-testid={`gstr1-total-sgst-${group.key}`} className="text-right tabular-nums">
                    {fmtPaise(sumOf(group.rows, (r) => r.sgstPaise))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("billingOffice.title")}</h1>

      {loadError !== null && (
        <p role="alert" data-testid="load-error" className="text-sm text-red-600">{loadError}</p>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as OfficeTab)}>
        <TabsList>
          <TabsTrigger value="refunds" data-testid="tab-refunds">{t("billingOffice.tabs.refunds")}</TabsTrigger>
          <TabsTrigger value="recon" data-testid="tab-recon">{t("billingOffice.tabs.recon")}</TabsTrigger>
          <TabsTrigger value="daybook" data-testid="tab-daybook">{t("billingOffice.tabs.dayBook")}</TabsTrigger>
          <TabsTrigger value="gstr1" data-testid="tab-gstr1">{t("billingOffice.tabs.gstr1")}</TabsTrigger>
        </TabsList>
        <TabsContent value="refunds">{refundsTab}</TabsContent>
        <TabsContent value="recon">{reconTab}</TabsContent>
        <TabsContent value="daybook">{dayBookTab}</TabsContent>
        <TabsContent value="gstr1">{gstr1Tab}</TabsContent>
      </Tabs>

      {/* The cascade is named BEFORE the operator confirms, not after: voiding a receipt reverses
          every allocation it made, and there is no undo on the other side of this button. */}
      <Dialog open={eieConfirming} onOpenChange={setEieConfirming}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("billingOffice.eie.confirmTitle")}</DialogTitle></DialogHeader>
          <p data-testid="eie-cascade" className="text-sm">
            {t("billingOffice.eie.cascade", { receiptId: eieReceiptId })}
          </p>
          <div className="flex gap-2">
            <SubmitButton data-testid="eie-confirm-submit" onClick={(k) => markEnteredInError(k)}>
              {t("billingOffice.eie.confirm")}
            </SubmitButton>
            <Button variant="outline" onClick={() => setEieConfirming(false)}>{t("billingOffice.cancel")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
