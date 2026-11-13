import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchDispensePaper, fetchDispensePrintJobs, pharmacyErrorText, sendDispensePaper } from "../../lib/pharmacy-api";
import { printInFrame } from "../../lib/print-api";
import { say } from "./log";
import type { PharmacyPaperDoc, WirePharmacyPrintJob } from "../../lib/pharmacy-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PARITY P1 — THE DONE SCREEN PRINTS (the approved Desk board: "Bill and label are with the printer.")
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * After a hand-over the desk sends the bill and the medicine labels to the counter's roll through the
 * server's print relay (owner ruling 2026-09-04: printing is SERVER-SIDE). When no relay is serving
 * that roll the server says `browser`, and this prints the SAME documents — the relay's own
 * rendering — from a hidden frame on this page, and says so ONCE per desk session, quietly, in the
 * dock; the done line then reads "printed from this screen".
 *
 * R7 holds: printing is advisory. Nothing here can undo or block the hand-over. What it does owe is
 * the truth while the patient is still at the window — so it watches the jobs it queued and, when
 * the printer has not taken them, offers to print here rather than leave "with the printer" standing.
 *
 * Exceptions live behind ⋯: Reprint (a second copy, recorded against the person asking) and Print
 * here. The first send happens by itself only on the hand-over that just happened at this desk
 * (`autoPrint`), never on reopening an old ticket.
 */
type Mode = "idle" | "sending" | "relay" | "browser" | "error";

/** Said once per tab, not once per ticket — the pharmacist needs to learn it, not to be told it forty times. */
let saidNoRelay = false;
/** Tests only. */
export function resetPaperNotice(): void { saidNoRelay = false; }

/** How long a queued job may sit unclaimed before the screen offers the browser instead. */
export const NOT_TAKEN_AFTER_MS = 30_000;

export function paperState(jobs: readonly WirePharmacyPrintJob[], sentAt: number | null, now: number): "printed" | "failed" | "not_taken" | "with_printer" | "none" {
  if (jobs.length === 0) return "none";
  /* The newest job of each document is its current state; a reprint supersedes the row before it. */
  const latest = new Map<string, WirePharmacyPrintJob>();
  for (const j of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(j.document, j);
  const current = [...latest.values()];
  if (current.some((j) => j.status === "failed" || j.status === "cancelled")) return "failed";
  if (current.every((j) => j.status === "printed")) return "printed";
  if (sentAt !== null && now - sentAt > NOT_TAKEN_AFTER_MS && current.some((j) => j.status === "queued")) return "not_taken";
  return "with_printer";
}

/**
 * Spec #1046 D3 — the bill prints when the money is taken (`documents = ["pharmacy_bill"]`, the billed ticket's
 * row: every word and the reprint are the bill's), and the hand-over then sends the labels. `documents` narrows the
 * FIRST send and what "Print here" prints; on the finished ticket ⋯ still prints both.
 */
export function DonePaper({ dispenseId, autoPrint, documents }: { dispenseId: string; autoPrint: boolean; documents?: readonly PharmacyPaperDoc[] | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const billOnly = documents !== undefined && documents.length === 1 && documents[0] === "pharmacy_bill";
  /* The bill's own words on the billed ticket; the pair's after the hand-over. */
  const ns = billOnly ? "pharmacyDesk.paper.bill" : "pharmacyDesk.paper";
  const k = (key: string): string => `${ns}.${key}`;
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  const jobs = useQuery({
    queryKey: ["pharmacy", "print", dispenseId],
    queryFn: () => fetchDispensePrintJobs(dispenseId),
    retry: false,
    refetchInterval: (q) => {
      const rows = q.state.data?.jobs ?? [];
      return rows.some((j) => j.status === "queued" || j.status === "claimed") ? 4_000 : false;
    },
  });
  useEffect(() => {
    if (mode !== "relay") return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [mode]);

  const [sent, setSent] = useState<readonly PharmacyPaperDoc[] | undefined>(documents);
  const printHere = useCallback(async (only: readonly PharmacyPaperDoc[] | undefined = billOnly ? documents : undefined): Promise<void> => {
    try {
      const doc = await fetchDispensePaper(dispenseId, only);
      if (!printInFrame(doc)) throw new Error(t("pharmacyDesk.paper.frameRefused"));
      setMode("browser");
      setError(null);
    } catch (e) {
      setMode("error");
      setError(pharmacyErrorText(e, t));
    }
  }, [billOnly, dispenseId, documents, t]);

  const send = useCallback(async (reprint: boolean, only: readonly PharmacyPaperDoc[] | undefined): Promise<void> => {
    setMode("sending"); setError(null); setSent(only);
    try {
      const r = await sendDispensePaper(dispenseId, reprint, only);
      if (r.via === "relay") {
        setMode("relay");
        setSentAt(Date.now());
        qc.setQueryData(["pharmacy", "print", dispenseId], (old: { jobs: WirePharmacyPrintJob[] } | undefined) => ({
          jobs: [...r.jobs, ...(old?.jobs ?? []).filter((j) => !r.jobs.some((n) => n.id === j.id))],
        }));
        say(t(reprint ? `${ns}.logReprint` : `${ns}.logSent`));
        return;
      }
      await printHere(only);
      if (!saidNoRelay) {
        saidNoRelay = true;
        say(t("pharmacyDesk.paper.noRelayOnce"), "warn");
      }
    } catch (e) {
      setMode("error");
      setError(pharmacyErrorText(e, t));
    }
  }, [dispenseId, ns, printHere, qc, t]);

  const started = useRef(false);
  useEffect(() => {
    if (!autoPrint || started.current) return;
    started.current = true;
    void send(false, documents);
  }, [autoPrint, documents, send]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent): void => { if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopImmediatePropagation(); setMenu(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);

  /* The bill's row reads the bill's jobs alone; the finished ticket reads them all. */
  const rows = (jobs.data?.jobs ?? []).filter((j) => !billOnly || j.document === "pharmacy_bill");
  const state = paperState(rows, sentAt, now);
  const failedWhy = rows.find((j) => j.status === "failed")?.lastError ?? null;
  let line: { text: string; tone: string; offerHere: boolean } | null = null;
  if (mode === "sending") line = { text: t(k("sending")), tone: "var(--dim)", offerHere: false };
  else if (mode === "browser") line = { text: t(k("browser")), tone: "var(--dim)", offerHere: false };
  else if (mode === "error") line = { text: error ?? "", tone: "var(--red)", offerHere: true };
  else if (state === "printed") line = { text: t(k("printed")), tone: "var(--green)", offerHere: false };
  else if (state === "failed") line = { text: failedWhy === null ? t(k("failed")) : t("pharmacyDesk.paper.failedWhy", { why: failedWhy }), tone: "var(--red)", offerHere: true };
  else if (state === "not_taken") line = { text: t(k("notTaken")), tone: "var(--gold)", offerHere: true };
  /* Sent, and the jobs read has not caught up yet: the paper is with the printer, not unprinted. */
  else if (state === "with_printer" || (mode === "relay" && state === "none")) line = { text: t(k("withPrinter")), tone: "var(--dim)", offerHere: false };

  const printed = rows.length > 0 || mode === "browser" || mode === "relay";
  return (
    <div data-testid="desk-paper" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, minHeight: 30 }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--dim)", flexShrink: 0 }}>
        <path d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v7H6z" />
      </svg>
      <span role="status" data-testid="desk-paper-status" style={{ flexGrow: 1, fontSize: 12.5, color: line?.tone ?? "var(--dim)" }}>
        {line?.text ?? t(k("notYet"))}
      </span>
      {line?.offerHere === true ? (
        <button type="button" className="sec" data-testid="desk-paper-here" onClick={() => void printHere(sent)}>{t("pharmacyDesk.paper.printHere")}</button>
      ) : null}
      <span ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          aria-label={t("pharmacyDesk.paper.menu")}
          aria-expanded={menu}
          aria-haspopup="true"
          data-testid="desk-paper-menu"
          onClick={() => setMenu((m) => !m)}
          style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
        </button>
        {menu ? (
          <span className="lmenu" style={{ display: "block" }}>
            <button type="button" disabled={mode === "sending"} onClick={() => { setMenu(false); void send(printed, billOnly ? documents : undefined); }}>
              {printed ? t(k("reprint")) : t(k("print"))}
            </button>
            <button type="button" onClick={() => { setMenu(false); void printHere(billOnly ? documents : undefined); }}>{t("pharmacyDesk.paper.printHere")}</button>
          </span>
        ) : null}
      </span>
    </div>
  );
}
