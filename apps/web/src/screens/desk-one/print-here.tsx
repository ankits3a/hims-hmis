import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PRINT_DOCUMENT_LABEL } from "../../lib/print-api";
import type { WirePrintJob } from "../../lib/print-api";
import { claimAutoPrint, latestPerDocument, owedHere, printJobsHere, reprintHere } from "../../lib/browser-print";
import type { HerePrintResult, PrintSetting } from "../../lib/browser-print";
import { openPrintingPanel } from "../../components/printing-panel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * HAND OVER PRINTS — on this computer's own printer (owner, 2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"When I click on handover, can't the browser automatically send the print action for
 * prescription slip to default printer? Right now it doesn't automatically print."*
 *
 * It does now. The moment the hand-over screen has a paper this computer is set to print and nobody
 * has printed, the server's own document is printed from a hidden frame: one print window with the
 * sheet ready (none at all under Chrome's `--kiosk-printing`). Each job is attempted automatically
 * ONCE (`claimAutoPrint`) — a poll, a re-render or a second look at this screen prints nothing
 * twice; after that the paper is the clerk's to ask for, with the button.
 *
 * No browser says whether the person pressed Print or Cancel, so the line says "sent to this
 * printer" — and keeps "Print again" beside it for the sheet that did not come out.
 */
export function docLabel(t: (k: string, o?: Record<string, unknown>) => string, document: string): string {
  return t(`printHere.doc.${document}`, { defaultValue: PRINT_DOCUMENT_LABEL[document] ?? document });
}

type Row = { state: "sending" | "sent" | "notYet" | "gone" | "failed" };

export function PrintHere({ jobs, setting, onChanged }: {
  jobs: readonly WirePrintJob[];
  setting: PrintSetting;
  onChanged: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const busy = useRef(false);

  const apply = (results: readonly HerePrintResult[]): void => {
    setRows((prev) => {
      const next = { ...prev };
      for (const r of results) {
        next[r.document] = { state: r.outcome === "printed" ? "sent" : r.outcome === "gone" ? "gone" : r.outcome === "error" ? "failed" : "notYet" };
      }
      return next;
    });
    onChanged();
  };

  const owed = owedHere(setting, [...jobs]);
  const owedKey = owed.map((j) => j.id).join(",");
  useEffect(() => {
    if (busy.current) return;
    const fresh = owed.filter((j) => claimAutoPrint(j.id));
    if (fresh.length === 0) return;
    busy.current = true;
    setRows((prev) => ({ ...prev, ...Object.fromEntries(fresh.map((j) => [j.document, { state: "sending" } as Row])) }));
    void printJobsHere(fresh).then(apply).finally(() => { busy.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on WHICH jobs are owed, not on the array's identity
  }, [owedKey]);

  const current = latestPerDocument([...jobs]).filter((j) => setting.papers[j.document] === true);
  const printOne = (job: WirePrintJob): void => {
    if (busy.current) return;
    busy.current = true;
    setRows((prev) => ({ ...prev, [job.document]: { state: "sending" } }));
    const run = job.status === "queued" || job.status === "failed" ? printJobsHere([job]).then((r) => r[0]!) : reprintHere(job);
    void run.then((r) => apply([r])).catch(() => apply([{ document: job.document, jobId: job.id, outcome: "error" }])).finally(() => { busy.current = false; });
  };

  return (
    <div data-testid="print-here" style={{ marginTop: 9, fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", color: "var(--dim)" }}>
        <span data-testid="print-here-mode">{t("printHere.status.here")}</span>
        <button type="button" className="sec" data-testid="print-here-settings" style={{ height: 24 }} onClick={openPrintingPanel}>{t("printHere.status.settings")}</button>
      </div>
      {current.map((job) => {
        const label = docLabel(t, job.document);
        const row = rows[job.document];
        const state: Row["state"] = row?.state ?? (job.status === "printed" ? "sent" : "notYet");
        const tone = state === "sent" ? "var(--green)" : state === "sending" ? "var(--dim)" : "var(--red)";
        return (
          <div key={job.document} data-testid={`print-here-${job.document}`} data-state={state} style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span style={{ color: tone, fontWeight: state === "notYet" ? 600 : 400 }}>{t(`printHere.status.${state}`, { label })}</span>
            {state === "sending" ? null : (
              <button
                type="button"
                className={state === "sent" ? "sec" : "pri"}
                data-testid={`print-here-go-${job.document}`}
                style={{ height: state === "sent" ? 24 : 30 }}
                onClick={() => printOne(job)}
              >
                {state === "sent" ? t("printHere.status.again") : t("printHere.status.print", { label, lower: label.toLowerCase() })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
