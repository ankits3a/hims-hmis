import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { fetchAebasTodo, markAebasEntered, rosterErrorText } from "../lib/roster-api";
import type { WireAebasItem, WireAebasTodo } from "../lib/roster-api";
import { whoFrom } from "./roster-on-now";
import "./roster.css";

/**
 * ═══ 20-U U8b — THE AEBAS TO-DO LIST (plan §2.2) ═══
 *
 * For the college's AEBAS nodal officer. AEBAS takes leave, tours and holidays IN ADVANCE ONLY
 * (notice 18.06.2024), so every item the roster approves is due the day before it begins. Three
 * groups, in the order a person acts on them: ENTER TODAY, the ones whose first day has passed (AEBAS
 * will not take them; shown so nothing slips silently), and COMING UP by due day. One tap — "Entered
 * in AEBAS" — records that a person entered it, and the item leaves the list. The rail keeps the last
 * week's marks so the tap can be seen to have landed.
 *
 * **HMIS never talks to AEBAS.** The screen says so; nothing here sends anything anywhere.
 * The leave's reason is never on the wire (`aebas.ts` does not select it); the kind is, because AEBAS
 * asks for it.
 */

type T = (k: string, o?: Record<string, unknown>) => string;

/** `2026-11-10` → `10-11-2026` (owner 2026-10-03: DD-MM-YYYY everywhere a person reads a day). */
export const dmy = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

export function aebasWhat(i: WireAebasItem, t: T): string {
  return t(`rosterAebas.what.${i.what}`, { defaultValue: i.what });
}

function Item({ i, today, busy, onMark }: { i: WireAebasItem; today: string; busy: boolean; onMark?: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const days = t("rosterAebas.days", { count: i.firstDay === i.lastDay ? 1 : 2, from: dmy(i.firstDay), to: dmy(i.lastDay) });
  return (
    <div className={`ab-item ab-${i.state}`} data-testid={`aebas-item-${i.key}`} data-state={i.state}>
      <div className="ab-item-body">
        <span className="ab-who">{i.person === null ? t("rosterAebas.holiday") : i.person.name}</span>
        <span className="ab-what">
          {[aebasWhat(i, t), i.person?.departmentName ?? null].filter((x): x is string => x !== null && x !== "").join(" · ")}
        </span>
        <span className="ab-days mo">{days}</span>
      </div>
      <div className="ab-item-side">
        {i.state !== "missed" && (
          <span className="ab-due">{i.dueDay <= today ? t("rosterAebas.dueByToday") : t("rosterAebas.dueBy", { day: dmy(i.dueDay) })}</span>
        )}
        {onMark !== undefined && (
          <button type="button" className={i.state === "due_today" ? "ddf-btn ddf-btn-pri ab-mark" : "ddf-btn ab-mark"} disabled={busy} onClick={onMark} data-testid={`aebas-mark-${i.key}`}>
            {t("rosterAebas.mark")}
          </button>
        )}
      </div>
    </div>
  );
}

export function RosterAebas(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const qc = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["roster", "aebas"], queryFn: fetchAebasTodo, refetchInterval: 120_000 });
  const mark = useMutation({
    mutationFn: (key: string) => markAebasEntered(key),
    onSuccess: (next: WireAebasTodo) => {
      setRefusal(null);
      qc.setQueryData(["roster", "aebas"], (old: (WireAebasTodo & { you: unknown }) | undefined) => (old === undefined ? old : { ...old, ...next }));
    },
    onError: (e) => setRefusal(rosterErrorText(e, t)),
  });
  const d = q.data;
  const due = d?.items.filter((i) => i.state === "due_today") ?? [];
  const missed = d?.items.filter((i) => i.state === "missed") ?? [];
  const upcoming = d?.items.filter((i) => i.state === "upcoming") ?? [];
  const busy = mark.isPending;

  const rail = d === undefined ? undefined : (
    <>
      <section className="ddf-card ro-rail-card" data-testid="aebas-entered">
        <h2 className="ro-rail-h">{t("rosterAebas.enteredTitle")}</h2>
        {d.recentlyEntered.length === 0 && <p className="ro-rail-p ddf-dim">{t("rosterAebas.enteredNone")}</p>}
        {d.recentlyEntered.map((i) => (
          <div key={i.key} className="ab-done">
            <span className="ab-done-who">{i.person === null ? t("rosterAebas.holiday") : i.person.name}</span>
            <span className="ro-small">{`${aebasWhat(i, t)} · ${dmy(i.firstDay)}`}</span>
          </div>
        ))}
      </section>
      <section className="ddf-card ro-rail-card">
        <h2 className="ro-rail-h">{t("rosterAebas.howTitle")}</h2>
        <p className="ro-rail-p">{t("rosterAebas.how1")}</p>
        <p className="ro-rail-p">{t("rosterAebas.how2")}</p>
        <p className="ro-rail-p">{t("rosterAebas.how3")}</p>
      </section>
    </>
  );

  return (
    <DoctorDeskFrame
      active="aebas" testId="roster-aebas"
      context={t("rosterAebas.context")}
      pill={d === undefined ? undefined : { tag: t("rosterAebas.pillTag"), text: t("rosterAebas.pill", { count: due.length }) }}
      who={whoFrom(d?.you, username, t)}
      rail={rail}
      ask={<AskBar id="aebas-ask" placeholder={t("rosterAebas.ask")} fallback={() => null} terms={() => (d?.items ?? []).flatMap((i) => (i.person === null ? [] : [i.person.name]))} />}
    >
      <div className="ro-title">
        <div className="ro-title-text">
          <h1 className="ddf-h1">{t("rosterAebas.title")}</h1>
          <span className="ddf-dim ev-intro">{t("rosterAebas.intro")}</span>
        </div>
      </div>
      {q.isPending && <p className="ddf-dim">{t("rosterAebas.loading")}</p>}
      {q.isError && <p role="alert" className="ro-alert">{rosterErrorText(q.error, t)}</p>}
      {refusal !== null && <p role="alert" className="ro-alert" data-testid="aebas-error">{refusal}</p>}

      {d !== undefined && d.items.length === 0 && <p className="ro-hole ro-hole-ok" data-testid="aebas-empty">{t("rosterAebas.empty")}</p>}

      {due.length > 0 && (
        <section className="ddf-card-strong ab-group ab-group-due" aria-labelledby="ab-due-h" data-testid="aebas-due">
          <div className="ab-group-head">
            <h2 id="ab-due-h" className="ab-h">{t("rosterAebas.dueToday")}</h2>
            <span className="ro-small">{t("rosterAebas.dueTodaySub")}</span>
          </div>
          {due.map((i) => <Item key={i.key} i={i} today={d!.today} busy={busy} onMark={() => mark.mutate(i.key)} />)}
        </section>
      )}
      {missed.length > 0 && (
        <section className="ddf-card ab-group ab-group-missed" aria-labelledby="ab-missed-h" data-testid="aebas-missed">
          <div className="ab-group-head">
            <h2 id="ab-missed-h" className="ab-h">{t("rosterAebas.missed")}</h2>
            <span className="ro-small">{t("rosterAebas.missedSub")}</span>
          </div>
          {missed.map((i) => <Item key={i.key} i={i} today={d!.today} busy={busy} onMark={() => mark.mutate(i.key)} />)}
        </section>
      )}
      {upcoming.length > 0 && (
        <section className="ddf-card ab-group" aria-labelledby="ab-up-h" data-testid="aebas-upcoming">
          <div className="ab-group-head">
            <h2 id="ab-up-h" className="ab-h">{t("rosterAebas.upcoming")}</h2>
            <span className="ro-small">{t("rosterAebas.upcomingSub")}</span>
          </div>
          {upcoming.map((i) => <Item key={i.key} i={i} today={d!.today} busy={busy} onMark={() => mark.mutate(i.key)} />)}
        </section>
      )}
    </DoctorDeskFrame>
  );
}
