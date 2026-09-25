import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { money } from "../../lib/reports-api";
import {
  LEDGER_FIELDS, TALLY_KINDS, downloadTallyFile, exportTally, fetchTallyExports, fetchTallyLedgers, fetchTallyPreview, saveTallyLedgers,
} from "../../lib/tally-api";
import { Button } from "@/components/ui/button";
import type { RangeInput } from "../../lib/reports-api";
import type { TallyLedgers, WireTallyExport, WireTallyVoucher } from "../../lib/tally-api";

/**
 * ═══ PHARMACY PARITY P5 — THE TALLY EXPORT (TallyPrime XML) ═══
 *
 * The accountant picks a range and sees what the export would carry before it is made: how many of
 * each voucher, the total, the first vouchers as Tally will read them, and any earlier export of an
 * overlapping range (a re-export is seen before it happens). X exports: the export is RECORDED and
 * its two files — the ledgers (import first) and the vouchers — download from the record, so the same
 * file can be fetched again byte for byte. L opens the ledger names; the export waits until they have
 * been confirmed once, because the defaults are names, not the hospital's Tally company.
 */
export function TallyReport({ range, rangeBar, keysRef }: {
  range: RangeInput; rangeBar: React.ReactNode;
  /** The report screen owns the focus and the keys; this screen answers X and L through it. */
  keysRef: React.MutableRefObject<((key: string) => boolean) | null>;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ledgersOpen, setLedgersOpen] = useState(false);
  const [done, setDone] = useState<WireTallyExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({ queryKey: ["pharmacy", "tally", "preview", range], queryFn: () => fetchTallyPreview(range) });
  const history = useQuery({ queryKey: ["pharmacy", "tally", "exports"], queryFn: fetchTallyExports });
  const p = preview.data;
  const run = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const e = await exportTally(range);
      setDone(e);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "tally"] });
    } catch (err) { setError(pharmacyErrorText(err, t)); } finally { setBusy(false); }
  };
  const download = async (e: WireTallyExport, file: "vouchers" | "masters"): Promise<void> => {
    try { await downloadTallyFile(e, file); } catch (err) { setError(pharmacyErrorText(err, t)); }
  };
  keysRef.current = (k) => {
    if (busy || ledgersOpen) return false;
    if (k === "x" && p !== undefined && p.confirmed && p.voucherCount > 0) { void run(); return true; }
    if (k === "l") { setLedgersOpen(true); return true; }
    return false;
  };
  useEffect(() => () => { keysRef.current = null; }, [keysRef]);
  return (
    <div className="space-y-3" data-testid="tally-report">
      {rangeBar}
      {p !== undefined && (
        <div className={`flex flex-wrap items-center gap-2 rounded border p-2 text-sm ${p.confirmed ? "" : "border-amber-400 bg-amber-50"}`} data-testid="tally-ledger-state">
          <span className="flex-1">{p.confirmed ? t("pharmacyOffice.tally.ledgersConfirmed") : t("pharmacyOffice.tally.ledgersUnconfirmed")}</span>
          <Button type="button" size="sm" variant="outline" data-testid="tally-ledgers-open" onClick={() => setLedgersOpen(true)}>{t("pharmacyOffice.tally.ledgers")} <kbd className="ml-1 rounded border px-1 text-xs">L</kbd></Button>
        </div>
      )}
      {preview.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(preview.error, t)}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {p !== undefined && (
        <section className="space-y-2" data-testid="tally-preview">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {TALLY_KINDS.filter((k) => p.counts[k] > 0).map((k) => (
              <div key={k} className="rounded border p-2" data-testid={`tally-count-${k}`}>
                <div className="text-xl font-semibold tabular-nums">{p.counts[k]}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.tally.kind.${k}`)}</div>
              </div>
            ))}
          </div>
          <p className="text-sm" data-testid="tally-total">{t("pharmacyOffice.tally.summary", { count: p.voucherCount, value: money(p.debitPaise) })}</p>
          {p.earlier.length > 0 && (
            <div className="rounded border border-amber-400 p-2 text-sm" data-testid="tally-earlier">
              <p className="font-medium">{t("pharmacyOffice.tally.earlier")}</p>
              <ul>{p.earlier.map((e) => <li key={e.id}>{t("pharmacyOffice.tally.earlierRow", { from: e.from, to: e.to, who: e.exportedBy, at: new Date(e.exportedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), count: e.voucherCount, sum: e.checksum.slice(0, 12) })}</li>)}</ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" data-testid="tally-export" disabled={busy || !p.confirmed || p.voucherCount === 0} onClick={() => void run()}>
              {t("pharmacyOffice.tally.export")} <kbd className="ml-1 rounded border px-1 text-xs">X</kbd>
            </Button>
            {!p.confirmed && <span className="text-xs text-muted-foreground">{t("pharmacyOffice.tally.confirmFirst")}</span>}
          </div>
          {done !== null && (
            <div className="rounded border border-green-600 bg-green-50 p-2 text-sm" data-testid="tally-done">
              <p>{t("pharmacyOffice.tally.done", { count: done.voucherCount, sum: done.checksum.slice(0, 12) })}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" data-testid="tally-download-masters" onClick={() => void download(done, "masters")}>{t("pharmacyOffice.tally.mastersFile")}</Button>
                <Button type="button" size="sm" data-testid="tally-download-vouchers" onClick={() => void download(done, "vouchers")}>{t("pharmacyOffice.tally.vouchersFile")}</Button>
              </div>
            </div>
          )}
          {p.sample.length > 0 && (
            <details className="rounded border p-2 text-sm" data-testid="tally-sample">
              <summary className="cursor-pointer">{t("pharmacyOffice.tally.sample")}</summary>
              {p.sample.map((v) => <VoucherView key={v.remoteId} v={v} />)}
            </details>
          )}
        </section>
      )}
      {history.data !== undefined && history.data.length > 0 && (
        <section data-testid="tally-history">
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("pharmacyOffice.tally.history")}</h3>
          <ul className="divide-y rounded border text-sm">
            {history.data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-1.5" data-testid={`tally-history-${e.id}`}>
                <span className="font-mono text-xs">{e.from} – {e.to}</span>
                <span className="flex-1">{t("pharmacyOffice.tally.historyRow", { count: e.voucherCount, who: e.exportedBy, at: new Date(e.exportedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) })}</span>
                <span className="font-mono text-xs text-muted-foreground">{e.checksum.slice(0, 12)}</span>
                <button type="button" className="text-xs underline" onClick={() => void download(e, "masters")}>{t("pharmacyOffice.tally.mastersFile")}</button>
                <button type="button" className="text-xs underline" onClick={() => void download(e, "vouchers")}>{t("pharmacyOffice.tally.vouchersFile")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {ledgersOpen && <LedgerSettings onClose={() => setLedgersOpen(false)} />}
    </div>
  );
}

function VoucherView({ v }: { v: WireTallyVoucher }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <table className="mt-2 w-full max-w-2xl text-xs [&_td]:px-1.5 [&_th]:px-1.5" data-testid={`tally-voucher-${v.number}`}>
      <caption className="text-left font-medium">{v.type} · {v.number} · {v.date} · {v.party}</caption>
      <thead><tr className="text-left text-muted-foreground"><th>{t("pharmacyOffice.tally.ledger")}</th><th className="text-right">{t("pharmacyOffice.tally.debit")}</th><th className="text-right">{t("pharmacyOffice.tally.credit")}</th></tr></thead>
      <tbody>{v.entries.map((e, i) => (
        <tr key={`${e.ledger}-${String(i)}`}><td>{e.ledger}</td><td className="text-right">{e.amountPaise > 0 ? money(e.amountPaise) : ""}</td><td className="text-right">{e.amountPaise < 0 ? money(-e.amountPaise) : ""}</td></tr>
      ))}</tbody>
    </table>
  );
}

/** The ledger names, as the hospital's TallyPrime company has them. Saving confirms them. */
function LedgerSettings({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["pharmacy", "tally", "ledgers"], queryFn: fetchTallyLedgers });
  const [form, setForm] = useState<TallyLedgers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state.data !== undefined && form === null) setForm(state.data.ledgers); }, [state.data, form]);
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const save = async (): Promise<void> => {
    if (form === null) return;
    setBusy(true); setError(null);
    try {
      await saveTallyLedgers(form);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "tally"] });
      onClose();
    } catch (e) { setError(pharmacyErrorText(e, t)); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("pharmacyOffice.tally.ledgersTitle")} data-testid="tally-ledgers" className="h-full w-full max-w-xl overflow-y-auto bg-background p-4 shadow-xl focus:outline-none"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1 text-lg font-semibold">{t("pharmacyOffice.tally.ledgersTitle")}</h2>
          <button type="button" className="text-sm text-muted-foreground" onClick={onClose}>Esc</button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">{t("pharmacyOffice.tally.ledgersNote")}</p>
        {state.data !== undefined && state.data.confirmed && state.data.updatedAt !== null && (
          <p className="mb-2 text-xs text-muted-foreground">{t("pharmacyOffice.tally.lastSaved", { who: state.data.updatedBy ?? "", at: new Date(state.data.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) })}</p>
        )}
        {form !== null && (
          <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="flex items-center gap-2">
              <span className="w-48">{t("pharmacyOffice.tally.field.companyName")}</span>
              <input className="flex-1 rounded border px-2 py-0.5" value={form.companyName} placeholder={t("pharmacyOffice.tally.companyHint")} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            </label>
            {LEDGER_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-2">
                <span className="w-48">{t(`pharmacyOffice.tally.field.${f}`)}</span>
                <input className="flex-1 rounded border px-2 py-0.5" data-testid={`ledger-${f}`} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
              </label>
            ))}
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="w-48">{t("pharmacyOffice.tally.field.patientParty")}</legend>
              {(["patient", "single"] as const).map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input type="radio" name="patientParty" checked={form.patientParty === m} onChange={() => setForm({ ...form, patientParty: m })} />
                  {t(`pharmacyOffice.tally.party.${m}`)}
                </label>
              ))}
            </fieldset>
            {form.patientParty === "single" && (
              <label className="flex items-center gap-2">
                <span className="w-48">{t("pharmacyOffice.tally.field.patientLedger")}</span>
                <input className="flex-1 rounded border px-2 py-0.5" value={form.patientLedger} onChange={(e) => setForm({ ...form, patientLedger: e.target.value })} />
              </label>
            )}
            {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy} data-testid="tally-ledgers-save">{t("pharmacyOffice.tally.save")}</Button>
              <Button type="button" variant="outline" onClick={onClose}>{t("pharmacyOffice.tally.cancel")}</Button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
