import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DeskModal } from "./desk-modal";
import { CRK_FIELDS, fetchSignedCrk } from "../lib/crk-api";
import type { CrkEntry, SignedCrk } from "../lib/crk-api";

/**
 * #882 / decision 0053 — ONE CRK formulary entry, read: each field's statements, each with the source it
 * names. A field with no statement is not drawn. Used by the reviewer (draft) and the doctor (signed only).
 * Every string is model- or person-written text and goes through React's text path.
 */
export function CrkEntryView({ entry, testId }: { entry: CrkEntry; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  const titleOf = new Map(entry.sources.map((s) => [s.ref, s.title]));
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13.5, minWidth: 0 }}>
      {entry.combinationNote === null ? null : (
        <p data-testid={`${testId}-combination`} style={{ margin: 0, padding: "6px 8px", borderRadius: 6, background: "rgba(221,143,28,.1)", fontSize: 12.5 }}>
          <b>{t("crk.combination")}</b> {entry.combinationNote}
        </p>
      )}
      {CRK_FIELDS.map((f) => {
        const list = entry.fields[f] ?? [];
        if (list.length === 0) return null;
        return (
          <section key={f} data-testid={`${testId}-${f}`}>
            <h4 style={{ margin: "0 0 3px", fontSize: 12, fontWeight: 700, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".02em" }}>{t(`crk.field.${f}`)}</h4>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {list.map((st, i) => (
                <li key={i} lang={f === "patientAdviceHi" ? "hi" : undefined} style={{ overflowWrap: "anywhere" }}>
                  {st.text} <sup style={{ color: "var(--faint)" }} title={titleOf.get(st.source) ?? st.source}>[{st.source}]</sup>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <section data-testid={`${testId}-sources`}>
        <h4 style={{ margin: "0 0 3px", fontSize: 12, fontWeight: 700, color: "var(--dim)", textTransform: "uppercase" }}>{t("crk.sources")}</h4>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--dim)" }}>
          {entry.sources.map((s) => (
            <li key={s.ref} style={{ overflowWrap: "anywhere" }}>
              [{s.ref}] {s.url === null ? s.title : <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>}
              {s.asOf === null ? null : <span> · {s.asOf}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** "CRK Medical College formulary · reviewed by <name>, <date>" → its two halves, split at the first " · ". */
export function labelParts(label: string): [string, string] {
  const at = label.indexOf(" · ");
  return at < 0 ? [label, ""] : [label.slice(0, at), label.slice(at + 3)];
}

/** The signed entries of the medicines on a doctor's screen, by medicine id. Unsigned ones are simply absent. */
export function useSignedCrk(medicineIds: readonly string[]): Map<string, SignedCrk> {
  const ids = [...new Set(medicineIds.filter((m) => m !== ""))].sort();
  const q = useQuery({
    queryKey: ["formulary", "signed-crk", ids.join(",")], enabled: ids.length > 0, staleTime: 5 * 60_000,
    queryFn: () => fetchSignedCrk(ids),
  });
  return new Map((q.data ?? []).map((s) => [s.medicineId, s]));
}

/**
 * The doctor's door to a medicine's SIGNED entry: a small "Info" chip that opens it, labelled
 * "CRK Medical College formulary · reviewed by <name>, <date>". Nothing at all when no signed entry exists.
 * No price, stock value or drafting cost is read or shown here (decision 0058).
 */
export function CrkInfoButton({ entry, testId }: { entry: SignedCrk | undefined; testId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (entry === undefined) return null;
  return (
    <>
      <button type="button" data-testid={testId} onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{ border: "1px solid var(--line, #cfd8d3)", background: "transparent", borderRadius: 9, padding: "0 8px", height: 20, fontSize: 11, fontWeight: 600, color: "var(--green, #0e6b4e)", cursor: "pointer", whiteSpace: "nowrap" }}>
        ⓘ {t("crk.info")}
      </button>
      <DeskModal open={open} onClose={() => setOpen(false)} title={t("crk.infoTitle", { name: entry.name })} titleId={`${testId}-title`} testId={`${testId}-modal`} width={560} closeLabel={t("crk.close")}>
        {/* Decision 0053's label, in its words, as two one-line parts so neither wraps on a phone. */}
        <p data-testid={`${testId}-label`} role="note" aria-label={entry.label} title={entry.designation ?? undefined} style={{ margin: "0 0 10px", fontSize: 12, color: "var(--dim)", minWidth: 0 }}>
          <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {labelParts(entry.label)[0]}
            {entry.highAlert ? <span data-testid={`${testId}-high-alert`} className="pill rd" style={{ marginLeft: 6 }}>{t("crk.highAlertTag")}</span> : null}
            {/* #884 — past its due date it is still shown: hiding it would hide safety text. */}
            {entry.overdue ? <span data-testid={`${testId}-overdue`} className="pill" style={{ marginLeft: 6, background: "rgba(221,143,28,.14)", color: "#8a5a10" }}>{t("crk.overdueTag")}</span> : null}
          </span>
          <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {labelParts(entry.label)[1]}{entry.secondSigner === null ? null : <span> · {entry.secondSigner}</span>}
          </span>
        </p>
        <CrkEntryView entry={entry.crk} testId={`${testId}-entry`} />
      </DeskModal>
    </>
  );
}
