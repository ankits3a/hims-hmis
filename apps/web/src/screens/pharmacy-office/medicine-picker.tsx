import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { searchMedicines } from "../../lib/formulary-api";
import type { WireMedicineHit } from "../../lib/formulary-api";

/**
 * THE FORMULARY MEDICINE, PICKED BY NAME — one picker for "+ New drug" (`new-drug-sheet.tsx`) and the item master's
 * "Register an item" (`materials-items.tsx`; walk 2026-11-13: that one was a text box for a raw id). Type two or more
 * letters, the formulary answers, a click picks; "Change" puts the search back. `testId` names the input; its list
 * and the picked row are `<testId>-hits` and `<testId>-picked`.
 */
export function MedicinePicker({ label, value, onPick, testId, placeholder }: {
  label: string; value: WireMedicineHit | null; onPick: (m: WireMedicineHit | null) => void; testId: string; placeholder?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [ask, setAsk] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => { const id = setTimeout(() => setTyped(ask.trim()), 250); return () => clearTimeout(id); }, [ask]);
  const hits = useQuery({ queryKey: ["formulary", "medicine-picker", typed], queryFn: () => searchMedicines(typed, 10), enabled: value === null && typed.length >= 2 });
  const box = "rounded-md border px-2 py-1.5";
  if (value !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5" data-testid={`${testId}-picked`}>
        <span className="min-w-0 flex-1 font-medium">{value.name}</span>
        <button type="button" className="text-xs underline" onClick={() => onPick(null)}>{t("stockEntry.nd.change")}</button>
      </div>
    );
  }
  return (
    <>
      <input className={box} value={ask} placeholder={placeholder ?? t("stockEntry.nd.genericPlaceholder")} onChange={(e) => setAsk(e.target.value)} data-testid={testId} aria-label={label} />
      {typed.length >= 2 && (
        <ul className="max-h-56 overflow-y-auto rounded-md border" data-testid={`${testId}-hits`}>
          {(hits.data ?? []).map((h) => (
            <li key={h.id}>
              <button type="button" className="w-full px-2 py-1.5 text-left hover:bg-muted" onClick={() => onPick(h)}>
                <span className="font-medium">{h.name}</span>
                <span className="block text-xs text-muted-foreground">{[h.strength, h.form, h.salts.join(" + ")].filter((x) => x !== null && x !== "").join(" · ")}</span>
              </button>
            </li>
          ))}
          {hits.data !== undefined && hits.data.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("stockEntry.nd.noGeneric")}</li>}
        </ul>
      )}
    </>
  );
}
