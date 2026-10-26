import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { cleanRefusal, fetchHkSetup, fetchRota, publishRotaApi, saveRotaApi } from "../lib/housekeeping-api";
import type { HkRotaView, HkSetupView, RotaPlaceInput } from "@hmis/contracts";
import "./housekeeping.css";

/**
 * HK-1 (#973) — TEAMS AND ROTA (design board "Supervisor · Teams and allocation"). The supervisor places each person for
 * one shift: on a floor, on a route of areas, or on a section of beds, through three views of the same rota (Floor-wise,
 * Area-wise, Bed-wise). Save keeps a draft; Publish sends each person their own list. There is no fixed headcount: each
 * person's open load shows where the next attendant is needed. Publishing warns about anyone placed without a roster
 * duty in the shift (they get no tasks). A discharge turnover always goes to the floor team, whatever the sections.
 */
type View = "floor" | "area" | "bed";
type Places = Map<string, RotaPlaceInput>;

function placesOf(r: HkRotaView | undefined): Places {
  const m: Places = new Map();
  for (const p of r?.places ?? []) {
    if (p.mode === "floor" && p.floorId !== null) m.set(p.userId, { userId: p.userId, mode: "floor", floorId: p.floorId });
    else if (p.mode === "route") m.set(p.userId, { userId: p.userId, mode: "route", areaIds: p.areaIds });
    else if (p.mode === "beds") m.set(p.userId, { userId: p.userId, mode: "beds", bedIds: p.bedIds });
  }
  return m;
}

export function HkRota(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [shift, setShift] = useState<string | undefined>(undefined);
  const rota = useQuery({ queryKey: ["housekeeping", "rota", shift ?? "now"], queryFn: () => fetchRota(shift) });
  const setup = useQuery({ queryKey: ["housekeeping", "setup"], queryFn: fetchHkSetup, staleTime: 60_000 });
  const [view, setView] = useState<View>("floor");
  const [places, setPlaces] = useState<Places>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bedFloor, setBedFloor] = useState<string>("");
  useEffect(() => { setPlaces(placesOf(rota.data)); }, [rota.data]);

  const s: HkSetupView | undefined = setup.data;
  const floors = useMemo(() => (s?.places ?? []).filter((p) => p.kind === "floor"), [s]);
  const nameOf = useMemo(() => new Map((s?.people ?? []).map((p) => [p.userId, p])), [s]);
  const loadOf = useMemo(() => new Map((rota.data?.places ?? []).map((p) => [p.userId, p.load])), [rota.data]);
  const unplaced = (s?.people ?? []).filter((p) => !places.has(p.userId));
  const r = rota.data;

  const put = (p: RotaPlaceInput | null, userId: string): void => {
    setPlaces((cur) => { const m = new Map(cur); if (p === null) m.delete(userId); else m.set(userId, p); return m; });
  };
  const addArea = (userId: string, areaId: string): void => {
    const cur = places.get(userId);
    const ids = cur?.mode === "route" ? [...new Set([...cur.areaIds, areaId])] : [areaId];
    put({ userId, mode: "route", areaIds: ids }, userId);
  };
  const addBed = (userId: string, bedId: string): void => {
    const cur = places.get(userId);
    const ids = cur?.mode === "beds" ? [...new Set([...cur.bedIds, bedId])] : [bedId];
    put({ userId, mode: "beds", bedIds: ids }, userId);
  };
  const ownerOf = (pred: (p: RotaPlaceInput) => boolean): string => [...places.values()].find(pred)?.userId ?? "";
  const refuse = (e: unknown): void => { const x = cleanRefusal(e); setNotice(x === null ? t("tasks.refusal.failed") : `${x.message} ${x.fix}`.trim()); };

  const save = async (publish: boolean): Promise<void> => {
    if (r === undefined) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await saveRotaApi(r.shiftStartsAt, [...places.values()]);
      const done = publish && saved.id !== null ? await publishRotaApi(saved.id) : saved;
      setNotice(publish ? t("housekeeping.rota.published") : t("housekeeping.rota.saved"));
      qc.setQueryData(["housekeeping", "rota", shift ?? "now"], done);
    } catch (e) { refuse(e); } finally { setBusy(false); }
  };

  const personSelect = (value: string, onPick: (userId: string) => void, label: string): React.ReactElement => (
    <select aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>
      <option value="">{t("housekeeping.rota.nobody")}</option>
      {(s?.people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.company !== "In-house" ? ` · ${p.company}` : ""}</option>)}
    </select>
  );
  const chip = (userId: string): React.ReactElement => {
    const p = nameOf.get(userId);
    return (
      <span key={userId} className="pill" style={{ marginRight: 4 }}>
        {p?.name ?? userId}{p !== undefined && p.company !== "In-house" && <span className="hk-ctr">{t("housekeeping.rota.ctr")}</span>}
        {p !== undefined && p.skills.length > 0 && <span className="hk-ctr">{p.skills.join(" ")}</span>}
        <button type="button" aria-label={t("housekeeping.rota.remove", { name: p?.name ?? "" })} onClick={() => put(null, userId)} style={{ border: 0, background: "none", marginLeft: 4 }}>×</button>
      </span>
    );
  };

  return (
    <PaperScreen testId="hk-rota">
      <div className="hk-page">
        <div className="hk-bar">
          <h1>{t("housekeeping.rota.title")}</h1>
          <div className="hk-seg" role="group" aria-label={t("housekeeping.rota.views")}>
            {(["floor", "area", "bed"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{t(`housekeeping.rota.view.${v}`)}</button>
            ))}
          </div>
          <span style={{ flex: "1 1 auto" }} />
          <button type="button" className="hk-btn" disabled={busy || r === undefined} onClick={() => void save(false)}>{t("housekeeping.rota.save")}</button>
          <button type="button" className="hk-btn pri" disabled={busy || r === undefined} onClick={() => void save(true)}>{t("housekeeping.rota.publish")}</button>
        </div>
        {r !== undefined && (
          <div className="hk-bar">
            <span>{t(`housekeeping.rota.shift.${r.shift}`)} · {t(`housekeeping.rota.status.${r.status}`)}</span>
            <button type="button" className="hk-btn" onClick={() => setShift(undefined)}>{t("housekeeping.rota.thisShift")}</button>
            <button type="button" className="hk-btn" onClick={() => setShift(r.shiftEndsAt)}>{t("housekeeping.rota.nextShift")}</button>
          </div>
        )}
        {notice !== null && <p role="status" className="hk-hint">{notice}</p>}
        {(r?.warnings.length ?? 0) > 0 && (
          <p role="alert" className="hk-hint bad">
            {t("housekeeping.rota.noDuty", { names: r!.warnings.map((w) => nameOf.get(w.userId)?.name ?? w.userId).join(", ") })}
          </p>
        )}
        <div className="hk-bar"><b>{t("housekeeping.rota.unplaced", { count: unplaced.length })}</b>{unplaced.map((p) => <span key={p.userId} className="pill">{p.name}</span>)}</div>

        {view === "floor" && (
          <table className="hk-table">
            <thead><tr><th>{t("housekeeping.rota.col.floor")}</th><th>{t("housekeeping.rota.col.people")}</th><th>{t("housekeeping.rota.col.add")}</th></tr></thead>
            <tbody>
              {floors.map((f) => (
                <tr key={f.id}>
                  <td><b>{f.name}</b></td>
                  <td>{[...places.values()].filter((p) => p.mode === "floor" && p.floorId === f.id).map((p) => chip(p.userId))}</td>
                  <td>{personSelect("", (u) => { if (u !== "") put({ userId: u, mode: "floor", floorId: f.id }, u); }, t("housekeeping.rota.addTo", { place: f.name }))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === "area" && (
          <table className="hk-table">
            <thead><tr><th>{t("housekeeping.rota.col.area")}</th><th>{t("housekeeping.rota.col.class")}</th><th>{t("housekeeping.rota.col.person")}</th></tr></thead>
            <tbody>
              {(s?.areas ?? []).map((a) => {
                const owner = ownerOf((p) => p.mode === "route" && p.areaIds.includes(a.id));
                return (
                  <tr key={a.id}>
                    <td><b>{a.name}</b> <small>{a.floorName ?? ""}</small></td>
                    <td>{t(`housekeeping.class.${a.areaClass}`)}</td>
                    <td>{owner !== "" ? chip(owner) : personSelect("", (u) => { if (u !== "") addArea(u, a.id); }, t("housekeeping.rota.addTo", { place: a.name }))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {view === "bed" && (
          <>
            <div className="hk-form">
              <label>{t("housekeeping.rota.col.floor")}
                <select value={bedFloor} onChange={(e) => setBedFloor(e.target.value)}>
                  <option value="">—</option>
                  {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <span className="sub">{t("housekeeping.rota.bedNote")}</span>
            </div>
            <table className="hk-table">
              <thead><tr><th>{t("housekeeping.rota.col.bed")}</th><th>{t("housekeeping.rota.col.person")}</th></tr></thead>
              <tbody>
                {(s?.beds ?? []).filter((b) => b.floorId === bedFloor).map((b) => {
                  const owner = ownerOf((p) => p.mode === "beds" && p.bedIds.includes(b.id));
                  return (
                    <tr key={b.id}>
                      <td className="mono">{b.code}</td>
                      <td>{owner !== "" ? chip(owner) : personSelect("", (u) => { if (u !== "") addBed(u, b.id); }, t("housekeeping.rota.addTo", { place: b.code }))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        <table className="hk-table">
          <thead><tr><th>{t("housekeeping.rota.col.person")}</th><th>{t("housekeeping.rota.col.company")}</th><th>{t("housekeeping.rota.col.load")}</th></tr></thead>
          <tbody>
            {[...places.keys()].map((u) => (
              <tr key={u}><td>{nameOf.get(u)?.name ?? u}</td><td>{nameOf.get(u)?.company ?? ""}</td><td>{loadOf.get(u) ?? 0}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </PaperScreen>
  );
}
