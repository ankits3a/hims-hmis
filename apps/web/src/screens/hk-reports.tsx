import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  HK_INSPECTION_ITEM_IDS, HK_INSPECT_PASS_PCT, cleanRefusal, fetchConsumables, fetchDaily, fetchFloorStores, fetchInspections, fetchSla,
  istMonthOf, recordInspectionApi, rupees, uploadInspectionPhoto,
} from "../lib/housekeeping-api";
import { photoBase64, readQrFromFile, tokenFromScan } from "../lib/hk-qr";
import type { HkBucket, HkInspectionView } from "@hmis/contracts";
import "./housekeeping.css";

/*
 * HK-2 (#974, decision 0086) — HOUSEKEEPING REPORTS: a floor's shift (rounds, turnarounds, requests, fails, inspections —
 * each count from the tasks behind it), this shift's random inspections (scan the area, score the NABH items, one photo;
 * under 80 % raises rework on the floor team), the month's consumables per floor (what the floor store received, value at
 * the store's cost, cost per occupied bed-day on a ward floor), and the contractor report (company names only, no money).
 */
type Tab = "daily" | "inspections" | "consumables" | "contractors";
const TABS: readonly Tab[] = ["daily", "inspections", "consumables", "contractors"];

export function HkReports(): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("daily");
  return (
    <PaperScreen testId="hk-reports">
      <div className="hk-page">
        <h1>{t("housekeeping.reports.title")}</h1>
        <div role="tablist" className="hk-tabs">
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "hk-btn pri" : "hk-btn"} onClick={() => setTab(k)}>
              {t(`housekeeping.reports.tab.${k}`)}
            </button>
          ))}
        </div>
        {tab === "daily" && <Daily />}
        {tab === "inspections" && <Inspections />}
        {tab === "consumables" && <Consumables />}
        {tab === "contractors" && <Contractors />}
      </div>
    </PaperScreen>
  );
}

function Daily(): React.ReactElement {
  const { t } = useTranslation();
  const floors = useQuery({ queryKey: ["housekeeping", "floor-stores"], queryFn: fetchFloorStores });
  const [floor, setFloor] = useState("");
  const chosen = floor !== "" ? floor : floors.data?.floors[0]?.floorId ?? "";
  const r = useQuery({ queryKey: ["housekeeping", "daily", chosen], queryFn: () => fetchDaily(chosen), enabled: chosen !== "" });
  const d = r.data;
  const line = (label: string, b: HkBucket, extra?: string) => (
    <tr><td>{label}</td><td><b>{b.count}</b>{extra === undefined ? "" : ` · ${extra}`}</td></tr>
  );
  return (
    <section aria-label={t("housekeeping.reports.tab.daily")}>
      <label className="hk-pick" style={{ display: "flex", flexDirection: "column", gap: 4 }}>{t("housekeeping.reports.floor")}
        <select value={chosen} onChange={(e) => setFloor(e.target.value)}>
          {(floors.data?.floors ?? []).map((f) => <option key={f.floorId} value={f.floorId}>{f.floorName}</option>)}
        </select>
      </label>
      {d !== undefined && (
        <table className="hk-table" style={{ marginTop: 8 }} data-testid="hk-daily">
          <caption>{t(`housekeeping.reports.shift.${d.shift}`)}</caption>
          <tbody>
            {line(t("housekeeping.reports.roundsDue"), d.rounds.due)}
            {line(t("housekeeping.reports.roundsDone"), d.rounds.done)}
            {line(t("housekeeping.reports.roundsMissed"), d.rounds.missed)}
            {line(t("housekeeping.reports.turnarounds"), d.turnarounds, d.turnarounds.medianMin === null ? undefined : t("housekeeping.reports.median", { min: d.turnarounds.medianMin }))}
            {line(t("housekeeping.reports.requestsRaised"), d.requests.raised)}
            {line(t("housekeeping.reports.requestsClosed"), d.requests.closed)}
            {line(t("housekeeping.reports.fails"), d.fails)}
            {line(t("housekeeping.reports.rework"), d.rework)}
            {line(t("housekeeping.reports.inspectionsDrawn"), d.inspections.drawn)}
            {line(t("housekeeping.reports.inspectionsPassed"), d.inspections.passed)}
            {line(t("housekeeping.reports.inspectionsFailed"), d.inspections.failed)}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Inspections(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["housekeeping", "inspections"], queryFn: fetchInspections });
  const [open, setOpen] = useState<HkInspectionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = q.data?.inspections ?? [];
  return (
    <section aria-label={t("housekeeping.reports.tab.inspections")}>
      {notice !== null && <p role="status" className="hk-hint">{notice}</p>}
      {list.length === 0 && q.isSuccess && <p className="hk-empty">{t("housekeeping.inspect.none")}</p>}
      <table className="hk-table">
        <tbody>
          {list.map((i) => (
            <tr key={i.id}>
              <td><b>{i.areaName}</b> <small>{i.floorName ?? ""}</small></td>
              <td>{t(`housekeeping.class.${i.areaClass}`)}</td>
              <td>{i.status === "due" ? t("housekeeping.inspect.due") : t(`housekeeping.inspect.${i.status}`, { score: i.scorePct ?? 0 })}</td>
              <td>{i.status === "due" && <button type="button" className="hk-btn pri" onClick={() => { setNotice(null); setOpen(i); }}>{t("housekeeping.inspect.score")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null && <InspectSheet inspection={open} onClose={(msg) => { setOpen(null); setNotice(msg); }} />}
    </section>
  );
}

/** Scan the area's own QR, answer every NABH item, one photo (never a patient), then Save. */
export function InspectSheet({ inspection, onClose }: { inspection: HkInspectionView; onClose: (notice: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [scan, setScan] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const left = HK_INSPECTION_ITEM_IDS.filter((id) => answers[id] === undefined).length;
  const yes = HK_INSPECTION_ITEM_IDS.filter((id) => answers[id] === true).length;
  const ready = scan.trim() !== "" && left === 0 && photoKey !== null;
  const refuse = (e: unknown): void => { const r = cleanRefusal(e); setRefused(r === null ? t("tasks.refusal.failed") : `${r.message} ${r.fix}`.trim()); };
  const readQr = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const text = await readQrFromFile(file).catch(() => null);
    if (text === null) { setRefused(t("housekeeping.work.qrUnread")); return; }
    setRefused(null); setScan(tokenFromScan(text));
  };
  const takePhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setBusy(true);
    try { const p = await photoBase64(file); setPhotoKey((await uploadInspectionPhoto(inspection.id, p.mimeType, p.base64)).photoKey); setRefused(null); }
    catch (e) { refuse(e); } finally { setBusy(false); }
  };
  const save = (): void => {
    setBusy(true);
    recordInspectionApi(inspection.id, tokenFromScan(scan), HK_INSPECTION_ITEM_IDS.map((id) => ({ itemId: id, ok: answers[id]! })), photoKey!).then(
      (r) => {
        setBusy(false);
        void qc.invalidateQueries({ queryKey: ["housekeeping"] });
        onClose(r.status === "passed" ? t("housekeeping.inspect.passed", { score: r.scorePct ?? 0 }) : t("housekeeping.inspect.failedRework", { score: r.scorePct ?? 0 }));
      },
      (e: unknown) => { setBusy(false); refuse(e); },
    );
  };
  return (
    <div className="hk-sheet hk-inspect" data-testid="hk-inspect">
      <b>{inspection.areaName}</b>
      <label className={scan === "" ? "tk-act" : "hk-ghost"} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        {scan === "" ? t("housekeeping.work.scan") : t("housekeeping.work.scanned")}
        <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void readQr(e.target.files?.[0])} />
      </label>
      <div className="hk-scan"><input aria-label={t("housekeeping.work.code")} value={scan} onChange={(e) => setScan(e.target.value)} autoComplete="off" placeholder={t("housekeeping.work.codePlaceholder")} /></div>
      <div className="hk-list">
        {HK_INSPECTION_ITEM_IDS.map((id) => (
          <div key={id} className="hk-ck">
            <span>{t(`housekeeping.inspect.item.${id}`)}</span>
            <button type="button" className="hk-yn yes" aria-pressed={answers[id] === true} aria-label={t("housekeeping.work.yes", { item: t(`housekeeping.inspect.item.${id}`) })}
              onClick={() => setAnswers((a) => ({ ...a, [id]: true }))}>✓</button>
            <button type="button" className="hk-yn no" aria-pressed={answers[id] === false} aria-label={t("housekeeping.work.no", { item: t(`housekeeping.inspect.item.${id}`) })}
              onClick={() => setAnswers((a) => ({ ...a, [id]: false }))}>✕</button>
          </div>
        ))}
      </div>
      <div className="sub">{t("housekeeping.inspect.passMark", { pct: HK_INSPECT_PASS_PCT, yes, total: HK_INSPECTION_ITEM_IDS.length })}</div>
      <label className="hk-ghost" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        {photoKey === null ? t("housekeeping.work.photo") : t("housekeeping.work.photoTaken")}
        <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void takePhoto(e.target.files?.[0])} data-testid="hk-inspect-photo" />
      </label>
      <div className="sub">{t("housekeeping.work.noPatient")}</div>
      {refused !== null && <p role="alert" className="hk-hint bad">{refused}</p>}
      <div className="hk-pf">
        <button type="button" className="hk-btn" onClick={() => onClose(null)}>{t("housekeeping.inspect.cancel")}</button>
        <button type="button" className="hk-btn pri" disabled={!ready || busy} onClick={save}>{t("housekeeping.inspect.save")}</button>
      </div>
    </div>
  );
}

function MonthPick({ month, onChange }: { month: string; onChange: (m: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <label className="hk-pick" style={{ display: "flex", flexDirection: "column", gap: 4 }}>{t("housekeeping.reports.month")}
      <input type="month" value={month} onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(e.target.value); }} />
    </label>
  );
}

function Consumables(): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(istMonthOf(new Date()));
  const q = useQuery({ queryKey: ["housekeeping", "consumables", month], queryFn: () => fetchConsumables(month) });
  return (
    <section aria-label={t("housekeeping.reports.tab.consumables")}>
      <MonthPick month={month} onChange={setMonth} />
      {q.data !== undefined && q.data.floors.length === 0 && <p className="hk-empty">{t("housekeeping.reports.noStores")}</p>}
      {(q.data?.floors ?? []).map((f) => (
        <div key={f.floorId} className="hk-list" style={{ marginTop: 8, padding: "10px 14px" }} data-testid={`hk-cons-${f.floorId}`}>
          <b>{f.floorName}</b> <small>{f.storeName}</small>
          <table className="hk-table">
            <thead><tr><th>{t("housekeeping.reports.item")}</th><th>{t("housekeeping.reports.qty")}</th><th>{t("housekeeping.reports.value")}</th></tr></thead>
            <tbody>
              {f.items.map((i) => <tr key={i.itemId}><td>{i.itemName}</td><td>{i.qty} {i.baseUom}</td><td>{rupees(i.valuePaise)}</td></tr>)}
            </tbody>
          </table>
          <div><b>{t("housekeeping.reports.total", { value: rupees(f.totalPaise) })}</b></div>
          {f.costPerBedDayPaise !== null && (
            <div>{t("housekeeping.reports.perBedDay", { value: rupees(f.costPerBedDayPaise), days: f.occupiedBedDays ?? 0 })}</div>
          )}
        </div>
      ))}
    </section>
  );
}

function Contractors(): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(istMonthOf(new Date()));
  const q = useQuery({ queryKey: ["housekeeping", "sla", month], queryFn: () => fetchSla(month) });
  const dash = (n: number | null, unit = ""): string => (n === null ? "—" : `${String(n)}${unit}`);
  return (
    <section aria-label={t("housekeeping.reports.tab.contractors")}>
      <MonthPick month={month} onChange={setMonth} />
      <p className="sub">{t("housekeeping.reports.reportOnly")}</p>
      <table className="hk-table hk-sla-wide" data-testid="hk-sla">
        <thead>
          <tr>
            <th>{t("housekeeping.reports.company")}</th><th>{t("housekeeping.reports.onTime")}</th><th>{t("housekeeping.reports.late")}</th>
            <th>{t("housekeeping.reports.missed")}</th><th>{t("housekeeping.reports.tat")}</th><th>{t("housekeeping.reports.firstPass")}</th>
            <th>{t("housekeeping.reports.inspectionScore")}</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.rows ?? []).map((r) => (
            <tr key={r.contractorId ?? "in-house"}>
              <td><b>{r.inHouse ? t("housekeeping.setup.inHouse") : r.company}</b></td>
              <td>{r.rounds.onTime}</td><td>{r.rounds.late}</td><td>{r.rounds.missed}</td>
              <td>{dash(r.turnaround.medianMin)} / {dash(r.turnaround.p90Min)}</td>
              <td>{dash(r.firstPass.ratePct, " %")}</td>
              <td>{dash(r.inspections.avgScorePct, " %")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hk-sla-cards" data-testid="hk-sla-cards">
        {(q.data?.rows ?? []).map((r) => (
          <div key={r.contractorId ?? "in-house"} className="hk-sla-card">
            <b>{r.inHouse ? t("housekeeping.setup.inHouse") : r.company}</b>
            <dl>
              <dt>{t("housekeeping.reports.onTime")}</dt><dd>{r.rounds.onTime}</dd>
              <dt>{t("housekeeping.reports.late")}</dt><dd>{r.rounds.late}</dd>
              <dt>{t("housekeeping.reports.missed")}</dt><dd>{r.rounds.missed}</dd>
              <dt>{t("housekeeping.reports.tat")}</dt><dd>{dash(r.turnaround.medianMin)} / {dash(r.turnaround.p90Min)}</dd>
              <dt>{t("housekeeping.reports.firstPass")}</dt><dd>{dash(r.firstPass.ratePct, " %")}</dd>
              <dt>{t("housekeeping.reports.inspectionScore")}</dt><dd>{dash(r.inspections.avgScorePct, " %")}</dd>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
