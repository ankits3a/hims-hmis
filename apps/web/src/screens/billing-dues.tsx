import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { MoneyInput } from "../components/money-input";
import { TenderEditor } from "../components/tender-editor";
import { fmtPaise } from "../lib/format";
import { api } from "../lib/api";
import { billingErrorCode, billingErrorDetail, billingErrorMessage, billingPatientLabel } from "../lib/billing-api";
import type { WireDiscountCategory, WireDueRow, WireTender } from "../lib/billing-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * DUES & ADVANCES (Plan 08 T14 / D1 / D4 / owner ruling R1) — ONE LEDGER, ONE SCREEN.
 *
 * Dues and patient advances are the same instrument: a receipt allocated against a bill clears a
 * due, and the same receipt row left unallocated IS the advance. That ruling is why this screen
 * has one balance read and three write lanes rather than two screens that would drift apart.
 *
 *  · PARTIAL SETTLEMENT IS FIRST CLASS. The allocation posts THE AMOUNT THE CASHIER TYPED, never
 *    the invoice's outstanding — a clear of ₹300 against a ₹450 due is an ordinary Tuesday, and
 *    the ledger carries the figure (D1: settlement state is DERIVED from allocations, never
 *    stored). K41/W-5 exist because the previous plan shipped a test that could not tell the two
 *    apart.
 *  · TWO REFUSALS ARE TERMINAL BY DESIGN and are rendered as dead ends — see `TERMINAL_CODES`.
 *  · `over_cap` ON A CAP OF ZERO IS A CONFIGURATION MESSAGE, not a money refusal (carried item 2).
 *  · NO PAN, NO PAYEE IDENTITY. `GET /billing/receipts` is read through an explicit projection
 *    (`toReceiptRow`) so nothing but the five fields this screen renders survives the fetch. The
 *    server-side exposure was fixed in `30a272d` — the route now sends a derived `panCaptured` and
 *    no number at all — and the projection here is a second belt, not the security boundary: a
 *    cashier can still call the route directly, so a screen that merely declines to render a field
 *    would never have been the fix.
 *  · THE REFUND LANE IS A LINK. Advance refunds are approval-gated vouchers with guard flags and
 *    payee identity (D6); the back office owns that flow and this screen builds no second copy.
 *
 * The 15 s polling read is the balance. T13's counter OWNS that convention's teeth (K39/W-3);
 * this screen follows it.
 */
const POLL_MS = 15_000;

const DISCOUNT_CATEGORIES: WireDiscountCategory[] = ["charity", "scheme", "negotiated_corporate", "employee"];

/**
 * REFUSALS WITH NO CORRECTION PATH. Once an advance-refund voucher has returned a receipt's money,
 * that money can never be allocated: `allocation_exceeds_advance` is not a mistake the cashier can
 * retype her way out of, because the cash physically left the drawer and a paid voucher cannot be
 * un-paid. Offering a retry here would be lying to her.
 *
 * The ledger's OTHER terminal refusal, `eie_advance_refunded`, is raised by `markEnteredInError`
 * and is unreachable from this screen — the EIE lane lives in the back office, which owns it.
 */
const TERMINAL_CODES = new Set(["allocation_exceeds_advance"]);

type WirePatientBalance = {
  patientId: string;
  advancePaise: number;
  outstandingPaise: number;
  dues: WireDueRow[];
};

/** The FIVE fields of a receipt row this screen renders. Nothing else survives `toReceiptRow`. */
type ReceiptRow = { id: string; receiptNo: string; serviceDay: string; totalPaise: number; panCaptured: boolean };

type WireRecordReceiptResult = { receiptId: string; receiptNo: string; totalPaise: number };

/** The lane the cashier has open. Exactly one at a time — one action, one set of money fields. */
type Lane =
  | { kind: "clear" | "clearance" | "apply"; invoiceId: string }
  | { kind: "take" }
  | null;

/**
 * THE PROJECTION. `GET /billing/receipts` answers with a row shaped by the server, and this screen
 * takes the five fields it renders and drops the rest on the floor — including anything a future
 * regression might add back beside `panCaptured` (the Rule 114B capture is a chip, never a number).
 */
function toReceiptRow(row: ReceiptRow): ReceiptRow {
  return {
    id: row.id,
    receiptNo: row.receiptNo,
    serviceDay: row.serviceDay,
    totalPaise: row.totalPaise,
    panCaptured: row.panCaptured,
  };
}

/** The asked-vs-cap numbers an `over_cap` refusal carries, or null when the body is not that shape. */
function overCapDetail(detail: unknown): { askedPaise: number; capPaise: number; discountCategory: string } | null {
  if (detail === null || typeof detail !== "object") return null;
  const d = detail as { askedPaise?: unknown; capPaise?: unknown; discountCategory?: unknown };
  if (typeof d.askedPaise !== "number" || typeof d.capPaise !== "number" || typeof d.discountCategory !== "string") {
    return null;
  }
  return { askedPaise: d.askedPaise, capPaise: d.capPaise, discountCategory: d.discountCategory };
}

export function BillingDues(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [lane, setLane] = useState<Lane>(null);
  const [tenders, setTenders] = useState<WireTender[]>([]);
  const [allocatePaise, setAllocatePaise] = useState<number | undefined>(undefined);
  const [askPaise, setAskPaise] = useState<number | undefined>(undefined);
  const [category, setCategory] = useState<WireDiscountCategory | "">("");
  const [reason, setReason] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overCap, setOverCap] = useState<{ askedPaise: number; capPaise: number; discountCategory: string } | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);

  const patientId = patient?.id ?? "";

  // ——— reads ————————————————————————————————————————————————————————————————————————————————

  /** THE screen's one polling read: a bill can be settled at the counter while this list is open. */
  const balance = useQuery({
    queryKey: ["billing-dues", "balance", patientId],
    queryFn: () => api<WirePatientBalance>("GET", `/billing/patients/${encodeURIComponent(patientId)}/balance`),
    enabled: patient !== null,
    refetchInterval: POLL_MS,
  });

  /**
   * Only the apply-advance lane needs the receipt rows, so only that lane pays for the read. The
   * route has no date window and no pagination (carried item 6) — do not build paging on it.
   */
  const receipts = useQuery({
    queryKey: ["billing-dues", "receipts", patientId],
    queryFn: async () => {
      const res = await api<{ items: ReceiptRow[] }>(
        "GET", `/billing/receipts?patientId=${encodeURIComponent(patientId)}`,
      );
      return res.items.map(toReceiptRow);
    },
    enabled: patient !== null && lane !== null && lane.kind === "apply",
  });

  const dues = balance.data?.dues ?? [];
  const receiptRows = receipts.data ?? [];
  const selectedReceipt = receiptRows.find((row) => row.id === receiptId) ?? null;

  // ——— lanes ————————————————————————————————————————————————————————————————————————————————

  /** Opening a lane clears every field of the last one — money must never carry between bills. */
  const openLane = (next: Lane, seedPaise?: number): void => {
    setLane(next);
    setTenders([]);
    setAllocatePaise(seedPaise);
    setAskPaise(seedPaise);
    setCategory("");
    setReason("");
    setReceiptId("");
    setError(null);
    setOverCap(null);
    setTerminal(null);
  };

  const closeLane = (): void => {
    openLane(null);
  };

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["billing-dues"] });
  };

  /**
   * One refusal reader for all three lanes. `prefix` is non-empty only when money was already
   * taken before the refusal — the cashier must be told the receipt exists and where it went.
   */
  const showRefusal = (e: unknown, prefix = ""): void => {
    const code = billingErrorCode(e);
    const message = prefix === "" ? billingErrorMessage(e) : `${prefix} ${billingErrorMessage(e)}`;
    if (code !== null && TERMINAL_CODES.has(code)) {
      setTerminal(message);
      return;
    }
    if (code === "over_cap") {
      const detail = overCapDetail(billingErrorDetail(e));
      if (detail !== null) {
        setOverCap(detail);
        setError(null);
        return;
      }
    }
    setError(message);
  };

  /**
   * DUES CLEAR — money in, then allocated. Two calls, in this order, because the ledger is
   * append-only: the receipt is the money and the allocation is what it settles (D1). If the
   * second call is refused the FIRST has already committed, so the receipt number is carried into
   * the message: that money is now sitting on the patient's advance, not lost.
   */
  const clearDue = async (due: WireDueRow): Promise<void> => {
    if (patient === null) return;
    if (tenders.length === 0) {
      setError(t("billingDues.clear.tendersRequired"));
      return;
    }
    if (allocatePaise === undefined || allocatePaise <= 0) {
      setError(t("billingDues.clear.amountRequired"));
      return;
    }
    setError(null);
    let receipt: WireRecordReceiptResult;
    try {
      receipt = await api<WireRecordReceiptResult>("POST", "/billing/receipts", {
        patientId: patient.id,
        tenders,
      });
    } catch (e) {
      showRefusal(e);
      return;
    }
    try {
      // THE AMOUNT THE CASHIER TYPED — never `due.outstandingPaise`, never the tender sum.
      await api("POST", `/billing/receipts/${encodeURIComponent(receipt.receiptId)}/allocations`, {
        invoiceId: due.invoiceId,
        amountPaise: allocatePaise,
      });
    } catch (e) {
      showRefusal(e, t("billingDues.clear.receiptBanked", { receiptNo: receipt.receiptNo }));
      await refresh();
      return;
    }
    closeLane();
    await refresh();
  };

  /**
   * THE CLEARANCE DISCOUNT (D4) — the legacy "Dues Clear discount", on the adjustment side of the
   * seam. Category and reason are both mandatory here as well as at the server: a write-off with
   * no category has no cap to be checked against, and one with no reason is unsigned.
   */
  const clearanceDiscount = async (due: WireDueRow): Promise<void> => {
    if (category === "") {
      setError(t("billingDues.clearance.categoryRequired"));
      return;
    }
    if (reason.trim() === "") {
      setError(t("billingDues.clearance.reasonRequired"));
      return;
    }
    if (askPaise === undefined || askPaise <= 0) {
      setError(t("billingDues.clearance.askRequired"));
      return;
    }
    setError(null);
    setOverCap(null);
    try {
      await api("POST", `/billing/invoices/${encodeURIComponent(due.invoiceId)}/credit-notes`, {
        kind: "clearance_discount",
        discountCategory: category,
        askPaise,
        reason: reason.trim(),
      });
    } catch (e) {
      showRefusal(e);
      return;
    }
    closeLane();
    await refresh();
  };

  /**
   * APPLY AN ADVANCE — the SAME allocation call the clear lane makes, from a receipt that already
   * exists. No new money changes hands, so NO receipt is posted: that absence is the whole
   * difference between the two lanes.
   */
  const applyAdvance = async (due: WireDueRow): Promise<void> => {
    if (receiptId === "") {
      setError(t("billingDues.advanceLane.receiptRequired"));
      return;
    }
    if (allocatePaise === undefined || allocatePaise <= 0) {
      setError(t("billingDues.advanceLane.amountRequired"));
      return;
    }
    setError(null);
    try {
      await api("POST", `/billing/receipts/${encodeURIComponent(receiptId)}/allocations`, {
        invoiceId: due.invoiceId,
        amountPaise: allocatePaise,
      });
    } catch (e) {
      showRefusal(e);
      return;
    }
    closeLane();
    await refresh();
  };

  /** TAKE AN ADVANCE — a receipt with nothing allocated against it. That is the whole instrument. */
  const takeAdvance = async (): Promise<void> => {
    if (patient === null) return;
    if (tenders.length === 0) {
      setError(t("billingDues.clear.tendersRequired"));
      return;
    }
    setError(null);
    try {
      await api<WireRecordReceiptResult>("POST", "/billing/receipts", { patientId: patient.id, tenders });
    } catch (e) {
      showRefusal(e);
      return;
    }
    closeLane();
    await refresh();
  };

  // ——— render ———————————————————————————————————————————————————————————————————————————————

  /** The dead end. No control inside it: there is nothing here that can be tried again. */
  const terminalBlock = terminal === null ? null : (
    <div data-testid="terminal-refusal" role="alert" className="space-y-1 rounded border border-red-400 p-2">
      <p className="text-sm font-semibold text-red-700">{t("billingDues.terminal.title")}</p>
      <p className="text-sm text-red-700">{terminal}</p>
    </div>
  );

  const errorLine = error === null ? null : (
    <p role="alert" data-testid="lane-error" className="text-sm text-red-600">{error}</p>
  );

  const laneFor = (due: WireDueRow): React.ReactElement | null => {
    if (lane === null || lane.kind === "take" || lane.invoiceId !== due.invoiceId) return null;
    if (terminal !== null) return terminalBlock;

    if (lane.kind === "clear") {
      return (
        <div key={`clear-${due.invoiceId}`} className="space-y-2 border-t pt-2">
          <p className="text-sm font-semibold">{t("billingDues.clear.title", { invoiceNo: due.invoiceNo })}</p>
          <TenderEditor payablePaise={allocatePaise ?? 0} onChange={setTenders} />
          <MoneyInput
            id="clear-amount"
            label={t("billingDues.clear.allocate")}
            value={due.outstandingPaise}
            onChange={setAllocatePaise}
          />
          {errorLine}
          <div className="flex gap-2">
            <Button data-testid="clear-submit" onClick={() => void clearDue(due)}>
              {t("billingDues.clear.submit")}
            </Button>
            <Button variant="outline" onClick={closeLane}>{t("billingDues.cancel")}</Button>
          </div>
        </div>
      );
    }

    if (lane.kind === "clearance") {
      return (
        <div key={`clearance-${due.invoiceId}`} className="space-y-2 border-t pt-2">
          <p className="text-sm font-semibold">{t("billingDues.clearance.title", { invoiceNo: due.invoiceNo })}</p>
          <label className="block text-sm font-medium" htmlFor="clearance-category">
            {t("billingDues.clearance.category")}
          </label>
          <select
            id="clearance-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as WireDiscountCategory | "")}
            className="w-full rounded border px-2 py-1"
          >
            <option value="">{t("billingDues.clearance.categoryPlaceholder")}</option>
            {DISCOUNT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`billing.discountCategory.${c}`)}</option>
            ))}
          </select>
          <MoneyInput
            id="clearance-ask"
            label={t("billingDues.clearance.ask")}
            value={due.outstandingPaise}
            onChange={setAskPaise}
          />
          <label className="block text-sm font-medium" htmlFor="clearance-reason">
            {t("billingDues.clearance.reason")}
          </label>
          <input
            id="clearance-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded border px-2 py-1"
          />
          {errorLine}
          {overCap !== null && (overCap.capPaise === 0 ? (
            /*
             * A cap of zero is not a ceiling the cashier hit — it is a category nobody has
             * configured. `credit-notes.ts` reads an absent `manualCaps[category]` as zero and
             * `seed-billing.ts` seeds no cap rows at all, so on a fresh environment EVERY clearance
             * ask is refused this way. "Over cap" on a cap of zero is how a configuration gap
             * becomes a bug report.
             */
            <p role="alert" data-testid="clearance-not-configured" className="text-sm text-amber-700">
              {t("billingDues.clearance.notConfigured", {
                category: t(`billing.discountCategory.${overCap.discountCategory}`),
              })}
            </p>
          ) : (
            <p role="alert" data-testid="clearance-over-cap" className="text-sm text-red-600">
              {t("billingDues.clearance.overCap", {
                asked: fmtPaise(overCap.askedPaise),
                cap: fmtPaise(overCap.capPaise),
                category: t(`billing.discountCategory.${overCap.discountCategory}`),
              })}
            </p>
          ))}
          <div className="flex gap-2">
            <Button data-testid="clearance-submit" onClick={() => void clearanceDiscount(due)}>
              {t("billingDues.clearance.submit")}
            </Button>
            <Button variant="outline" onClick={closeLane}>{t("billingDues.cancel")}</Button>
          </div>
        </div>
      );
    }

    return (
      <div key={`apply-${due.invoiceId}`} className="space-y-2 border-t pt-2">
        <p className="text-sm font-semibold">{t("billingDues.advanceLane.applyTitle", { invoiceNo: due.invoiceNo })}</p>
        <label className="block text-sm font-medium" htmlFor="apply-receipt">
          {t("billingDues.advanceLane.receipt")}
        </label>
        <select
          id="apply-receipt"
          value={receiptId}
          onChange={(e) => setReceiptId(e.target.value)}
          className="w-full rounded border px-2 py-1"
        >
          <option value="">—</option>
          {receiptRows.map((row) => (
            <option key={row.id} value={row.id}>
              {`${row.receiptNo} · ${row.serviceDay} · ${fmtPaise(row.totalPaise)}`}
            </option>
          ))}
        </select>
        {receiptRows.length === 0 && (
          <p className="text-sm text-neutral-500">{t("billingDues.advanceLane.noReceipts")}</p>
        )}
        {selectedReceipt !== null && selectedReceipt.panCaptured && (
          <Badge data-testid={`receipt-pan-${selectedReceipt.id}`} variant="outline">
            {t("billingDues.advanceLane.panCaptured")}
          </Badge>
        )}
        <MoneyInput
          id="apply-amount"
          label={t("billingDues.advanceLane.amount")}
          value={due.outstandingPaise}
          onChange={setAllocatePaise}
        />
        {errorLine}
        <div className="flex gap-2">
          <Button data-testid="apply-submit" onClick={() => void applyAdvance(due)}>
            {t("billingDues.advanceLane.apply")}
          </Button>
          <Button variant="outline" onClick={closeLane}>{t("billingDues.cancel")}</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("billingDues.title")}</h1>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* (a) who owes what, and what the hospital is already holding for them */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t("billingDues.pickPatient")}</h2>
          <PatientPicker onPick={(hit) => { setPatient(hit); openLane(null); }} />
          {patient !== null && (
            <div className="rounded border p-2">
              <p className="text-sm">{t("billingDues.selectedPatient")}: {patient.name ?? "—"}</p>
              <p className="font-mono text-xs text-neutral-600">{patient.uhid}</p>
            </div>
          )}

          {patient === null && <p className="text-sm text-neutral-500">{t("billingDues.pickPatientFirst")}</p>}

          {balance.data !== undefined && (
            <div className="space-y-2 rounded border p-2">
              <p className="text-sm">
                {t("billingDues.advance")}:{" "}
                <span data-testid="advance-balance" className="font-semibold text-emerald-700">
                  {fmtPaise(balance.data.advancePaise)}
                </span>
              </p>
              <p className="text-sm">
                {t("billingDues.outstanding")}:{" "}
                <span data-testid="outstanding-total" className="font-semibold text-red-600">
                  {fmtPaise(balance.data.outstandingPaise)}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="take-advance-open"
                  onClick={() => openLane({ kind: "take" })}
                >
                  {t("billingDues.advanceLane.takeOpen")}
                </Button>
                {/*
                  A refund draws on the advance through an APPROVAL-GATED voucher with guard flags
                  and payee identity at pay time (D6). That flow belongs to the back office; this is
                  a link to it, not a second implementation of it.
                */}
                <a
                  href="/billing/office"
                  data-testid="refund-advance-link"
                  className="text-sm underline hover:no-underline"
                >
                  {t("billingDues.advanceLane.refund")}
                </a>
              </div>
              {lane !== null && lane.kind === "take" && (
                terminal !== null ? terminalBlock : (
                  <div key="take" className="space-y-2 border-t pt-2">
                    <p className="text-sm font-semibold">{t("billingDues.advanceLane.takeTitle")}</p>
                    <TenderEditor payablePaise={0} onChange={setTenders} />
                    {errorLine}
                    <div className="flex gap-2">
                      <Button data-testid="take-advance-submit" onClick={() => void takeAdvance()}>
                        {t("billingDues.advanceLane.take")}
                      </Button>
                      <Button variant="outline" onClick={closeLane}>{t("billingDues.cancel")}</Button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* (b) the worklist, in the server's own oldest-first order, and the three action lanes */}
        <div className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold">{t("billingDues.dues")}</h2>
          {patient !== null && dues.length === 0 && (
            <p className="text-sm text-neutral-500">{t("billingDues.noDues")}</p>
          )}
          {dues.map((due) => (
            <div key={due.invoiceId} data-testid={`due-row-${due.invoiceId}`} className="space-y-2 rounded border p-2">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-mono">{due.invoiceNo}</span>
                <span data-testid={`due-name-${due.invoiceId}`}>{billingPatientLabel(due)}</span>
                <span data-testid={`due-day-${due.invoiceId}`}>{due.serviceDay}</span>
                <span data-testid={`due-payable-${due.invoiceId}`} className="tabular-nums">
                  {t("billingDues.table.payable")}: {fmtPaise(due.netPayablePaise)}
                </span>
                {/*
                  The list route sends no "paid" figure, so this column is `netPayable −
                  outstanding` — money CLEARED, by allocations or by credit notes, which is why it
                  is not labelled "paid". Both figures are the server's; only the subtraction is
                  ours.
                */}
                <span data-testid={`due-cleared-${due.invoiceId}`} className="tabular-nums">
                  {t("billingDues.table.cleared")}: {fmtPaise(due.netPayablePaise - due.outstandingPaise)}
                </span>
                <span data-testid={`due-outstanding-${due.invoiceId}`} className="font-semibold tabular-nums text-red-600">
                  {t("billingDues.table.outstanding")}: {fmtPaise(due.outstandingPaise)}
                </span>
                {/*
                  DUE or CREDIT only: `listDues` returns exactly the invoices still carrying an
                  outstanding balance, so a settled row never reaches this table and a PAID badge
                  would be unreachable code.
                */}
                <Badge data-testid={`due-badge-${due.invoiceId}`} variant={due.creditExtended ? "outline" : "default"}>
                  {due.creditExtended ? t("billingDues.badge.credit") : t("billingDues.badge.due")}
                </Badge>
              </div>
              {/*
                Keyboard-first: the row's FIRST control is the clear lane — Tab to the row the
                cashier is looking at, press Enter, and the lane she needs nine times in ten is
                open. (`/` puts the caret back in the picker; keyboard.tsx owns that globally.)
              */}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid={`due-open-clear-${due.invoiceId}`}
                  onClick={() => openLane({ kind: "clear", invoiceId: due.invoiceId }, due.outstandingPaise)}
                >
                  {t("billingDues.clear.open")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`due-open-clearance-${due.invoiceId}`}
                  onClick={() => openLane({ kind: "clearance", invoiceId: due.invoiceId }, due.outstandingPaise)}
                >
                  {t("billingDues.clearance.open")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`due-open-apply-${due.invoiceId}`}
                  onClick={() => openLane({ kind: "apply", invoiceId: due.invoiceId }, due.outstandingPaise)}
                >
                  {t("billingDues.advanceLane.applyOpen")}
                </Button>
              </div>
              {laneFor(due)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
