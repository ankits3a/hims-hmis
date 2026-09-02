import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  cancelDispense, claimDispense, declineLine, fetchAlternatives, fetchDispense, fetchQueue, findAtCounter, pharmacyErrorText,
  verifyDispense,
} from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import type { VerifyLine, WireAlternative, WireDispense, WireDispenseLine, WireFindResult } from "../lib/pharmacy-api";

/**
 * PLAN 16c T3 — THE DISPENSE COUNTER, first half: the portal list, the one field with three doors,
 * the Rx in hand (allergies beside it), each line settled — quantity, a generic equivalent with
 * consent, or declined — and **Verify & place order**. Pick, bill and hand over are T4's half of
 * this same screen. Desk One (D11): `data-seat` on the root, nothing else opts in.
 */
type LineEdit = { qtyBase: string; medicineId: string; consent: boolean };

export function PharmacyCounter(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [inHand, setInHand] = useState<WireDispense | null>(null);
  const [candidates, setCandidates] = useState<WireFindResult | null>(null);
  const [edits, setEdits] = useState<Record<number, LineEdit>>({});
  const [alts, setAlts] = useState<Record<number, WireAlternative[]>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const queue = useQuery({ queryKey: ["pharmacy", "queue"], queryFn: fetchQueue, refetchInterval: 10_000 });

  const take = (d: WireDispense): void => {
    setInHand(d);
    setCandidates(null);
    const next: Record<number, LineEdit> = {};
    for (const l of d.lines) next[l.lineIdx] = { qtyBase: l.qtyBase === null ? "" : String(l.qtyBase), medicineId: l.dispensedMedicine?.id ?? "", consent: false };
    setEdits(next);
    setAlts({});
  };

  useEffect(() => {
    if (inHand === null || inHand.status !== "claimed") return;
    let live = true;
    void (async () => {
      const out: Record<number, WireAlternative[]> = {};
      for (const l of inHand.lines) {
        if (l.status !== "open" || l.dispensedMedicine === null || l.rxLine.noSubstitution) continue;
        try { out[l.lineIdx] = await fetchAlternatives(inHand.id, l.lineIdx); } catch { out[l.lineIdx] = []; }
      }
      if (live) setAlts(out);
    })();
    return () => { live = false; };
  }, [inHand]);

  const run = async (work: () => Promise<WireDispense | null>): Promise<void> => {
    setError(null); setNote(null);
    try {
      const d = await work();
      if (d !== null) take(d);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "queue"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const find = async (): Promise<void> => {
    setError(null); setNote(null); setCandidates(null);
    try {
      const r = await findAtCounter(q);
      if (r.kind === "dispense") { take(r.dispense); setQ(""); return; }
      if (r.kind === "patients") { setCandidates(r); return; }
      setNote(t(r.reason === "qr_invalid" ? "pharmacyCounter.qrInvalid" : r.reason === "no_prescription_today" ? "pharmacyCounter.noRx" : "pharmacyCounter.notFound"));
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const verify = (): Promise<void> => run(async () => {
    if (inHand === null) return null;
    const lines: VerifyLine[] = inHand.lines.filter((l) => l.status === "open").map((l) => {
      const e = edits[l.lineIdx] ?? { qtyBase: "", medicineId: "", consent: false };
      const chosen = e.medicineId !== "" && e.medicineId !== (l.dispensedMedicine?.id ?? "") ? e.medicineId : undefined;
      return { lineIdx: l.lineIdx, qtyBase: Number(e.qtyBase), ...(chosen === undefined ? {} : { dispensedMedicineId: chosen, patientConsent: e.consent }) };
    });
    const d = await verifyDispense(inHand.id, lines, newIdempotencyKey());
    setNote(t("pharmacyCounter.done", { no: d.dispenseNo ?? "" }));
    return d;
  });

  const patientName = (p: { name: string | null; alias: string | null; uhid: string }): string => p.alias ?? p.name ?? p.uhid;
  const statusLabel = (s: string): string => t(`pharmacyCounter.s_${s}`);
  const lineTitle = (l: WireDispenseLine): string => l.dispensedMedicine === null ? l.rxLine.drug : `${l.dispensedMedicine.brandName} · ${l.dispensedMedicine.form}`;

  return (
    <div data-seat="pharmacy-counter" className="min-h-screen space-y-6 p-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{t("pharmacyCounter.title")}</h1>
      </header>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <input
          aria-label={t("pharmacyCounter.find")}
          placeholder={t("pharmacyCounter.find")}
          className="w-full max-w-xl rounded border px-3 py-2"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <Button type="submit">{t("pharmacyCounter.findButton")}</Button>
      </form>

      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {note !== null && <p role="status" className="text-sm">{note}</p>}

      {candidates !== null && candidates.kind === "patients" && (
        <section className="space-y-2">
          <p className="text-sm">{t("pharmacyCounter.confirmPatient")}</p>
          <ul className="divide-y">
            {candidates.patients.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                <span>{patientName(p)} · <span className="font-mono">{p.uhid}</span></span>
                <Button type="button" size="sm" variant="outline" onClick={() => { setQ(p.uhid); void find(); }}>{t("pharmacyCounter.choose")}</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section className="space-y-2">
          <h2 className="text-lg font-medium">{t("pharmacyCounter.queue")}</h2>
          {queue.data !== undefined && queue.data.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyCounter.queueEmpty")}</p>}
          <ul className="divide-y">
            {(queue.data ?? []).map((r) => (
              <li key={r.dispenseId} className="flex items-center justify-between py-2 text-sm">
                <button type="button" className="text-left" onClick={() => void run(() => fetchDispense(r.dispenseId))}>
                  <span className="font-medium">{patientName(r.patient)}</span> · <span className="font-mono">{r.patient.uhid}</span>
                  <span className="block text-xs text-muted-foreground">
                    {statusLabel(r.status)} · {t("pharmacyCounter.lines", { count: r.lineCount })}{r.dispenseNo !== null ? ` · ${r.dispenseNo}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4">
          {inHand !== null && (
            <div className="space-y-4 rounded border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold">{patientName(inHand.patient)} <span className="font-mono text-sm">{inHand.patient.uhid}</span></p>
                  <p className="text-sm text-muted-foreground">
                    {t("pharmacyCounter.status")}: {statusLabel(inHand.status)}
                    {inHand.dispenseNo !== null ? ` · ${t("pharmacyCounter.dispenseNo")} ${inHand.dispenseNo}` : ""}
                    {inHand.scheduled ? ` · ${t("pharmacyCounter.scheduled")}` : ""}
                  </p>
                </div>
                <p className="text-sm">
                  <span className="font-medium">{t("pharmacyCounter.allergies")}: </span>
                  {inHand.allergies.length === 0 ? t("pharmacyCounter.noAllergies") : inHand.allergies.map((a) => a.substance).join(", ")}
                </p>
              </div>

              {inHand.status === "queued" && (
                <Button type="button" onClick={() => void run(() => claimDispense(inHand.id, "rx_qr", newIdempotencyKey()))}>
                  {t("pharmacyCounter.claim")}
                </Button>
              )}

              <ol className="space-y-3">
                {inHand.lines.map((l) => {
                  const e = edits[l.lineIdx] ?? { qtyBase: "", medicineId: "", consent: false };
                  const editable = inHand.status === "claimed" && l.status === "open";
                  const options = alts[l.lineIdx] ?? [];
                  const substituting = e.medicineId !== "" && e.medicineId !== (l.dispensedMedicine?.id ?? "");
                  return (
                    <li key={l.lineIdx} className={`rounded border p-3 ${l.status === "declined" ? "opacity-60" : ""}`} data-line={l.lineIdx}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-medium">
                          {l.lineIdx + 1}. {lineTitle(l)}
                          {l.scheduleFlag !== null ? <span className="ml-2 rounded bg-muted px-1 text-xs">{l.scheduleFlag}</span> : null}
                          {l.substitutionType === "generic" ? <span className="ml-2 text-xs">{t("pharmacyCounter.substituted")}</span> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("pharmacyCounter.prescribed")}: {l.rxLine.drug} · {l.rxLine.dose} · {l.rxLine.frequency}{l.rxLine.durationDays !== null ? ` · ${String(l.rxLine.durationDays)}d` : ""}
                        </p>
                      </div>
                      {l.status === "declined" && <p className="text-sm">{t("pharmacyCounter.declined")}: {l.declinedReason}</p>}
                      {l.status === "open" && l.dispensedMedicine === null && <p className="text-sm text-red-700">{t("pharmacyCounter.unresolved")}</p>}
                      {l.status === "open" && l.dispensedMedicine !== null && !l.saleable && !substituting && <p className="text-sm text-red-700">{t("pharmacyCounter.unstocked")}</p>}
                      {l.status === "open" && l.available !== null && <p className="text-xs text-muted-foreground">{t("pharmacyCounter.available", { n: l.available })}</p>}
                      {editable && (
                        <div className="mt-2 flex flex-wrap items-end gap-3">
                          <label className="text-sm">
                            {t("pharmacyCounter.qty")}{l.item !== null ? ` ${t("pharmacyCounter.baseUnit", { unit: l.item.baseUom })}` : ""}
                            <input
                              aria-label={`${t("pharmacyCounter.qty")} ${String(l.lineIdx + 1)}`}
                              className="ml-2 w-24 rounded border px-2 py-1"
                              inputMode="numeric"
                              value={e.qtyBase}
                              onChange={(ev) => setEdits({ ...edits, [l.lineIdx]: { ...e, qtyBase: ev.target.value } })}
                            />
                          </label>
                          {options.length > 0 && (
                            <label className="text-sm">
                              {t("pharmacyCounter.alternatives")}
                              <select
                                aria-label={`${t("pharmacyCounter.alternatives")} ${String(l.lineIdx + 1)}`}
                                className="ml-2 rounded border px-2 py-1"
                                value={e.medicineId}
                                onChange={(ev) => setEdits({ ...edits, [l.lineIdx]: { ...e, medicineId: ev.target.value } })}
                              >
                                <option value={l.dispensedMedicine?.id ?? ""}>{t("pharmacyCounter.asPrescribed")}</option>
                                {options.map((a) => (
                                  <option key={a.medicineId} value={a.medicineId}>{a.brandName} · {a.itemCode} · {t("pharmacyCounter.available", { n: a.available })}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {substituting && (
                            <label className="flex items-center gap-1 text-sm">
                              <input type="checkbox" checked={e.consent} onChange={(ev) => setEdits({ ...edits, [l.lineIdx]: { ...e, consent: ev.target.checked } })} />
                              {t("pharmacyCounter.consent")}
                            </label>
                          )}
                          <Button
                            type="button" size="sm" variant="outline"
                            onClick={() => {
                              const why = window.prompt(t("pharmacyCounter.declineReason")) ?? "";
                              if (why.trim() !== "") void run(() => declineLine(inHand.id, l.lineIdx, why));
                            }}
                          >
                            {t("pharmacyCounter.decline")}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>

              {inHand.status === "claimed" && (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void verify()}>{t("pharmacyCounter.verify")}</Button>
                </div>
              )}
              {inHand.status === "verified" && <p className="text-sm text-muted-foreground">{t("pharmacyCounter.next")}</p>}
              {["queued", "claimed", "verified"].includes(inHand.status) && (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); void run(() => cancelDispense(inHand.id, reason)); setReason(""); }}>
                  <label className="text-sm">
                    {t("pharmacyCounter.cancelReason")}
                    <input aria-label={t("pharmacyCounter.cancelReason")} className="ml-2 rounded border px-2 py-1" value={reason} onChange={(ev) => setReason(ev.target.value)} />
                  </label>
                  <Button type="submit" variant="destructive" size="sm" disabled={reason.trim() === ""}>{t("pharmacyCounter.cancel")}</Button>
                </form>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
