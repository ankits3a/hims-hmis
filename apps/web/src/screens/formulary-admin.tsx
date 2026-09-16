import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  admitStaging, fetchCensus, fetchCoverage, fetchMedicinesPage, fetchPairRates, fetchSaltsPage,
  formularyErrorMessage, rejectStaging, searchStaging,
} from "../lib/formulary-api";
import { Button } from "@/components/ui/button";
import { MappingWorklist } from "../components/mapping-worklist";
import type { AdmitInput, WireSalt, WireStagingRow } from "../lib/formulary-api";

/** Two letters before the first request: one letter over 3,283 moieties is not a search, it is a
 *  scroll, and it answers with twenty rows that mean nothing. */
const MIN_QUERY = 2;

/**
 * 180 ms, the `DrugField` cadence, for the same reason it was chosen there: the moiety search
 * answers in about the same time, so a faster one queues requests behind a pharmacist typing at
 * speed and paints answers to prefixes they have already left behind.
 */
const DEBOUNCE_MS = 180;

/** One page of hits. A picker that needs a second page needs a better query, not more rows — so
 *  this deliberately does not follow `nextCursor`; the catalogue list below is where paging lives. */
const SALT_HITS = 20;

/** The catalogue page. 50 is the server's own default and about a screenful for a pharmacist. */
const CATALOGUE_PAGE = 50;

/**
 * Indian digit grouping — 1,03,383, not 103,383 — because the person reading this strip is a
 * pharmacist in Delhi, and it is the grouping every other figure on their desk uses. The digits
 * themselves are Latin in both locales, which is what a Hindi prescription and a Hindi bill both
 * print, so one formatter serves both languages.
 */
const NUMBERS = new Intl.NumberFormat("en-IN");

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
/** The drug class is what separates two moieties with similar names, so it rides along when known. */
function saltLabel(s: WireSalt): string {
  return s.drugClass === null ? s.name : `${s.name} (${s.drugClass})`;
}

export function FormularyAdmin(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [picked, setPicked] = useState<WireStagingRow | null>(null);
  const [brandName, setBrandName] = useState("");
  const [form, setForm] = useState("tablet");
  const [routeClass, setRouteClass] = useState<"systemic" | "topical">("systemic");
  /**
   * ═══ THE CHOSEN MOIETIES ARE HELD AS ROWS, NOT AS IDS — WHICH IS THE WIDGET'S WHOLE POINT ═══
   *
   * A chip has to show a NAME. Hold ids alone and the name has to be looked up in whatever the
   * search last returned, so the moment the pharmacist types a second moiety the first chip loses
   * its label — and a composition whose first salt has gone blank is one a tired person removes.
   * Holding the row makes "a moiety already chosen survives a new search" true by construction
   * rather than by anybody remembering it.
   */
  const [chosen, setChosen] = useState<WireSalt[]>([]);
  const saltIds = chosen.map((s) => s.id);
  const [saltQuery, setSaltQuery] = useState("");
  /** What was last ASKED, as opposed to what is being typed — see `DEBOUNCE_MS`. */
  const [saltAsk, setSaltAsk] = useState("");
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [acknowledgeIntraFdc, setAcknowledgeIntraFdc] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setSaltAsk(saltQuery.trim()); }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [saltQuery]);

  /**
   * ═══ THE CENSUS IS THE ONLY THING THIS SCREEN LOADS EAGERLY, AND IT CARRIES NO ROWS ═══
   *
   * This screen used to open by fetching the whole of `formulary_medicines` and the whole of
   * `formulary_salts`. On the owner's catalogue that is 103,383 rows and ~57 MiB into a browser,
   * plus 3,283 `<option>` nodes — to show a count and fill a dropdown. The count now comes from one
   * statement of scalar subqueries, and the dropdown is gone.
   *
   * `uncomposedActiveMedicines` is the number nobody has ever been shown: active products with no
   * moiety on file, which the interaction, allergy and substitution checks cannot reason about at
   * all. It is invisible in every list that shows names, and it is a curation worklist of its own.
   */
  const census = useQuery({ queryKey: ["formulary", "census"], queryFn: fetchCensus });

  /**
   * The moiety typeahead. `activeOnly` is asked of the SERVER, not filtered here: "may this be
   * composed into a new medicine" is decided where the rows are, and a client-side filter over a
   * page would also shorten the page it filtered.
   */
  const saltHits = useQuery({
    queryKey: ["formulary", "salts", "search", saltAsk],
    queryFn: () => fetchSaltsPage({ q: saltAsk, activeOnly: true, limit: SALT_HITS }),
    enabled: saltAsk.length >= MIN_QUERY,
  });

  /**
   * The catalogue, a page at a time, and NOT FETCHED AT ALL until the disclosure is opened —
   * `enabled` is the disclosure. THE END OF THE LIST IS `nextCursor === null` AND NOTHING ELSE:
   * `getNextPageParam` returns the cursor the server issued, so a short page that carries one still
   * offers "load more", and a page that happens to be exactly full without one does not.
   */
  const catalogue = useInfiniteQuery({
    queryKey: ["formulary", "medicines", "page"],
    queryFn: ({ pageParam }) => fetchMedicinesPage({ limit: CATALOGUE_PAGE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: catalogueOpen,
  });
  const stocked = (catalogue.data?.pages ?? []).flatMap((page) => page.items);
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
    setChosen([]);
    setSaltQuery("");
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
      setChosen([]);
      setSaltQuery("");
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

      {/*
        ——— HOW BIG THE CATALOGUE IS, AND HOW MUCH OF IT IS BLIND TO EVERY SAFETY CHECK ———

        Three figures, one statement, no rows. The third is the one this module has never shown
        anyone: an ACTIVE medicine with no composition can be prescribed and dispensed, and the
        interaction, allergy and substitution checks have nothing to reason with — they do not warn
        and they cannot warn. It is not an error state, it is a curation backlog, so it is stated
        plainly and coloured only when it is non-zero.
      */}
      {census.data !== undefined && (
        <dl data-testid="formulary-census" className="flex flex-wrap gap-x-8 gap-y-2 rounded border p-3">
          <div>
            <dt className="text-xs text-neutral-600">{t("formularyAdmin.census.moieties")}</dt>
            <dd data-testid="census-salts" className="text-sm">
              {t("formularyAdmin.census.activeOfTotal", {
                active: NUMBERS.format(census.data.activeSalts),
                total: NUMBERS.format(census.data.salts),
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-600">{t("formularyAdmin.census.medicines")}</dt>
            <dd data-testid="census-medicines" className="text-sm">
              {t("formularyAdmin.census.activeOfTotal", {
                active: NUMBERS.format(census.data.activeMedicines),
                total: NUMBERS.format(census.data.medicines),
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-600">{t("formularyAdmin.census.uncomposed")}</dt>
            <dd
              data-testid="census-uncomposed"
              className={census.data.uncomposedActiveMedicines > 0 ? "text-sm font-medium text-amber-700" : "text-sm"}
            >
              {t("formularyAdmin.census.uncomposedCount", {
                count: census.data.uncomposedActiveMedicines,
                shown: NUMBERS.format(census.data.uncomposedActiveMedicines),
              })}
            </dd>
            <p className="max-w-md text-xs text-neutral-600">{t("formularyAdmin.census.uncomposedHint")}</p>
          </div>
          {/*
            THE MAPPING LOOP'S TWO FIGURES (phase 2). The first says how much of the release is still
            waiting for a pharmacist; the second is what that waiting COSTS: products a doctor can
            pick whose components carry no class and no interaction pairs. A release-only or an empty
            database shows zero substances, and the strip says so rather than hiding the row.
          */}
          <div>
            <dt className="text-xs text-neutral-600">{t("formularyAdmin.census.substances")}</dt>
            <dd data-testid="census-substances" className="text-sm">
              {t("formularyAdmin.census.substanceStates", {
                pending: NUMBERS.format(census.data.pendingSubstances),
                drafted: NUMBERS.format(census.data.draftedPendingSubstances),
                mapped: NUMBERS.format(census.data.mappedSubstances),
                unmappable: NUMBERS.format(census.data.unmappableSubstances),
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-600">{t("formularyAdmin.census.unreviewed")}</dt>
            <dd
              data-testid="census-unreviewed"
              className={census.data.unreviewedActiveMedicines > 0 ? "text-sm font-medium text-amber-700" : "text-sm"}
            >
              {t("formularyAdmin.census.unreviewedCount", {
                count: census.data.unreviewedActiveMedicines,
                shown: NUMBERS.format(census.data.unreviewedActiveMedicines),
              })}
            </dd>
            <p className="max-w-md text-xs text-neutral-600">{t("formularyAdmin.census.unreviewedHint")}</p>
          </div>
        </dl>
      )}

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

          {/*
            ═══ THE MOIETY PICKER IS A TYPEAHEAD OVER CHIPS, AND IT REPLACED A `<select multiple>` ═══

            That control listed every active moiety: 3,283 `<option>` nodes mounted on a screen where
            a pharmacist wants two of them, fetched in full on every open of this page. A multi-select
            is also the least forgiving control in HTML — one stray click with the mouse button down
            clears every selection made so far, silently, and the person only finds out when the
            composition they admit is wrong.

            The chips are the fix for BOTH failures. What has been chosen is visible as text, it is
            removed one at a time by a named button, and IT DOES NOT DEPEND ON THE SEARCH: searching
            for the second moiety cannot disturb the first, because the first is held as a row in
            `chosen` and not as a highlighted option inside a list that is about to be replaced.
          */}
          <div>
            <label className="block text-sm font-medium" htmlFor="formulary-salt-search">
              {t("formularyAdmin.composition")}
            </label>

            {chosen.length === 0
              ? <p data-testid="formulary-composition-empty" className="text-sm text-neutral-600">{t("formularyAdmin.compositionEmpty")}</p>
              : (
                <ul data-testid="formulary-composition" className="flex flex-wrap gap-2 py-1">
                  {chosen.map((s) => (
                    <li
                      key={s.id} data-testid={`formulary-salt-chip-${s.id}`}
                      className="flex items-center gap-1 rounded-full border bg-neutral-50 px-2 py-0.5 text-sm"
                    >
                      {saltLabel(s)}
                      <button
                        type="button"
                        data-testid={`formulary-salt-remove-${s.id}`}
                        aria-label={t("formularyAdmin.saltRemove", { name: s.name })}
                        onClick={() => { setChosen(chosen.filter((c) => c.id !== s.id)); }}
                        className="px-1 text-neutral-600 hover:text-red-700"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

            <input
              id="formulary-salt-search"
              data-testid="formulary-salt-search"
              value={saltQuery}
              autoComplete="off"
              placeholder={t("formularyAdmin.saltSearchPlaceholder")}
              onChange={(e) => { setSaltQuery(e.target.value); }}
              className="w-full max-w-md rounded border px-2 py-1"
            />

            {/*
              THE ERROR BRANCH IS NOT OPTIONAL, AND ITS ABSENCE WAS A LIE. Without it a failed
              request — a 500, an expired session, a dropped network — fell through to the
              zero-hits message, and the screen told a pharmacist "No active moiety matches that
              name" when nothing had answered at all. They would then admit the product with an
              empty composition, which lands it in the very `uncomposedActiveMedicines` figure the
              census strip above this form exists to call out. A refusal must read as a refusal.
            */}
            {saltAsk.length < MIN_QUERY
              ? <p className="text-xs text-neutral-600">{t("formularyAdmin.saltSearchHint")}</p>
              : saltHits.isPending
                ? <p data-testid="formulary-salt-busy" className="text-xs text-neutral-600">{t("formularyAdmin.saltSearching")}</p>
                : saltHits.isError
                  ? <p data-testid="formulary-salt-error" role="alert" className="text-xs text-red-700">{t("formularyAdmin.saltSearchFailed")}</p>
                  : (saltHits.data?.items ?? []).length === 0
                    ? <p data-testid="formulary-salt-no-hits" className="text-xs text-neutral-600">{t("formularyAdmin.saltNoHits")}</p>
                    : (
                      <>
                      <ul data-testid="formulary-salt-hits" className="flex flex-wrap gap-1 py-1">
                      {(saltHits.data?.items ?? []).map((s) => {
                        const already = saltIds.includes(s.id);
                        return (
                          <li key={s.id}>
                            <Button
                              type="button" variant="outline" size="sm"
                              data-testid={`formulary-salt-hit-${s.id}`}
                              disabled={already}
                              onClick={() => { if (!already) setChosen([...chosen, s]); }}
                            >
                              {saltLabel(s)}
                              {already && <span className="ml-1 text-xs text-neutral-600">{t("formularyAdmin.saltAlreadyChosen")}</span>}
                            </Button>
                          </li>
                        );
                      })}
                      </ul>
                      {/*
                        A LIST THAT IS CUT MUST SAY SO. `%q%` matching plus a 20-row cap made a real
                        moiety unreachable: "sodium" matches 180 active moieties and 130 sort before
                        the one named `Sodium`. The server now ranks exact and prefix matches first,
                        which is the actual fix; this line is the other half — a pharmacist who sees
                        twenty rows should know whether twenty is the answer or the cap.
                      */}
                      {(saltHits.data?.items ?? []).length >= SALT_HITS && (
                        <p data-testid="formulary-salt-truncated" className="text-xs text-neutral-600">
                          {t("formularyAdmin.saltMoreMatches", { shown: SALT_HITS })}
                        </p>
                      )}
                    </>
                  )}

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

      {/*
        The mapping worklist sits BELOW the stocking flow, not above it. Found in the browser: ten
        tall cards between the census and the name search pushed the pharmacist's everyday act,
        stocking a medicine, off the first screen. Mapping is done in sittings; stocking is done
        all day.
      */}
      <MappingWorklist />

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
                  {t("formularyAdmin.pairCount", { count: p.timesOnIssued })}
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

      {/*
        ——— WHAT IS ALREADY STOCKED: COLLAPSED, PAGED, AND FREE UNTIL SOMEBODY OPENS IT ———

        This was a flat `<ul>` over every medicine, rendered on every visit to the screen whether or
        not anyone looked at it. The count it was really being read for now lives in the census strip
        at the top, which costs no rows at all; the LIST is what a pharmacist opens when they want to
        read names, so it is fetched when they open it and a page at a time after that.

        "Load more" appears while the server has issued a cursor and disappears when it has not. It
        is never decided by the length of the page that came back — the server over-fetches by one to
        answer that question, and second-guessing it here is how a full last page becomes an infinite
        list, or a short middle page becomes a truncated catalogue.
      */}
      <div>
        <h2 className="font-medium">{t("formularyAdmin.stocked")}</h2>
        <Button
          type="button" variant="outline" size="sm"
          data-testid="formulary-catalogue-toggle"
          aria-expanded={catalogueOpen}
          onClick={() => { setCatalogueOpen(!catalogueOpen); }}
        >
          {catalogueOpen ? t("formularyAdmin.catalogueHide") : t("formularyAdmin.catalogueShow")}
        </Button>
        {!catalogueOpen && <p className="text-xs text-neutral-600">{t("formularyAdmin.catalogueCost")}</p>}
        {catalogueOpen && (
          <div data-testid="formulary-catalogue" className="space-y-2 py-2">
            <ul data-testid="formulary-medicines" className="text-sm">
              {stocked.map((m) => (
                <li key={m.id} data-testid={`formulary-medicine-${m.id}`}>
                  {m.brandName} — {t("formularyAdmin.moietyCount", { count: m.salts.length })}
                </li>
              ))}
            </ul>
            {catalogue.isError && (
              <p data-testid="formulary-catalogue-error" className="text-sm text-red-700">
                {formularyErrorMessage(catalogue.error)}
              </p>
            )}
            {catalogue.hasNextPage
              ? (
                <Button
                  type="button" variant="outline" size="sm"
                  data-testid="formulary-catalogue-more"
                  disabled={catalogue.isFetchingNextPage}
                  onClick={() => { void catalogue.fetchNextPage(); }}
                >
                  {catalogue.isFetchingNextPage ? t("formularyAdmin.catalogueLoading") : t("formularyAdmin.catalogueMore")}
                </Button>
              )
              : (!catalogue.isPending && !catalogue.isError && (
                <p data-testid="formulary-catalogue-end" className="text-xs text-neutral-600">
                  {t("formularyAdmin.catalogueEnd")}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
