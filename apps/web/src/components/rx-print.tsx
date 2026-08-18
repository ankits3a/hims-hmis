import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { WireRxLine, WireRxPrint, WireVitals } from "../lib/opd-api";

/**
 * The printed e-Rx (D5 / Task 15): the hospital letterhead, the prescriber, the patient, the
 * diagnosis, the latest vitals, one row per drug line, the follow-up line and the signed QR.
 * Props are the T7 `RxPrintData` wire shape verbatim (`GET /opd/prescriptions/:id/print`).
 *
 * THERE IS DELIBERATELY NO SIGNATURE LINE (owner decision 2026-08-15, Assertion Book K50): the
 * HMAC-signed QR IS the authentication of this document, and a printed "Signature: ____" would
 * only invite a hand-signed blank to stand in for it. `t("rx.signature")` does not exist as a key.
 * rx-print.test.tsx asserts the absence, and mutant X3 — a copy that adds the line — is what proves
 * that absence assertion has teeth rather than passing against a fixture that never had one.
 *
 * `.print-doc` isolation (styles.css, T12) makes this the only element that reaches the paper. A
 * screen that mounts this MUST keep it mutually exclusive with any other `.print-doc` surface; the
 * component itself has no opinion on that (the TokenSlip precedent).
 */

/** `BP 120/80 · P 72 · SpO₂ 98% · T 37.0 °C · Wt 60 kg` — present parts only, in that order. */
function vitalsLine(v: WireVitals | null): string | null {
  if (v === null) return null;
  const parts: string[] = [];
  if (v.sbp !== null && v.dbp !== null) parts.push(`BP ${v.sbp}/${v.dbp}`);
  if (v.pulse !== null) parts.push(`P ${v.pulse}`);
  if (v.spo2 !== null) parts.push(`SpO₂ ${v.spo2}%`);
  if (v.tempC !== null) parts.push(`T ${v.tempC.toFixed(1)} °C`);
  if (v.weightKg !== null) parts.push(`Wt ${v.weightKg} kg`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** `drug · dose · frequency · route · N days · instructions` — the T7 dosage order, blanks dropped. */
function lineText(l: WireRxLine, days: (n: number) => string): string {
  const parts = [l.drug, l.dose, l.frequency, l.route];
  if (l.durationDays !== null) parts.push(days(l.durationDays));
  if (l.instructions !== null && l.instructions.trim() !== "") parts.push(l.instructions);
  return parts.filter((p) => p.trim() !== "").join(" · ");
}

export function RxPrint({ data }: { data: WireRxPrint }): React.ReactElement {
  const { t } = useTranslation();
  const p = data.patient;
  const name = p.restricted ? (p.alias ?? "—") : (p.name ?? p.alias ?? "—");
  const vitals = vitalsLine(data.vitals);
  return (
    <div className="space-y-3">
      <div className="print-doc w-[560px] space-y-2 rounded-lg border p-4">
        <header className="space-y-1 border-b pb-2">
          <h2 className="text-lg font-bold">{data.letterhead.name}</h2>
          {data.letterhead.addressLines.map((line) => (
            <p key={line} className="text-xs text-neutral-600">{line}</p>
          ))}
        </header>

        <section className="space-y-1">
          <p className="text-sm font-medium">{data.doctor.displayName}</p>
          {data.doctor.departmentName !== null && (
            <p className="text-xs text-neutral-600">{data.doctor.departmentName}</p>
          )}
          {data.doctor.registrationNo !== null && (
            <p className="text-xs text-neutral-600">{t("rx.regNo")}: {data.doctor.registrationNo}</p>
          )}
        </section>

        <section className="grid grid-cols-2 gap-1 border-y py-2 text-sm">
          <p data-testid="rx-patient-name">{name}</p>
          <p className="font-mono text-xs">{t("rx.uhid")}: {p.uhid}</p>
          <p data-testid="rx-patient-age">{t("rx.age")}: {p.ageYears ?? "—"} · {t("rx.sex")}: {p.sex}</p>
          <p data-testid="rx-date">{t("rx.date")}: {data.encounter.serviceDate}</p>
        </section>

        {data.encounter.diagnosis !== null && (
          <p data-testid="rx-diagnosis" className="text-sm">
            {t("rx.diagnosis")}: {data.encounter.diagnosis}
            {data.encounter.icd10Code !== null ? ` (${data.encounter.icd10Code})` : ""}
          </p>
        )}
        {vitals !== null && (
          <p data-testid="rx-vitals" className="text-sm">{t("rx.vitals")}: {vitals}</p>
        )}

        <ol className="space-y-1 text-sm">
          {data.lines.map((l, i) => (
            <li key={`${l.drug}-${String(i)}`} data-testid={`rx-line-${String(i)}`}>
              {i + 1}. {lineText(l, (n) => t("rx.days", { n }))}
              {l.noSubstitution && <span className="ml-2 text-xs font-medium">{t("rx.noSubstitution")}</span>}
            </li>
          ))}
        </ol>

        {data.encounter.advice !== null && (
          <p className="text-sm">{t("rx.advice")}: {data.encounter.advice}</p>
        )}
        {data.encounter.followUpDays !== null && (
          <p data-testid="rx-follow-up" className="text-sm">
            {t("rx.followUp", { days: data.encounter.followUpDays })}
          </p>
        )}

        <div className="flex items-end justify-between pt-2">
          <QRCodeSVG value={data.qrPayload} size={96} />
          <span className="text-xs text-neutral-500">{t("rx.version", { n: data.version })}</span>
        </div>
        {/* No signature line — the signed QR above is the authentication (K50). */}
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("rx.print")}
      </Button>
    </div>
  );
}
