import { useTranslation } from "react-i18next";
import type { WireLabel } from "../lib/pharmacy-api";

/**
 * PLAN 16c T4 — ONE LABEL PER PACK, browser-printed (the lab's `specimen-label` posture: no ZPL).
 * Bilingual headings, the directions as the doctor wrote them, the batch and expiry off the ledger,
 * and D6's "in place of <brand>" when a generic was substituted. 70 × 40 mm, the common
 * dispensing-label roll.
 */
export function DispenseLabel({ label }: { label: WireLabel }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="dispense-labels">
      <style>{`
        @media print { body * { visibility: hidden; } .dispense-labels, .dispense-labels * { visibility: visible; } .dispense-labels { position: absolute; left: 0; top: 0; } }
        .dispense-label { width: 70mm; min-height: 40mm; border: 1px dashed #999; padding: 3mm; margin: 2mm; font: 10pt/1.25 system-ui, sans-serif; page-break-inside: avoid; }
        .dispense-label .drug { font-weight: 700; font-size: 12pt; }
        .dispense-label .small { font-size: 8pt; color: #333; }
      `}</style>
      {label.lines.map((l) => (
        <div key={l.lineIdx} className="dispense-label" data-testid={`label-${String(l.lineIdx)}`}>
          <div className="small">{t("hospital.name")} · {label.dispenseNo ?? ""}</div>
          <div>{label.patient.display} · <span className="small">{label.patient.uhid}</span></div>
          <div className="drug">{l.drug}{l.strength !== null ? ` ${l.strength}` : ""}{l.form !== null ? ` ${l.form}` : ""}</div>
          {l.substitutedFor !== null && <div className="small">{t("pharmacyCounter.substitutedFor", { brand: l.substitutedFor })}</div>}
          <div>{t("pharmacyCounter.qty")}: {l.qtyBase} {l.unit}{l.packs !== null ? ` (${l.packs})` : ""}</div>
          <div>{t("pharmacyCounter.directions")}: {l.directions}</div>
          <div className="small">{t("pharmacyCounter.batch")} {l.batchNo}{l.expiryDate !== null ? ` · ${t("pharmacyCounter.expiry")} ${l.expiryDate}` : ""}</div>
        </div>
      ))}
    </div>
  );
}
