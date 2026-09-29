import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchRetailLicences, pharmacyErrorText, recordRetailLicence } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NewButton, OfficeHead, labelCls, useNewKey } from "./pharmacy-office/office-page";
import { Sheet } from "./pharmacy-office/sheet";

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
  /* GAP-CLOSURE B5 — recording is a sheet over the entries (N), never a form above them. */
  const [open, setOpen] = useState(false);

  const complete = draft.form20No.trim() !== "" && draft.form21No.trim() !== "" && draft.pharmacistInCharge.trim() !== ""
    && draft.validFrom !== "" && draft.validTo !== "";

  const save = async (): Promise<void> => {
    setError(null); setDone(false);
    try {
      await recordRetailLicence({
        form20No: draft.form20No.trim(), form21No: draft.form21No.trim(), validFrom: draft.validFrom, validTo: draft.validTo,
        pharmacistInCharge: draft.pharmacistInCharge.trim(), ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
      });
      setDraft(EMPTY); setDone(true); setOpen(false);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "retail"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const state = list.data?.state;
  const field = (key: keyof Draft, label: string, type = "text"): React.ReactElement => (
    <label className={labelCls}>{label}
      <Input type={type} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );

  const openNew = (): void => { setError(null); setDone(false); setOpen(true); };
  useNewKey(openNew);

  return (
    <div className="space-y-4" data-testid="pharmacy-retail-licence">
      <OfficeHead title={t("pharmacyRetailLicence.title")} lead={t("pharmacyRetailLicence.intro")}>
        <NewButton label={t("pharmacyRetailLicence.newLicence")} onClick={openNew} testId="licence-new" />
      </OfficeHead>
      {state !== undefined && (
        <p role="status" data-testid="licence-state" className={`ofp-card text-sm ${state.state === "current" ? "text-green-800" : "text-red-800"}`}>
          {state.state === "current"
            ? t("pharmacyRetailLicence.current", { f20: state.licence?.form20No ?? "", f21: state.licence?.form21No ?? "", to: state.licence?.validTo ?? "" })
            /* B5 — on this page the refusal names the act on this page, not "record it at Retail licence". */
            : state.state === "missing"
              ? t("pharmacyRetailLicence.stateMissing")
              : t(`pharmacyRetail.shut_${state.state}`, { to: state.licence?.validTo ?? "" })}
        </p>
      )}
      {!open && done && <p role="status" className="text-sm text-green-700">{t("pharmacyRetailLicence.saved")}</p>}
      <section className="ofp-box">
        <h2 className="ofp-group ofp-label">{t("pharmacyRetailLicence.history")} · {list.data?.items.length ?? "…"}</h2>
        {list.data !== undefined && list.data.items.length === 0 && <p className="ofp-empty">{t("pharmacyRetailLicence.none")}</p>}
        <ul className="ofp-rows">
          {(list.data?.items ?? []).map((l, i) => (
            <li key={l.id} data-testid={`licence-${l.id}`}>
              {i === 0 ? `${t("pharmacyRetailLicence.latest")} · ` : ""}
              {t("pharmacyRetailLicence.row", { f20: l.form20No, f21: l.form21No, from: l.validFrom, to: l.validTo, pharmacist: l.pharmacistInCharge })}
              {l.note === null ? "" : ` · ${l.note}`}
            </li>
          ))}
        </ul>
      </section>
      {open && (
        <Sheet title={t("pharmacyRetailLicence.newLicence")} testId="licence-sheet" onClose={() => setOpen(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {field("form20No", t("pharmacyRetailLicence.form20"))}
              {field("form21No", t("pharmacyRetailLicence.form21"))}
              {field("validFrom", t("pharmacyRetailLicence.validFrom"), "date")}
              {field("validTo", t("pharmacyRetailLicence.validTo"), "date")}
              {field("pharmacistInCharge", t("pharmacyRetailLicence.pharmacist"))}
              {field("note", t("pharmacyRetailLicence.note"))}
            </div>
            <Button type="submit" disabled={!complete}>{t("pharmacyRetailLicence.save")}</Button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
