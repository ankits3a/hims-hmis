import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtPaise } from "../lib/format";
import { MoneyInput } from "./money-input";
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
  payablePaise, onChange, lane,
}: {
  payablePaise: number;
  /** The complete tenders, in row order. Integer paise, always. */
  onChange: (tenders: WireTender[]) => void;
  /**
   * ═══ FD-25 — THE FAST PATH, DRIVING THIS EDITOR RATHER THAN REPLACING IT ═══
   *
   * The billing artboard draws THREE LANES keyed 1/2/3 — cash, UPI, card — and the amount already
   * filled in, because the overwhelmingly common bill is one payment of the exact payable and a
   * cashier should not assemble that by hand from an empty row.
   *
   * It does NOT draw a mixed-tender editor, and it would have been easy to read that as permission
   * to delete one. That would be wrong: mixed tenders are real (₹200 cash and the rest on UPI is an
   * ordinary Indian counter transaction), they are supported end to end, and this component's
   * exact/short/over states are the tested guard on the arithmetic.
   *
   * So the lanes SEED this editor rather than bypassing it. A cashier who presses `2` gets one UPI
   * row for the full payable and can still add a second row; a cashier who ignores the lanes gets
   * exactly what they got before. The artboard's common case is one press, and the uncommon case
   * did not have to be sacrificed for it.
   *
   * Seeded on CHANGE only, so a cashier who then edits the amount is not overwritten on the next
   * render — the lane is an instruction, not a binding.
   */
  lane?: { mode: TenderMode; amountPaise: number; nonce: number } | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() => [{ key: nextKey(), mode: "cash", amountPaise: undefined, refText: "" }]);

  const lastLane = useRef<number | null>(null);
  useEffect(() => {
    if (lane === undefined || lane === null || lane.nonce === lastLane.current) return;
    lastLane.current = lane.nonce;
    setRows([{ key: nextKey(), mode: lane.mode, amountPaise: lane.amountPaise, refText: "" }]);
  }, [lane]);

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

  /*
    ═══ FD-25 — THE ONE BLOCK OF THE OLD DESIGN LEFT IN THE MIDDLE OF THE MONEY COLUMN ═══

    Found by looking at the redesigned `/billing`: everything around this had become paper-and-pine
    and this had not, so a shadcn card with `rounded border px-2 py-1` sat between the three lanes
    and the primary button — the most-looked-at part of the screen. Restyled onto the same
    primitives, no behaviour touched: every testid, every handler and the exact/short/over states
    are exactly as they were, and `billing-dues.tsx` mounts the same component unchanged.
  */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <span className="tag">{t("billing.tender.title")}</span>
      {rows.map((row, index) => (
        <div
          key={row.key}
          data-testid={`tender-row-${String(index)}`}
          style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "11px 12px", display: "flex", flexDirection: "column", gap: 9 }}
        >
          <div style={{ display: "flex", alignItems: "flex-end", gap: 9 }}>
            <div style={{ width: 110 }}>
              <label className="tag" htmlFor={`tender-mode-${String(index)}`} style={{ display: "block", marginBottom: 5 }}>
                {t("billing.tender.mode")}
              </label>
              <select
                id={`tender-mode-${String(index)}`}
                className="in"
                style={{ height: 36 }}
                value={row.mode}
                onChange={(e) => patch(row.key, { mode: e.target.value as TenderMode })}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>{t(`billing.tender.modes.${mode}`)}</option>
                ))}
              </select>
            </div>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              {/*
                ═══ THE FIELD SHOWS WHAT WILL BE POSTED ═══

                A lane seed (the `lane` effect above) writes an amount into ROW STATE and `toWire`
                posts it; without `value` the cashier read a BLANK box while the full payable was
                armed, and a figure typed before the lane press vanished with nothing in its place.
                The drawer is counted on the posted tender (`sessions.ts`: `expectedCashPaise =
                openingFloat + Σ cash tenders − …`), so a box that cannot state its own number is a
                variance waiting at close. The REFERENCE input eleven lines below was bound all
                along; the one control carrying the money was not.

                `MoneyInput` reads `value` ONCE, at mount, on purpose — re-deriving it per keystroke
                would rewrite "112." to "112.00" under the cashier's fingers — so the `key` is what
                makes a re-seed land. The row wrapper already carries `row.key` and would remount
                this anyway; it is restated HERE, at the thing that depends on it, so a later
                refactor that reuses the row key cannot silently re-hide the amount again.
              */}
              <MoneyInput
                key={row.key}
                id={`tender-amount-${String(index)}`}
                label={t("billing.tender.amount")}
                value={row.amountPaise}
                onChange={(paise) => patch(row.key, { amountPaise: paise })}
              />
            </div>
            {rows.length > 1 && (
              <button
                type="button"
                className="sec"
                data-testid={`tender-remove-${String(index)}`}
                style={{ height: 36 }}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                {t("billing.tender.remove")}
              </button>
            )}
          </div>
          {needsRef(row.mode) && (
            <div>
              <label className="tag" htmlFor={`tender-ref-${String(index)}`} style={{ display: "block", marginBottom: 5 }}>
                {t("billing.tender.ref")}
              </label>
              <input
                id={`tender-ref-${String(index)}`}
                className="in mo"
                value={row.refText}
                onChange={(e) => patch(row.key, { refText: e.target.value })}
              />
              {/* A UPI or card payment with no reference cannot be reconciled at close, so the
                  refusal is stated here rather than discovered by the person counting the drawer. */}
              {row.refText.trim() === "" && (
                <p role="alert" style={{ margin: "5px 0 0", fontSize: 11, color: "var(--red)" }}>
                  {t("billing.tender.refRequired")}
                </p>
              )}
            </div>
          )}
        </div>
      ))}

      <button
        type="button"
        className="sec"
        style={{ alignSelf: "flex-start" }}
        onClick={() => setRows((current) => [...current, { key: nextKey(), mode: "cash", amountPaise: undefined, refText: "" }])}
      >
        {t("billing.tender.add")}
      </button>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 13, paddingTop: 9, borderTop: "1px solid var(--line2)", fontSize: 12 }}>
        <span style={{ color: "var(--dim)" }}>
          {t("billing.tender.payable")}: <span className="mo" data-testid="tender-payable" style={{ color: "var(--ink)" }}>{fmtPaise(payablePaise)}</span>
        </span>
        <span style={{ color: "var(--dim)" }}>
          {t("billing.tender.tendered")}: <span className="mo" data-testid="tender-sum" style={{ color: "var(--ink)" }}>{fmtPaise(sumPaise)}</span>
        </span>
        <span
          data-testid="tender-state"
          className={state === "short" ? "pill rd" : state === "over" ? "pill gd" : "pill on"}
        >
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
