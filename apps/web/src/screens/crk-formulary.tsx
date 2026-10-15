import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CrkEntryView } from "../components/crk-entry";
import { useAuth } from "../lib/auth";
import { formularyErrorMessage } from "../lib/formulary-api";
import {
  CRK_FIELDS, CRK_SOURCE_KINDS, fetchCrkDraft, fetchCrkWorklist, saveCrkEntry, searchCrkGenerics, signCrkEntry,
} from "../lib/crk-api";
import type { CrkDraftRow, CrkEntry, CrkField, CrkSourceKind, CrkState } from "../lib/crk-api";

/**
 * ═══ #882 / DECISION 0053 — THE CRK FORMULARY: THE PHARMACOLOGY REVIEWER'S SCREEN ═══
 *
 * The worklist (counts by state, what waits, and — for a signer only — what the drafting model has cost) and,
 * for one medicine, the entry beside its sources with Sign. A high-alert entry takes a second signature from
 * a different reviewer; the screen says so and the server refuses the first signer twice. Editing saves a
 * DRAFT: changed text is unsigned text, and the screen says that before the save.
 *
 * The cost line is shown to `formulary.monograph.review` holders only. It never reaches a doctor's screen
 * (decision 0058); the doctor's door (`components/crk-entry.tsx`) reads signed entries and nothing else.
 */
type Opened = { sctid: string; name: string };
const DESIGNATION_KEY = "hmis.crk.designation";

const readDesignation = (): string => {
  try { return localStorage.getItem(DESIGNATION_KEY) ?? ""; } catch { return ""; }
};
const keepDesignation = (v: string): void => {
  try { localStorage.setItem(DESIGNATION_KEY, v); } catch { /* a convenience only */ }
};

export function CrkFormularyScreen(): React.ReactElement {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Opened | null>(null);
  return (
    <div data-testid="crk-formulary" className="mx-auto w-full max-w-4xl space-y-3 p-3">
      <header>
        <h1 className="text-lg font-semibold">{t("crk.title")}</h1>
        <p className="text-xs text-neutral-600">{t("crk.intro")}</p>
      </header>
      {opened === null
        ? <Worklist onOpen={setOpened} />
        : <SignPanel opened={opened} onBack={() => setOpened(null)} />}
    </div>
  );
}

const STATE_TONE: Record<CrkState, string> = {
  draft: "bg-amber-100 text-amber-900", awaiting_second: "bg-sky-100 text-sky-900", due: "bg-neutral-200 text-neutral-800",
};

function Worklist({ onOpen }: { onOpen: (o: Opened) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ["formulary", "crk-worklist"], queryFn: fetchCrkWorklist });
  const [q, setQ] = useState("");
  const [ask, setAsk] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => { setAsk(q.trim()); }, 250);
    return () => { clearTimeout(timer); };
  }, [q]);
  const hits = useQuery({ queryKey: ["formulary", "crk-search", ask], queryFn: () => searchCrkGenerics(ask), enabled: ask.length >= 2 });
  const w = list.data;
  if (list.isError) return <p role="alert" className="text-sm text-red-700">{formularyErrorMessage(list.error)}</p>;
  if (w === undefined) return <p className="text-sm text-neutral-600">…</p>;
  const counts: [keyof typeof w.counts, number][] = [
    ["draft", w.counts.draft], ["awaitingSecond", w.counts.awaitingSecond], ["dueForReview", w.counts.dueForReview],
    ["signed", w.counts.signed], ["none", w.counts.none],
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" data-testid="crk-counts">
        {counts.map(([k, n]) => (
          <span key={k} data-testid={`crk-count-${k}`} className="rounded border px-2 py-1 text-xs whitespace-nowrap">
            <b className="tabular-nums">{n}</b> {t(`crk.count.${k}`)}
          </span>
        ))}
      </div>
      {/* Decision 0058 keeps money off doctor screens; the drafting cost is the signers' number. */}
      {can("formulary.monograph.review") && (
        <p data-testid="crk-cost" className="text-xs text-neutral-600">
          {t("crk.cost", { n: w.drafting.drafted, inTok: w.drafting.inputTokens.toLocaleString("en-IN"), outTok: w.drafting.outputTokens.toLocaleString("en-IN") })}
        </p>
      )}
      {!w.drafter.configured && <p data-testid="crk-no-model" className="text-xs text-amber-800">{t("crk.noModel")}</p>}

      {w.items.length === 0
        ? <p data-testid="crk-empty" className="text-sm text-neutral-600">{t("crk.empty")}</p>
        : (
          <ul className="divide-y rounded border" data-testid="crk-items">
            {w.items.map((it) => (
              <li key={it.monographId}>
                <button type="button" data-testid={`crk-item-${it.genericSctid}`} onClick={() => onOpen({ sctid: it.genericSctid, name: it.name })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50">
                  <span className="min-w-0 flex-1 truncate font-medium">{it.name}</span>
                  <span className="hidden text-xs text-neutral-500 sm:inline">{it.draftedModel === null ? t("crk.byHand") : t("crk.byModel")}</span>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-xs whitespace-nowrap ${STATE_TONE[it.state]}`}>{t(`crk.state.${it.state}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="crk-search">{t("crk.write")}</label>
        <input id="crk-search" data-testid="crk-search" className="w-full rounded border px-2 py-1 text-sm"
          placeholder={t("crk.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        {(hits.data ?? []).length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="crk-hits">
            {(hits.data ?? []).map((h) => (
              <li key={h.id}>
                <button type="button" className="text-left underline" data-testid={`crk-hit-${h.sctid}`} onClick={() => onOpen({ sctid: h.sctid, name: h.name })}>{h.name}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const EMPTY_ENTRY: CrkEntry = { sources: [], fields: {}, combinationNote: null };

function statusOf(row: CrkDraftRow | null, today: string): "none" | "draft" | "awaiting" | "reviewed" | "due" {
  if (row === null || row.crk === null) return "none";
  if (row.status === "reviewed") return row.reviewDueOn !== null && row.reviewDueOn <= today ? "due" : "reviewed";
  return row.firstSignedBy === null ? "draft" : "awaiting";
}

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function SignPanel({ opened, onBack }: { opened: Opened; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { actor, can } = useAuth();
  const qc = useQueryClient();
  const draft = useQuery({ queryKey: ["formulary", "crk-draft", opened.sctid], queryFn: () => fetchCrkDraft(opened.sctid) });
  const [editing, setEditing] = useState<CrkEntry | null>(null);
  const [designation, setDesignation] = useState(readDesignation);
  const [highAlert, setHighAlert] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const row = draft.data;
  const refresh = async (): Promise<void> => {
    await draft.refetch();
    await qc.invalidateQueries({ queryKey: ["formulary", "crk-worklist"] });
  };

  const save = async (): Promise<void> => {
    if (editing === null) return;
    setBusy(true); setError(null); setSaid(null);
    try {
      await saveCrkEntry(opened.sctid, editing);
      setEditing(null);
      await refresh();
      setSaid(t("crk.saved"));
    } catch (e) { setError(formularyErrorMessage(e)); } finally { setBusy(false); }
  };

  const sign = async (): Promise<void> => {
    if (row == null) return;
    setBusy(true); setError(null); setSaid(null);
    try {
      keepDesignation(designation.trim());
      const res = await signCrkEntry(row.id, { designation: designation.trim(), ...(highAlert ? { highAlert: true } : {}) });
      await refresh();
      setSaid(res.status === "reviewed" ? t("crk.signed") : t("crk.awaitingSecond"));
    } catch (e) { setError(formularyErrorMessage(e)); } finally { setBusy(false); }
  };

  if (draft.isError) return <p role="alert" className="text-sm text-red-700">{formularyErrorMessage(draft.error)}</p>;
  if (row === undefined) return <p className="text-sm text-neutral-600">…</p>;
  const status = statusOf(row, istToday());
  const iSignedFirst = row !== null && row.firstSignedBy !== null && actor !== null && row.firstSignedBy === actor.id;
  const canSign = can("formulary.monograph.review") && row !== null && row.crk !== null && row.status === "draft" && editing === null;
  const tone = status === "reviewed" ? "text-emerald-800" : status === "none" ? "text-neutral-600" : "text-amber-800";

  return (
    <div className="space-y-3" data-testid="crk-sign">
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="crk-back" onClick={onBack}>{t("crk.back")}</Button>
        <h2 className="min-w-0 flex-1 truncate font-medium">{opened.name}</h2>
      </div>
      <p data-testid="crk-status" className={`truncate text-sm ${tone}`}>
        {t(`crk.status.${status}`)}
        {status === "awaiting" && row?.firstSignerDesignation != null && <span className="text-neutral-600"> · {t("crk.firstBy", { who: row.firstSignerDesignation })}</span>}
      </p>

      {editing !== null
        ? <EntryEditor value={editing} onChange={setEditing} />
        : row?.crk != null ? <CrkEntryView entry={row.crk} testId="crk-entry" /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {editing === null
          ? <Button type="button" size="sm" variant="outline" data-testid="crk-edit" onClick={() => { setSaid(null); setEditing(structuredClone(row?.crk ?? EMPTY_ENTRY)); }}>{t("crk.edit")}</Button>
          : (
            <>
              <Button type="button" size="sm" data-testid="crk-save" disabled={busy} onClick={() => void save()}>{t("crk.save")}</Button>
              <Button type="button" size="sm" variant="outline" data-testid="crk-cancel" onClick={() => setEditing(null)}>{t("crk.cancel")}</Button>
              {row?.status === "reviewed" || row?.firstSignedBy != null
                ? <span data-testid="crk-save-unsigns" className="text-xs text-amber-800">{t("crk.saveUnsigns")}</span> : null}
            </>
          )}
      </div>

      {canSign && (
        <div className="space-y-2 rounded border p-3" data-testid="crk-sign-form">
          {status === "awaiting" && (
            <p data-testid="crk-second-prompt" className="text-sm text-sky-900">
              {iSignedFirst ? t("crk.youSignedFirst") : t("crk.status.awaiting")}
            </p>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {t("crk.designation")}
            <input data-testid="crk-designation" className="rounded border px-2 py-1" placeholder={t("crk.designationPlaceholder")}
              value={designation} onChange={(e) => setDesignation(e.target.value)} />
          </label>
          {status === "draft" && !row.highAlert && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid="crk-high-alert" checked={highAlert} onChange={(e) => setHighAlert(e.target.checked)} />
              {t("crk.highAlert")}
            </label>
          )}
          <Button type="button" size="sm" data-testid="crk-sign-button" disabled={busy || designation.trim() === "" || iSignedFirst} onClick={() => void sign()}>
            {status === "awaiting" ? t("crk.signSecond") : t("crk.sign")}
          </Button>
        </div>
      )}

      {said !== null && <p data-testid="crk-said" className="text-sm text-emerald-700">{said}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** The entry as a form: its sources, then each field's statements, each naming one of those sources. */
function EntryEditor({ value, onChange }: { value: CrkEntry; onChange: (v: CrkEntry) => void }): React.ReactElement {
  const { t } = useTranslation();
  const refs = value.sources.map((s) => s.ref);
  const setField = (f: CrkField, list: CrkEntry["fields"][CrkField]): void => onChange({ ...value, fields: { ...value.fields, [f]: list } });
  const nextRef = (): string => {
    let n = value.sources.length + 1;
    while (refs.includes(`s${String(n)}`)) n += 1;
    return `s${String(n)}`;
  };
  return (
    <div className="space-y-3 text-sm" data-testid="crk-editor">
      <fieldset className="space-y-2 rounded border p-2">
        <legend className="px-1 text-xs font-semibold uppercase text-neutral-600">{t("crk.sources")}</legend>
        {value.sources.map((s, i) => (
          <div key={s.ref} className="flex flex-wrap items-center gap-2" data-testid={`crk-source-${s.ref}`}>
            <span className="font-mono text-xs">[{s.ref}]</span>
            <select aria-label={t("crk.sourceKind")} className="rounded border px-1 py-1" value={s.kind}
              onChange={(e) => onChange({ ...value, sources: value.sources.map((x, j) => (j === i ? { ...x, kind: e.target.value as CrkSourceKind } : x)) })}>
              {CRK_SOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input aria-label={t("crk.sourceTitle")} placeholder={t("crk.sourceTitle")} className="min-w-40 flex-1 rounded border px-2 py-1" value={s.title}
              onChange={(e) => onChange({ ...value, sources: value.sources.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
            <input aria-label={t("crk.sourceUrl")} placeholder={t("crk.sourceUrl")} className="min-w-40 flex-1 rounded border px-2 py-1" value={s.url ?? ""}
              onChange={(e) => onChange({ ...value, sources: value.sources.map((x, j) => (j === i ? { ...x, url: e.target.value.trim() === "" ? null : e.target.value.trim() } : x)) })} />
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" data-testid="crk-add-source"
          onClick={() => onChange({ ...value, sources: [...value.sources, { ref: nextRef(), kind: "openfda", title: "", url: null, asOf: null }] })}>{t("crk.addSource")}</Button>
      </fieldset>
      {CRK_FIELDS.map((f) => {
        const list = value.fields[f] ?? [];
        return (
          <fieldset key={f} className="space-y-1" data-testid={`crk-edit-${f}`}>
            <legend className="text-xs font-semibold uppercase text-neutral-600">{t(`crk.field.${f}`)}</legend>
            {list.map((st, i) => (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <textarea aria-label={t("crk.statement")} data-testid={`crk-edit-${f}-${String(i)}`} className="min-h-12 min-w-0 flex-1 basis-60 rounded border px-2 py-1"
                  lang={f === "patientAdviceHi" ? "hi" : undefined} value={st.text}
                  onChange={(e) => setField(f, list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                <select aria-label={t("crk.source")} className="rounded border px-1 py-1" value={st.source}
                  onChange={(e) => setField(f, list.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))}>
                  {!refs.includes(st.source) && <option value={st.source}>{t("crk.noSource")}</option>}
                  {refs.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={() => setField(f, list.filter((_, j) => j !== i))}>{t("crk.remove")}</Button>
              </div>
            ))}
            {refs.length > 0 && (
              <Button type="button" size="sm" variant="outline" data-testid={`crk-add-${f}`}
                onClick={() => setField(f, [...list, { text: "", source: refs[0]! }])}>{t("crk.addStatement")}</Button>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
