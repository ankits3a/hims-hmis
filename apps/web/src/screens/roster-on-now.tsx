import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { dayMonthIst, fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { fetchOnNowBoard, rosterErrorText } from "../lib/roster-api";
import type { WireBoardDepartment, WireBoardHole, WireBoardService } from "../lib/roster-api";

/**
 * ═══ 20-U U5a — WHO IS ON NOW, THE HOSPITAL'S UNIT BOARD ═══
 *
 * The board the owner approved on 2026-09-20 (`docs/design/2026-09-20-roster/OnNow.dc.html`):
 * casualty, the front desk, the duty manager and every ward read this same screen. Per department
 * that runs units: the unit on take and till when, who is in the building, the faculty on call and
 * the backup unit; then the hospital-wide services; then the holes in the next 24 hours.
 *
 * **A department with no published roster SAYS SO** (`source !== "published"`) — the server sends no
 * people for it, and this screen draws a banner across the people columns rather than an empty row
 * that looks staffed. The design board's clock buttons were a review device; the real screen shows
 * NOW, refreshes every minute, and offers "+8 h" (and `?at=` for a link to an instant).
 *
 * No phone numbers yet: D6 puts them on this board alone, in a later task.
 */
const REFRESH_MS = 60_000;
const AHEAD_MS = 8 * 3_600_000;

type Props = { at?: string };

export function RosterOnNow({ at }: Props): React.ReactElement {
  const { t } = useTranslation();
  const [ahead, setAhead] = useState(false);
  const pinned = at !== undefined;
  const q = useQuery({
    queryKey: ["roster", "on-now", at ?? (ahead ? "ahead" : "now")],
    queryFn: () => fetchOnNowBoard(at ?? (ahead ? new Date(Date.now() + AHEAD_MS).toISOString() : undefined)),
    refetchInterval: pinned ? false : REFRESH_MS,
  });
  const b = q.data;
  const day = b === undefined ? null : todayIst(new Date(b.at));
  const lateNight = b !== undefined && b.departments.some((d) => d.unitOnTake !== null && todayIst(new Date(d.unitOnTake.startsAt)) !== day);

  return (
    <div className="space-y-4 p-4" data-testid="roster-on-now">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-semibold">{t("rosterOnNow.title")}</h1>
          {b !== undefined && day !== null && (
            <p className="text-lg font-semibold" data-testid="on-now-clock">{t("rosterOnNow.clock", { day: dayMonthIst(day), time: fmtIst(b.at) })}</p>
          )}
          <p className="max-w-3xl text-sm text-muted-foreground">{lateNight ? t("rosterOnNow.lateNight") : t("rosterOnNow.intro")}</p>
        </div>
        {!pinned && (
          <div className="inline-flex overflow-hidden rounded border text-sm" role="group" aria-label={t("rosterOnNow.when")}>
            <button type="button" aria-pressed={!ahead} className={`px-3 py-1 ${!ahead ? "bg-foreground text-background" : ""}`} onClick={() => setAhead(false)}>{t("rosterOnNow.now")}</button>
            <button type="button" aria-pressed={ahead} className={`border-l px-3 py-1 ${ahead ? "bg-foreground text-background" : ""}`} onClick={() => setAhead(true)}>{t("rosterOnNow.ahead")}</button>
          </div>
        )}
      </div>

      {q.isError && <p role="alert" className="text-sm text-red-700">{rosterErrorText(q.error, t)}</p>}
      {q.isPending && <p className="text-sm text-muted-foreground">{t("rosterOnNow.loading")}</p>}
      {b !== undefined && day !== null && (
        <>
          {!b.resolverEnabled && (
            <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm" data-testid="resolver-off">{t("rosterOnNow.resolverOff")}</p>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-4">
              <section className="overflow-x-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">{t("rosterOnNow.col.department")}</th>
                      <th className="px-3 py-2">{t("rosterOnNow.col.unit")}</th>
                      <th className="px-3 py-2">{t("rosterOnNow.col.building")}</th>
                      <th className="px-3 py-2">{t("rosterOnNow.col.faculty")}</th>
                      <th className="px-3 py-2">{t("rosterOnNow.col.backup")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.departments.map((d) => <DepartmentRow key={d.departmentId} d={d} day={day} />)}
                  </tbody>
                </table>
              </section>
              <Services services={b.services} />
            </div>
            <Holes holes={b.holes} />
          </div>
        </>
      )}
    </div>
  );
}

function DepartmentRow({ d, day }: { d: WireBoardDepartment; day: string }): React.ReactElement {
  const { t } = useTranslation();
  const published = d.source === "published";
  const u = d.unitOnTake;
  return (
    <tr className="border-t align-top" data-testid={`dept-${d.code}`}>
      <td className="px-3 py-2 font-medium">
        {d.name}
        {d.skeleton && <span className="ml-2 rounded bg-red-700 px-1 text-xs font-semibold text-white">{t("rosterOnNow.skeleton")}</span>}
      </td>
      <td className="px-3 py-2">
        {u === null ? <span className="font-semibold text-red-700">{t("rosterOnNow.noUnit")}</span> : (
          <>
            <div className="font-semibold">{u.name}</div>
            <div className="text-xs text-muted-foreground">{d.units === 1 ? t("rosterOnNow.singleUnit") : till(t, u.endsAt, day)}</div>
          </>
        )}
      </td>
      {published ? (
        <>
          <td className="px-3 py-2">
            {d.inTheBuilding.length === 0 ? <span className="text-red-700">{t("rosterOnNow.nobodyIn")}</span> : (
              <ul className="m-0 list-none space-y-0.5 p-0">
                {d.inTheBuilding.map((p) => (
                  <li key={p.userId} className="flex gap-2">
                    <span className="w-8 shrink-0 font-mono text-xs font-semibold text-muted-foreground">{t(`rosterOnNow.grade.${p.cadre}`, { defaultValue: p.cadre })}</span>
                    <span>{p.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
          <td className="px-3 py-2">
            {d.facultyOnCall.length === 0 ? <span className="text-muted-foreground">—</span> : d.facultyOnCall.map((r, i) => (
              <div key={r.userId ?? `vacant-${String(i)}`}>
                {r.name === null ? <span className="font-semibold text-red-700">{t("rosterOnNow.vacant")}</span> : r.name}
                <div className="text-xs text-muted-foreground">{t(`rosterOnNow.position.${r.positionKey}`, { defaultValue: r.positionLabel })}</div>
              </div>
            ))}
          </td>
        </>
      ) : (
        <td colSpan={2} className="px-3 py-2">
          <p role="note" className="m-0 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm" data-testid={`unpublished-${d.code}`}>
            {t("rosterOnNow.notPublished")}
          </p>
        </td>
      )}
      <td className="px-3 py-2 text-muted-foreground">
        {d.backupUnit !== null ? t("rosterOnNow.backup", { unit: d.backupUnit.name }) : d.units === 1 ? t("rosterOnNow.singleBackup") : "—"}
      </td>
    </tr>
  );
}

function Services({ services }: { services: WireBoardService[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" data-testid="on-now-services">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("rosterOnNow.services")}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {services.map((s) => (
          <div key={s.positionKey} className="rounded border bg-background px-3 py-2" data-testid={`service-${s.positionKey}`}>
            <div className="text-xs text-muted-foreground">{t(`rosterOnNow.position.${s.positionKey}`, { defaultValue: s.positionLabel })}</div>
            {s.source !== "published" ? <div className="text-sm text-amber-800">{t("rosterOnNow.serviceNotPublished")}</div>
              : s.people.length === 0 ? <div className="text-sm font-semibold text-red-700">{t("rosterOnNow.nobodyOn")}</div>
                : <div className="font-semibold">{s.people.map((p) => p.name).join(", ")}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Holes({ holes }: { holes: WireBoardHole[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <aside className="h-fit space-y-2 rounded border border-foreground p-3" data-testid="on-now-holes">
      <h2 className="text-base font-semibold">{t("rosterOnNow.holes")}</h2>
      {holes.length === 0 ? <p className="text-sm text-emerald-800">{t("rosterOnNow.noHoles")}</p> : (
        <ul className="m-0 list-none space-y-2 p-0">
          {holes.map((h, i) => (
            <li key={`${h.kind}-${h.departmentId}-${h.userId ?? ""}-${h.from}-${String(i)}`} className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
              <div className="text-xs text-muted-foreground">{dayMonthIst(todayIst(new Date(h.from)))} · {fmtIst(h.from)}</div>
              <div>{t(`rosterOnNow.hole.${h.kind}`, {
                dept: h.departmentName,
                position: h.positionKey === null ? "" : t(`rosterOnNow.position.${h.positionKey}`, { defaultValue: h.positionLabel ?? h.positionKey }),
                name: h.name ?? "",
                from: fmtIst(h.from),
                to: fmtIst(h.to),
              })}</div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** "till 08:00" today, "till 08:00 tomorrow", or "till 08:00 on 7 Oct" — an IST day, never the desk clock's. */
function till(t: (k: string, o?: Record<string, unknown>) => string, endsAt: string, day: string): string {
  const endDay = todayIst(new Date(endsAt));
  const time = fmtIst(endsAt);
  if (endDay === day) return t("rosterOnNow.tillToday", { time });
  const next = todayIst(new Date(new Date(`${day}T12:00:00+05:30`).getTime() + 86_400_000));
  if (endDay === next) return t("rosterOnNow.tillTomorrow", { time });
  return t("rosterOnNow.tillOn", { time, day: dayMonthIst(endDay) });
}
