import { useTranslation } from "react-i18next";
import type { WireReportPrint } from "../../lib/radiology-reading-api";

/**
 * PLAN 18-S RS8a T5 — **THE A4 IMAGING REPORT, WITH ITS SIGNER (owner ruling 4).**
 *
 * The lab report (`lab-report-print.tsx`) is the precedent for everything structural: `.print-doc`
 * isolation, the A4 `@page` rule scoped to this class, the letterhead block, a signatory block
 * that NAMES the signer instead of a blank "Signature: ____" line a hand-signed blank could stand
 * in for.
 *
 * ═══ WHAT RULING 4 PUTS ON THE PAGE, AND WHAT IT KEEPS OFF ═══
 *
 * · The SIGNING radiologist prints in full: name, qualification, designation, council registration
 *   number, and the electronic-signature line (the second factor's instant and the authenticator
 *   it came from). All of it from the SNAPSHOT on the signed version (`imaging_reports.signer`),
 *   never from today's data — a designation changed next month does not rewrite this page.
 * · The REFERRING doctor prints as Doctor ID + department only (the 06 Sep "Doctor ID only" rule
 *   the ruling does not lift).
 * · "Electronically signed", not "digitally signed with a certificate": the marker is a second
 *   factor, not a DSC under the IT Act, and the page does not claim more than the system holds.
 * · A version signed before RS8a has no snapshot; it prints "signer details were not recorded at
 *   signing" rather than today's details dressed as the signature's.
 */
/** "29 Sept 2026, 14:05" in IST — a document carries the date, not only the clock time. */
export function fmtIstDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

export function ImagingReportPrint({ report }: { report: WireReportPrint }): React.ReactElement {
  const { t } = useTranslation();
  const s = report.signer;
  return (
    <div className="print-doc imaging-report-a4 w-full max-w-[760px] space-y-3 rounded-lg border bg-white p-6 text-black" data-testid="imaging-report-print">
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm; } .imaging-report-a4 { width: auto; max-width: none; border: 0; padding: 0; } }`}</style>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-black pb-2">
        <div className="min-w-0">
          {report.letterhead !== null && (
            <>
              <h1 className="text-xl font-bold">{report.letterhead.name}</h1>
              {report.letterhead.addressLines.map((line) => <p key={line} className="text-xs text-neutral-700">{line}</p>)}
            </>
          )}
          <h2 className="mt-1 text-sm font-bold">{t("radiology.read.print.department")}</h2>
          <p className="text-xs text-neutral-700">{t("radiology.read.print.title")}</p>
        </div>
        <div className="text-right text-xs">
          <p className="font-bold">{report.accessionNo}</p>
          <p>
            {t("radiology.read.print.version")} {report.version}
            {report.version > 1 && report.amendmentReason !== null && <span className="ml-1 font-bold">· {t("radiology.read.print.amended")}</span>}
          </p>
          {report.status === "superseded" && <p className="font-bold">{t("radiology.read.print.superseded")}</p>}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2">
        <p><span className="text-neutral-700">{t("radiology.read.print.patient")}: </span><b>{report.patient.name}</b></p>
        <p><span className="text-neutral-700">{t("radiology.read.print.uhid")}: </span><b>{report.patient.uhid}</b></p>
        <p><span className="text-neutral-700">{t("radiology.read.print.ageSex")}: </span><b>{report.patient.age ?? "—"} · {report.patient.sex}</b></p>
        <p><span className="text-neutral-700">{t("radiology.read.print.study")}: </span><b>{report.studyTypeName}</b></p>
        <p data-testid="print-referrer">
          <span className="text-neutral-700">{t("radiology.read.print.referredBy")}: </span>
          <b>{report.referrer.doctorCode ?? "—"}{report.referrer.department !== null ? ` · ${report.referrer.department}` : ""}</b>
        </p>
        <p><span className="text-neutral-700">{t("radiology.read.print.acquired")}: </span><b>{report.acquiredAt === null ? "—" : fmtIstDateTime(report.acquiredAt)}</b></p>
      </section>

      {/* The Indian report's order: technique · findings · IMPRESSION · category · recommendation. */}
      {report.sections.filter((sec) => sec.key !== "recommendation").map((sec) => (
        <section key={sec.key} className="text-sm">
          <h3 className="text-xs font-bold uppercase tracking-wide">{t(`radiology.read.section.${sec.key}`, { defaultValue: sec.label })}</h3>
          <p className="whitespace-pre-wrap">{sec.text}</p>
        </section>
      ))}
      <section className="text-sm">
        <h3 className="text-xs font-bold uppercase tracking-wide">{t("radiology.read.section.impression")}</h3>
        <p className="whitespace-pre-wrap font-bold">{report.impression ?? "—"}</p>
      </section>
      {report.codedLines.length > 0 && (
        <section className="text-sm" data-testid="print-coded">
          {report.codedLines.map((line) => <p key={line} className="font-bold">{line}</p>)}
        </section>
      )}
      {report.sections.filter((sec) => sec.key === "recommendation").map((sec) => (
        <section key={sec.key} className="text-sm">
          <h3 className="text-xs font-bold uppercase tracking-wide">{t("radiology.read.section.recommendation")}</h3>
          <p className="whitespace-pre-wrap">{sec.text}</p>
        </section>
      ))}
      {report.criticalCategory !== null && (
        <p className="text-xs font-bold">{t("radiology.read.print.critical", { category: report.criticalCategory.toUpperCase() })}</p>
      )}

      <footer className="border-t pt-2 text-xs" data-testid="print-signer">
        <p className="text-neutral-700">{t("radiology.read.print.reportedBy")}</p>
        {s === null
          ? <p>{t("radiology.read.print.signerNotRecorded")}</p>
          : (
            <>
              <p className="text-sm font-bold">{s.name}</p>
              <p>{s.qualification}{s.designation !== null ? ` · ${s.designation}` : ""}</p>
              <p>{t("radiology.read.print.councilReg")}: <b>{s.councilRegNo}</b>{s.doctorCode !== null ? ` · ${s.doctorCode}` : ""}</p>
              <p className="mo text-neutral-700">
                {t("radiology.read.print.esigned", { at: fmtIstDateTime(report.signedAt) })}
                {s.signature.keyId !== null ? ` · ${s.signature.keyId}` : ""}
                {` · SHA-256 ${s.signature.contentSha256.slice(0, 12)}`}
              </p>
              {s.draftedBy != null && (
                <p className="text-neutral-700" data-testid="print-drafted-by">
                  {t("radiology.read.print.draftedBy", { name: s.draftedBy.name, at: fmtIstDateTime(s.draftedBy.signedAt) })}
                </p>
              )}
            </>
          )}
      </footer>
    </div>
  );
}
