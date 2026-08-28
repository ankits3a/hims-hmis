import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { fetchList, otErrorText, publishList } from "../lib/ot-api";
import { Button } from "@/components/ui/button";
import type { WireGate, WireListItem } from "../lib/ot-api";

/**
 * PLAN 15 T8 — **THE DAY'S THEATRE LIST**, and the one screen the whole unit stands around at 7 a.m.
 *
 * ═══ THE GATES ARE SHOWN PER CASE, BECAUSE "WHY IS THIS CASE NOT READY" IS THE ONLY QUESTION ═══
 *
 * A list that showed only `state` would answer "not ready" and stop, and the coordinator's morning
 * is spent finding out which of nine gates is open. So every case carries its gate chips, and the
 * open ones are the ones that read differently. The chips are the SERVER's gate rows — the screen
 * never decides what "satisfied" means, it renders what `caseGates` reported (§2.54).
 *
 * ═══ PUBLISHING IS A LIST ACTION, AND ITS RESULT IS A COUNT OF WHO BECAME READY ═══
 *
 * `publishList` moves every booked case to `listed` and evaluates readiness in the same call, so
 * the honest thing to report back is both numbers: how many cases were published and how many of
 * them came out ready. "Published 6 cases; 4 ready" tells the coordinator there are two to chase;
 * "Published" tells them nothing.
 */
export function OtList(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [listDate, setListDate] = useState("");
  const [theatre, setTheatre] = useState("");
  const [applied, setApplied] = useState<{ listDate: string; theatreResourceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["ot", "list", applied],
    queryFn: () => fetchList(applied!),
    enabled: applied !== null,
  });

  const publish = async (): Promise<void> => {
    setError(null);
    setDone(null);
    if (applied === null) return;
    try {
      const res = await publishList(applied);
      setDone(t("otList.published", { count: res.caseCount, ready: res.readyCaseIds.length }));
      await qc.invalidateQueries({ queryKey: ["ot", "list"] });
    } catch (e) {
      setError(otErrorText(e, t));
    }
  };

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">{t("otList.title")}</h1>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          {t("otList.listDate")}
          <input
            type="date" className="rounded border px-2 py-1" value={listDate}
            onChange={(e) => setListDate(e.target.value)}
          />
        </label>
        <label className="flex flex-col text-sm">
          {t("otList.theatre")}
          <input
            className="rounded border px-2 py-1" value={theatre}
            onChange={(e) => setTheatre(e.target.value)}
          />
        </label>
        <Button
          onClick={() => { setApplied({ listDate, theatreResourceId: theatre }); }}
          disabled={listDate === "" || theatre === ""}
        >
          {t("otList.load")}
        </Button>
        <Button variant="secondary" onClick={() => void publish()} disabled={applied === null}>
          {t("otList.publish")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("otList.publishHint")}</p>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p className="text-sm text-green-700">{done}</p>}

      {applied !== null && list.data !== undefined && (
        list.data.length === 0
          ? <p className="text-sm">{t("otList.empty")}</p>
          : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="py-1">{t("otList.seq")}</th>
                  <th>{t("otList.patient")}</th>
                  <th>{t("otList.procedure")}</th>
                  <th>{t("otList.surgeon")}</th>
                  <th>{t("otList.state")}</th>
                  <th>{t("otList.gates")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((item: WireListItem) => (
                  <tr key={item.caseId} className="border-t">
                    <td className="py-1">{item.seq}</td>
                    <td>{item.patientDisplay}</td>
                    <td>
                      {item.procedureCode}
                      {item.laterality !== null && <span className="ml-1 font-semibold">({item.laterality})</span>}
                    </td>
                    <td>{item.surgeonId}</td>
                    <td>{item.state}</td>
                    <td className="space-x-1">
                      {item.gates.map((g: WireGate) => (
                        <span
                          key={g.kind}
                          className={
                            g.state === "satisfied" || g.state === "waived" || g.state === "overridden"
                              ? "rounded bg-green-100 px-1 text-green-900"
                              : "rounded bg-amber-100 px-1 font-semibold text-amber-900"
                          }
                        >
                          {g.kind}
                        </span>
                      ))}
                    </td>
                    <td>
                      <Link to="/ot/cockpit/$caseId" params={{ caseId: item.caseId }} className="underline">
                        {t("otList.open")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
    </div>
  );
}
