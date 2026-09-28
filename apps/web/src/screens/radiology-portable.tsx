import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { fetchPortableRound, radiologyErrorText } from "../lib/radiology-api";
import { Button } from "@/components/ui/button";
import type { WireBedsideStudy } from "../lib/radiology-api";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS2b — **THE PORTABLE ROUND: the beds the trolley goes to.**
 *
 * `GET /radiology/portable/round` returns bedside studies booked on a portable machine and still to
 * be done, already sorted by place then slot. This screen groups them by WARD — the text before the
 * first "·" or "," of the place ("Ward 3 · bed 12" → "Ward 3") — so the technologist walks one ward
 * at a time. The grouping is presentation; which rows exist and in what order is the server's.
 *
 * Each row opens the existing study console, where the gates, the acquisition and the dose are.
 * Nothing on this screen performs an act: there is no "arrived at bed" button (the owner's layout
 * rule — no button that only records presence).
 *
 * The centre carries a plain note that ordering from the ward arrives with the IPD plan: today a
 * bedside study reaches this list because the imaging desk booked it with a ward and bed.
 */
export function wardOf(bedsideLocation: string): string {
  const head = bedsideLocation.split(/\s*[·,]\s*/)[0]?.trim();
  return head === undefined || head === "" ? bedsideLocation : head;
}

function groupByWard(rows: readonly WireBedsideStudy[]): [string, WireBedsideStudy[]][] {
  const groups = new Map<string, WireBedsideStudy[]>();
  for (const r of rows) {
    const ward = wardOf(r.bedsideLocation);
    groups.set(ward, [...(groups.get(ward) ?? []), r]);
  }
  return [...groups.entries()];
}

function slotText(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export function RadiologyPortable(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["radiology", "portable", "round"], queryFn: fetchPortableRound });
  const rows = q.data?.rows ?? [];
  const groups = groupByWard(rows);
  const open = (studyId: string) => {
    void navigate({ to: "/radiology/studies/$studyId", params: { studyId } });
  };
  const next = rows[0];

  const list = (
    <div className="space-y-3" data-testid="portable-round">
      {groups.map(([ward, items]) => (
        <section key={ward} aria-label={ward}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {ward} · {items.length}
          </h3>
          <ul className="mt-1 space-y-1">
            {items.map((r) => (
              <li key={r.studyId}>
                <button
                  type="button" data-testid={`round-${r.studyId}`}
                  className="w-full rounded border bg-card p-2 text-left text-sm hover:bg-muted"
                  onClick={() => { open(r.studyId); }}
                >
                  <span className="flex justify-between gap-2">
                    <b className="truncate">{r.patientName}</b>
                    <span className="mo shrink-0 text-xs">{slotText(r.scheduledAt)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.bedsideLocation} · {r.studyTypeCode} · {r.deviceCode ?? ""} · {r.status}
                    {r.priority === "stat" ? ` · ${t("radiology.worklist.stat")}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!q.isPending && rows.length === 0 ? <p className="text-sm">{t("radiology.portable.empty")}</p> : null}
    </div>
  );

  return (
    <RadiologyStation
      station="portable"
      title={t("radiology.portable.title")}
      place={t("radiology.portable.place")}
      stats={[
        { label: t("radiology.portable.beds"), value: rows.length },
        { label: t("radiology.portable.wards"), value: groups.length },
        { label: t("radiology.station.stat"), value: rows.filter((r) => r.priority === "stat").length, tone: "danger" },
      ]}
      list={list}
    >
      <div className="space-y-4">
        {q.isError ? <p role="alert" className="text-red-600">{radiologyErrorText(q.error)}</p> : null}
        {q.isPending ? <p>{t("common.loading")}</p> : null}
        {next !== undefined
          ? (
            <div className="rounded border bg-card p-3" data-testid="portable-next">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("radiology.portable.next")}</p>
              <p className="mt-1 text-lg font-semibold">{next.bedsideLocation}</p>
              <p className="text-sm">
                {next.patientName} · {next.studyTypeCode} · {next.accessionNo} · {slotText(next.scheduledAt)}
              </p>
              <Button className="mt-2" onClick={() => { open(next.studyId); }}>{t("radiology.portable.open")}</Button>
            </div>
          )
          : null}
        <p className="rounded border border-dashed p-3 text-sm text-muted-foreground" data-testid="portable-ipd-note">
          {t("radiology.portable.ipdNote")}
        </p>
      </div>
    </RadiologyStation>
  );
}
