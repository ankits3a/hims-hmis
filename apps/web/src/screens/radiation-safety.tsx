import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { aerbErrorText, fetchAppointments, fetchLicenceGaps, fetchLicences, fetchQaRecords } from "../lib/aerb-api";
import type { WireAppointment, WireLicence, WireLicenceGap, WireQaRecord } from "../lib/aerb-api";

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
 * The tabs Dose, Badges and Calendar arrive with T3, T4 and T5. They are declared here as disabled
 * rather than absent so that the screen's shape is the register's shape from the first commit, and
 * so a reader can see what is coming without reading the phase document.
 */
const TABS = ["licences", "people", "qa", "dose", "badges", "calendar"] as const;
type Tab = (typeof TABS)[number];
const BUILT: readonly Tab[] = ["licences", "people", "qa"];

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
  const people = useQuery({
    queryKey: ["aerb", "persons"],
    queryFn: fetchAppointments,
    enabled: tab === "people",
  });

  const licenceRows: WireLicence[] = licences.data?.rows ?? [];
  const gapRows: WireLicenceGap[] = gaps.data?.rows ?? [];
  const qaRows: WireQaRecord[] = qa.data?.rows ?? [];
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
