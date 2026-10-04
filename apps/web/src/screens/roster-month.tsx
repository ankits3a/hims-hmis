import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { dayMonthIst, fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import {
  acceptRosterFinding, draftUnitMonth, editRosterSlot, fetchRosterUnits, fetchUnitMonth, publishUnitMonth,
  rosterErrorText,
} from "../lib/roster-api";
import type { WireMonthAssignment, WireMonthFinding, WireUnitMonth } from "../lib/roster-api";

/**
 * ═══ 20-U U5b — ROSTER: THE UNIT'S MONTH ═══
 *
 * The board the owner approved on 2026-09-20 (`docs/design/2026-09-20-roster/Main.dc.html`), for a
 * unit's senior resident and its head. A month the proposer has already drafted, one row per person
 * and one column per day; a *Before you publish* list on the right where every validator finding is
 * a SENTENCE naming the person and the day, with a one-tap fix where the roster supports one
 * (leave that duty vacant — a declared hole is an honest answer) and, for a warning, "it's fine, I'll
 * note why" for whoever holds `accept_warning`. **Publish stays disabled, and says why, while a
 * must-fix item stands** — the server's own gate (`blocked_by_findings`) decides; this only mirrors
 * the count the server computed with the gate's own rule.
 *
 * Write affordances follow `youMay`, which the server probes through the same act check the write
 * will make. Hidden here is a courtesy; refused there is the guard.
 */

type Props = { team?: string; month?: string };

const thisMonthIst = (): string => todayIst(new Date()).slice(0, 7);
const weekday = (istDate: string): number => new Date(`${istDate}T12:00:00Z`).getUTCDay();

export function RosterMonth({ team, month }: Props): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [teamId, setTeamId] = useState<string | undefined>(team);
  const [ym, setYm] = useState<string>(month ?? thisMonthIst());
  const [picked, setPicked] = useState<WireMonthAssignment | null>(null);

  const units = useQuery({ queryKey: ["roster", "units"], queryFn: fetchRosterUnits });
  const firstUnit = units.data?.[0]?.units[0]?.teamId;
  const unitId = teamId ?? firstUnit;
  const key = ["roster", "month", unitId ?? "", ym];
  const m = useQuery({
    queryKey: key,
    queryFn: () => fetchUnitMonth(unitId!, ym),
    enabled: unitId !== undefined && /^\d{4}-\d{2}$/.test(ym),
  });

  const settle = (next: WireUnitMonth): void => { qc.setQueryData(key, next); setPicked(null); };
  const draft = useMutation({ mutationFn: () => draftUnitMonth(unitId!, ym), onSuccess: settle });
  const slot = useMutation({ mutationFn: (v: { assignmentId: string; userId: string | null }) => editRosterSlot(v.assignmentId, v.userId), onSuccess: settle });
  const accept = useMutation({
    mutationFn: (v: { f: WireMonthFinding; reason: string }) =>
      acceptRosterFinding(m.data!.period!.periodId, { ruleKey: v.f.ruleKey, assignmentId: v.f.assignmentId, userId: v.f.userId }, v.reason),
    onSuccess: settle,
  });
  const publish = useMutation({
    mutationFn: () => publishUnitMonth(m.data!.period!.periodId, m.data!.period!.contentHash),
    onSuccess: settle,
  });
  const failure = [draft, slot, accept, publish].find((x) => x.isError)?.error;
  const busy = [draft, slot, accept, publish].some((x) => x.isPending);

  const d = m.data;
  const monthName = (x: string): string => t(`rosterMonth.monthName.${String(Number(x.slice(5, 7)))}`, { year: x.slice(0, 4) });

  return (
    <div className="space-y-4 p-4" data-testid="roster-month">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-semibold">
            {d === undefined ? t("rosterMonth.title") : d.period === null
              ? t("rosterMonth.titleEmpty", { month: monthName(d.month), unit: d.unit.name })
              : d.period.status === "published"
                ? t("rosterMonth.titlePublished", { month: monthName(d.month), unit: d.unit.name })
                : t("rosterMonth.titleDraft", { month: monthName(d.month), unit: d.unit.name })}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("rosterMonth.intro")}</p>
          {d !== undefined && !d.unit.confirmed && (
            <p role="note" className="max-w-3xl rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm" data-testid="unit-unconfirmed">{t("rosterMonth.unconfirmed")}</p>
          )}
        </div>
        <label className="flex flex-col text-xs text-muted-foreground">
          {t("rosterMonth.unit")}
          <select className="h-9 rounded border px-2 text-sm text-foreground" value={unitId ?? ""} onChange={(e) => { setTeamId(e.target.value); setPicked(null); }} data-testid="unit-picker">
            {(units.data ?? []).map((dep) => (
              <optgroup key={dep.departmentId} label={dep.name}>
                {dep.units.map((u) => <option key={u.teamId} value={u.teamId}>{u.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-muted-foreground">
          {t("rosterMonth.month")}
          <input type="month" className="h-9 rounded border px-2 text-sm text-foreground" value={ym} onChange={(e) => { setYm(e.target.value); setPicked(null); }} data-testid="month-picker" />
        </label>
      </div>

      {(units.isError || m.isError) && <p role="alert" className="text-sm text-red-700">{rosterErrorText(units.error ?? m.error, t)}</p>}
      {failure !== undefined && failure !== null && <p role="alert" className="text-sm text-red-700" data-testid="month-error">{rosterErrorText(failure, t)}</p>}
      {units.data !== undefined && units.data.length === 0 && <p className="text-sm text-muted-foreground">{t("rosterMonth.noUnits")}</p>}
      {m.isPending && unitId !== undefined && <p className="text-sm text-muted-foreground">{t("rosterOnNow.loading")}</p>}

      {d !== undefined && d.period === null && (
        <section className="space-y-2 rounded border p-4" data-testid="no-draft">
          <p>{t("rosterMonth.notDrafted", { month: monthName(d.month), unit: d.unit.name })}</p>
          {d.youMay.draft
            ? <button type="button" className="rounded bg-emerald-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => draft.mutate()}>{t("rosterMonth.draftIt")}</button>
            : <p className="text-sm text-muted-foreground">{t("rosterMonth.cannotDraft")}</p>}
        </section>
      )}

      {d !== undefined && d.period !== null && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <Legend />
            <Grid d={d} picked={picked} onPick={d.youMay.edit ? setPicked : undefined} />
            {picked !== null && d.youMay.edit && (
              <SlotEditor d={d} a={picked} busy={busy} onSave={(userId) => slot.mutate({ assignmentId: picked.assignmentId, userId })} onClose={() => setPicked(null)} />
            )}
            <Fairness d={d} />
          </div>
          <BeforeYouPublish
            d={d} busy={busy}
            onVacate={(assignmentId) => slot.mutate({ assignmentId, userId: null })}
            onAccept={(f, reason) => accept.mutate({ f, reason })}
            onPublish={() => publish.mutate()}
            monthName={monthName(d.month)}
          />
        </div>
      )}
    </div>
  );
}

function Legend(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 rounded bg-emerald-100" />{t("rosterMonth.legend.day")}</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 rounded bg-slate-900" />{t("rosterMonth.legend.night")}</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 rounded border border-dashed border-red-700" />{t("rosterMonth.legend.vacant")}</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 rounded outline outline-2 outline-red-700" />{t("rosterMonth.legend.needsYou")}</span>
    </div>
  );
}

const VACANT = "__vacant__";

function Grid({ d, picked, onPick }: { d: WireUnitMonth; picked: WireMonthAssignment | null; onPick?: (a: WireMonthAssignment) => void }): React.ReactElement {
  const { t } = useTranslation();
  const flagged = new Set(d.findings.filter((f) => f.blocking && f.assignmentId !== null).map((f) => f.assignmentId));
  const rows = [...d.people.map((p) => ({ id: p.userId, name: p.name, grade: p.grade })), { id: VACANT, name: t("rosterMonth.vacantRow"), grade: "" }];
  const cellOf = (rowId: string, day: string) => d.assignments.filter((a) => a.istDate === day && (rowId === VACANT ? a.userId === null : a.userId === rowId));
  return (
    <section className="overflow-x-auto rounded border" data-testid="month-grid">
      <table className="text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="sticky left-0 bg-muted/50 px-2 py-1 text-left">{t("rosterMonth.unitDay")}</th>
            {d.days.map((day) => (
              <th key={day} className={`w-11 px-0.5 py-1 text-center ${weekday(day) === 0 ? "bg-muted" : ""}`}>
                <div className="font-normal text-muted-foreground">{t(`rosterMonth.dow.${String(weekday(day))}`)}</div>
                <div className="font-mono">{Number(day.slice(8, 10))}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t" data-testid={`row-${r.id}`}>
              <td className="sticky left-0 whitespace-nowrap bg-background px-2 py-1">
                <div className="font-semibold">{r.name}</div>
                {r.grade !== "" && <div className="text-muted-foreground">{t(`rosterMonth.grade.${r.grade}`, { defaultValue: r.grade })}</div>}
              </td>
              {d.days.map((day) => (
                <td key={day} className="h-10 p-0.5 align-middle">
                  {cellOf(r.id, day).map((a) => {
                    const cls = a.userId === null ? "border border-dashed border-red-700 text-red-700"
                      : a.night ? "bg-slate-900 text-white" : "bg-emerald-100 text-emerald-900";
                    const mark = flagged.has(a.assignmentId) ? " outline outline-2 outline-red-700" : picked?.assignmentId === a.assignmentId ? " outline outline-2 outline-foreground" : "";
                    const label = a.night ? t("rosterMonth.cell.night") : t("rosterMonth.cell.day");
                    return onPick === undefined
                      ? <div key={a.assignmentId} className={`rounded px-0.5 text-center font-semibold ${cls}${mark}`} title={`${fmtIst(a.startsAt)}–${fmtIst(a.endsAt)}`}>{label}</div>
                      : <button key={a.assignmentId} type="button" className={`w-full rounded px-0.5 text-center font-semibold ${cls}${mark}`} title={`${fmtIst(a.startsAt)}–${fmtIst(a.endsAt)}`} onClick={() => onPick(a)} data-testid={`slot-${a.assignmentId}`}>{label}</button>;
                  })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{t("rosterMonth.gridFoot")}</p>
    </section>
  );
}

function SlotEditor({ d, a, busy, onSave, onClose }: {
  d: WireUnitMonth; a: WireMonthAssignment; busy: boolean; onSave: (userId: string | null) => void; onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [who, setWho] = useState<string>(a.userId ?? VACANT);
  return (
    <section className="flex flex-wrap items-end gap-3 rounded border border-foreground p-3 text-sm" data-testid="slot-editor">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t(a.night ? "rosterMonth.editNight" : "rosterMonth.editDay", { day: dayMonthIst(a.istDate), from: fmtIst(a.startsAt), to: fmtIst(a.endsAt) })}</div>
        <div className="text-muted-foreground">{a.name ?? t("rosterMonth.vacantRow")}</div>
      </div>
      <label className="flex flex-col text-xs text-muted-foreground">
        {t("rosterMonth.who")}
        <select className="h-9 rounded border px-2 text-sm text-foreground" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value={VACANT}>{t("rosterMonth.leaveVacant")}</option>
          {d.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
        </select>
      </label>
      <button type="button" className="h-9 rounded bg-emerald-800 px-3 font-semibold text-white disabled:opacity-50" disabled={busy || who === (a.userId ?? VACANT)} onClick={() => onSave(who === VACANT ? null : who)}>{t("rosterMonth.save")}</button>
      <button type="button" className="h-9 rounded border px-3" onClick={onClose}>{t("rosterMonth.cancel")}</button>
    </section>
  );
}

function Fairness({ d }: { d: WireUnitMonth }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="rounded border p-3 text-sm" data-testid="fairness">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("rosterMonth.fairShare")}</h2>
      {d.fairness.length === 0 ? <p className="m-0 text-muted-foreground">—</p> : (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {d.fairness.map((f) => (
            <li key={f.userId} className="flex gap-3">
              <span className="w-48 truncate">{f.name}</span>
              <span className="font-mono text-muted-foreground">{t("rosterMonth.shareLine", { nights: f.nights, sundays: f.sundays })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A finding as a sentence: the rule's own template, the person, the day, and the numbers it carries. */
function sentence(f: WireMonthFinding, t: (k: string, o?: Record<string, unknown>) => string): string {
  const p = f.params;
  const num = (k: string): string => (typeof p[k] === "number" ? String(p[k]) : "");
  return t(`rosterMonth.rule.${f.ruleKey}`, {
    defaultValue: t("rosterMonth.rule.other", { rule: f.ruleKey, name: f.name ?? "" }),
    name: f.name ?? t("rosterMonth.someone"),
    day: f.istDate === null ? "" : dayMonthIst(f.istDate),
    restHours: num("restHours"), minHours: num("minHours"), hours: num("hours"), maxHours: num("maxHours"),
    present: num("present"), minCount: num("minCount"), oneInN: num("oneInN"), gapDays: num("gapDays"),
  });
}

function BeforeYouPublish({ d, busy, onVacate, onAccept, onPublish, monthName }: {
  d: WireUnitMonth; busy: boolean; monthName: string;
  onVacate: (assignmentId: string) => void; onAccept: (f: WireMonthFinding, reason: string) => void; onPublish: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const published = d.period?.status === "published";
  const { blocking, warnings } = d.counts;
  const countLine = blocking > 0
    ? t("rosterMonth.countMustFix", { count: blocking }) + (warnings > 0 ? ` · ${t("rosterMonth.countLook", { count: warnings })}` : "")
    : warnings > 0 ? t("rosterMonth.countLook", { count: warnings }) : t("rosterMonth.allClear");
  /** Why publish is disabled — one reason, the first that applies, in the order a person can act on. */
  const why = published ? null
    : blocking > 0 ? t("rosterMonth.publishBlocked", { count: blocking })
      : !d.youMay.publish ? t("rosterMonth.publishNotYours")
        : null;
  return (
    <aside className="h-fit space-y-3 rounded border border-foreground p-3" data-testid="before-you-publish">
      <div className="flex items-baseline gap-2">
        <h2 className="flex-1 text-base font-semibold">{t("rosterMonth.beforeYouPublish")}</h2>
        <span className={`font-mono text-xs font-bold ${blocking > 0 ? "text-red-700" : warnings > 0 ? "text-amber-800" : "text-emerald-800"}`} data-testid="count-line">{countLine}</span>
      </div>
      {d.findings.length === 0 ? <p className="text-sm text-emerald-800">{t("rosterMonth.noFindings")}</p> : (
        <ul className="m-0 list-none space-y-2 p-0">
          {d.findings.map((f, i) => (
            <FindingCard
              key={`${f.ruleKey}-${f.assignmentId ?? ""}-${f.userId ?? ""}-${String(i)}`}
              f={f} d={d} busy={busy} published={published}
              onVacate={onVacate} onAccept={onAccept}
            />
          ))}
        </ul>
      )}
      {published ? (
        <div className="rounded bg-emerald-50 p-3 text-emerald-900" data-testid="published">
          <div className="font-semibold">{t("rosterMonth.publishedLine", { month: monthName, unit: d.unit.name, version: d.period?.version ?? 1 })}</div>
          <div className="text-sm">{t("rosterMonth.publishedNote")}</div>
        </div>
      ) : (
        <>
          <button
            type="button" data-testid="publish"
            className={`h-11 w-full rounded font-bold ${why === null ? "bg-emerald-800 text-white" : "cursor-not-allowed bg-muted text-muted-foreground"}`}
            disabled={why !== null || busy}
            aria-describedby="publish-why"
            onClick={onPublish}
          >
            {why === null ? t("rosterMonth.publish", { month: monthName, unit: d.unit.name }) : t("rosterMonth.cannotPublish")}
          </button>
          {why !== null && <p id="publish-why" className="m-0 text-sm text-muted-foreground" data-testid="publish-why">{why}</p>}
        </>
      )}
    </aside>
  );
}

function FindingCard({ f, d, busy, published, onVacate, onAccept }: {
  f: WireMonthFinding; d: WireUnitMonth; busy: boolean; published: boolean;
  onVacate: (assignmentId: string) => void; onAccept: (f: WireMonthFinding, reason: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [reasoning, setReasoning] = useState(false);
  const [reason, setReason] = useState("");
  const tone = f.accepted !== null ? "border-emerald-200 bg-emerald-50"
    : f.blocking ? "border-red-200 bg-red-50" : f.severity === "warn" ? "border-amber-200 bg-amber-50" : "border-slate-200";
  const tag = f.accepted !== null ? t("rosterMonth.tag.accepted")
    : f.blocking ? t("rosterMonth.tag.mustFix") : f.severity === "warn" ? t("rosterMonth.tag.look") : t("rosterMonth.tag.note");
  // The one-tap fix the roster supports for a finding about ONE duty: leave that duty vacant.
  const canVacate = !published && d.youMay.edit && f.assignmentId !== null && f.accepted === null && f.severity !== "info"
    && d.assignments.some((a) => a.assignmentId === f.assignmentId && a.userId !== null);
  const canAccept = !published && d.youMay.acceptWarning && f.severity === "warn" && f.accepted === null;
  return (
    <li className={`space-y-2 rounded border p-2 text-sm ${tone}`} data-testid={`finding-${f.ruleKey}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded bg-foreground/10 px-1.5 font-bold tracking-wide">{tag}</span>
        {f.istDate !== null && <span className="text-muted-foreground">{dayMonthIst(f.istDate)}</span>}
      </div>
      <p className="m-0">{sentence(f, t)}</p>
      {f.accepted !== null && (
        <p className="m-0 text-xs text-emerald-900">{t("rosterMonth.acceptedBy", { name: f.accepted.byName, reason: f.accepted.reason })}</p>
      )}
      {(canVacate || canAccept) && (
        <div className="flex flex-wrap gap-2">
          {canVacate && <button type="button" className="min-h-8 rounded bg-emerald-800 px-3 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => onVacate(f.assignmentId!)}>{t("rosterMonth.fixVacate")}</button>}
          {canAccept && !reasoning && <button type="button" className="min-h-8 rounded border bg-background px-3 text-xs" onClick={() => setReasoning(true)}>{t("rosterMonth.acceptWhy")}</button>}
        </div>
      )}
      {canAccept && reasoning && (
        <div className="flex gap-2">
          <label className="sr-only" htmlFor={`reason-${f.ruleKey}-${f.assignmentId ?? f.userId ?? ""}`}>{t("rosterMonth.reason")}</label>
          <input id={`reason-${f.ruleKey}-${f.assignmentId ?? f.userId ?? ""}`} className="h-8 min-w-0 flex-1 rounded border px-2 text-xs" placeholder={t("rosterMonth.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="h-8 rounded bg-emerald-800 px-3 text-xs font-semibold text-white disabled:opacity-50" disabled={busy || reason.trim() === ""} onClick={() => onAccept(f, reason.trim())}>{t("rosterMonth.accept")}</button>
        </div>
      )}
    </li>
  );
}
