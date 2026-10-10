import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { listOutsideTests, saveOutsideTest } from "../lib/ordering-api";
import type { WireOutsideTest } from "../lib/ordering-api";

/**
 * OUTSIDE TESTS (owner 2026-10-10, decision 0065) — ECG, echo and the other tests the hospital does not
 * do yet. The doctor advises them like any test; the slip prints them under "Tests to be done outside".
 * When the hospital starts one, set it "In hospital" and name the department.
 */
type Draft = { code: string; nameEn: string; site: "outside" | "in_hospital"; department: string; active: boolean };

const EMPTY: Draft = { code: "", nameEn: "", site: "outside", department: "", active: true };

function draftOf(row: WireOutsideTest): Draft {
  return { code: row.code, nameEn: row.nameEn, site: row.site, department: row.department ?? "", active: row.active };
}

export function OutsideTests(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayEdit = can("tariff.services.manage");
  const list = useQuery({ queryKey: ["ordering", "outside-tests", "all"], queryFn: () => listOutsideTests(true) });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) => saveOutsideTest({
      code: d.code, nameEn: d.nameEn, site: d.site, department: d.site === "in_hospital" ? d.department : null, active: d.active,
    }),
    onSuccess: async (row) => {
      setNotice(t("outsideTests.saved", { name: row.nameEn }));
      setEditing(null);
      setDraft(EMPTY);
      await qc.invalidateQueries({ queryKey: ["ordering"] });
    },
  });
  const error = save.error instanceof Error ? save.error.message : null;

  const form = (
    <div className="flex flex-wrap items-end gap-2" data-testid="outside-test-form">
      <label className="text-xs">
        {t("outsideTests.code")}
        <input className="block w-28 rounded border px-2 py-1 text-sm uppercase" value={draft.code} disabled={editing !== null}
          onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
      </label>
      <label className="min-w-[12rem] flex-1 text-xs">
        {t("outsideTests.name")}
        <input className="block w-full rounded border px-2 py-1 text-sm" value={draft.nameEn}
          onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} />
      </label>
      <label className="text-xs">
        {t("outsideTests.where")}
        <select className="block rounded border px-2 py-1 text-sm" value={draft.site}
          onChange={(e) => setDraft({ ...draft, site: e.target.value as Draft["site"] })}>
          <option value="outside">{t("outsideTests.outside")}</option>
          <option value="in_hospital">{t("outsideTests.inHospital")}</option>
        </select>
      </label>
      {draft.site === "in_hospital" && (
        <label className="text-xs">
          {t("outsideTests.department")}
          <input className="block w-40 rounded border px-2 py-1 text-sm" value={draft.department}
            onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
        </label>
      )}
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
        {t("outsideTests.active")}
      </label>
      <button type="button" className="rounded bg-emerald-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        disabled={save.isPending || draft.code.trim() === "" || draft.nameEn.trim() === "" || (draft.site === "in_hospital" && draft.department.trim() === "")}
        onClick={() => { setNotice(null); save.mutate(draft); }}>
        {editing === null ? t("outsideTests.add") : t("outsideTests.save")}
      </button>
      {editing !== null && (
        <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => { setEditing(null); setDraft(EMPTY); }}>
          {t("outsideTests.cancel")}
        </button>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4" data-testid="outside-tests">
      <div>
        <h1 className="text-lg font-semibold">{t("outsideTests.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("outsideTests.lead")}</p>
      </div>
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {mayEdit && form}
      {list.isLoading && <p className="text-sm text-muted-foreground">{t("outsideTests.loading")}</p>}
      {list.data !== undefined && list.data.length === 0 && <p className="text-sm text-muted-foreground">{t("outsideTests.empty")}</p>}
      {list.data !== undefined && list.data.length > 0 && (
        <ul className="divide-y rounded-lg border bg-white" data-testid="outside-test-list">
          {list.data.map((row) => (
            <li key={row.serviceId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm" data-testid={`outside-test-${row.code}`}>
              <span className="w-20 font-mono text-xs">{row.code}</span>
              <span className={`min-w-0 flex-1 ${row.active ? "" : "text-muted-foreground line-through"}`}>{row.nameEn}</span>
              <span className="text-xs">
                {row.site === "outside" ? t("outsideTests.outside") : t("outsideTests.inHospitalAt", { department: row.department ?? "" })}
              </span>
              {mayEdit && (
                <button type="button" className="rounded border px-2 py-0.5 text-xs"
                  onClick={() => { setEditing(row.serviceId); setDraft(draftOf(row)); setNotice(null); }}>
                  {t("outsideTests.edit")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
