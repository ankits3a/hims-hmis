import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { PatientPhoto } from "../screens/registration-desk";

/**
 * The smallest shape both lanes of the picker can produce: the free-text search route returns
 * more (phone, hasPhoto, isConfidential — Plan 05's SearchHit), the QR-verify route returns less.
 * `onPick` is deliberately pinned to their intersection so it stays a stable, reusable contract for
 * T13's walk-in open as well as this task's booking flow.
 */
export type PatientPickerHit = { id: string; uhid: string; name: string | null; sex: string; dob: string | null };

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; sex: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
};
type QrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; sex: string; dob: string | null } }
  | { ok: false; reason: string };

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Search-first patient picker (§11.1 entry lane), reused by T12's booking flow and T13's walk-in
 * open. Wraps `GET /patients/search` (typed digits, phone-first) and a QR-scan text box that posts
 * `POST /patients/qr/verify` — the same signed-QR verification Plan 05's card uses.
 */
export function PatientPicker({ onPick }: { onPick: (hit: PatientPickerHit) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState(false);
  const debounced = useDebounced(q, 250);

  const search = useQuery({
    queryKey: ["picker-search", debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const verify = async (payload: string): Promise<void> => {
    setScanError(false);
    try {
      const res = await api<QrVerifyResult>("POST", "/patients/qr/verify", { payload });
      if (res.ok) {
        onPick({ id: res.patient.id, uhid: res.patient.uhid, name: res.patient.name, sex: res.patient.sex, dob: res.patient.dob });
        setScan("");
      } else {
        setScanError(true);
      }
    } catch {
      setScanError(true);
    }
  };

  return (
    <div className="space-y-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("picker.searchPlaceholder")}
        aria-label={t("picker.searchLabel")}
        className="w-full rounded border px-3 py-2"
      />
      <div className="space-y-1">
        {(search.data?.items ?? []).map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => onPick({ id: hit.id, uhid: hit.uhid, name: hit.name, sex: hit.sex, dob: hit.dob })}
            className="flex w-full items-center gap-2 rounded border p-1 text-left hover:bg-neutral-50"
          >
            {hit.hasPhoto ? (
              <PatientPhoto patientId={hit.id} className="h-8 w-7 rounded" />
            ) : (
              <div className="h-8 w-7 rounded bg-neutral-100" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{hit.name}</span>
              <span className="block font-mono text-xs text-neutral-600">{hit.uhid}</span>
            </span>
          </button>
        ))}
      </div>
      <div>
        <input
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").trim();
            if (text !== "") void verify(text);
          }}
          placeholder={t("picker.scanPlaceholder")}
          aria-label={t("picker.scanLabel")}
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
        {scanError && <p role="alert" className="text-sm text-red-600">{t("picker.badScan")}</p>}
      </div>
    </div>
  );
}
