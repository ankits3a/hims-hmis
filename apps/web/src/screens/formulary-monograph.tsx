import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import {
  fetchMonographDraft, formularyErrorMessage, reviewMonograph, saveMonograph, searchMonographGenerics,
} from "../lib/formulary-api";
import type { MonographSection, RenalSeverity, WireGenericHit, WireRenalDose } from "../lib/formulary-api";

const SECTIONS = ["patient", "prescriber", "nursing", "affordability"] as const;
type SectionName = (typeof SECTIONS)[number];
const SEVERITIES: readonly RenalSeverity[] = ["normal", "reduce", "avoid"];
type Band = { min: string; max: string; dose: string; severity: RenalSeverity };

const EMPTY_TEXT: Record<SectionName, string> = { patient: "", prescriber: "", nursing: "", affordability: "" };
const pretty = (v: MonographSection | null | undefined): string => (v == null ? "" : JSON.stringify(v, null, 2));
const isObject = (v: unknown): v is MonographSection => typeof v === "object" && v !== null && !Array.isArray(v);
const bound = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/**
 * ═══ THE DRUG MONOGRAPH EDITOR (owner 2026-10-02) ═══
 *
 * The owner's Drug Information Service specification tells one generic four ways and ships each telling as a
 * JSON object, so this door takes them as JSON: paste the whole document and split it, or paste a section into
 * its own box. The renal dose bands are typed as rows, because a check will compute on them.
 *
 * Saving writes a DRAFT, and a draft is shown to nobody. The pharmacy writes; a physician holding
 * `formulary.monograph.review` opens it here and reviews it (Drugs and Therapeutics Committee practice), and
 * the server still refuses the person who wrote it. Saving an edit to a reviewed monograph makes it a draft again.
 */
export function FormularyMonograph(): React.ReactElement {
  const { t } = useTranslation();
  // The pharmacy writes (`formulary.manage`); a physician reviews (`formulary.monograph.review`). The server holds both rules.
  const { can } = useAuth();
  const canWrite = can("formulary.manage");
  const canReview = can("formulary.monograph.review");
  const [q, setQ] = useState("");
  const [ask, setAsk] = useState("");
  const [picked, setPicked] = useState<WireGenericHit | null>(null);
  const [version, setVersion] = useState("");
  const [text, setText] = useState<Record<SectionName, string>>(EMPTY_TEXT);
  const [bands, setBands] = useState<Band[]>([]);
  const [pasted, setPasted] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setAsk(q.trim()); }, 250);
    return () => { clearTimeout(timer); };
  }, [q]);
  const hits = useQuery({ queryKey: ["formulary", "monograph-search", ask], queryFn: () => searchMonographGenerics(ask), enabled: ask.length >= 2 && picked === null });
  const current = useQuery({ queryKey: ["formulary", "monograph", picked?.sctid], queryFn: () => fetchMonographDraft(picked!.sctid), enabled: picked !== null });
  const held = current.data;

  useEffect(() => {
    if (held === undefined) return;
    setVersion(held?.sourceVersion ?? "");
    setText(held === null ? EMPTY_TEXT : { patient: pretty(held.patient), prescriber: pretty(held.prescriber), nursing: pretty(held.nursing), affordability: pretty(held.affordability) });
    setBands((held?.renalDoses ?? []).map((b) => ({ min: b.crclMin === null ? "" : String(b.crclMin), max: b.crclMax === null ? "" : String(b.crclMax), dose: b.dose, severity: b.severity })));
  }, [held]);

  /** The specification's section 4: one document, four tellings. The Jan Aushadhi benchmark sits inside its pharmacy object. */
  const split = (): void => {
    setError(null);
    let doc: unknown;
    try { doc = JSON.parse(pasted); } catch { doc = undefined; }
    if (!isObject(doc)) { setError(t("formularyAdmin.monograph.invalidDocument")); return; }
    const part = (key: string): string => (isObject(doc[key]) ? pretty(doc[key]) : "");
    const pos = doc.pharmacy_inventory_pos;
    setText({
      patient: part("consumer_patient_knowledge"), prescriber: part("physician_cds_master"), nursing: part("ipd_nursing_administration"),
      affordability: isObject(pos) && isObject(pos.dpco_jan_aushadhi_benchmark) ? pretty(pos.dpco_jan_aushadhi_benchmark) : "",
    });
    const meta = doc.metadata;
    if (isObject(meta) && typeof meta.source_of_truth_version === "string") setVersion(meta.source_of_truth_version);
  };

  const save = async (): Promise<void> => {
    if (picked === null) return;
    setError(null); setSaid(null);
    if (version.trim() === "") { setError(t("formularyAdmin.monograph.versionNeeded")); return; }
    const sections = {} as Record<SectionName, MonographSection | null>;
    for (const name of SECTIONS) {
      const raw = text[name].trim();
      if (raw === "") { sections[name] = null; continue; }
      let value: unknown;
      try { value = JSON.parse(raw); } catch { value = undefined; }
      if (!isObject(value)) { setError(t("formularyAdmin.monograph.invalidJson", { section: t(`formularyAdmin.monograph.section.${name}`) })); return; }
      sections[name] = value;
    }
    const renalDoses: WireRenalDose[] = bands.map((b) => ({ crclMin: bound(b.min), crclMax: bound(b.max), dose: b.dose.trim(), severity: b.severity }));
    try {
      await saveMonograph({ genericSctid: picked.sctid, sourceVersion: version.trim(), ...sections, renalDoses });
      await current.refetch();
      setSaid(t("formularyAdmin.monograph.savedDraft"));
    } catch (e) {
      setError(formularyErrorMessage(e));
    }
  };

  const review = async (): Promise<void> => {
    if (held == null) return;
    setError(null); setSaid(null);
    try {
      await reviewMonograph(held.id);
      await current.refetch();
      setSaid(t("formularyAdmin.monograph.reviewedNow"));
    } catch (e) {
      setError(formularyErrorMessage(e));
    }
  };

  const setBand = (i: number, patch: Partial<Band>): void => { setBands(bands.map((b, j) => (j === i ? { ...b, ...patch } : b))); };
  const status = held === undefined ? null
    : held === null ? t("formularyAdmin.monograph.statusNone")
      : held.status === "reviewed" ? t("formularyAdmin.monograph.statusReviewed", { date: (held.reviewedAt ?? "").slice(0, 10) })
        : t("formularyAdmin.monograph.statusDraft");

  return (
    <div data-testid="formulary-monograph" className="space-y-2 rounded border p-3">
      <h2 className="font-medium">{t("formularyAdmin.monograph.title")}</h2>
      <p className="text-xs text-neutral-600">{t("formularyAdmin.monograph.intro")}</p>
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        data-testid="monograph-search"
        aria-label={t("formularyAdmin.monograph.searchLabel")}
        placeholder={t("formularyAdmin.monograph.searchPlaceholder")}
        value={picked === null ? q : picked.name}
        onChange={(e) => { setPicked(null); setSaid(null); setError(null); setQ(e.target.value); }}
      />
      {picked === null && (hits.data ?? []).length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="monograph-hits">
          {(hits.data ?? []).map((h) => (
            <li key={h.id}>
              <button type="button" className="text-left underline" data-testid={`monograph-hit-${h.sctid}`} onClick={() => { setPicked(h); setSaid(null); setError(null); setPasted(""); }}>
                {h.name} <span className="text-xs text-neutral-600">{t(`formularyAdmin.monograph.hit.${h.monographStatus}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked !== null && status !== null && (
        <div className="space-y-3 text-sm">
          <p data-testid="monograph-status" className={held?.status === "reviewed" ? "text-emerald-800" : "text-amber-800"}>{status}</p>

          <label className="flex flex-col gap-1">
            {t("formularyAdmin.monograph.document")}
            <textarea className="h-20 rounded border px-2 py-1 font-mono text-xs" data-testid="monograph-document" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          <Button type="button" size="sm" variant="outline" data-testid="monograph-split" onClick={split}>{t("formularyAdmin.monograph.split")}</Button>

          <label className="flex max-w-xs flex-col gap-1">
            {t("formularyAdmin.monograph.version")}
            <input className="rounded border px-2 py-1" data-testid="monograph-version" value={version} onChange={(e) => setVersion(e.target.value)} />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            {SECTIONS.map((name) => (
              <label key={name} className="flex flex-col gap-1">
                {t(`formularyAdmin.monograph.section.${name}`)}
                <textarea
                  className="h-40 rounded border px-2 py-1 font-mono text-xs"
                  data-testid={`monograph-section-${name}`}
                  value={text[name]}
                  onChange={(e) => setText({ ...text, [name]: e.target.value })}
                />
              </label>
            ))}
          </div>

          <div className="space-y-1">
            <h3 className="font-medium">{t("formularyAdmin.monograph.renal")}</h3>
            <p className="text-xs text-neutral-600">{t("formularyAdmin.monograph.renalHelp")}</p>
            {bands.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input className="w-20 rounded border px-2 py-1" inputMode="numeric" aria-label={t("formularyAdmin.monograph.bandMin")} placeholder={t("formularyAdmin.monograph.bandMin")} data-testid={`monograph-band-${String(i)}-min`} value={b.min} onChange={(e) => setBand(i, { min: e.target.value })} />
                <input className="w-20 rounded border px-2 py-1" inputMode="numeric" aria-label={t("formularyAdmin.monograph.bandMax")} placeholder={t("formularyAdmin.monograph.bandMax")} data-testid={`monograph-band-${String(i)}-max`} value={b.max} onChange={(e) => setBand(i, { max: e.target.value })} />
                <input className="min-w-64 flex-1 rounded border px-2 py-1" aria-label={t("formularyAdmin.monograph.bandDose")} placeholder={t("formularyAdmin.monograph.bandDose")} data-testid={`monograph-band-${String(i)}-dose`} value={b.dose} onChange={(e) => setBand(i, { dose: e.target.value })} />
                <select className="rounded border px-1 py-1" aria-label={t("formularyAdmin.monograph.bandSeverity")} data-testid={`monograph-band-${String(i)}-severity`} value={b.severity} onChange={(e) => setBand(i, { severity: e.target.value as RenalSeverity })}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{t(`formularyAdmin.monograph.severity.${s}`)}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" data-testid={`monograph-band-${String(i)}-remove`} onClick={() => setBands(bands.filter((_, j) => j !== i))}>{t("formularyAdmin.monograph.bandRemove")}</Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" data-testid="monograph-band-add" onClick={() => setBands([...bands, { min: "", max: "", dose: "", severity: "normal" }])}>{t("formularyAdmin.monograph.bandAdd")}</Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {canWrite && <Button type="button" size="sm" data-testid="monograph-save" onClick={() => void save()}>{t("formularyAdmin.monograph.save")}</Button>}
            {canReview && held != null && held.status === "draft" && (
              <Button type="button" size="sm" variant="outline" data-testid="monograph-review" onClick={() => void review()}>{t("formularyAdmin.monograph.review")}</Button>
            )}
          </div>
        </div>
      )}
      {said !== null && <p data-testid="monograph-said" className="text-sm text-emerald-700">{said}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
