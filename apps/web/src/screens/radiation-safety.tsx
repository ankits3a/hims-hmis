import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DOSE_UNITS, aerbErrorText, fetchAppointments, fetchBadges, fetchCalendar, fetchDoseRegister,
  fetchLicenceGaps, fetchLicences, fetchQaRecords,
} from "../lib/aerb-api";
import type {
  WireAppointment, WireBadge, WireBadgeGap, WireCalendarRow, WireDoseRow, WireLicence,
  WireLicenceGap, WireQaRecord,
} from "../lib/aerb-api";

/**
 * PLAN 18c T1 / D11 — **THE RADIATION-SAFETY REGISTER: one screen, the tabs an inspector asks for.**
 *
 * ═══ THE GAP IS A TAB'S WORTH OF THE POINT, NOT A FOOTNOTE ═══
 *
 * A register screen that only lists the licences it holds cannot show the thing the register exists
 * to make visible: **a machine that emits and has no paper.** So the Licences tab renders the gap
 * list above the file, in red, and it is the server that decides which machines belong on it —
 * which modalities AERB licences at all is a regulatory fact, and a client-side list of them would
 * be the copy that drifted the day somebody added a modality.
 *
 * All five registers are built as of T5. The tab list is still declared as a constant rather than
 * inlined, because `BUILT` is what a future phase narrows if it ever adds a sixth.
 */
const TABS = ["licences", "people", "qa", "dose", "badges", "calendar"] as const;
type Tab = (typeof TABS)[number];
/** T5 — every register the inspector asks for is built. */
const BUILT: readonly Tab[] = [...TABS];

/**
 * The measured numbers, each with the unit `aerb/units.ts` names for it. 18b's close review found a
 * DAP figure rendered with a unit the tree never declared; nothing here infers one, and a quantity
 * with no number simply does not appear.
 */
function doseText(r: WireDoseRow): string {
  const parts: string[] = [];
  if (r.doseCtdivol !== null) parts.push(`CTDIvol ${r.doseCtdivol} ${DOSE_UNITS.ctdivol ?? ""}`);
  if (r.doseDlp !== null) parts.push(`DLP ${r.doseDlp} ${DOSE_UNITS.dlp ?? ""}`);
  if (r.doseDap !== null) parts.push(`DAP ${r.doseDap} ${DOSE_UNITS.dap ?? ""}`);
  if (r.fluoroSeconds !== null) parts.push(`${String(r.fluoroSeconds)} ${DOSE_UNITS.fluoro_seconds ?? ""}`);
  return parts.join(" · ");
}

function istToday(): string {
  const now = new Date();
  /** The IST calendar day, which is the day the register's windows are compared against. */
  return new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60_000).toISOString().slice(0, 10);
}

export function RadiationSafety(): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("licences");
  const [includeInactive, setIncludeInactive] = useState(false);
  const onDate = istToday();

  const licences = useQuery({
    queryKey: ["aerb", "licences", includeInactive],
    queryFn: () => fetchLicences(includeInactive),
    enabled: tab === "licences",
  });
  const gaps = useQuery({
    queryKey: ["aerb", "gaps", onDate],
    queryFn: () => fetchLicenceGaps(onDate),
    enabled: tab === "licences",
  });
  const qa = useQuery({
    queryKey: ["aerb", "qa"],
    queryFn: fetchQaRecords,
    enabled: tab === "qa",
  });
  const [overDrlOnly, setOverDrlOnly] = useState(false);
  const doses = useQuery({
    queryKey: ["aerb", "doses", overDrlOnly],
    queryFn: () => fetchDoseRegister(overDrlOnly),
    enabled: tab === "dose",
  });
  const badges = useQuery({
    queryKey: ["aerb", "badges"],
    queryFn: fetchBadges,
    enabled: tab === "badges",
  });
  const [calendarIncludeOk, setCalendarIncludeOk] = useState(false);
  const calendar = useQuery({
    queryKey: ["aerb", "calendar", calendarIncludeOk],
    queryFn: () => fetchCalendar(calendarIncludeOk),
    enabled: tab === "calendar",
  });
  const people = useQuery({
    queryKey: ["aerb", "persons"],
    queryFn: fetchAppointments,
    enabled: tab === "people",
  });

  const licenceRows: WireLicence[] = licences.data?.rows ?? [];
  const gapRows: WireLicenceGap[] = gaps.data?.rows ?? [];
  const qaRows: WireQaRecord[] = qa.data?.rows ?? [];
  const doseRows: WireDoseRow[] = doses.data?.rows ?? [];
  const badgeRows: WireBadge[] = badges.data?.rows ?? [];
  const badgeGapRows: WireBadgeGap[] = badges.data?.gaps ?? [];
  const calendarRows: WireCalendarRow[] = calendar.data?.rows ?? [];
  const peopleRows: WireAppointment[] = people.data?.rows ?? [];
  /** A machine sitting in `qa_blocked` is the state the QA tab exists to make impossible to miss. */
  const blockedNow = qaRows.filter((r) => r.deviceStatus === "qa_blocked");

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">{t("aerb.title")}</h1>

      <div className="flex gap-2 flex-wrap" role="tablist" aria-label={t("aerb.tabsLabel")}>
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={k === tab}
            disabled={!BUILT.includes(k)}
            data-testid={`aerb-tab-${k}`}
            className={`border px-3 py-1 text-sm ${k === tab ? "bg-black text-white" : ""} ${BUILT.includes(k) ? "" : "opacity-40"}`}
            onClick={() => { setTab(k); }}
          >
            {t(`aerb.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === "licences"
        ? (
          <section className="space-y-4">
            {/*
              * The gap first, because it is the row that means something is wrong. It is rendered
              * whenever the server sends one — never hidden behind a toggle.
              */}
            {gaps.isError ? <p role="alert" className="text-red-600">{aerbErrorText(gaps.error)}</p> : null}
            {gapRows.length > 0
              ? (
                <div role="alert" data-testid="aerb-gaps" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.gaps.title", { date: onDate })}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {gapRows.map((g) => (
                      <li key={g.deviceResourceId}>
                        {g.code} — {g.name} ({g.modality})
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="aerb-include-inactive"
                checked={includeInactive}
                onChange={(e) => { setIncludeInactive(e.target.checked); }}
              />
              {t("aerb.licences.includeInactive")}
            </label>

            {licences.isError ? <p role="alert" className="text-red-600">{aerbErrorText(licences.error)}</p> : null}
            {licences.isPending ? <p>{t("common.loading")}</p> : null}
            {!licences.isPending && licenceRows.length === 0
              ? <p data-testid="aerb-licences-empty">{t("aerb.licences.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-licences">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.licences.device")}</th>
                      <th>{t("aerb.licences.no")}</th>
                      <th>{t("aerb.licences.type")}</th>
                      <th>{t("aerb.licences.validity")}</th>
                      <th>{t("aerb.licences.rso")}</th>
                      <th>{t("aerb.licences.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {licenceRows.map((l) => (
                      <tr key={l.id} data-testid={`aerb-licence-${l.id}`}>
                        <td>{l.deviceCode} ({l.modality ?? "—"})</td>
                        <td>{l.licenceNo}{l.eloraRef === null ? "" : ` · ${l.eloraRef}`}</td>
                        <td>{t(`aerb.licenceType.${l.licenceType}`)}</td>
                        <td>{l.validFrom} → {l.validTo}</td>
                        <td>{l.rsoName ?? t("aerb.licences.noRso")}</td>
                        <td>{t(`aerb.status.${l.status}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "qa"
        ? (
          <section className="space-y-4">
            {/*
              * The stopped machines first, for the same reason the licence gap comes first: the
              * register's job is to surface the state that must not be missed, and a machine the
              * system has taken out of service is exactly that.
              */}
            {blockedNow.length > 0
              ? (
                <div role="alert" data-testid="aerb-qa-blocked" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.qa.blockedTitle")}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {[...new Set(blockedNow.map((r) => r.deviceCode))].map((code) => <li key={code}>{code}</li>)}
                  </ul>
                </div>
              )
              : null}

            {qa.isError ? <p role="alert" className="text-red-600">{aerbErrorText(qa.error)}</p> : null}
            {qa.isPending ? <p>{t("common.loading")}</p> : null}
            {!qa.isPending && qaRows.length === 0
              ? <p data-testid="aerb-qa-empty">{t("aerb.qa.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-qa">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.licences.device")}</th>
                      <th>{t("aerb.qa.type")}</th>
                      <th>{t("aerb.qa.result")}</th>
                      <th>{t("aerb.qa.performed")}</th>
                      <th>{t("aerb.qa.nextDue")}</th>
                      <th>{t("aerb.qa.effect")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qaRows.map((r) => (
                      <tr key={r.id} data-testid={`aerb-qa-${r.id}`}>
                        <td>{r.deviceCode}</td>
                        <td>{r.qaType}</td>
                        <td>{t(`aerb.qaResult.${r.result}`)}</td>
                        <td>{r.performedOn} · {r.performedBy}</td>
                        <td>{r.nextDueOn ?? "—"}</td>
                        <td>
                          {r.blockApplied
                            ? (r.releasedAt === null ? t("aerb.qa.blocked") : t("aerb.qa.released"))
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "dose"
        ? (
          <section className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="aerb-over-drl-only"
                checked={overDrlOnly}
                onChange={(e) => { setOverDrlOnly(e.target.checked); }}
              />
              {t("aerb.dose.overDrlOnly")}
            </label>

            {doses.isError ? <p role="alert" className="text-red-600">{aerbErrorText(doses.error)}</p> : null}
            {doses.isPending ? <p>{t("common.loading")}</p> : null}
            {!doses.isPending && doseRows.length === 0
              ? <p data-testid="aerb-dose-empty">{t("aerb.dose.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-dose">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.dose.when")}</th>
                      <th>{t("aerb.dose.patient")}</th>
                      <th>{t("aerb.dose.exam")}</th>
                      <th>{t("aerb.dose.dose")}</th>
                      <th>{t("aerb.dose.drl")}</th>
                      <th>{t("aerb.dose.verdict")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doseRows.map((r) => (
                      <tr key={r.id} data-testid={`aerb-dose-${r.id}`}>
                        <td>{r.occurredAt.slice(0, 10)}</td>
                        <td>{r.patientName} · {r.uhid}</td>
                        <td>{r.procedureCode} ({r.modality}){r.deviceCode === null ? "" : ` · ${r.deviceCode}`}</td>
                        <td>{doseText(r)}{r.doseManual ? ` · ${t("aerb.dose.manual")}` : ""}</td>
                        <td>
                          {r.drlValue === null
                            ? "—"
                            : `${r.drlValue} ${DOSE_UNITS[r.drlQuantity ?? ""] ?? ""}`}
                        </td>
                        {/*
                          * THREE states, not two. `null` is "no level published" and must never
                          * render as "within" — that would be a claim of compliance nobody measured.
                          */}
                        <td className={r.overDrl === true ? "text-red-700 font-semibold" : ""}>
                          {r.overDrl === null
                            ? t("aerb.dose.noLevel")
                            : r.overDrl ? t("aerb.dose.over") : t("aerb.dose.under")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "badges"
        ? (
          <section className="space-y-4">
            {/*
              * The badge nobody is reading, first. It is the register's negative space — a person
              * whose occupational exposure is unknown — and a book that listed only the readings it
              * HAS could never show one.
              */}
            {badgeGapRows.length > 0
              ? (
                <div role="alert" data-testid="aerb-badge-gaps" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.badges.gapsTitle")}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {badgeGapRows.map((g) => (
                      <li key={g.badgeId}>
                        {g.userName} · {g.badgeNo} —{" "}
                        {g.lastPeriodEnd === null
                          ? t("aerb.badges.neverRead", { days: g.daysSince })
                          : t("aerb.badges.staleRead", { since: g.lastPeriodEnd, days: g.daysSince })}
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}

            {badges.data !== undefined
              ? (
                <p className="text-sm text-slate-600" data-testid="aerb-badge-limits">
                  {t("aerb.badges.limits", {
                    annual: badges.data.limits.annualMsv,
                    fiveYear: badges.data.limits.fiveYearTotalMsv,
                    level: badges.data.investigationLevelMsvPerMonth,
                  })}
                </p>
              )
              : null}

            {badges.isError ? <p role="alert" className="text-red-600">{aerbErrorText(badges.error)}</p> : null}
            {badges.isPending ? <p>{t("common.loading")}</p> : null}
            {!badges.isPending && badgeRows.length === 0
              ? <p data-testid="aerb-badges-empty">{t("aerb.badges.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-badges">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.badges.worker")}</th>
                      <th>{t("aerb.badges.badge")}</th>
                      <th>{t("aerb.badges.last")}</th>
                      <th>{t("aerb.badges.ytd")}</th>
                      <th>{t("aerb.badges.fiveYear")}</th>
                      <th>{t("aerb.licences.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {badgeRows.map((b) => (
                      <tr key={b.badgeId} data-testid={`aerb-badge-${b.badgeId}`}>
                        <td>{b.userName}</td>
                        <td>{b.badgeNo}</td>
                        <td className={b.lastInvestigation === true ? "text-amber-700 font-semibold" : ""}>
                          {b.lastHp10Msv === null
                            ? t("aerb.badges.noRead")
                            : `${b.lastHp10Msv} mSv · ${b.lastPeriodEnd ?? ""}${b.lastInvestigation === true ? ` · ${t("aerb.badges.investigate")}` : ""}`}
                        </td>
                        <td className={b.overAnnualLimit ? "text-red-700 font-semibold" : ""}>
                          {b.ytdMsv} mSv{b.overAnnualLimit ? ` · ${t("aerb.badges.overLimit")}` : ""}
                        </td>
                        <td className={b.overFiveYearLimit ? "text-red-700 font-semibold" : ""}>
                          {b.fiveYearMsv} mSv{b.overFiveYearLimit ? ` · ${t("aerb.badges.overLimit")}` : ""}
                        </td>
                        <td>{t(`aerb.badgeStatus.${b.status}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "calendar"
        ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-4 print:hidden">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="aerb-calendar-include-ok"
                  checked={calendarIncludeOk}
                  onChange={(e) => { setCalendarIncludeOk(e.target.checked); }}
                />
                {t("aerb.calendar.includeOk")}
              </label>
              {/*
                * D12 — the inspector's file is a PRINT of this list with everything shown, not a
                * separate document rail. One register read two ways; a PDF service would be a
                * second copy of the same rows.
                */}
              <button
                type="button"
                data-testid="aerb-print"
                className="border px-3 py-1 text-sm"
                onClick={() => { setCalendarIncludeOk(true); setTimeout(() => { window.print(); }, 0); }}
              >
                {t("aerb.calendar.print")}
              </button>
            </div>

            <h2 className="hidden print:block font-semibold">
              {t("aerb.calendar.printTitle", { date: onDate })}
            </h2>

            {calendar.isError ? <p role="alert" className="text-red-600">{aerbErrorText(calendar.error)}</p> : null}
            {calendar.isPending ? <p>{t("common.loading")}</p> : null}
            {!calendar.isPending && calendarRows.length === 0
              ? <p data-testid="aerb-calendar-empty">{t("aerb.calendar.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-calendar">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.calendar.what")}</th>
                      <th>{t("aerb.calendar.subject")}</th>
                      <th>{t("aerb.calendar.due")}</th>
                      <th>{t("aerb.calendar.state")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendarRows.map((r) => (
                      <tr key={`${r.kind}-${r.ref}`} data-testid={`aerb-calendar-${r.ref}`}>
                        <td>{t(`aerb.calendar.kind.${r.kind}`)}</td>
                        <td>{r.subject} · {r.detail}</td>
                        <td>{r.dueOn ?? t("aerb.calendar.neverRead")}</td>
                        <td className={r.state === "overdue" ? "text-red-700 font-semibold" : r.state === "due" ? "text-amber-700" : ""}>
                          {r.state === "overdue"
                            ? t("aerb.calendar.overdue", { days: r.daysOverdue })
                            : r.state === "due"
                              ? (r.daysOverdue === 0
                                  ? t("aerb.calendar.dueToday")
                                  : t("aerb.calendar.dueIn", { days: -r.daysOverdue }))
                              : t("aerb.calendar.ok")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "people"
        ? (
          <section className="space-y-2">
            {people.isError ? <p role="alert" className="text-red-600">{aerbErrorText(people.error)}</p> : null}
            {people.isPending ? <p>{t("common.loading")}</p> : null}
            {!people.isPending && peopleRows.length === 0
              ? <p data-testid="aerb-people-empty">{t("aerb.people.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-people">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.people.role")}</th>
                      <th>{t("aerb.people.name")}</th>
                      <th>{t("aerb.people.qualification")}</th>
                      <th>{t("aerb.people.approval")}</th>
                      <th>{t("aerb.licences.validity")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peopleRows.map((p) => (
                      <tr key={p.id} data-testid={`aerb-person-${p.id}`}>
                        <td>{t(`aerb.personRole.${p.personRole}`)}</td>
                        <td>{p.userName}</td>
                        <td>{p.qualification}</td>
                        <td>{p.approvalRef ?? "—"}</td>
                        <td>{p.validFrom} → {p.validTo ?? t("aerb.people.openEnded")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {!BUILT.includes(tab) ? <p>{t("aerb.notYet")}</p> : null}
    </div>
  );
}
