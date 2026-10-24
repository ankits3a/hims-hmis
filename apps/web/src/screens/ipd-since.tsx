import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdSinceLine, IpdSinceYesterday } from "@hmis/contracts";
import { getSince, polishSince } from "../lib/ipd-copilot-api";
import { dateLocale } from "../lib/date-locale";

/*
 * E5.3 (#740) — "SINCE YESTERDAY", the first block of the rounds patient page (spec §4.9 E).
 *
 * Four to six lines over what was recorded since the doctor's own last round. Every line carries a source chip; the chip
 * opens the records the line was drawn from. The lines come from the record (the plain read) and are on screen at once;
 * a reworded copy is asked for afterwards and replaces them only if it arrives — the page never waits for it. A line a
 * model reworded says so. A line that needs the doctor first carries a mark AND a word (never colour alone).
 * No money (decision 0058); nothing here orders or doses anything.
 */

const clock = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const dayClock = (iso: string): string =>
  new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

const istDay = (iso: string): number => Math.floor((new Date(iso).getTime() + 330 * 60_000) / 86_400_000);
/**
 * "Since yesterday 09:10" (spec §4.9 E) when the window opens on the previous IST day — the doctor's last round, or the
 * 24 hours before now; "Since 06:50 today" for a round earlier today; the date when it is older. The SERVER's `asOf` is
 * "now" (§4.10 edge 18), never the phone's clock.
 */
function titleKey(s: Pick<IpdSinceYesterday, "since" | "asOf">): string {
  const days = istDay(s.asOf) - istDay(s.since);
  return days === 1 ? "ipdCopilot.since.title" : days <= 0 ? "ipdCopilot.since.titleToday" : "ipdCopilot.since.titleOlder";
}

function Line({ l }: { l: IpdSinceLine }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className={`ipdc-line${l.abnormal ? " abn" : ""}`} data-testid={`ipd-since-line-${l.key}`}>
      <div className="row">
        {l.abnormal ? <span className="mark" aria-hidden="true">▲</span> : null}
        <span className="text">{l.abnormal ? <span className="sr">{t("ipdCopilot.since.attention")} </span> : null}{l.text}</span>
        {l.by === "model" ? <span className="ai" title={t("ipdCopilot.since.aiHint")}>{t("ipdCopilot.since.ai")}</span> : null}
        <button type="button" className="ipdc-chip" aria-expanded={open} disabled={l.records.length === 0} onClick={() => setOpen(!open)}>
          {t(`ipdCopilot.source.${l.source}`)}{l.records.length > 0 ? ` · ${String(l.records.length)}` : ""}
        </button>
      </div>
      {open ? (
        <ul className="ipdc-records" aria-label={t("ipdCopilot.since.records")}>
          {l.records.map((r) => <li key={`${r.id}:${r.label}`}><span className="mono dim">{r.at === null ? "—" : dayClock(r.at)}</span> {r.label}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

export function SinceYesterday({ admissionId }: { admissionId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [s, setS] = useState<IpdSinceYesterday | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setS(null); setFailed(false);
    getSince(admissionId).then((plain) => {
      if (!live) return;
      setS(plain);
      // The reworded copy is optional: it replaces the lines only if it comes back; any failure leaves the plain timeline.
      if (plain.polishable) polishSince(admissionId).then((better) => { if (live) setS(better); }, () => undefined);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [admissionId]);
  if (failed) return <section className="ipdr-panel ipdc-since" aria-label={t("ipdCopilot.since.label")}><p className="dim">{t("ipdCopilot.since.failed")}</p></section>;
  if (s === null) return <section className="ipdr-panel ipdc-since" aria-label={t("ipdCopilot.since.label")}><p className="dim">{t("ipdCopilot.since.loading")}</p></section>;
  return (
    <section className="ipdr-panel ipdc-since" aria-label={t("ipdCopilot.since.label")} data-testid="ipd-since">
      <h2>
        {t(titleKey(s), { time: clock(s.since), day: dayClock(s.since) })}
        <span className={`ipdc-mode ${s.mode}`} data-testid="ipd-since-mode">
          {s.mode === "model" && s.stamp !== null
            ? t("ipdCopilot.since.modeModel", { model: s.stamp.modelId ?? "", version: s.stamp.promptVersion })
            : t("ipdCopilot.since.modeTimeline")}
        </span>
      </h2>
      {s.truncated.length > 0 ? (
        <p className="ipdc-cut" role="alert" data-testid="ipd-since-truncated">⚠ {t("ipdCopilot.truncated", { lists: s.truncated.map((k) => t(`ipdCopilot.list.${k}`, { defaultValue: k })).join(", ") })}</p>
      ) : null}
      <ul className="ipdc-lines">{s.lines.map((l) => <Line key={l.key} l={l} />)}</ul>
    </section>
  );
}
