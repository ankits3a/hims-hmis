import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchRetailLicences, pharmacyErrorText, recordRetailLicence } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * ═══ PHARMACY P19 — THE WALK-IN COUNTER'S LICENCE ═══
 *
 * The retail store sells to the public only under a current Form 20/21 licence (Drugs and Cosmetics
 * Act §18(c)). The pharmacist in charge, the medical superintendent or the owner records it here. An
 * entry is never edited: a renewal or a correction is a new entry, and the latest one is the licence.
 */
type Draft = { form20No: string; form21No: string; validFrom: string; validTo: string; pharmacistInCharge: string; note: string };
const EMPTY: Draft = { form20No: "", form21No: "", validFrom: "", validTo: "", pharmacistInCharge: "", note: "" };

export function PharmacyRetailLicence(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["pharmacy", "retail", "licences"], queryFn: fetchRetailLicences });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const complete = draft.form20No.trim() !== "" && draft.form21No.trim() !== "" && draft.pharmacistInCharge.trim() !== ""
    && draft.validFrom !== "" && draft.validTo !== "";

  const save = async (): Promise<void> => {
    setError(null); setDone(false);
    try {
      await recordRetailLicence({
        form20No: draft.form20No.trim(), form21No: draft.form21No.trim(), validFrom: draft.validFrom, validTo: draft.validTo,
        pharmacistInCharge: draft.pharmacistInCharge.trim(), ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
      });
      setDraft(EMPTY); setDone(true);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "retail"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const state = list.data?.state;
  const field = (key: keyof Draft, label: string, type = "text"): React.ReactElement => (
    <label className="text-sm">{label}
      <Input type={type} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyRetailLicence.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyRetailLicence.intro")}</p>
      {state !== undefined && (
        <p role="status" data-testid="licence-state" className={state.state === "current" ? "text-sm text-green-800" : "text-sm text-red-800"}>
          {state.state === "current"
            ? t("pharmacyRetailLicence.current", { f20: state.licence?.form20No ?? "", f21: state.licence?.form21No ?? "", to: state.licence?.validTo ?? "" })
            : t(`pharmacyRetail.shut_${state.state}`, { to: state.licence?.validTo ?? "" })}
        </p>
      )}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done && <p role="status" className="text-sm text-green-700">{t("pharmacyRetailLicence.saved")}</p>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {field("form20No", t("pharmacyRetailLicence.form20"))}
        {field("form21No", t("pharmacyRetailLicence.form21"))}
        {field("validFrom", t("pharmacyRetailLicence.validFrom"), "date")}
        {field("validTo", t("pharmacyRetailLicence.validTo"), "date")}
        {field("pharmacistInCharge", t("pharmacyRetailLicence.pharmacist"))}
        {field("note", t("pharmacyRetailLicence.note"))}
        <Button type="submit" disabled={!complete}>{t("pharmacyRetailLicence.save")}</Button>
      </form>
      <section>
        <h2 className="font-semibold">{t("pharmacyRetailLicence.history")}</h2>
        {list.data !== undefined && list.data.items.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyRetailLicence.none")}</p>}
        <ul className="text-sm">
          {(list.data?.items ?? []).map((l, i) => (
            <li key={l.id} data-testid={`licence-${l.id}`}>
              {i === 0 ? `${t("pharmacyRetailLicence.latest")} · ` : ""}
              {t("pharmacyRetailLicence.row", { f20: l.form20No, f21: l.form21No, from: l.validFrom, to: l.validTo, pharmacist: l.pharmacistInCharge })}
              {l.note === null ? "" : ` · ${l.note}`}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
