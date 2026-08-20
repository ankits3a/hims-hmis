import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtPaise } from "../lib/format";
import { MoneyInput } from "./money-input";
import { Button } from "@/components/ui/button";
import type { TenderMode, WireTender } from "../lib/billing-api";

/**
 * Mixed-tender capture (Plan 08 D2/D7): one receipt carries several tenders, each with its own
 * mode, amount and — for the electronic modes — the reference the reconciliation upload matches on
 * (E-25/26; in degraded mode the server REQUIRES that ref, so the counter always asks for it).
 *
 * WHAT LEAVES THIS COMPONENT IS THE WIRE SHAPE: `{ mode, amountPaise, refText? }[]` with INTEGER
 * paise, straight from `MoneyInput`. A row that is not yet complete — no amount, or an electronic
 * mode with no reference — is NOT emitted, so an incomplete row can never reach a request body;
 * it shows its refusal inline and the running total reads short until the cashier finishes it.
 *
 * The running total is compared against the payable and rendered short / exact / over. OVER IS NOT
 * AN ERROR (D2 step 5): the surplus is the change-due or banked-advance lane, and the server
 * reports it back as `unallocatedPaise`.
 */

const MODES: TenderMode[] = ["cash", "upi", "card"];

type Row = { key: string; mode: TenderMode; amountPaise: number | undefined; refText: string };

/** An electronic tender without its reference cannot be reconciled — and cannot be posted. */
function needsRef(mode: TenderMode): boolean {
  return mode !== "cash";
}

function toWire(rows: Row[]): WireTender[] {
  const tenders: WireTender[] = [];
  for (const row of rows) {
    const { amountPaise } = row;
    const refText = row.refText.trim();
    if (amountPaise === undefined || amountPaise <= 0) continue;
    if (needsRef(row.mode) && refText === "") continue;
    const tender: WireTender = { mode: row.mode, amountPaise };
    if (refText !== "") tender.refText = refText;
    tenders.push(tender);
  }
  return tenders;
}

let seq = 0;
function nextKey(): string {
  seq += 1;
  return `tender-${String(seq)}`;
}

export function TenderEditor({
  payablePaise, onChange,
}: {
  payablePaise: number;
  /** The complete tenders, in row order. Integer paise, always. */
  onChange: (tenders: WireTender[]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() => [{ key: nextKey(), mode: "cash", amountPaise: undefined, refText: "" }]);

  // `onChange` is re-created by most parents on every render, so it is held in a ref rather than a
  // dependency: the emission is driven by the ROWS changing, never by the parent re-rendering.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current(toWire(rows));
  }, [rows]);

  const patch = (key: string, next: Partial<Row>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)));
  };

  const sumPaise = toWire(rows).reduce((total, tender) => total + tender.amountPaise, 0);
  const state = sumPaise === payablePaise ? "exact" : sumPaise < payablePaise ? "short" : "over";
  const differencePaise = state === "short" ? payablePaise - sumPaise : sumPaise - payablePaise;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t("billing.tender.title")}</h3>
      {rows.map((row, index) => (
        <div key={row.key} data-testid={`tender-row-${String(index)}`} className="space-y-2 rounded border p-2">
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor={`tender-mode-${String(index)}`}>
                {t("billing.tender.mode")}
              </label>
              <select
                id={`tender-mode-${String(index)}`}
                value={row.mode}
                onChange={(e) => patch(row.key, { mode: e.target.value as TenderMode })}
                className="rounded border px-2 py-1"
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>{t(`billing.tender.modes.${mode}`)}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <MoneyInput
                id={`tender-amount-${String(index)}`}
                label={t("billing.tender.amount")}
                onChange={(paise) => patch(row.key, { amountPaise: paise })}
              />
            </div>
            {rows.length > 1 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={`tender-remove-${String(index)}`}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                {t("billing.tender.remove")}
              </Button>
            )}
          </div>
          {needsRef(row.mode) && (
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor={`tender-ref-${String(index)}`}>
                {t("billing.tender.ref")}
              </label>
              <input
                id={`tender-ref-${String(index)}`}
                value={row.refText}
                onChange={(e) => patch(row.key, { refText: e.target.value })}
                className="w-full rounded border px-2 py-1 font-mono text-sm"
              />
              {row.refText.trim() === "" && (
                <p role="alert" className="text-sm text-red-600">{t("billing.tender.refRequired")}</p>
              )}
            </div>
          )}
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRows((current) => [...current, { key: nextKey(), mode: "cash", amountPaise: undefined, refText: "" }])}
      >
        {t("billing.tender.add")}
      </Button>

      <div className="flex flex-wrap items-center gap-3 border-t pt-2 text-sm">
        <span>{t("billing.tender.payable")}: <span data-testid="tender-payable">{fmtPaise(payablePaise)}</span></span>
        <span>{t("billing.tender.tendered")}: <span data-testid="tender-sum">{fmtPaise(sumPaise)}</span></span>
        <span data-testid="tender-state" className={state === "short" ? "text-red-600" : "text-emerald-700"}>
          {state === "exact"
            ? t("billing.tender.exact")
            : state === "short"
              ? t("billing.tender.short", { amount: fmtPaise(differencePaise) })
              : t("billing.tender.over", { amount: fmtPaise(differencePaise) })}
        </span>
      </div>
    </div>
  );
}
