import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { apiDownload } from "../lib/api";
import { deskErrorText, fetchMyRatings } from "../lib/doctor-desk-api";
import type { WireMyRatings } from "../lib/doctor-desk-api";
import { RATING_MIN_OWN, WORK_RATINGS } from "../../../../packages/contracts/src/doctor-desk";
import "./doctor-desk.css";

/**
 * ═══ DD-1.7 — MY WORK RATINGS: my PG logbook, beside the department's and the hospital's share ═══
 *
 * Owner 2026-10-09 ("my performance vs averages"): a doctor sees their OWN figure beside an anonymous
 * department and hospital AVERAGE — never another person's name, rank or individual figure. Shown
 * neutrally: no red or green, no rank, no arrow. An average appears only above its minimum sample (the
 * server sends null below it, and the screen says the sample is too small). The CSV is my own logbook.
 */
export function DoctorDeskRatings(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const q = useQuery({ queryKey: ["doctor-desk", "ratings"], queryFn: fetchMyRatings });
  const r = q.data;
  return (
    <DoctorDeskFrame
      active="myRatings" testId="doctor-desk-ratings" context={t("doctorDesk.rate.context")}
      who={{ name: username ?? "", role: null }}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {r !== undefined && <Body r={r} />}
    </DoctorDeskFrame>
  );
}

function Share({ testId, label, v }: { testId: string; label: string; v: number | null }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="dd-share" data-testid={testId}>
      <span className="dd-share-v">{v === null ? "—" : `${String(v)}%`}</span>
      <span className="dd-share-k">{label}</span>
      {v === null && <span className="dd-note">{t("doctorDesk.rate.tooFew")}</span>}
    </div>
  );
}

function Body({ r }: { r: WireMyRatings }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <section className="dd-card" data-testid="dd-ratings">
        <div className="dd-card-head">
          <h1 className="dd-h1" style={{ fontSize: 20 }}>{t("doctorDesk.rate.mine", { month: r.month })}</h1>
          <button type="button" className="dd-clock-btn" data-testid="dd-logbook" onClick={() => { void apiDownload("/doctor-desk/ratings/logbook.csv", "pg-logbook.csv"); }}>{t("doctorDesk.rate.logbook")}</button>
        </div>
        <div className="dd-ov" data-testid="dd-rating-counts">
          <div><span className="dd-ov-v">{r.counts.total}</span><span className="dd-ov-k">{t("doctorDesk.rate.total")}</span></div>
          {WORK_RATINGS.map((k) => (
            <div key={k}><span className="dd-ov-v">{r.counts[k]}</span><span className="dd-ov-k">{t(`doctorDesk.rate.r.${k}`)}</span></div>
          ))}
        </div>
        <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.rate.shareTitle")}</h2></div>
        <div className="dd-shares">
          <Share testId="dd-share-you" label={t("doctorDesk.rate.you")} v={r.share.you} />
          <Share testId="dd-share-dept" label={t("doctorDesk.rate.department")} v={r.share.department} />
          <Share testId="dd-share-hosp" label={t("doctorDesk.rate.hospital")} v={r.share.hospital} />
        </div>
        <div className="dd-note">{t("doctorDesk.rate.neutral", { n: RATING_MIN_OWN })}</div>
      </section>
      <section className="dd-card" data-testid="dd-rating-recent">
        <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.rate.recent")}</h2></div>
        {r.recent.length === 0 && <div className="dd-empty">{t("doctorDesk.rate.none")}</div>}
        {r.recent.map((x, i) => (
          <div key={i} className="dd-grid dd-grid-recent">
            <span className="dd-mono">{x.workDate}</span>
            <span>{t("doctorDesk.rate.opdVisit")}</span>
            <span className="dd-strong">{t(`doctorDesk.rate.r.${x.rating}`)}</span>
            <span className="dd-note">{x.reason ?? ""}</span>
          </div>
        ))}
      </section>
    </>
  );
}
