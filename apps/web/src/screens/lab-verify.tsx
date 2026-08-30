import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  flagTone, getReport, labErrorText, printReport, publishReport, requestRerun, verifyResult,
  verifyWorklist,
} from "../lib/lab-api";
import { LabReportPrint } from "../components/lab-report-print";
import { Button } from "@/components/ui/button";
import type { WireReportView } from "../lib/lab-api";

/**
 * PLAN 17b T8 — **VERIFY & REPORT**: the pathologist's queue, the signature, and the document.
 *
 * ═══ THE SCREEN NEVER DECIDES WHETHER A REPORT MAY BE HANDED OVER ═══
 *
 * `report.delivery` is the SERVER's verdict — invoice-grained, computed by `deliveryAllowed`
 * (DD23) — and the print button is disabled from it rather than from any arithmetic here. A client
 * that added up what a patient owes would be a second answer to a money question billing already
 * answers, and the copy that drifted would be the one a counter clerk was reading.
 *
 * ═══ THE REFUSAL IS SHOWN AS A SENTENCE WITH THE INVOICES IN IT ═══
 *
 * "₹300.00 outstanding on 1 invoice" is something a clerk can act on at the cash window. A disabled
 * button with no reason is what makes people telephone the laboratory.
 *
 * ═══ ONE `.print-doc` AT A TIME ═══
 *
 * `LabReportPrint` is mounted only while a report is open, and this screen mounts no other
 * printable surface — the `RxPrint`/`TokenSlip` rule, which the component's own header states and
 * which the screen has to honour.
 */
export function LabVerify(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [open, setOpen] = useState<WireReportView | null>(null);
  const [collector, setCollector] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({ queryKey: ["lab", "verify"], queryFn: verifyWorklist });

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["lab"] }); };

  const sign = useMutation({
    mutationFn: (resultId: string) => verifyResult(resultId, newIdempotencyKey()),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const rerun = useMutation({
    mutationFn: (resultId: string) => requestRerun(resultId, t("lab.verify.rerunReason")),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const publish = useMutation({
    mutationFn: (orderId: string) => publishReport(orderId, newIdempotencyKey()),
    onSuccess: async (r) => {
      setError(null);
      setOpen(await getReport(r.reportId));
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const hand = useMutation({
    mutationFn: (reportId: string) => printReport(
      reportId, { channel: "print", collectorIdentity: collector }, newIdempotencyKey(),
    ),
    onSuccess: async () => {
      setError(null);
      if (open !== null) setOpen(await getReport(open.reportId));
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("lab.verify.title")}</h1>
      {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("lab.verify.queue")}</h2>
        {(queue.data ?? []).length === 0 && <p className="text-sm">{t("lab.verify.empty")}</p>}
        {(queue.data ?? []).map((row) => (
          <article key={row.orderItemId} className="space-y-1 rounded border p-2">
            <header className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-semibold">{row.orderableCode}</span>
              <span>{row.patientDisplay}</span>
              <span className="font-mono text-xs">{row.orderNo}</span>
            </header>
            <table className="w-full text-sm">
              <tbody>
                {row.analytes.filter((a) => a.resultId !== null).map((a) => (
                  <tr key={a.analyteId}>
                    <td className="pr-2">{a.code}</td>
                    <td className={`pr-2 ${flagTone(a.flag) === "critical" ? "font-bold" : ""}`}>
                      {a.value} {a.unit ?? ""} {a.flag ?? ""}
                    </td>
                    <td className="pr-2 text-xs">
                      {a.refLow !== null && a.refHigh !== null ? `${a.refLow} – ${a.refHigh}` : (a.refText ?? "")}
                    </td>
                    <td className="pr-2 text-xs">{a.verificationStatus}</td>
                    <td className="flex gap-2">
                      {a.verificationStatus === "unverified" && (
                        <>
                          <Button type="button" onClick={() => sign.mutate(a.resultId!)}>
                            {t("lab.verify.sign")}
                          </Button>
                          <Button type="button" onClick={() => rerun.mutate(a.resultId!)}>
                            {t("lab.verify.rerun")}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button type="button" onClick={() => publish.mutate(row.orderId)}>
              {t("lab.verify.publish")}
            </Button>
          </article>
        ))}
      </section>

      {open !== null && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            {t("lab.verify.report")} {open.snapshot.orderNo} · v{open.version}
          </h2>
          {/*
            THE INTERLOCK, AS A SENTENCE. `delivery` is the server's verdict; the button follows it
            and never computes it (DD23 / T7 A1).
          */}
          {!open.delivery.allowed && (
            <p role="alert" className="text-sm font-semibold">
              {t("lab.verify.held", {
                amount: (open.delivery.outstandingPaise / 100).toFixed(2),
                count: open.delivery.unpaidInvoiceIds.length,
              })}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label className="text-sm">
              {t("lab.verify.collector")}
              <input className="mt-1 block rounded border px-2 py-1" value={collector}
                onChange={(e) => setCollector(e.target.value)} />
            </label>
            <Button
              type="button"
              disabled={!open.delivery.allowed || collector.trim() === ""}
              onClick={() => hand.mutate(open.reportId)}
            >{t("lab.verify.print")}</Button>
          </div>
          <LabReportPrint report={open} />
        </section>
      )}
    </div>
  );
}
