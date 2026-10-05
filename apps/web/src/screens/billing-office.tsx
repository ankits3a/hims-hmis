import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoneyInput } from "../components/money-input";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { SubmitButton } from "../components/submit-button";
import { fmtPaise } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { api } from "../lib/api";
import { billingErrorMessage, billingPatientLabel } from "../lib/billing-api";
import type { WireChargeOrphan } from "../lib/billing-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FeeSwitches } from "./billing-office/fee-switches";
import { ConsultPrices } from "./billing-office/consult-prices";
import { useAuth } from "../lib/auth";
import { dayWords, fetchBillingNeeds } from "../lib/billing-office-api";
import { istClock, istDateLabel } from "./desk-one/model";
import { MENU, OLD_TABS, SIDE_KEYS, pagesOf } from "./billing-office/pages";
import { TodayDesk } from "./billing-office/today";
import type { OfficePage, OfficeView } from "./billing-office/pages";
import "../styles/paper-pine.css";
import "./desk-one/desk-one.css";
import "./pharmacy-office/pharmacy-office.css";
import "./billing-office/billing-office.css";

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
 *  · **NO PATIENT NAME LOOKUP FROM THE BROWSER.** The worklist is CROSS-PATIENT, so a name read
 *    per row would be an N+1. UX-AUDIT 2026-09-28: the office was reading "Patient: p-1" off every
 *    voucher, so `GET /billing/refunds` now carries the alias-safe summary (uhid, name, alias,
 *    restricted) from ONE server-side `getPatientSummaries` batch — the `listMismatches`
 *    precedent. The screen still makes no patient call of its own, and a restricted row renders
 *    its alias through `billingPatientLabel`, never a name (§14).
 *  · **NO IDENTITY DOCUMENT REFERENCE IS EVER RENDERED.** `GET /billing/refunds` stopped sending
 *    `payeeIdRef` in `30a272d`; `toVoucherRow` below is a second belt that keeps a future
 *    regression off the screen. OWNER RULING 2026-09-28 — Aadhaar is never stored: the pay flow
 *    (`billing-office/hand.tsx`) no longer collects a reference at all, only the payee's name and
 *    the TYPE of ID shown. Neither belt is the security boundary: a caller with the permission can
 *    still hit the route directly, and `payRefundVoucher` refuses an Aadhaar number there.
 *  · **THE 403 LANE ASSUMES NOTHING.** This screen holds no permission model: whichever route the
 *    server refuses, the refusal is rendered in ONE shared error state, in the server's own words.
 *    Which permission guards which route is the server's business (§3.5), and a client that
 *    second-guessed the map would be wrong the first time the map changed.
 *
 * The worklists follow the 15 s polling convention; T13's counter owns that convention's teeth
 * (K39/W-3) and this screen follows it.
 *
 * ═══ UX-AUDIT 2026-09-28 · BOARD — FIVE TABS BECAME ONE LIST AND A HEADER MENU ═══
 *
 * The owner-approved billing back office board (docs/design/2026-09-28-ux-audit/billing-back-office.html)
 * rebuilt the frame on the pharmacy office's pattern: the office owns the viewport, opens on TODAY — one
 * ranked "needs you today" (`GET /billing/office/needs`, `billing-office/today.tsx`) — and every other
 * page lives in the header menu at `?view=<side>&page=<key>` (`billing-office/pages.ts`); the old
 * `?tab=` state redirects. The pages below are the office's existing screens, kept working, with two
 * changes: a voucher is PAID and a mismatch DECIDED in the item-in-hand flow on Today (`hand.tsx`), and
 * the pay lane's ID-reference field is gone — OWNER RULING 2026-09-28: Aadhaar is never stored.
 */
const POLL_MS = 15_000;

type OfficeTab = "refunds" | "recon" | "daybook" | "gstr1" | "orphans";
/** Which of the old tabs' reads a page needs — each read stays gated, so a page nobody opened costs nothing. */
const TAB_OF_PAGE: Record<string, OfficeTab> = {
  pay: "refunds", request: "refunds", waiting: "refunds", all: "refunds", void: "refunds",
  paper: "daybook", daybook: "daybook", upload: "recon", mismatches: "recon", gstr1: "gstr1", unbilled: "orphans",
};

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
  /** UX-AUDIT 2026-09-28 — the alias-safe summary; `name` is null exactly when `restricted`. */
  uhid: string;
  name: string | null;
  alias: string | null;
  restricted: boolean;
};

/** The TWELVE fields of a voucher this worklist renders. Nothing else survives `toVoucherRow`. */
type VoucherRow = {
  id: string; voucherNo: string; patientId: string; kind: RefundKind;
  amountPaise: number; method: RefundMethod; status: "issued" | "paid";
  guardFlags: string[];
  uhid: string; name: string | null; alias: string | null; restricted: boolean;
};

/**
 * THE PROJECTION. The route answers with a row shaped by the server and this screen takes the twelve
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
    uhid: row.uhid ?? "",
    name: row.name ?? null,
    alias: row.alias ?? null,
    restricted: row.restricted === true,
  };
}

/** `GET /billing/receipts?patientId=` — the four fields the void lane's receipt list renders. */
type WireReceiptListRow = { id: string; receiptNo: string; receivedAt: string; totalPaise: number };

/**
 * ═══ UX-AUDIT 2026-09-28 — "settled 48000p vs expected 49250p (tolerance 100p)" ═══
 *
 * `mismatchNote` is written by `recon.ts` (`mismatchNoteFor`) and STORED on the tender, so a server
 * change would fix only tomorrow's rows. The note is rendered here in rupees, formatted by the same
 * `fmtPaise` every other figure on this screen goes through. The known shape is re-said in the
 * operator's language; any other note keeps its words and only has its paise figures converted.
 */
const MISMATCH_NOTE = /^settled (\d+)p vs expected (\d+)p \(tolerance (\d+)p\)$/;
function mismatchNoteText(note: string, t: (key: string, opts: Record<string, string>) => string): string {
  const m = MISMATCH_NOTE.exec(note);
  if (m !== null) {
    return t("billingOffice.recon.mismatchNote", {
      settled: fmtPaise(Number(m[1])), expected: fmtPaise(Number(m[2])), tolerance: fmtPaise(Number(m[3])),
    });
  }
  return note.replace(/\b(\d+)p\b/g, (_, digits: string) => fmtPaise(Number(digits)));
}

/** The visit types `opd.visitType.*` already names; anything else falls to the unknown label or its own word. */
const KNOWN_VISIT_TYPES = ["new", "revisit", "renewal", "referral"];

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

/** The office's pages, each the block it was on the old tabs. `onHand` opens an item on Today. */
function OfficePages({ page, onHand, onGo }: {
  page: string; onHand: (id: string) => void; onGo: (view: OfficeView, page?: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const tab: OfficeTab = TAB_OF_PAGE[page] ?? "refunds";

  // ——— refunds: request → issue → pay, and the entered-in-error correction ———
  const [kind, setKind] = useState<RefundKind>("advance_refund");
  const [subject, setSubject] = useState("");
  /** UX-AUDIT 2026-09-28 — the patient an advance refund is for, picked; `subject` carries its id. */
  const [refundPatient, setRefundPatient] = useState<PatientPickerHit | null>(null);
  const [amountPaise, setAmountPaise] = useState<number | undefined>(undefined);
  const [reasonClass, setReasonClass] = useState<ReasonClass>("mistake");
  const [reason, setReason] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ result: WireRequestRefundResult; body: Record<string, unknown> } | null>(null);

  const [method, setMethod] = useState<RefundMethod>("cash");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<WireIssueRefundResult | null>(null);


  const [eieReceiptId, setEieReceiptId] = useState("");
  /**
   * UX-AUDIT 2026-09-28 — the void lane took a raw receipt id. Staff hold the PRINTED receipt
   * number, so the lane is patient → their receipts (the shipped `GET /billing/receipts?patientId=`
   * read, the dues screen's precedent; no new route) with a number filter over that list.
   */
  const [eiePatient, setEiePatient] = useState<PatientPickerHit | null>(null);
  const [eieReceiptNo, setEieReceiptNo] = useState("");
  const [eieFilter, setEieFilter] = useState("");
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
  /** UX-AUDIT 2026-09-28 · BOARD — unbilled visits get a date of their own, no longer the day book's. */
  const [orphanDay, setOrphanDay] = useState<string>(() => todayIst());

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

  /**
   * ═══ FD-33 — WHY IS THERE NO BILL AGAINST THIS TOKEN? (OWNER, 2026-09-13) ═══
   *
   * *"When auditing, I am unable to see why there's no bill against that token."* The nightly close
   * has computed this since Plan 08 and it reached no screen. The list is the day's visits that
   * SHOULD carry a consultation charge and do not — a free revisit is absent by construction — so
   * the audit inverts: a token MISSING from here is legitimately unbilled.
   *
   * Polled like the other live tabs, and READ-ONLY on the server (`chargeOrphans`, never
   * `runDailyClose`) so a refresh cannot close the books.
   */
  const orphans = useQuery({
    queryKey: ["billing-office", "orphans", orphanDay],
    queryFn: () => api<{ items: WireChargeOrphan[] }>("GET", `/billing/charge-orphans?serviceDate=${encodeURIComponent(orphanDay)}`),
    enabled: tab === "orphans",
    refetchInterval: POLL_MS,
  });

  const eieReceipts = useQuery({
    queryKey: ["billing-office", "eie-receipts", eiePatient?.id ?? ""],
    queryFn: async () => {
      const res = await api<{ items: WireReceiptListRow[] }>(
        "GET", `/billing/receipts?patientId=${encodeURIComponent(eiePatient?.id ?? "")}`,
      );
      // THE PROJECTION: four fields, the dues screen's discipline — nothing else of a receipt row
      // (the Rule 114B capture above all) is carried into this screen's state.
      return res.items.map((r) => ({ id: r.id, receiptNo: r.receiptNo, receivedAt: r.receivedAt, totalPaise: r.totalPaise }));
    },
    enabled: page === "void" && eiePatient !== null,
  });

  // The refunds waiting for a decision come from the office's own feed — `/approvals` is not billing-scoped.
  const waiting = useQuery({
    queryKey: ["billing-office", "needs"],
    queryFn: fetchBillingNeeds,
    enabled: page === "waiting",
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
  const active = page === "waiting" ? waiting : tab === "refunds" ? vouchers : tab === "recon" ? mismatches : tab === "daybook" ? dayBook : tab === "orphans" ? orphans : gstr1;
  const loadError = active.error === null ? null : billingErrorMessage(active.error);

  const voucherRows = vouchers.data ?? [];
  const mismatchRows = mismatches.data ?? [];
  const gstr1Groups = groupGstr1(gstr1.data ?? []);

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
      setEieReceiptNo("");
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

  /** The picked patient as the picker gave it: a search/scan hit always carries a UHID, not always a name. */
  const hit2label = (hit: PatientPickerHit): string => hit.name ?? hit.uhid;

  const visitTypeLabel = (visitType: string): string =>
    KNOWN_VISIT_TYPES.includes(visitType)
      ? t(`opd.visitType.${visitType}`)
      : visitType === "unknown" ? t("billingOffice.orphans.typeUnknown") : visitType;

  const eieNeedle = eieFilter.trim().toLowerCase();
  const eieReceiptRows = (eieReceipts.data ?? []).filter(
    (r) => eieNeedle === "" || r.receiptNo.toLowerCase().includes(eieNeedle),
  );

  // ——— pages ———

  const requestPage = (
    <div className="max-w-xl space-y-3">
        <div className="space-y-2 rounded border bg-white p-2">
          <h2 className="text-sm font-semibold">{t("billingOffice.request.title")}</h2>
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="refund-kind">{t("billingOffice.request.kind")}</label>
            <select
              id="refund-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as RefundKind);
                setSubject("");
                setRefundPatient(null);
              }}
              className="w-full rounded border px-2 py-1"
            >
              <option value="advance_refund">{t("billingOffice.request.kindAdvance")}</option>
              <option value="invoice_refund">{t("billingOffice.request.kindInvoice")}</option>
            </select>
          </div>
          {kind === "advance_refund" ? (
            /* UX-AUDIT 2026-09-28 — this was a text box that took the raw internal patient id. It is
               the app's shared picker now (name / UHID / phone, or a card scan); the id it yields is
               what the request body carries, exactly as before. */
            <div className="space-y-1" data-testid="refund-patient">
              <p className="block text-sm font-medium">{t("billingOffice.request.patient")}</p>
              {refundPatient === null ? (
                <PatientPicker
                  onPick={(hit) => {
                    setRefundPatient(hit);
                    setSubject(hit.id);
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                  <span data-testid="refund-patient-picked" className="font-medium">{hit2label(refundPatient)}</span>
                  <span className="font-mono text-xs text-neutral-600">{refundPatient.uhid}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="refund-patient-change"
                    onClick={() => {
                      setRefundPatient(null);
                      setSubject("");
                    }}
                  >
                    {t("billingOffice.change")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="refund-subject">
                {t("billingOffice.request.creditNote")}
              </label>
              <input
                id="refund-subject"
                value={subject}
                autoComplete="off"
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
            </div>
          )}
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

    </div>
  );

  const voidPage = (
    <div className="max-w-xl space-y-3">
        {/* ——— the correction lane: voiding a receipt reverses everything it settled ——— */}
        <div className="space-y-2 rounded border bg-white p-2">
          <h2 className="text-sm font-semibold">{t("billingOffice.eie.title")}</h2>
          <div className="space-y-1" data-testid="eie-patient">
            <p className="block text-sm font-medium">{t("billingOffice.eie.patient")}</p>
            {eiePatient === null ? (
              <PatientPicker
                onPick={(hit) => {
                  setEiePatient(hit);
                  setEieReceiptId("");
                  setEieReceiptNo("");
                  setEieFilter("");
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                <span data-testid="eie-patient-picked" className="font-medium">{hit2label(eiePatient)}</span>
                <span className="font-mono text-xs text-neutral-600">{eiePatient.uhid}</span>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="eie-patient-change"
                  onClick={() => {
                    setEiePatient(null);
                    setEieReceiptId("");
                    setEieReceiptNo("");
                  }}
                >
                  {t("billingOffice.change")}
                </Button>
              </div>
            )}
          </div>
          {eiePatient !== null && (
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="eie-receipt-filter">{t("billingOffice.eie.receipt")}</label>
              <input
                id="eie-receipt-filter"
                value={eieFilter}
                autoComplete="off"
                placeholder={t("billingOffice.eie.receiptFilter")}
                onChange={(e) => setEieFilter(e.target.value)}
                className="w-full rounded border px-2 py-1 font-mono text-sm"
              />
              {eieReceiptRows.length === 0 ? (
                <p data-testid="eie-no-receipts" className="text-sm text-neutral-500">
                  {eieReceipts.isLoading ? t("billingOffice.eie.loadingReceipts") : t("billingOffice.eie.noReceipts")}
                </p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {eieReceiptRows.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        data-testid={`eie-receipt-${r.id}`}
                        aria-pressed={eieReceiptId === r.id}
                        onClick={() => {
                          setEieReceiptId(r.id);
                          setEieReceiptNo(r.receiptNo);
                        }}
                        className={`flex w-full flex-wrap items-center justify-between gap-2 rounded border px-2 py-1 text-left text-sm ${eieReceiptId === r.id ? "border-blue-500 bg-blue-50" : "hover:bg-neutral-50"}`}
                      >
                        <span className="font-mono">{r.receiptNo}</span>
                        <span className="text-xs text-neutral-600">{r.receivedAt.slice(0, 10)}</span>
                        <span className="tabular-nums">{fmtPaise(r.totalPaise)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
              {t("billingOffice.eie.done", { count: eieDone.reversedAllocationIds.length })}
            </p>
          )}
        </div>
      </div>

  );

  // UX-AUDIT 2026-09-28 · BOARD — "Vouchers to pay" is the issued ones; "All vouchers" every one.
  const shownVouchers = page === "pay" ? voucherRows.filter((r) => r.status === "issued") : voucherRows;
  const voucherPage = (
      <div className="space-y-2 rounded border bg-white p-2">
        <h2 className="text-sm font-semibold">{page === "pay" ? t("billingOffice.board.page.pay") : t("billingOffice.worklist.title")}</h2>
        <p data-testid="guard-flag-note" className="text-xs text-neutral-600">
          {t("billingOffice.guardFlags.note")}
        </p>
        {shownVouchers.length === 0 ? (
          <p data-testid="no-vouchers" className="text-sm text-neutral-500">{t("billingOffice.worklist.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {shownVouchers.map((row) => (
              <li key={row.id} data-testid={`voucher-row-${row.id}`} className="space-y-1 rounded border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid={`voucher-no-${row.id}`} className="font-semibold">{row.voucherNo}</span>
                  <Badge data-testid={`voucher-status-${row.id}`} variant={row.status === "paid" ? "outline" : "default"}>
                    {t(`billingOffice.status.${row.status}`)}
                  </Badge>
                  <span data-testid={`voucher-amount-${row.id}`} className="tabular-nums">{fmtPaise(row.amountPaise)}</span>
                  <span className="text-neutral-600">{t(`billingOffice.kind.${row.kind}`)}</span>
                  <span className="text-neutral-600">{t(`billingOffice.method.${row.method}`)}</span>
                  {/* UX-AUDIT 2026-09-28: the alias-safe name the server batched, and the UHID staff
                      search by — never the internal id. A restricted row shows its alias. */}
                  <span data-testid={`voucher-patient-${row.id}`} className="text-xs text-neutral-500">
                    {t("billingOffice.worklist.patient")}: {billingPatientLabel(row)}
                    {row.uhid !== "" && <span className="ml-1 font-mono">{row.uhid}</span>}
                  </span>
                </div>
                {row.guardFlags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {row.guardFlags.map((flag) => flagChip(`voucher-flag-${row.id}`, flag))}
                  </div>
                )}
                {row.status === "issued" && (
                  /* UX-AUDIT 2026-09-28 · BOARD — a voucher is paid in the numbered flow on Today. */
                  <Button size="sm" data-testid={`voucher-pay-${row.id}`} onClick={() => onHand(`pay:${row.id}`)}>
                    {t("billingOffice.pay.open")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

      </div>
  );

  const uploadPage = (
    <div className="max-w-3xl space-y-3">
      <div className="space-y-2 rounded border bg-white p-2">
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
      {uploaded !== null && uploaded.rowsMismatched > 0 && (
        <p className="text-sm">
          <button type="button" className="underline" data-testid="recon-to-mismatches" onClick={() => onGo("recon", "mismatches")}>
            {t("billingOffice.board.recon.seeMismatches")}
          </button>
        </p>
      )}
    </div>
  );

  const mismatchesPage = (
    <div className="max-w-3xl space-y-3">
      <div className="space-y-2 rounded border bg-white p-2">
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
                {row.mismatchNote !== null && (
                  <p data-testid={`mismatch-note-${row.tenderId}`} className="text-xs text-neutral-500">
                    {mismatchNoteText(row.mismatchNote, t)}
                  </p>
                )}
                {/* UX-AUDIT 2026-09-28 · BOARD — a mismatch is decided in its flow on Today. */}
                <Button size="sm" variant="outline" className="mt-1" data-testid={`mismatch-decide-${row.tenderId}`} onClick={() => onHand(`recon:${row.tenderId}`)}>
                  {t("billingOffice.board.recon.decide")}
                </Button>
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

  /**
   * UX-AUDIT 2026-09-28 · BOARD — unbilled visits: a date of their own, and a way out. The billing
   * counter already opens a bill for a visit at `/billing?encounterId=` (the OPD desk's door), so
   * "Raise the missing bill" is a link there — nothing in billing's exported surface changes.
   */
  const unbilledPage = (
    <div className="max-w-3xl space-y-3">
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="orphan-day">{t("billingOffice.dayBook.day")}</label>
        <input id="orphan-day" type="date" value={orphanDay} onChange={(e) => setOrphanDay(e.target.value)} className="rounded border px-2 py-1 tabular-nums" />
      </div>
      <p style={{ margin: "0 0 9px", fontSize: 12, color: "var(--dim)" }}>{t("billingOffice.orphans.blurb")}</p>
      {orphans.data?.items.length === 0 ? (
        /* The GOOD answer, and it has to read as one: an empty list means every visit that owed
           a consultation fee has one raised against it. A blank table would read as a failure. */
        <p data-testid="orphans-none" style={{ margin: 0, fontWeight: 600 }}>{t("billingOffice.orphans.none", { day: dayWords(orphanDay) })}</p>
      ) : (
        <table data-testid="orphans-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--dim)", fontSize: 10.5 }}>
              <th>{t("billingOffice.orphans.visit")}</th>
              <th>{t("billingOffice.orphans.type")}</th>
              <th>{t("billingOffice.orphans.date")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(orphans.data?.items ?? []).map((o) => (
              <tr key={o.encounterId} data-testid={`orphan-${o.encounterId}`}>
                <td className="mo">{o.visitNo}</td>
                <td data-testid={`orphan-type-${o.encounterId}`}>{visitTypeLabel(o.visitType)}</td>
                <td className="mo">{dayWords(o.serviceDate)}</td>
                <td style={{ textAlign: "right" }}>
                  <Link to="/billing" search={{ encounterId: o.encounterId }} className="underline" data-testid={`orphan-raise-${o.encounterId}`}>
                    {t("billingOffice.board.simple.unbilled_visit.act")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  /** Refunds waiting for a decision — the manager's (open in approvals) and the owner's (above ₹25,000.00). */
  const waitingRows = (waiting.data?.rows ?? []).filter((r) => r.kind === "approve_refund" || r.kind === "refund_owner");
  const waitingPage = (
    <div className="max-w-3xl space-y-2 rounded border bg-white p-2">
      <h2 className="text-sm font-semibold">{t("billingOffice.board.page.waiting")}</h2>
      {waiting.data !== undefined && waitingRows.length === 0 && <p data-testid="waiting-empty" className="text-sm text-neutral-500">{t("billingOffice.board.waiting.empty")}</p>}
      <ul className="space-y-2">
        {waitingRows.map((r) => (
          <li key={r.id} data-testid={`waiting-${r.id}`} className="flex flex-wrap items-center gap-3 rounded border p-2 text-sm">
            <span className="tabular-nums font-semibold">{fmtPaise(typeof r.params.amountPaise === "number" ? r.params.amountPaise : 0)}</span>
            <span>{r.patient === null ? "" : billingPatientLabel(r.patient)}</span>
            <span className="flex-1 text-xs text-neutral-500">{typeof r.params.note === "string" ? r.params.note : ""}</span>
            {r.kind === "refund_owner"
              ? <span className="text-xs font-semibold text-amber-800">{t("billingOffice.board.simple.refund_owner.act")}</span>
              : <Link to="/approvals" search={{ focus: String(r.params.approvalId) }} className="underline">{t("billingOffice.board.simple.approve_refund.act")}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );

  const body = page === "request" ? requestPage
    : page === "void" ? voidPage
    : page === "waiting" ? waitingPage
    : page === "pay" || page === "all" ? voucherPage
    : page === "upload" ? uploadPage
    : page === "mismatches" ? mismatchesPage
    : page === "daybook" || page === "paper" ? dayBookTab
    : page === "gstr1" ? gstr1Tab
    : unbilledPage;

  return (
    <div className="space-y-4">
      {loadError !== null && (
        <p role="alert" data-testid="load-error" className="text-sm text-red-600">{loadError}</p>
      )}
      {page === "paper" && <p className="bof-page-note">{t("billingOffice.board.paperNote")}</p>}
      {body}

      {/* The cascade is named BEFORE the operator confirms, not after: voiding a receipt reverses
          every allocation it made, and there is no undo on the other side of this button. */}
      <Dialog open={eieConfirming} onOpenChange={setEieConfirming}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("billingOffice.eie.confirmTitle")}</DialogTitle></DialogHeader>
          <p data-testid="eie-cascade" className="text-sm">
            {t("billingOffice.eie.cascade", { receiptId: eieReceiptNo === "" ? eieReceiptId : eieReceiptNo })}
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

/** True below `px`. jsdom has no `matchMedia`, so a test renders the wide desk. */
function useNarrow(px: number): boolean {
  const query = `(max-width: ${String(px)}px)`;
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const on = (): void => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

type Where = { view: OfficeView; page: string | null; open: string | null };
function whereOf(search: Record<string, unknown>): Where {
  const v = typeof search.view === "string" ? search.view : null;
  const tab = typeof search.tab === "string" ? OLD_TABS[search.tab] : undefined;
  if (v === null && tab !== undefined) return { view: tab.view, page: tab.page, open: null };
  return {
    view: MENU.includes(v as OfficeView) ? (v as OfficeView) : "today",
    page: typeof search.page === "string" ? search.page : null,
    open: typeof search.open === "string" ? search.open : null,
  };
}

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE BILLING BACK OFFICE ═══
 *
 * The frame of the approved board: the wordmark, the header menu (Today · Refunds ▾ · Receipts ▾ ·
 * Reconciliation ▾ · Day book · GSTR-1 · Unbilled visits), the money pills, the IST clock and who is
 * signed in; below it Today's desk or the page the menu opened. The URL is the state —
 * `?view=&page=&open=` — so reload and back/forward land where the person was, and the old `?tab=`
 * redirects to its page. Below 1100 px the menu folds behind one Menu button; up to 900 px the phone
 * layout (artboard 4).
 */
export function BillingOffice(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const navigate = useNavigate();
  const phone = useNarrow(900);
  const folded = useNarrow(1100);
  const drawerMode = useNarrow(1280);

  const routed = useSearch({ strict: false }) as Record<string, unknown>;
  const where = whereOf(routed);
  const shown = where.view;
  const sidePages = shown === "today" ? [] : pagesOf(shown);
  const page: OfficePage | null = sidePages.find((pg) => pg.key === where.page) ?? sidePages[0] ?? null;

  // The old tab state redirects to the page that replaced it.
  const oldTab = typeof routed.tab === "string" ? routed.tab : null;
  useEffect(() => {
    if (oldTab === null) return;
    const to = OLD_TABS[oldTab];
    void navigate({ to: "/billing/office", search: to === undefined ? {} : { view: to.view, page: to.page }, replace: true });
  }, [oldTab, navigate]);

  const needs = useQuery({ queryKey: ["billing-office", "needs"], queryFn: fetchBillingNeeds, refetchInterval: POLL_MS });
  const [drop, setDrop] = useState<OfficeView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => { if (notice === null) return; const id = setTimeout(() => setNotice(null), 6_000); return () => clearTimeout(id); }, [notice]);

  const go = useCallback((view: OfficeView, pageKey?: string, open?: string): void => {
    setDrop(null); setMenuOpen(false); setDrawerOpen(false);
    const search: Record<string, string> = { view };
    if (pageKey !== undefined) search.page = pageKey;
    if (open !== undefined) search.open = open;
    void navigate({ to: "/billing/office", search });
  }, [navigate]);
  const setOpen = useCallback((id: string | null): void => {
    void navigate({ to: "/billing/office", search: id === null ? { view: "today" } : { view: "today", open: id }, replace: true });
  }, [navigate]);
  const openSide = (v: OfficeView, fromKey: boolean): void => {
    if (v === "today" || pagesOf(v).length <= 1) { go(v); return; }
    setDrop((d) => (d === v && !fromKey ? null : v));
    if (fromKey) setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-drop="${v}"] [role="menuitem"]`)?.focus(), 0);
  };

  // A dropdown closes on a click anywhere outside it.
  useEffect(() => {
    if (drop === null) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Node) || document.querySelector(`[data-navi="${drop}"]`)?.contains(e.target) !== true) setDrop(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [drop]);

  // The board's letters open a side (R V C D G U) — on Today and while a dropdown is open, never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" && drop !== null) { e.preventDefault(); setDrop(null); return; }
      if (e.defaultPrevented || phone || folded || where.open !== null) return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (shown !== "today" && drop === null) return;
      const side = MENU.find((v) => SIDE_KEYS[v] !== undefined && SIDE_KEYS[v] === e.key.toUpperCase());
      if (side === undefined) return;
      e.preventDefault();
      openSide(side, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const onDropKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };

  const d = needs.data;
  const openCount = d?.rows.filter((r) => r.state === "open").length ?? 0;
  const sideName = (v: OfficeView): string => t(`billingOffice.board.menu.${v}`);
  const pageName = (pg: OfficePage): string => t(`billingOffice.board.page.${pg.key}`);
  const pills = (
    <>
      {d !== undefined && d.money.toPayCount > 0 && (
        <span className="pill gd" data-testid="pill-to-pay">{t("billingOffice.board.pill.toPay", { count: d.money.toPayCount, amount: fmtPaise(d.money.toPayPaise) })}</span>
      )}
      {d !== undefined && d.money.shortPaise > 0 && (
        <span className="pill rd" style={{ marginLeft: 6 }} data-testid="pill-short">{t("billingOffice.board.pill.short", { amount: fmtPaise(d.money.shortPaise) })}</span>
      )}
    </>
  );

  const phoneMenu = (
    <nav className="pof-drop" aria-label={t("billingOffice.board.menuLabel")}>
      {MENU.map((v) => {
        const list = v === "today" ? [] : pagesOf(v);
        if (list.length <= 1) {
          return <button key={v} type="button" aria-current={v === shown ? "page" : undefined} data-testid={`office-view-${v}`} onClick={() => go(v)}>{sideName(v)}</button>;
        }
        return (
          <div key={v} role="group" aria-label={sideName(v)} data-testid={`office-group-${v}`}>
            <div className="tag pof-drop-head">{sideName(v)}</div>
            {list.map((pg) => (
              <button key={pg.key} type="button" className="pof-drop-ent" aria-current={v === shown && pg.key === page?.key ? "page" : undefined} data-testid={`office-entry-${pg.key}`} onClick={() => go(v, pg.key)}>
                {pageName(pg)}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );

  const header = phone || folded ? (
    !full && (
      <header className="pof-ptop">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 0 L14 7 L7 14 L0 7 Z" fill="#0e6b4e" /></svg>
        <span className="mo" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".12em", flexGrow: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {shown === "today" ? t("billingOffice.board.wordmark") : t("billingOffice.board.phoneWordmark", { view: sideName(shown).toUpperCase() })}
        </span>
        {!phone && pills}
        {!phone && drawerMode && where.open !== null && (
          <button type="button" className="bof-badge" data-testid="needs-badge" onClick={() => setDrawerOpen((o) => !o)}>{t("billingOffice.board.pill.needs", { count: openCount })}</button>
        )}
        <button type="button" className="pof-pmenu" aria-label={t("billingOffice.board.menuAria")} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} data-testid="office-menu">
          ☰ {t("billingOffice.board.menuButton")}
        </button>
        {menuOpen && phoneMenu}
      </header>
    )
  ) : (
    <header className="pof-top">
      <div className="pof-brand">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 0 L14 7 L7 14 L0 7 Z" fill="#0e6b4e" /></svg>
        <span className="mo" style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".12em", whiteSpace: "nowrap" }}>{t("billingOffice.board.wordmark")}</span>
      </div>
      <nav aria-label={t("billingOffice.board.menuLabel")} className="pof-nav">
        {MENU.map((v) => {
          const list = v === "today" ? [] : pagesOf(v);
          const multi = list.length > 1;
          return (
            <span key={v} className="pof-navi" data-navi={v}>
              <button type="button" className={`nav${v === shown ? " on" : ""}${multi ? " dd" : ""}`} aria-current={v === shown ? "page" : undefined}
                aria-haspopup={multi ? "menu" : undefined} aria-expanded={multi ? drop === v : undefined} data-testid={`office-view-${v}`} onClick={() => openSide(v, false)}>
                {sideName(v)}
              </button>
              {multi && drop === v && (
                <div className="pof-dd" role="menu" aria-label={sideName(v)} data-drop={v} data-testid={`office-drop-${v}`} onKeyDown={onDropKey}>
                  <div className="tag pof-dd-head">
                    {sideName(v)}
                    {SIDE_KEYS[v] !== undefined && <span className="kb">{SIDE_KEYS[v]}</span>}
                  </div>
                  {list.map((pg) => (
                    <button key={pg.key} type="button" role="menuitem" className={v === shown && pg.key === page?.key ? "pof-ent on" : "pof-ent"} data-testid={`office-entry-${pg.key}`} onClick={() => go(v, pg.key)}>
                      <b>{pageName(pg)}</b>
                      <span className="was">{t(`billingOffice.board.was.${pg.key}`)}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          );
        })}
      </nav>
      <div style={{ flexGrow: 1 }} />
      {pills}
      {drawerMode && where.open !== null && (
        <button type="button" className="bof-badge" style={{ marginLeft: 6 }} data-testid="needs-badge" onClick={() => setDrawerOpen((o) => !o)}>{t("billingOffice.board.pill.needs", { count: openCount })}</button>
      )}
      <span className="mo pof-clock">{istDateLabel(now)} · {istClock(now)}</span>
      <span className="pof-user">{username ?? ""}</span>
    </header>
  );

  return (
    <div className="d1 pof bof" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"} data-seat="billing-office" data-testid="billing-office">
      {header}
      {shown === "today" ? (
        <TodayDesk
          data={d} error={needs.error === null ? null : billingErrorMessage(needs.error)} phone={phone}
          drawerMode={drawerMode} drawerOpen={drawerOpen} onDrawer={setDrawerOpen}
          openId={where.open} onOpen={setOpen} onGo={(g) => go(g.view, g.page)} onDone={setNotice} onFullScreen={setFull}
        />
      ) : (
        <div className="pof-page" data-testid={`office-page-${shown}`} data-page={page?.key}>
          <div className="pof-legacy">
            <h1 className="mb-3 text-lg font-semibold">{page === null ? sideName(shown) : pageName(page)}</h1>
            {page !== null && (page.key === "fees"
              ? <FeeSwitches />
              : page.key === "prices"
              ? <ConsultPrices />
              : <OfficePages key={page.key} page={page.key} onHand={(id) => go("today", undefined, id)} onGo={(v, pg) => go(v, pg)} />)}
          </div>
        </div>
      )}
      {notice !== null && (
        <p role="status" data-testid="office-notice" style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 47, margin: 0, padding: "9px 14px", borderRadius: 7, border: "1px solid var(--green-line)", background: "var(--card)", color: "var(--green)", fontSize: 13, fontWeight: 500, maxWidth: "calc(100vw - 32px)" }}>{notice}</p>
      )}
    </div>
  );
}
