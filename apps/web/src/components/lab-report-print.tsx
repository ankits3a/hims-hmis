import { useTranslation } from "react-i18next";
import { flagTone } from "../lib/lab-api";
import type { WireReportPanel, WireReportView } from "../lib/lab-api";

/**
 * PLAN 17b T8 — **THE A4 LABORATORY REPORT**, laid out from
 * `docs/design/2026-08-29-opd-counter-flow/ReportA4.dc.html`.
 *
 * ═══ THE DESIGN TREE IS ANOTHER SESSION'S AND UNTRACKED, SO IT IS COPIED BY EYE ═══
 *
 * Plan 17 §9.3 S8 ruled it: that tree is READ for the layout and **never staged**, and
 * `rx-print.tsx` is the committed precedent for everything structural — the `.print-doc` isolation,
 * the letterhead block, the fixed page width. What comes from the design is the ORDER of the
 * sections and the shape of the results table: identity block, accreditation mark, one table per
 * panel with `Test name / value / Unit / Flag / Biological ref. interval`, the notes, and the two
 * signatories.
 *
 * ═══ EVERY VALUE ON THIS PAGE COMES FROM THE SNAPSHOT, NOT FROM TODAY'S DATA (DD13 / E4) ═══
 *
 * The component reads `report.snapshot` and nothing else about the patient. That is what makes a
 * reprint of last year's report the SAME DOCUMENT rather than today's data in last year's layout —
 * a merge, a renamed analyte or a re-curated range book afterwards changes nothing here.
 *
 * ═══ NO SIGNATURE LINE TO SIGN — AND THE REASON IS `rx-print.tsx`'s, NOT A NEW ONE ═══
 *
 * The signatory block NAMES the pathologist who signed and says the report is computer generated.
 * A printed "Signature: ______" invites a hand-signed blank to stand in for the record, which is
 * exactly what DD13's versioned snapshot exists to make unnecessary.
 *
 * ═══ `.print-doc` ISOLATION (styles.css) ═══
 *
 * This is the only element that reaches the paper. A screen that mounts it MUST keep it mutually
 * exclusive with any other `.print-doc` surface; the component has no opinion on that (the
 * `TokenSlip` and `RxPrint` precedent).
 */

/** The flag word a clinician reads. Never a bare letter: "HH" means nothing at a nursing station. */
function flagLabel(flag: string | null, t: (k: string) => string): string {
  switch (flag) {
    case "HH": return t("lab.print.flagCriticalHigh");
    case "LL": return t("lab.print.flagCriticalLow");
    case "H": return t("lab.print.flagHigh");
    case "L": return t("lab.print.flagLow");
    case "A": return t("lab.print.flagAbnormal");
    case "N": return t("lab.print.flagNormal");
    default: return "—";
  }
}

/** `15 – 40`, `< 1:80`, or a dash. The range AS IT WAS SIGNED AGAINST — never today's book. */
function refText(line: { refLow: string | null; refHigh: string | null; refText: string | null }): string {
  if (line.refText !== null && line.refText !== "") return line.refText;
  if (line.refLow !== null && line.refHigh !== null) return `${trim(line.refLow)} – ${trim(line.refHigh)}`;
  if (line.refHigh !== null) return `≤ ${trim(line.refHigh)}`;
  if (line.refLow !== null) return `≥ ${trim(line.refLow)}`;
  return "—";
}

/** `4.9400` reads as clutter on paper; `4.94` is the same number. Trailing zeros only. */
function trim(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function Panel({ panel, t }: { panel: WireReportPanel; t: (k: string) => string }): React.ReactElement {
  return (
    <section className="space-y-1">
      <h3 className="border-b border-neutral-400 pb-1 text-sm font-bold uppercase">
        {panel.nameEn}
        {panel.nameHi !== null && <span className="ml-2 font-normal">{panel.nameHi}</span>}
      </h3>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-neutral-100">
            <th className="border border-neutral-400 px-2 py-1 text-left">{t("lab.print.testName")}</th>
            <th className="border border-neutral-400 px-2 py-1 text-right">{t("lab.print.result")}</th>
            <th className="border border-neutral-400 px-2 py-1 text-left">{t("lab.print.unit")}</th>
            <th className="border border-neutral-400 px-2 py-1 text-left">{t("lab.print.flag")}</th>
            <th className="border border-neutral-400 px-2 py-1 text-left">{t("lab.print.refInterval")}</th>
          </tr>
        </thead>
        <tbody>
          {panel.analytes.map((line) => {
            const tone = flagTone(line.flag);
            return (
              <tr key={line.analyteCode}>
                <td className="border border-neutral-400 px-2 py-1">
                  {line.nameEn}
                  {line.nameHi !== null && <span className="ml-1 text-neutral-600">/ {line.nameHi}</span>}
                </td>
                <td
                  className={`border border-neutral-400 px-2 py-1 text-right tabular-nums ${
                    tone === "critical" ? "font-bold" : tone === "abnormal" ? "font-semibold" : ""
                  }`}
                >
                  {trim(line.value)}
                  {/* 02 H2 — a delta is a MARKER beside the number, never a colour a photocopy loses. */}
                  {line.deltaFlag && <span className="ml-1" aria-label="delta">Δ</span>}
                </td>
                <td className="border border-neutral-400 px-2 py-1">{line.unit ?? "—"}</td>
                <td className="border border-neutral-400 px-2 py-1">{flagLabel(line.flag, t)}</td>
                <td className="border border-neutral-400 px-2 py-1 tabular-nums">{refText(line)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/*
        DD11 — A NIGHT-MODE RELEASE PRINTS AS PROVISIONAL. The technologist signed it alone and the
        pathologist has not reviewed it yet; a report that hid that would present a single-operator
        release as an ordinary one, which is the whole reason the flag is on the row.
      */}
      {panel.analytes.some((a) => a.pathologistReviewPending) && (
        <p className="text-xs font-semibold">{t("lab.print.provisional")}</p>
      )}
    </section>
  );
}

/**
 * ═══ 17d T7 / D8 — THE PATIENT'S COPY MAY SPEAK HINDI, AND IT IS THE SAME DOCUMENT ═══
 *
 * Design board EdgeCases #25: *"Patient reads Hindi only."* The SMS and WhatsApp text are already
 * bilingual; the paper was not. What changes is the FURNITURE — the column headings, the flag
 * words, the standing notes — and nothing else:
 *
 * · **No value, unit or reference interval is translated.** `4.94`, `mg/dL` and `0.35 – 4.94` are
 *   the same in every language, and a report whose NUMBERS depended on a toggle would be two
 *   different documents claiming one signature. The one thing this feature must not do is change
 *   what the report says.
 * · Analyte names already print `nameEn` with `nameHi` beside them and are untouched here: that is
 *   the catalogue's bilingual data, not this component's presentation.
 * · **The doctor's copy stays English** by NABL convention, which is why `lang` is a parameter the
 *   caller passes rather than a global the app switches: the same screen prints both copies, and a
 *   patient asking for Hindi must not change what the ward receives.
 *
 * `getFixedT("hi")` rather than switching the app's language: this renders a Hindi document inside
 * an English SPA, and a component that reached for `i18n.changeLanguage` would repaint the whole
 * screen behind the clerk who pressed print.
 */
export function LabReportPrint({
  report, lang = "en",
}: { report: WireReportView; lang?: "en" | "hi" }): React.ReactElement {
  const { t: tApp, i18n } = useTranslation();
  const t = lang === "hi" ? i18n.getFixedT("hi") : tApp;
  const s = report.snapshot;
  return (
    <div className="print-doc lab-report-a4 w-[760px] space-y-3 rounded-lg border bg-white p-6 text-black">
      {/*
        ═══ A4, NOT THE SHARED A5 `@page` RULE (close review, web MAJOR) ═══

        `styles.css`'s print block is sized for the prescription and the token slip. A laboratory
        report is A4 and its own `@media print` rule is scoped to this class, so nothing else on the
        SPA changes size. The rule lives here, beside the component that needs it, for the reason
        the component's own header gives about `.print-doc`: a screen must not have to remember it.
      */}
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm; } .lab-report-a4 { width: auto; border: 0; padding: 0; } }`}</style>
      {/*
        ═══ THE HOSPITAL, FROM THE SNAPSHOT AND NOT FROM A TRANSLATION STRING ═══

        This header used to be `t("lab.print.department")` alone — "Department of Laboratory
        Medicine", identical in every hospital that ever runs this software. An Indian pathology
        report identifies the laboratory that issued it, and the printed invoice and the e-Rx have
        both carried `opd.letterhead` since Plan 07; the lab report was the only printed document in
        the system that did not.

        Read off `s.letterhead` and NOT from a live config call, because a report is a frozen signed
        artefact: a rename must not rewrite a document already handed to a patient. The fallback
        keeps a pre-change snapshot rendering exactly as it was signed — those reports are immutable
        by trigger and cannot be backfilled.
      */}
      <header className="flex items-start justify-between border-b-2 border-black pb-2">
        <div>
          {s.letterhead != null && (
            <>
              <h1 className="text-xl font-bold">{s.letterhead.name}</h1>
              {s.letterhead.addressLines.map((line) => (
                <p key={line} className="text-xs text-neutral-700">{line}</p>
              ))}
            </>
          )}
          <h2 className="mt-1 text-sm font-bold">{t("lab.print.department")}</h2>
          <p className="text-xs text-neutral-700">{t("lab.print.reportTitle")}</p>
        </div>
        <div className="text-right text-xs">
          <p className="font-bold">{s.orderNo}</p>
          <p>
            {t("lab.print.version")} {report.version}
            {report.version > 1 && <span className="ml-1 font-bold">· {t("lab.print.amended")}</span>}
          </p>
          {report.partial && <p className="font-bold">{t("lab.print.partial")}</p>}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
        <p><span className="text-neutral-700">{t("lab.print.name")}: </span><span className="font-bold">{s.patient.name}</span></p>
        <p><span className="text-neutral-700">{t("lab.print.uhid")}: </span><span className="font-bold">{s.patient.uhid}</span></p>
        <p><span className="text-neutral-700">{t("lab.print.sex")}: </span><span className="font-bold">{s.patient.sex}</span></p>
        <p><span className="text-neutral-700">{t("lab.print.dob")}: </span><span className="font-bold">{s.patient.dob ?? "—"}</span></p>
        <p><span className="text-neutral-700">{t("lab.print.encounter")}: </span><span className="font-bold">{s.encounterNo}</span></p>
        <p><span className="text-neutral-700">{t("lab.print.serviceDate")}: </span><span className="font-bold">{s.serviceDate}</span></p>
        {s.panels[0]?.specimenNo != null && (
          <p><span className="text-neutral-700">{t("lab.print.specimenNo")}: </span><span className="font-bold">{s.panels[0].specimenNo}</span></p>
        )}
        <p><span className="text-neutral-700">{t("lab.print.authorised")}: </span><span className="font-bold">{s.signatory.signedAt}</span></p>
      </section>

      {s.panels.map((panel) => <Panel key={panel.orderItemId} panel={panel} t={t} />)}

      {/* 02 H4/H5 — why a range could not be chosen on the usual evidence, printed where a clinician
          reads it rather than kept in a column nobody prints. */}
      {s.notes.length > 0 && (
        <section className="space-y-0.5 text-xs">
          {s.notes.map((note) => <p key={note}>· {note}</p>)}
        </section>
      )}

      <section className="space-y-0.5 border-t border-neutral-400 pt-2 text-xs">
        <p className="font-bold">{t("lab.print.pleaseNote")}</p>
        <p>{t("lab.print.note1")}</p>
        <p>{t("lab.print.note2")}</p>
        <p>{t("lab.print.note3")}</p>
      </section>

      <footer className="flex items-end justify-between border-t border-neutral-400 pt-2 text-xs">
        {/*
          ═══ A NAMED, REGISTERED PRACTITIONER — NOT A LOGIN ═══

          This printed `s.signatory.username`. A username is an authentication artefact and appears
          on no medical document anywhere; the report was signed "dr.iyer". `users.full_name` is
          `notNull()` and `opd_doctors.registration_no` is the council number the e-Rx already
          prints, and both were one join away for the whole of Plan 17.

          It survived every test because `test/helpers/opd.ts` creates users with
          `fullName: username`, so the two render the same string in every suite that has ever run.

          The registration line appears only when there IS one: `registration_no` is nullable, and a
          blank is what tells the person filing the report that a datum is missing. Printing the
          username in its place would be a false claim on a legal document.
        */}
        <div>
          <p className="text-neutral-700">{t("lab.print.authorisedBy")}</p>
          <p className="font-bold">{s.signatory.fullName ?? s.signatory.username}</p>
          {s.signatory.registrationNo != null && (
            <p className="text-neutral-700">
              {t("lab.print.registrationNo")}: {s.signatory.registrationNo}
            </p>
          )}
        </div>
        <p className="max-w-[300px] text-right text-neutral-700">{t("lab.print.computerGenerated")}</p>
      </footer>
    </div>
  );
}
