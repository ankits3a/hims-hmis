import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { fmtPaise } from "../lib/format";
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

/** `BP 120/80 · P 72 · SpO₂ 98% · T 37.0 °C · Wt 60 kg · Glucose 186 mg/dL (random)` — present parts only, in that order. */
const GLUCOSE_WHEN: Record<string, string> = { fasting: "fasting", random: "random", after_food: "after food" };
function vitalsLine(v: WireVitals | null): string | null {
  if (v === null) return null;
  const parts: string[] = [];
  if (v.sbp !== null && v.dbp !== null) parts.push(`BP ${v.sbp}/${v.dbp}`);
  if (v.pulse !== null) parts.push(`P ${v.pulse}`);
  if (v.spo2 !== null) parts.push(`SpO₂ ${v.spo2}%`);
  if (v.tempC !== null) parts.push(`T ${v.tempC.toFixed(1)} °C`);
  if (v.weightKg !== null) parts.push(`Wt ${v.weightKg} kg`);
  // Owner 2026-10-08 — the number and WHEN it was taken, and nothing about what it means.
  if (v.glucoseMgDl !== null && v.glucoseMgDl !== undefined) {
    const when = GLUCOSE_WHEN[v.glucoseTiming ?? ""];
    parts.push(`Glucose ${v.glucoseMgDl} mg/dL${when === undefined ? "" : ` (${when})`}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * `drug · dose · frequency · route · eye · N days · instructions` — the T7 dosage order, blanks
 * dropped. The eye sits after the route, as the FHIR dosage text has it.
 */
function lineText(l: WireRxLine, days: (n: number) => string, eye: (e: NonNullable<WireRxLine["eye"]>) => string): string {
  const parts = [l.drug, l.dose, l.frequency, l.route];
  if (l.eye !== undefined && l.eye !== null) parts.push(eye(l.eye));
  if (l.durationDays !== null) parts.push(days(l.durationDays));
  if (l.instructions !== null && l.instructions.trim() !== "") parts.push(l.instructions);
  return parts.filter((p) => p.trim() !== "").join(" · ");
}

export function RxPrint({ data }: { data: WireRxPrint }): React.ReactElement {
  const { t } = useTranslation();
  const p = data.patient;
  const name = p.restricted ? (p.alias ?? "—") : (p.name ?? p.alias ?? "—");
  const vitals = vitalsLine(data.vitals);
  /*
    EVERY DIAGNOSIS PRINTS WITH ITS OWN CODE (consult walk 2026-09-28, defect C). The display string
    carries every tag but only the PRIMARY code, so two diagnoses printed as "A · B (A01.00)" and the
    second code was lost from the paper. The coded rows print tag by tag whenever the payload has them;
    a payload from before the rows existed prints the display string as it always did.
  */
  const rows = data.encounter.diagnoses ?? [];
  const codedDiagnoses = rows.length > 0 ? rows : null;
  return (
    <div className="space-y-3">
      <div className="print-doc w-[560px] space-y-2 rounded-lg border p-4">
        <header className="space-y-1 border-b pb-2">
          <h2 className="text-lg font-bold">{data.letterhead.name}</h2>
          {data.letterhead.addressLines.map((line) => (
            <p key={line} className="text-xs text-neutral-600">{line}</p>
          ))}
        </header>

        {/*
          Owner ruling 2026-10-06 — A TRANSCRIPTION SAYS IT IS ONE. When the desk typed this from the
          doctor's paper, the sheet must not pass for a prescription the doctor keyed and the QR
          authenticated as theirs: it names the desk that typed it and says the signed paper is the
          original. Printed, not only shown — the pharmacist reads the paper copy.
        */}
        {data.transcribedByName != null && (
          <p data-testid="rx-transcribed" className="rounded border border-neutral-400 px-2 py-1 text-xs font-semibold">
            {t("paper.printNote", { name: data.transcribedByName })}
          </p>
        )}

        {/*
          THE PRESCRIBER IS THE DOCTOR ID, AND ONLY THAT — owner rulings 2026-09-06 ("As a medical
          Institution with college, there's no need of mentioning Dr. Name and their registration
          number. Only Dr. ID is required.") and 2026-09-28 ("Prescription print: Doctor ID only").
          The name and the council number are not read here even if an old payload carries them.
          No signature line joins it: K50 (owner 2026-08-15) makes the signed QR the authentication.
        */}
        {/*
          OWNER 2026-10-04 — SUPERSEDES the above: the department, then **Unit Number** (the unit for a
          unit doctor; the Doctor ID for Guest Faculty and — DECIDED — anyone in no unit) and **Dept.
          Regn** (that day's unit head's council number, blank when none). Never a doctor's name, and
          never the words "Guest Faculty". The server resolves both (`prescriberPrint`).
        */}
        <section className="space-y-1">
          {data.doctor.departmentName !== null && (
            <p data-testid="rx-department" className="text-sm font-medium">{data.doctor.departmentName}</p>
          )}
          {data.doctor.unitNumber !== undefined ? (
            <>
              <p data-testid="rx-unit-number" className="text-sm">{t("rx.unitNumber")}: <span className="font-mono">{data.doctor.unitNumber}</span></p>
              {/* Blank — no placeholder — when the unit head's number is not on file (owner 2026-10-04). */}
              <p data-testid="rx-dept-regn" className="text-sm">{t("rx.deptRegn")}: <span className="font-mono">{data.doctor.deptRegn ?? ""}</span></p>
            </>
          ) : (
            <p data-testid="rx-doctor-id" className="text-sm font-medium">{t("rx.doctorId")} <span className="font-mono">{data.doctor.code ?? "—"}</span></p>
          )}
        </section>

        <section className="grid grid-cols-2 gap-1 border-y py-2 text-sm">
          <p data-testid="rx-patient-name">{name}</p>
          <p className="font-mono text-xs">{t("rx.uhid")}: {p.uhid}</p>
          <p data-testid="rx-patient-age">{t("rx.age")}: {p.ageYears ?? "—"} · {t("rx.sex")}: {p.administrativeGender}</p>
          <p data-testid="rx-date">{t("rx.date")}: {data.encounter.serviceDate}</p>
          {/*
            The visit number is the cross-reference a lab requisition or a pharmacy slip will quote
            back. It needs no spelled-month partner here the way the token slip's does: this
            document already carries an unambiguous four-digit-year date in the cell above, so the
            YYMMDD inside the id cannot be the only date a reader has.
          */}
          <p data-testid="rx-visit-no" className="font-mono text-xs">{t("rx.visitNo")}: {data.encounter.visitNo}</p>
        </section>

        {data.encounter.diagnosis !== null && (
          <p data-testid="rx-diagnosis" className="text-sm">
            {/*
              THE EYE PRINTS BESIDE ITS OWN CODE (board "Ophthal"). The display string carries every
              tag but only the PRIMARY code, so it cannot say which tag is which eye — a visit that
              names an eye prints tag by tag from the coded rows; every other visit prints as before.
            */}
            {t("rx.diagnosis")}: {codedDiagnoses !== null
              ? codedDiagnoses.map((d) => `${d.text}${d.icd10Code === null ? "" : ` (${d.icd10Code}${d.laterality === null ? "" : `, ${t(`rx.eye.${d.laterality}`)}`})`}`).join(" · ")
              : <>{data.encounter.diagnosis}{data.encounter.icd10Code !== null ? ` (${data.encounter.icd10Code})` : ""}</>}
          </p>
        )}
        {vitals !== null && (
          <p data-testid="rx-vitals" className="text-sm">{t("rx.vitals")}: {vitals}</p>
        )}

        <ol className="space-y-1 text-sm">
          {data.lines.map((l, i) => (
            <li key={`${l.drug}-${String(i)}`} data-testid={`rx-line-${String(i)}`}>
              {i + 1}. {lineText(l, (n) => t("rx.days", { n }), (e) => t(`rx.eye.${e}`))}
              {l.noSubstitution && <span className="ml-2 text-xs font-medium">{t("rx.noSubstitution")}</span>}
            </li>
          ))}
        </ol>

        {data.encounter.advice !== null && (
          <p className="text-sm">{t("rx.advice")}: {data.encounter.advice}</p>
        )}

        {/*
          PLAN 07d T5 / DD4 — **ADVISED TESTS, AND THE PAPER SAYS WHAT THEY ARE NOT.**

          This creates no order, books no sample and returns no result: there is no lab or radiology
          module in this system. What it is, is what an Indian hospital does before a LIMS lands —
          the tests are written on the slip WITH their prices, the patient takes it to the counter,
          and somebody bills them.

          The disclaimer is on the PAPER and not only on the screen, deliberately. The slip outlives
          the consultation and is read by a patient, a relative and a counter clerk, none of whom
          saw the screen. A printed list of test names that looked like an order would send somebody
          to a sample-collection desk that does not exist.
        */}
        {/*
          `?? []` IS NOT DEFENSIVE CLUTTER, and `auth.tsx` records the same reasoning for
          `permissions ?? NO_PERMISSIONS`: a browser tab left open across a deploy can hold a print
          payload older than this field, and an undefined list must read as "none advised" rather
          than crash the whole printable document. A prescription that will not render is a patient
          who leaves without their slip.
        */}
        {(data.encounter.advisedTests ?? []).length > 0 && (
          <div data-testid="rx-advised-tests" className="text-sm">
            <p className="font-medium">{t("rx.advisedTests")}</p>
            <ul className="ml-4 list-disc">
              {(data.encounter.advisedTests ?? []).map((test) => (
                <li key={test.serviceId}>
                  {test.name} — {fmtPaise(test.pricePaise)}
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-600">
              {t("rx.advisedTestsNote", { date: data.encounter.serviceDate })}
            </p>
          </div>
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
