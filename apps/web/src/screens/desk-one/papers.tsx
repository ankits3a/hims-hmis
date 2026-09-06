import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listPrintJobs, printSummary, reprintJob, PRINT_DOCUMENT_LABEL } from "../../lib/print-api";
import { fetchInvoicePrint, listInvoicesFor } from "../../lib/billing-api";
import { InvoicePrint } from "../../components/invoice-print";
import { SubmitButton } from "../../components/submit-button";
import { dayMonthIst } from "../../lib/format";
import { rs } from "./model";
import { useDesk } from "./session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-27 — "I LOST MY BILL AND MY PRESCRIPTION SHEET"
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-06: *"if the patient comes back again saying he lost the bill and OPD prescription
 * page by mistake and so can't be consulted by doctor, how are we tackling it, how is the user
 * finding the old ticket/token and OPD prescription page? If he can find it, can he print it
 * again?"*
 *
 * THE ANSWER BEFORE THIS FILE WAS: THEY COULD NOT. Measured, not inferred:
 *
 *   · The only reprint control in the application was inside `StageDone`'s `PrintStatus`, and it
 *     rendered ONLY when a job had FAILED — a slip that printed correctly and was then lost had no
 *     control at all. It also required `s.visit`, which only `walkIn()` sets, so it was unreachable
 *     the moment the desk was cleared, let alone on a later day.
 *   · `GET /billing/invoices?patientId=` has existed since Plan 08 with ZERO callers, so an issued
 *     invoice was reachable only from the tab that issued it.
 *   · The dossier's history strip was already holding the `encounterId` of every past visit — and
 *     spending it on a React key.
 *   · `en.json` even promised a road out: *"print the tax invoice instead, or reprint from the
 *     billing counter"*. No code referenced the key, and the billing-counter reprint did not exist.
 *
 * So nothing here is a new capability on the server. `listPrintJobs`, `reprintJob`,
 * `listInvoicesFor` and `fetchInvoicePrint` are all routes that already shipped; this is the door.
 *
 * ═══ IT IS SCOPED TO ONE ENCOUNTER, AND THAT IS THE PRIVACY BOUNDARY ═══
 *
 * A clerk opens it from a row of the patient IN HAND's own history. It is not a print-job browser
 * and it cannot be pointed at a stranger: every read below is keyed by an encounter the dossier
 * already resolved for the person standing at the counter. `POST /print/reprint` mints a NEW job
 * with a fresh requester rather than reviving the old row, so "who printed this patient's document
 * again, and when" stays answerable — which is the property that makes a reprint button lawful on a
 * document carrying a patient's name.
 */
export function PapersSheet({ encounterId, when }: { encounterId: string; when: string | null }): React.ReactElement {
  const d = useDesk();
  const [note, setNote] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: ["d1", "papers", "jobs", encounterId],
    queryFn: () => listPrintJobs(encounterId),
    retry: false,
  });
  const bills = useQuery({
    queryKey: ["d1", "papers", "invoices", encounterId],
    queryFn: () => listInvoicesFor({ encounterId }),
    retry: false,
  });
  /*
    The invoice a clerk asked to see, rendered as the SAME `InvoicePrint` document the counter
    prints on the day. One component, so a reprint cannot quietly differ from the original —
    a second renderer for "the copy" is how a reprint stops being evidence of the first.
  */
  const [showing, setShowing] = useState<string | null>(null);
  const sheet = useQuery({
    queryKey: ["d1", "papers", "print", showing],
    queryFn: () => fetchInvoicePrint(showing!),
    enabled: showing !== null,
    retry: false,
  });

  const rows = jobs.data?.jobs ?? [];
  /*
    NEWEST PER DOCUMENT. A reprint mints a new row rather than reviving the old one, so an encounter
    reprinted three times carries four token-slip rows — and offering four identical buttons would
    read as four different documents. The clerk wants "the token slip", once.
  */
  const latest = new Map<string, (typeof rows)[number]>();
  for (const j of rows) {
    const held = latest.get(j.document);
    if (held === undefined || j.createdAt > held.createdAt) latest.set(j.document, j);
  }

  if (sheet.data !== undefined && showing !== null) {
    return (
      <div style={{ padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{sheet.data.invoice.invoiceNo}</span>
          <button className="sec" style={{ height: 24 }} onClick={() => setShowing(null)}>back to the papers</button>
        </div>
        <InvoicePrint data={sheet.data} />
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 18px" }} data-testid="papers-sheet">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Their papers</span>
        <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
          {when === null ? "this visit" : dayMonthIst(when)} · everything this visit put on paper, and a way to hand it over again
        </span>
      </div>

      {note === null ? null : (
        <p role="status" data-testid="papers-note" style={{ margin: "10px 0 0", fontSize: 12, fontWeight: 600, color: "var(--green)" }}>{note}</p>
      )}

      {/* ═══ THE SLIPS ═══ */}
      <div className="tag" style={{ marginTop: 16 }}>printed at the counter</div>
      {jobs.isPending ? (
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>reading the print log…</div>
      ) : latest.size === 0 ? (
        <div data-testid="papers-no-jobs" style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 6, lineHeight: "16px" }}>
          Nothing was queued for this visit. That is expected for a visit opened before the printer
          was wired — the bill below can still be printed.
        </div>
      ) : (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 2 }}>
          {[...latest.values()].map((j) => (
            <div key={j.id} data-testid={`papers-job-${j.document}`} className="drow" style={{ cursor: "default" }}>
              <span style={{ fontSize: 12.5, flexGrow: 1, minWidth: 0 }}>
                {PRINT_DOCUMENT_LABEL[j.document] ?? j.document}
              </span>
              {/*
                THE STATE IS SHOWN BESIDE THE BUTTON, NOT INSTEAD OF IT. `PrintStatus` offered a
                reprint only for a FAILED job, which is exactly backwards for this screen: the
                patient in front of the clerk lost paper that printed perfectly well.
              */}
              <span
                className={j.status === "printed" ? "pill on" : j.status === "failed" ? "pill rd" : "pill"}
                style={{ height: 20, flexShrink: 0 }}
              >
                {j.status}
              </span>
              <SubmitButton
                plain
                type="button"
                className="sec"
                data-testid={`papers-reprint-${j.document}`}
                style={{ height: 24, flexShrink: 0 }}
                onClick={async () => {
                  await reprintJob(j.id);
                  await jobs.refetch();
                  const label = PRINT_DOCUMENT_LABEL[j.document] ?? j.document;
                  setNote(`${label} queued again — it prints at the front desk.`);
                  d.note(`reprint queued — ${label}`, "ok");
                }}
              >
                print again
              </SubmitButton>
            </div>
          ))}
        </div>
      )}
      {/*
        AND WHAT "QUEUED" HONESTLY MEANS. Printing is advisory (owner ruling R7) and the paper comes
        out of a relay running inside the hospital, not out of this browser. A clerk who presses the
        button and watches nothing happen needs to know which of those two facts they are looking at.
      */}
      {printSummary(rows).state === "failed" ? (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--red)" }}>{printSummary(rows).text}</p>
      ) : null}

      {/* ═══ THE MONEY ═══ */}
      <div className="tag" style={{ marginTop: 20 }}>bills raised for this visit</div>
      {bills.isPending ? (
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>reading the ledger…</div>
      ) : (bills.data?.items ?? []).length === 0 ? (
        <div data-testid="papers-no-bills" style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 6 }}>
          No bill was raised for this visit.
        </div>
      ) : (
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 2 }}>
          {(bills.data?.items ?? []).map((inv) => (
            <div key={inv.id} data-testid={`papers-invoice-${inv.invoiceNo}`} className="drow" style={{ cursor: "default" }}>
              <span className="mo" style={{ fontSize: 12, flexGrow: 1, minWidth: 0 }}>{inv.invoiceNo}</span>
              <span className="mo" style={{ fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>{rs(inv.netPayablePaise)}</span>
              {inv.creditExtended ? <span className="pill gd" style={{ height: 20, flexShrink: 0 }}>on credit</span> : null}
              <button
                type="button"
                className="sec"
                data-testid={`papers-show-${inv.invoiceNo}`}
                style={{ height: 24, flexShrink: 0 }}
                onClick={() => setShowing(inv.id)}
              >
                open the bill
              </button>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>
        The bill opens as the printed document — the same one the counter prints on the day, from the
        server&apos;s own figures. Nothing here re-adds anything up.
      </p>
    </div>
  );
}
