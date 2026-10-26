import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { PhoneDock, PhoneShell, useCopilotToggles } from "../components/doctor-desk/phone";
import { deskErrorText, fetchWardBeds } from "../lib/doctor-desk-api";
import type { WireWardBed, WireWardBeds } from "../lib/doctor-desk-api";
import { roundQueue } from "../lib/round-queue";
import { clockLine } from "./doctor-desk-now";
import "./doctor-desk-ward.css";

/**
 * ═══ #962 (plan DD-IPD.3) — BEDS, the phone (`docs/design/2026-09-18-doctor-desk/Beds.dc.html`) ═══
 *
 * The unit's beds in WALK ORDER (ward, then bed — the order the round walks), or SICKEST FIRST (the latest early-warning
 * score, highest first). The mark on a bed is PER DOCTOR: something was recorded after MY last round on that patient
 * (IPD's `lastSeenBy`), never "since midnight". The unit's patients lodged in another unit's ward are listed apart,
 * under NOT IN YOUR WARD. Every figure is the server's (`GET /doctor-desk/ward/beds`, IPD's `bedsOf`). Inpatient
 * referrals not yet accepted (the board's second outlier line) are ABSENT until IPD has referrals (plan I15).
 * No money (decision 0058). Light cards (R13).
 */
type T = (k: string, o?: Record<string, unknown>) => string;
type Sort = "walk" | "sick";

const FLAG_RANK: Record<string, number> = { critical: 0, owed: 1, could_go_home: 2, none: 3 };

export function sortBeds(beds: readonly WireWardBed[], sort: Sort): WireWardBed[] {
  if (sort === "walk") return [...beds];
  return [...beds].sort((a, b) =>
    (b.occupant?.ews?.value ?? -1) - (a.occupant?.ews?.value ?? -1)
    || (FLAG_RANK[a.flag] ?? 9) - (FLAG_RANK[b.flag] ?? 9)
    || Number(b.changed === true) - Number(a.changed === true));
}

/**
 * A line before "Show all" (DECIDED): every bed with one of the unit's patients — the round sees every patient, a quiet
 * one says "No change". Free beds and another unit's lodger on an allotted bed fold behind "Show all".
 */
const loud = (b: WireWardBed): boolean => b.occupant !== null;

export function markOf(b: WireWardBed, t: T): { text: string; tone: "red" | "amber" | "green" | "dim" } {
  const parts: string[] = [];
  if (b.flag !== "none") parts.push(t(`doctorDesk.ward.flag.${b.flag}`));
  parts.push(b.changed === true ? t("doctorDesk.ward.changed") : t("doctorDesk.ward.noChange"));
  const tone = b.flag === "critical" ? "red" : b.flag === "owed" || b.changed === true ? "amber" : b.flag === "could_go_home" ? "green" : "dim";
  return { text: parts.join(" · "), tone };
}

export function DoctorDeskBeds(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["doctor-desk", "ward", "beds"], queryFn: fetchWardBeds, refetchInterval: 60_000 });
  const toggles = useCopilotToggles();
  const v = q.data;
  const occupied = v === undefined ? 0 : v.beds.filter((b) => b.status === "occupied").length;
  const title = v === undefined ? "" : v.unit === null ? t("doctorDesk.ward.noUnitTitle") : t("doctorDesk.ward.bedsTitle", { unit: v.unit.short, count: occupied });
  return (
    <PhoneShell
      testId="doctor-desk-beds" title={title} sub={v?.unit === null || v === undefined ? null : t("doctorDesk.ward.marksSince")}
      clock={v === undefined ? "" : clockLine(v.at, i18n.language)} tab="beds"
      dock={<PhoneDock id="ask-beds" placeholder={t("doctorDesk.now.askPlaceholder")} toggles={toggles} />}
    >
      {q.isPending && <p className="ddp-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {v !== undefined && v.unit === null && <div className="ddp-card ddp-empty" data-testid="dd-beds-nounit">{t("doctorDesk.ward.noUnit")}</div>}
      {v !== undefined && v.unit !== null && <Beds v={v} />}
    </PhoneShell>
  );
}

function Beds({ v }: { v: WireWardBeds }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const [sort, setSort] = useState<Sort>("walk");
  const [all, setAll] = useState(false);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    let live = true;
    void roundQueue().list().then((n) => { if (live) setWaiting(n.filter((x) => x.status !== "synced").length); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const go = (e: React.MouseEvent, to: string): void => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to }); };
  const sorted = sortBeds(v.beds, sort);
  const shown = all ? sorted : sorted.filter(loud);
  const quiet = sorted.length - shown.length;
  const first = v.beds.find((b) => b.occupant !== null);
  return (
    <>
      <div className="ddw-sorts" role="group" aria-label={t("doctorDesk.ward.sortLabel")}>
        {(["walk", "sick"] as const).map((k) => (
          <button key={k} type="button" className={`ddw-sort${sort === k ? " ddw-sort-on" : ""}`} aria-pressed={sort === k} data-testid={`dd-beds-sort-${k}`} onClick={() => setSort(k)}>
            {t(`doctorDesk.ward.sort.${k}`)}
          </button>
        ))}
      </div>

      <div className="ddp-list" data-testid="dd-beds-list">
        {shown.length === 0 && <div className="ddp-empty">{t("doctorDesk.ward.allQuiet")}</div>}
        {shown.map((b) => <BedRow key={b.bedId} b={b} onOpen={go} />)}
        {(quiet > 0 || all) && (
          <div className="ddw-more">
            <span>{all ? "" : t("doctorDesk.ward.quietMore", { count: quiet })}</span>
            <button type="button" className="ddp-btn" data-testid="dd-beds-all" onClick={() => setAll((x) => !x)}>
              {all ? t("doctorDesk.ward.showFewer") : t("doctorDesk.ward.showAll", { n: sorted.length })}
            </button>
          </div>
        )}
      </div>

      {v.outliers.length > 0 && (
        <section className="ddw-out" data-testid="dd-beds-outliers">
          <div className="ddp-eyebrow">{t("doctorDesk.ward.notInWard")}</div>
          {v.outliers.map((b) => (
            <a key={b.bedId} href={b.occupant === null ? undefined : `/doctor-desk/round/${b.occupant.admissionId}`} className="ddw-out-line" data-testid={`dd-outlier-${b.bedId}`}
              onClick={(e) => { if (b.occupant !== null) go(e, `/doctor-desk/round/${b.occupant.admissionId}`); }}>
              <span className="ddw-mono">{b.bedCode}</span>
              {" · "}{b.occupant?.patient.name ?? t("doctorDesk.patientSealed")}
              {b.occupant?.ageSex !== null && b.occupant?.ageSex !== undefined ? ` · ${b.occupant.ageSex}` : ""}
              {" · "}{t("doctorDesk.ward.lodgedIn", { unit: v.unit?.short ?? "", ward: b.wardName })}
            </a>
          ))}
        </section>
      )}

      {first?.occupant != null && (
        <a href={`/doctor-desk/round/${first.occupant.admissionId}`} className="ddw-start" data-testid="dd-beds-start" onClick={(e) => go(e, `/doctor-desk/round/${first.occupant!.admissionId}`)}>
          {t("doctorDesk.ward.startAt", { bed: first.bedCode })}
        </a>
      )}
      <div className="ddw-foot">{t("doctorDesk.ward.savedFirst")}</div>
      {waiting > 0 && <div className="ddw-foot ddp-amber" data-testid="dd-beds-waiting">{t("doctorDesk.ward.waitingToSend", { count: waiting })}</div>}
    </>
  );
}

function BedRow({ b, onOpen }: { b: WireWardBed; onOpen: (e: React.MouseEvent, to: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  if (b.occupant === null) {
    return (
      <div className="ddw-bed ddw-bed-quiet" data-testid={`dd-bed-${b.bedId}`} data-flag={b.status === "free" ? "free" : "none"}>
        <span className="ddw-bar ddw-bar-none" />
        <span className="ddw-bed-code">{b.bedCode}</span>
        <span className="ddw-bed-main"><span className="ddw-bed-s">{b.status === "free" ? t("doctorDesk.ward.free") : t("doctorDesk.ward.otherUnit")}</span></span>
      </div>
    );
  }
  const o = b.occupant;
  const mark = markOf(b, t);
  const to = `/doctor-desk/round/${o.admissionId}`;
  const sub = [o.dx, t("doctorDesk.ward.day", { n: o.dayOfStay })].filter((x): x is string => x !== null && x !== "").join(" · ");
  return (
    <a href={to} className="ddw-bed" data-testid={`dd-bed-${b.bedId}`} data-flag={b.flag} data-changed={b.changed === true ? "yes" : "no"} onClick={(e) => onOpen(e, to)}>
      <span className={`ddw-bar ddw-bar-${b.flag}`} />
      <span className="ddw-bed-code">{b.bedCode}</span>
      <span className="ddw-bed-main">
        <span className="ddw-bed-t">{o.patient.name ?? t("doctorDesk.patientSealed")}{o.ageSex !== null && <span className="ddw-bed-age"> · {o.ageSex}</span>}</span>
        {sub !== "" && <span className="ddw-bed-s">{sub}</span>}
        <span className={`ddw-mark ddw-mark-${mark.tone}`} data-testid={`dd-mark-${b.bedId}`}>
          {mark.text}{o.ews !== null ? ` · ${t("doctorDesk.ward.ewsShort", { kind: o.ews.kind.toUpperCase(), v: o.ews.value })}` : ""}
        </span>
      </span>
      <span className="ddw-tags">{o.tags.map((x) => <span key={x} className="ddw-tag">{t(`doctorDesk.ward.tag.${x}`)}</span>)}</span>
    </a>
  );
}
