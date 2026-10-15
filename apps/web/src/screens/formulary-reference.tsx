import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchFdaReference } from "../lib/formulary-api";
import type { WireReferenceSection } from "../lib/formulary-api";

/** The order a reader looks in: the boxed warning first, then what it is for and how it is taken. */
const ORDER: readonly WireReferenceSection[] = [
  "boxed_warning", "uses", "directions", "contraindications", "warnings", "side_effects", "interactions", "pregnancy", "lactation",
  "children", "elderly", "overdose", "storage", "patient_information",
];

/**
 * #616 (decision 0051; plan 2026-10-07 §11) — THE US FDA LABEL REFERENCE for one generic, beside its monograph. Every
 * entry reads "US FDA label · <product> · <effective date>" and "Reference only — the US product may differ…", with its
 * source and retrieval date. A combination without its own label shows its parts under the banner; nothing on file reads
 * "No reference information yet". It is text to read: nothing here fills a dose or touches a prescription.
 */
export function FdaReference({ sctid }: { sctid: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const ref = useQuery({ queryKey: ["formulary", "fda-reference", sctid], queryFn: () => fetchFdaReference(sctid) });
  if (ref.isPending) return null;
  if (ref.isError) return <p data-testid="fda-reference-failed" className="text-sm text-neutral-600">{t("formularyRef.failed")}</p>;
  const r = ref.data;
  return (
    <section data-testid="fda-reference" className="space-y-2 rounded border border-sky-200 bg-sky-50/40 p-3 text-sm">
      <h3 className="font-medium">{t("formularyRef.heading")}</h3>
      {r.status === "none" && <p data-testid="fda-reference-none" className="text-neutral-700">{t("formularyRef.none")}</p>}
      {r.status === "components" && <p data-testid="fda-reference-banner" className="text-amber-800">{t("formularyRef.componentsBanner")}</p>}
      {r.status === "components" && r.missing.length > 0 && <p className="text-neutral-700">{t("formularyRef.missing", { names: r.missing.join(", ") })}</p>}
      {r.entries.map((e) => (
        <article key={e.labelId} data-testid={`fda-reference-${e.refKey}`} className="space-y-1 border-t pt-2">
          <p className="font-medium">{t("formularyRef.title", { product: e.product, date: e.effectiveDate ?? t("formularyRef.noDate") })}</p>
          <p className="text-xs text-amber-800">{t("formularyRef.caution")}</p>
          <p className="text-xs text-neutral-600">{t("formularyRef.source", { source: e.source, date: e.retrievedOn })}</p>
          {ORDER.filter((s) => (e.sections[s] ?? "") !== "").map((s) => (
            <details key={s} open={s === "boxed_warning"}>
              <summary className="cursor-pointer">{t(`formularyRef.section.${s}`)}</summary>
              <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs">{e.sections[s]}</p>
            </details>
          ))}
        </article>
      ))}
    </section>
  );
}
