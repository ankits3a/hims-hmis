import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  endPharmacistRegistration, fetchPharmacists, filePharmacistRegistration, pharmacyErrorText,
} from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import type { WirePharmacist } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P2 — THE REGISTER OF PHARMACISTS ═══
 *
 * The Pharmacy Act 1948 §42 reserves dispensing to a registered pharmacist, and the counter's verify
 * and a Schedule H/H1 hand-over now refuse anyone without a current state council registration on
 * file. This is where the pharmacist in charge files them: one row per person holding `pharmacy`,
 * what the register says about them, and the two acts. Nobody files or ends their own; the server
 * refuses it (`self_registration`) and the screen shows the refusal rather than hiding the button,
 * because who is looking at the screen is the server's question, not the screen's.
 */
type Draft = { council: string; registrationNo: string; validUntil: string };
const EMPTY: Draft = { council: "", registrationNo: "", validUntil: "" };

export function PharmacyPharmacists(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["pharmacy", "pharmacists"], queryFn: fetchPharmacists });
  const [filing, setFiling] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [ending, setEnding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["pharmacy", "pharmacists"] }); };

  const file = async (p: WirePharmacist): Promise<void> => {
    setError(null); setDone(null);
    try {
      await filePharmacistRegistration(p.userId, {
        council: draft.council.trim(), registrationNo: draft.registrationNo.trim(),
        validUntil: draft.validUntil === "" ? null : draft.validUntil,
      });
      setDone(t("pharmacyPharmacists.filed", { name: p.fullName }));
      setFiling(null); setDraft(EMPTY);
      await refresh();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const end = async (p: WirePharmacist, registrationId: string): Promise<void> => {
    setError(null); setDone(null);
    try {
      await endPharmacistRegistration(registrationId, reason.trim());
      setDone(t("pharmacyPharmacists.ended", { name: p.fullName }));
      setEnding(null); setReason("");
      await refresh();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyPharmacists.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyPharmacists.intro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}
      {list.data !== undefined && list.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("pharmacyPharmacists.none")}</p>
      )}
      <ul className="space-y-3">
        {(list.data ?? []).map((p) => (
          <li key={p.userId} className="rounded border p-3" data-testid={`pharmacist-${p.userId}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{p.fullName} <span className="text-xs text-muted-foreground">{p.username}</span></p>
              <p className="text-sm" data-testid={`pharmacist-status-${p.userId}`}>
                {p.current === null
                  ? <span className="text-red-700">{t("pharmacyPharmacists.noneOnFile")}</span>
                  : t("pharmacyPharmacists.current", {
                    council: p.current.council, no: p.current.registrationNo,
                    until: p.current.validUntil ?? t("pharmacyPharmacists.noEndDate"),
                  })}
                {p.renewalDueInDays !== undefined && p.renewalDueInDays !== null && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900" data-testid={`pharmacist-renewal-${p.userId}`}>
                    {p.renewalDueInDays === 0 ? t("pharmacyPharmacists.renewToday") : t("pharmacyPharmacists.renewIn", { count: p.renewalDueInDays })}
                  </span>
                )}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { setFiling(p.userId); setEnding(null); setDraft(EMPTY); }}>
                {p.current === null ? t("pharmacyPharmacists.file") : t("pharmacyPharmacists.renew")}
              </Button>
              {p.current !== null && (
                <Button type="button" size="sm" variant="outline" onClick={() => { setEnding(p.userId); setFiling(null); setReason(""); }}>
                  {t("pharmacyPharmacists.end")}
                </Button>
              )}
            </div>
            {filing === p.userId && (
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void file(p); }}>
                <label className="text-sm">{t("pharmacyPharmacists.council")}
                  <input className="ml-1 rounded border px-2 py-1" value={draft.council} onChange={(e) => setDraft({ ...draft, council: e.target.value })} />
                </label>
                <label className="text-sm">{t("pharmacyPharmacists.registrationNo")}
                  <input className="ml-1 rounded border px-2 py-1" value={draft.registrationNo} onChange={(e) => setDraft({ ...draft, registrationNo: e.target.value })} />
                </label>
                <label className="text-sm">{t("pharmacyPharmacists.validUntil")}
                  <input type="date" className="ml-1 rounded border px-2 py-1" value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} />
                </label>
                <Button type="submit" size="sm" disabled={draft.council.trim() === "" || draft.registrationNo.trim() === ""}>
                  {t("pharmacyPharmacists.save")}
                </Button>
              </form>
            )}
            {ending === p.userId && p.current !== null && (
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void end(p, p.current!.id); }}>
                <label className="text-sm">{t("pharmacyPharmacists.reason")}
                  <input className="ml-1 rounded border px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <Button type="submit" size="sm" disabled={reason.trim().length < 3}>{t("pharmacyPharmacists.confirmEnd")}</Button>
              </form>
            )}
            {p.history.some((h) => h.endedAt !== null) && (
              <ul className="mt-2 text-xs text-muted-foreground" aria-label={t("pharmacyPharmacists.history")}>
                {p.history.filter((h) => h.endedAt !== null).map((h) => (
                  <li key={h.id}>{h.council} {h.registrationNo} · {t("pharmacyPharmacists.endedBecause", { reason: h.endReason ?? "" })}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
