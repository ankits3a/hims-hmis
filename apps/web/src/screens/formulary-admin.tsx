import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  admitStaging, fetchCoverage, fetchMedicines, fetchPairRates, fetchSalts, formularyErrorMessage,
  rejectStaging, searchStaging,
} from "../lib/formulary-api";
import { Button } from "@/components/ui/button";
import type { AdmitInput, WireStagingRow } from "../lib/formulary-api";

/**
 * PLAN 16a T7 — THE FORMULARY DESK, and the shape of it is the ruling.
 *
 * ═══ THE ENTRY FLOW STARTS FROM A NAME, NOT FROM A QUEUE (spec §1.1) ═══
 *
 * The pharmacist is about to stock something. They type its name; if the crawl already knows it,
 * the form pre-fills and they verify. **There is no "all pending rows" view and no route that
 * could serve one.** The mined mass is potentially tens of thousands of entries: rendered as a
 * queue it becomes a backlog nobody can ever clear, and a backlog nobody clears is a screen nobody
 * opens. As a dictionary it is useful on the first day and useful for ever.
 *
 * ═══ SEED IS NEVER AUTHORITY ═══
 *
 * A pre-filled field is a SUGGESTION. What lands in the formulary is what this form submits, and
 * the composition must be chosen from moieties that already exist — a scraped salt name is never
 * silently created. If the moiety is missing, it is added deliberately, first.
 *
 * ═══ THE PAYLOAD IS UNTRUSTED AND THE REVIEWER IS PRIVILEGED ═══
 *
 * Everything under `payload` was scraped from a third-party page and is rendered through React's
 * default TEXT path — no `dangerouslySetInnerHTML`, no `innerHTML`, nowhere in this feature. The
 * person reading it holds `formulary.staging.review`, so a payload that executed would run with a
 * curator's session; the screen test drives a `<script>` fixture through it and asserts it renders
 * as characters.
 */
export function FormularyAdmin(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [picked, setPicked] = useState<WireStagingRow | null>(null);
  const [brandName, setBrandName] = useState("");
  const [form, setForm] = useState("tablet");
  const [routeClass, setRouteClass] = useState<"systemic" | "topical">("systemic");
  const [saltIds, setSaltIds] = useState<string[]>([]);
  const [acknowledgeIntraFdc, setAcknowledgeIntraFdc] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const salts = useQuery({ queryKey: ["formulary", "salts"], queryFn: fetchSalts });
  const medicines = useQuery({ queryKey: ["formulary", "medicines"], queryFn: fetchMedicines });
  /**
   * PLAN 16a T8 — the two curation surfaces. The worklist closes the loop on this very screen: a
   * row names a drug the hospital prescribes and the formulary cannot resolve, and clicking it
   * puts that name straight into the entry search above.
   */
  const coverage = useQuery({ queryKey: ["formulary", "coverage"], queryFn: fetchCoverage });
  const pairRates = useQuery({ queryKey: ["formulary", "pair-rates"], queryFn: fetchPairRates });

  const staging = useQuery({
    queryKey: ["formulary", "staging", submitted],
    queryFn: () => searchStaging(submitted),
    enabled: submitted.trim() !== "",
  });

  const runSearch = (): void => {
    setError(null);
    setDone(null);
    setPicked(null);
    setSubmitted(query);
  };

  /** Picking pre-fills the form from the mined row. Nothing is written by this. */
  const pick = (row: WireStagingRow): void => {
    setPicked(row);
    setBrandName(row.name);
    setSaltIds([]);
    setAcknowledgeIntraFdc(false);
    setRejectReason("");
    setError(null);
  };

  const admit = async (): Promise<void> => {
    if (picked === null) return;
    setError(null);
    const input: AdmitInput = {
      brandName: brandName.trim(), form: form.trim(), routeClass,
      salts: saltIds.map((saltId) => ({ saltId })),
      ...(acknowledgeIntraFdc ? { acknowledgeIntraFdc: true } : {}),
    };
    try {
      await admitStaging(picked.id, input);
      setDone(t("formularyAdmin.admitted", { name: brandName.trim() }));
      setPicked(null);
      setSubmitted("");
      setQuery("");
      await qc.invalidateQueries({ queryKey: ["formulary"] });
    } catch (e) {
      setError(formularyErrorMessage(e));
    }
  };

  const reject = async (): Promise<void> => {
    if (picked === null) return;
    setError(null);
    if (rejectReason.trim() === "") {
      setError(t("formularyAdmin.rejectReasonRequired"));
      return;
    }
    try {
      await rejectStaging(picked.id, rejectReason.trim());
      setDone(t("formularyAdmin.rejected", { name: picked.name }));
      setPicked(null);
      setSubmitted("");
      setQuery("");
      await qc.invalidateQueries({ queryKey: ["formulary"] });
    } catch (e) {
      setError(formularyErrorMessage(e));
    }
  };

  return (
    <div className="space-y-4 p-4" data-testid="formulary-admin">
      <h1 className="text-xl font-semibold">{t("formularyAdmin.title")}</h1>
      <p className="text-sm text-neutral-600">{t("formularyAdmin.intro")}</p>

      {/* ——— the entry point: a name, never a queue ——— */}
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="formulary-search">{t("formularyAdmin.searchLabel")}</label>
        <input
          id="formulary-search"
          data-testid="formulary-search"
          value={query}
          placeholder={t("formularyAdmin.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full max-w-md rounded border px-2 py-1"
        />
        <Button type="button" onClick={runSearch}>{t("formularyAdmin.search")}</Button>
      </div>

      {done !== null && <p data-testid="formulary-done" className="text-sm text-emerald-700">{done}</p>}
      {error !== null && <p data-testid="formulary-error" className="text-sm text-red-700">{error}</p>}

      {submitted.trim() !== "" && (staging.data ?? []).length === 0 && !staging.isLoading && (
        <p data-testid="formulary-no-hits" className="text-sm text-neutral-600">
          {t("formularyAdmin.noMinedRecord")}
        </p>
      )}

      {(staging.data ?? []).length > 0 && picked === null && (
        <ul data-testid="formulary-hits" className="space-y-1">
          {(staging.data ?? []).map((row) => (
            <li key={row.id}>
              <Button
                type="button" variant="outline" size="sm"
                data-testid={`formulary-hit-${row.id}`}
                onClick={() => pick(row)}
              >
                {row.name}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* ——— the admission form: pre-filled by the crawl, decided by the pharmacist ——— */}
      {picked !== null && (
        <div data-testid="formulary-entry" className="space-y-3 rounded border p-3">
          <h2 className="font-medium">{t("formularyAdmin.entryTitle")}</h2>

          {/*
            THE SCRAPED RECORD, rendered as TEXT. `JSON.stringify` and React's text path: a payload
            containing markup appears as characters, which is what the XSS fixture asserts.
          */}
          <div className="space-y-1 text-sm">
            <p data-testid="staging-source">{t("formularyAdmin.source", { url: picked.sourceUrl })}</p>
            <pre data-testid="staging-payload" className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs">
              {JSON.stringify(picked.payload, null, 2)}
            </pre>
            <p className="text-xs text-neutral-600">{t("formularyAdmin.payloadIsSuggestion")}</p>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            <div>
              <label className="block text-sm font-medium" htmlFor="formulary-brand">
                {t("formularyAdmin.brandName")}
              </label>
              <input
                id="formulary-brand" data-testid="formulary-brand" value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="formulary-form">
                {t("formularyAdmin.form")}
              </label>
              <input
                id="formulary-form" data-testid="formulary-form" value={form}
                onChange={(e) => setForm(e.target.value)}
                className="w-full rounded border px-2 py-1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="formulary-route">
                {t("formularyAdmin.routeClass")}
              </label>
              <select
                id="formulary-route" data-testid="formulary-route" value={routeClass}
                onChange={(e) => setRouteClass(e.target.value === "topical" ? "topical" : "systemic")}
                className="w-full rounded border px-2 py-1"
              >
                <option value="systemic">{t("formularyAdmin.systemic")}</option>
                <option value="topical">{t("formularyAdmin.topical")}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium" htmlFor="formulary-salts">
              {t("formularyAdmin.composition")}
            </label>
            <select
              id="formulary-salts" data-testid="formulary-salts" multiple value={saltIds}
              onChange={(e) => setSaltIds([...e.target.selectedOptions].map((o) => o.value))}
              className="w-full rounded border px-2 py-1"
            >
              {(salts.data ?? []).filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.drugClass === null ? s.name : `${s.name} (${s.drugClass})`}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-600">{t("formularyAdmin.compositionHint")}</p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox" data-testid="formulary-ack-fdc" checked={acknowledgeIntraFdc}
              onChange={(e) => setAcknowledgeIntraFdc(e.target.checked)}
            />
            {t("formularyAdmin.acknowledgeIntraFdc")}
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" data-testid="formulary-admit" onClick={() => void admit()}>
              {t("formularyAdmin.admit")}
            </Button>
            <input
              data-testid="formulary-reject-reason" value={rejectReason}
              placeholder={t("formularyAdmin.rejectReason")}
              onChange={(e) => setRejectReason(e.target.value)}
              className="rounded border px-2 py-1"
            />
            <Button type="button" variant="outline" data-testid="formulary-reject" onClick={() => void reject()}>
              {t("formularyAdmin.reject")}
            </Button>
          </div>
        </div>
      )}

      {/* ——— T8: the curation worklist — the prescribing stream IS the queue ——— */}
      {coverage.data !== null && coverage.data !== undefined && (
        <div data-testid="formulary-coverage" className="space-y-2 rounded border p-3">
          <h2 className="font-medium">{t("formularyAdmin.coverageTitle")}</h2>
          <p className="text-sm" data-testid="formulary-coverage-figure">
            {t("formularyAdmin.coverageFigure", { pct: Math.round(coverage.data.coverage * 100) })}
            {" "}
            <span className="text-neutral-600">
              {coverage.data.noticeEnabled
                ? t("formularyAdmin.noticeOn")
                : t("formularyAdmin.noticeOff")}
            </span>
          </p>
          {coverage.data.unresolvedTop.length === 0
            ? <p className="text-sm text-neutral-600">{t("formularyAdmin.worklistEmpty")}</p>
            : (
              <ul data-testid="formulary-worklist" className="space-y-1 text-sm">
                {coverage.data.unresolvedTop.map((row) => (
                  <li key={row.drug}>
                    <Button
                      type="button" size="sm" variant="outline"
                      data-testid={`worklist-${row.drug}`}
                      onClick={() => {
                        // The loop closes here: the unresolved name becomes the entry search.
                        setQuery(row.drug);
                        setSubmitted(row.drug);
                        setPicked(null);
                        setError(null);
                        setDone(null);
                      }}
                    >
                      {row.drug} — {row.count}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {/* ——— T8: which warnings are being clicked through (spec §1.4) ——— */}
      {(pairRates.data ?? []).length > 0 && (
        <div data-testid="formulary-pairs" className="space-y-2 rounded border p-3">
          <h2 className="font-medium">{t("formularyAdmin.pairsTitle")}</h2>
          <p className="text-xs text-neutral-600">{t("formularyAdmin.pairsCaveat")}</p>
          <ul className="space-y-1 text-sm">
            {(pairRates.data ?? []).map((p) => (
              <li key={`${p.saltAId}-${p.saltBId}`} data-testid={`pair-${p.saltAId}-${p.saltBId}`}>
                <span className={p.severity === "severe" ? "font-medium text-red-700" : ""}>
                  {t(`formularyAdmin.severity.${p.severity}`)}
                </span>
                {" — "}
                {p.note}
                {" "}
                <span className="text-neutral-600">
                  {t("formularyAdmin.pairCount", { n: p.timesOnIssued })}
                </span>
                {p.severity === "severe" && p.timesOnIssued >= 10 && (
                  <span data-testid={`pair-review-${p.saltAId}-${p.saltBId}`} className="ml-1 text-amber-700">
                    {t("formularyAdmin.pairNeedsReview")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ——— what is already stocked, so the desk can see its own master ——— */}
      <div>
        <h2 className="font-medium">{t("formularyAdmin.stocked")}</h2>
        <ul data-testid="formulary-medicines" className="text-sm">
          {(medicines.data ?? []).map((m) => (
            <li key={m.id} data-testid={`formulary-medicine-${m.id}`}>
              {m.brandName} — {m.salts.length > 0 ? m.salts.length : 0} {t("formularyAdmin.moieties")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
