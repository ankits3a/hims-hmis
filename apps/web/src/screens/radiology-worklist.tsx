import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { fetchWorklist, radiologyErrorText } from "../lib/radiology-api";
import { Button } from "@/components/ui/button";
import type { WireWorklistRow } from "../lib/radiology-api";

/**
 * PLAN 18a T9 — **THE IMAGING WORKLIST: the technologist's day and the radiologist's unread list.**
 *
 * ═══ THE SCREEN FILTERS NOTHING ═══
 *
 * A restricted study is not on this list because the SERVER did not send it (T8 A8), not because
 * this component hid it — and a confidential patient's row arrives already carrying whichever name
 * the reader is entitled to. Both rules are `read.ts`'s, and a client-side copy of either would be
 * the copy that drifts. What the screen adds is the thing a list is for: the `stat` rows read first,
 * and the two flags a technologist must not miss are visible without opening anything.
 */
const VIEWS = ["floor", "unread", "all"] as const;

export function RadiologyWorklist(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [view, setView] = useState<(typeof VIEWS)[number]>("floor");
  const q = useQuery({
    queryKey: ["radiology", "worklist", view],
    queryFn: () => fetchWorklist(view),
  });

  const rows: WireWorklistRow[] = q.data?.rows ?? [];
  /** `stat` first, then by slot. The sort is presentation; the server owns which rows exist. */
  const ordered = [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "stat" ? -1 : b.priority === "stat" ? 1 : 0;
    return (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "");
  });

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">{t("radiology.worklist.title")}</h1>

      <div className="flex gap-2" role="group" aria-label={t("radiology.worklist.viewLabel")}>
        {VIEWS.map((v) => (
          <Button key={v} variant={v === view ? "default" : "outline"} onClick={() => { setView(v); }}>
            {t(`radiology.worklist.view.${v}`)}
          </Button>
        ))}
      </div>

      {q.isError ? <p role="alert" className="text-red-600">{radiologyErrorText(q.error)}</p> : null}
      {q.isPending ? <p>{t("common.loading")}</p> : null}

      {!q.isPending && ordered.length === 0
        ? <p>{t("radiology.worklist.empty")}</p>
        : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>{t("radiology.worklist.accession")}</th>
                <th>{t("radiology.worklist.patient")}</th>
                <th>{t("radiology.worklist.study")}</th>
                <th>{t("radiology.worklist.status")}</th>
                <th>{t("radiology.worklist.slot")}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => (
                <tr key={r.studyId} data-testid={`study-${r.studyId}`}>
                  <td>
                    {/**
                      * `useNavigate` rather than `<Link>`: a `<Link>` needs a `RouterProvider` that
                      * the component-test harness deliberately does not mount, and the house
                      * convention (`opd-desk.tsx`, `patient-detail.tsx`) is to navigate instead.
                      */}
                    <button
                      type="button" className="underline"
                      onClick={() => {
                        void navigate({ to: "/radiology/studies/$studyId", params: { studyId: r.studyId } });
                      }}
                    >
                      {r.accessionNo}
                    </button>
                  </td>
                  <td>
                    {r.patientName}
                    {/**
                      * The two flags a technologist must not miss. `form_f_required` is the one with
                      * a criminal statute behind it, and it is on the ROW rather than one click in.
                      */}
                    {r.formFRequired
                      ? <span className="ml-2 rounded bg-amber-100 px-1" title={t("radiology.worklist.formFTitle")}>
                          {t("radiology.worklist.formF")}
                        </span>
                      : null}
                    {r.restricted
                      ? <span className="ml-2 rounded bg-slate-200 px-1">{t("radiology.worklist.restricted")}</span>
                      : null}
                  </td>
                  <td>{r.studyTypeCode}</td>
                  <td>
                    {r.status}
                    {r.priority === "stat"
                      ? <span className="ml-2 rounded bg-red-100 px-1 font-semibold">{t("radiology.worklist.stat")}</span>
                      : null}
                  </td>
                  <td>{r.scheduledAt ?? t("radiology.worklist.unslotted")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
