import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDebounced } from "../lib/format";
import { searchOrderableTests } from "../lib/ordering-api";
import type { WireOrderableTest } from "../lib/ordering-api";

/**
 * THE TEST PICKER (decision 0065) — for the IPD and Emergency doctor screens when they are built.
 * Searches every test a department claims (`GET /ordering/tests`) and tags each with who does it, so
 * the doctor sees "Lab", "Imaging" or "Outside" before picking. Ordering is the caller's: it posts the
 * picked ids to `POST /ordering/orders`, which routes each to its department.
 */
export function TestPicker({ picked, onPick }: {
  picked: readonly string[];
  onPick: (test: WireOrderableTest) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const found = useQuery({
    queryKey: ["ordering", "tests", term],
    queryFn: () => searchOrderableTests(term),
    enabled: term.length >= 2,
  });
  const rows = (found.data ?? []).filter((r) => !picked.includes(r.serviceId));
  return (
    <div className="space-y-1" data-testid="test-picker">
      <input
        className="w-full rounded border px-2 py-1 text-sm" value={q} placeholder={t("testPicker.placeholder")}
        aria-label={t("testPicker.placeholder")} onChange={(e) => setQ(e.target.value)}
      />
      {term.length >= 2 && found.data !== undefined && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("testPicker.none")}</p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y rounded border bg-white" data-testid="test-picker-results">
          {rows.map((r) => (
            <li key={r.serviceId}>
              <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-neutral-50"
                onClick={() => { onPick(r); setQ(""); }}>
                <span className="min-w-0 flex-1">{r.name}</span>
                <span className="rounded bg-neutral-100 px-1.5 text-xs" data-testid={`test-picker-dept-${r.serviceId}`}>
                  {r.department === "in_hospital" ? r.departmentName ?? t("testPicker.dept.in_hospital") : t(`testPicker.dept.${r.department}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
