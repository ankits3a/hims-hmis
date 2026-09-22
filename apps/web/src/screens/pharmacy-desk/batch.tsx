import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { batchRows, chosenBatch, expiryLabel } from "./work";
import type { Tick } from "./work";
import type { WireDispenseLine } from "../../lib/pharmacy-api";

/**
 * ═══ THE FEFO BATCH & SHELF CHIP, AND ITS SHEET (`B`) ═══
 *
 * The board's `.bchip`: under the drug being given, one button naming the batch that goes out and
 * where it sits. FEFO's first is preselected; a later batch is the pharmacist's choice, sent to the
 * pick as `batchId` and recorded there as a FEFO override — so the chip then says "later batch" in
 * amber. Location is per item at the counter's store (`pharmacy_shelf_locations`), so every batch
 * of a drug reads the same rack.
 */
function Shelf({ where, testId }: { where: string; testId?: string }): React.ReactElement {
  return (
    <span className="bshelf" data-testid={testId}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18M3 12h18M3 19h18M6 5v14M18 5v14" /></svg>
      {where}
    </span>
  );
}

export function BatchChip({ line, tick, onOpen }: { line: WireDispenseLine; tick: Tick | undefined; onOpen: (() => void) | null }): React.ReactElement | null {
  const { t } = useTranslation();
  const id = `desk-line-${String(line.lineIdx)}`;
  /* Collected: the batch it was GIVEN from, as a fact, not a choice. */
  if (line.pickedBatch != null) {
    return (
      <span className="bchip static" data-testid={`${id}-batch`}>
        <span className={line.fefoOverride ? "pill gd" : "pill on"}>{line.fefoOverride ? t("pharmacyDesk.batch.later") : t("pharmacyDesk.batch.given")}</span>
        <span className="mo">{t("pharmacyDesk.givenFrom", { batch: line.pickedBatch.batchNo, expiry: expiryLabel(line.pickedBatch.expiryDate) })}</span>
        {line.location == null ? null : <Shelf where={line.location} testId={`${id}-where`} />}
      </span>
    );
  }
  const b = chosenBatch(line, tick);
  if (b === undefined) return null;
  const fefo = b.batchId === line.batches?.[0]?.batchId;
  const body = (
    <>
      <span className={fefo ? "pill on" : "pill gd"}>{fefo ? t("pharmacyDesk.batch.fefo") : t("pharmacyDesk.batch.later")}</span>
      <span className="mo">{t("pharmacyDesk.batch.chip", { batch: b.batchNo, expiry: expiryLabel(b.expiryDate) })}</span>
      {tick !== undefined && tick.scan.trim() !== "" ? <span className="mo" style={{ color: "var(--dim)" }}>{t("pharmacyDesk.scanned")}</span> : null}
      {line.location == null ? null : <Shelf where={line.location} testId={`${id}-where`} />}
    </>
  );
  if (onOpen === null) return <span className="bchip static" data-testid={`${id}-batch`}>{body}</span>;
  return (
    <button
      type="button"
      className="bchip"
      data-testid={`${id}-batch`}
      aria-label={t("pharmacyDesk.batch.a11y", { batch: b.batchNo, expiry: expiryLabel(b.expiryDate), where: line.location ?? t("pharmacyDesk.batch.noShelf") })}
      onClick={onOpen}
    >
      {body}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
  );
}

export function BatchSheet({ line, tick, today, onChoose, onClose }: {
  line: WireDispenseLine;
  tick: Tick | undefined;
  today: string;
  /** null = FEFO's first (nothing to name to the pick); otherwise the batch id to send. */
  onChoose: (batchId: string | null) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const rows = batchRows(line, tick, today);
  const drug = line.dispensedMedicine?.brandName ?? line.rxLine.drug;
  const title = t("pharmacyDesk.batch.title");
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={`${title} — ${drug}`} onClick={onClose}>
      <div className="box" style={{ width: 620, maxWidth: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <span className="tag">{title}</span>
          <h2 style={{ margin: "3px 0 0 0", fontSize: 15, fontWeight: 600 }}>{drug}</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.batch.rule")}</p>
        </div>
        <div style={{ display: "flex", gap: 12, padding: "8px 18px", background: "var(--wash)" }}>
          <span style={{ width: 16 }} />
          <span className="tag" style={{ width: 110 }}>{t("pharmacyDesk.batch.colBatch")}</span>
          <span className="tag" style={{ width: 118 }}>{t("pharmacyDesk.batch.colExpires")}</span>
          <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.batch.colWhere")}</span>
          <span className="tag" style={{ width: 80, textAlign: "right" }}>{t("pharmacyDesk.batch.colOnHand")}</span>
        </div>
        <div style={{ overflowY: "auto" }}>
          {rows.map((r) => (
            <button
              key={r.batch.batchId}
              type="button"
              className={`brow${r.chosen ? " sel" : ""}${r.fefo ? "" : " late"}`}
              aria-pressed={r.chosen}
              onClick={() => onChoose(r.fefo ? null : r.batch.batchId)}
            >
              <span className="radio" />
              <span className="mo" style={{ width: 110, fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>{r.batch.batchNo}</span>
              <span style={{ width: 118 }}>
                <span className="mo" style={{ display: "block", fontSize: 12.5 }}>{expiryLabel(r.batch.expiryDate)}</span>
                {r.days === null ? null : (
                  <span style={{ display: "block", fontSize: 10.5, color: r.soon ? "var(--gold-ink, #9a6208)" : "var(--dim)" }}>
                    {r.days < 31 ? t("pharmacyDesk.batch.daysLeft", { count: Math.max(r.days, 0) }) : t("pharmacyDesk.batch.monthsLeft", { count: Math.floor(r.days / 30.44) })}
                  </span>
                )}
              </span>
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{line.location ?? t("pharmacyDesk.batch.noShelf")}</span>
                {r.fefo ? (
                  <span className={r.soon ? "pill gd" : "pill on"} style={{ marginTop: 4 }}>
                    {r.soon ? t("pharmacyDesk.batch.fefoSoon") : t("pharmacyDesk.batch.fefoFirst")}
                  </span>
                ) : null}
              </span>
              <span className="mo" style={{ width: 80, textAlign: "right", fontSize: 12.5, color: "var(--ink)" }}>{r.onHand}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--line2)" }}>
          <span style={{ fontSize: 11.5, color: "var(--dim)", flexGrow: 1 }}>
            <span className="kb">B</span> {t("pharmacyDesk.batch.keyHint")} · <span className="kb">Esc</span> {t("pharmacyDesk.batch.closes")}
          </span>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyDesk.close")}</button>
        </div>
      </div>
    </div>
  );
}
