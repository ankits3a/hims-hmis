import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdShiftMapView, IpdWardCockpit } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import {
  copyShiftMap, getCockpit, getShiftMap, nextShift, publishShiftMap, saveShiftMap, shiftAt, wardErrorOf,
} from "../lib/ipd-ward-api";
import type { NurseShift, StaffKind, WardError } from "../lib/ipd-ward-api";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import { WardDeskHeader } from "./ipd-ward-cockpit";
import "./ipd-nursing.css";
import "./ipd-ward-desk.css";

/**
 * WM-1 (#982, decision 0089) — SHIFT ASSIGNMENT, the in-charge's desk screen (1440; board "Shift assignment"). One
 * column per nurse on the shift: her beds and her load (acuity points); the occupied beds nobody holds sit in their own
 * column. Pick a bed, then "Take" under a nurse. "Same as last shift" copies the last live map; Publish refuses while an
 * occupied bed has no registered nurse or a student is a bed's only nurse (the server says which beds). A live map is
 * read here and changed bed by bed on the cockpit (a reason, both nurses told).
 */

type Staff = { userId: string; kind: StaffKind; pairedWithId: string | null };
type Rows = Record<string, string>; // bedId → nurseId

export function IpdWardAssign({ ward }: { ward?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const pick = useWardChoice(ward ?? null);
  const [cockpit, setCockpit] = useState<IpdWardCockpit | null>(null);
  const [which, setWhich] = useState<"this" | "next">("next");
  const [map, setMap] = useState<IpdShiftMapView | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<Rows>({});
  const [sel, setSel] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WardError | "forbidden" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slot = useMemo(() => {
    const now = shiftAt(new Date());
    return which === "this" ? now : nextShift(now);
  }, [which]);

  const load = useCallback(async () => {
    try {
      const c = await getCockpit(pick.wardId);
      setCockpit(c);
      if (c.ward === null) return;
      const m = await getShiftMap(c.ward.id, slot.date, slot.key);
      setMap(m);
      setStaff(m.staff.map((s) => ({ userId: s.userId, kind: s.kind, pairedWithId: s.pairedWithId })));
      setRows(Object.fromEntries(m.beds.map((b) => [b.bedId, b.nurseId])));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setErr("forbidden");
      else throw e;
    }
  }, [pick.wardId, slot.date, slot.key]);
  useEffect(() => { void load(); }, [load]);

  if (err === "forbidden") return <main className="ipdn ipdw" role="alert">{t("ipdWard.forbidden")}</main>;
  if (cockpit !== null && pick.needsPick(cockpit.wards)) {
    return (
      <main className="ipdn ipdw" data-testid="ipd-ward-assign">
        <WardPicker wards={cockpit.wards} value={null} onChange={pick.choose} />
        <PickWardPrompt className="ipdw-empty" />
      </main>
    );
  }
  if (cockpit === null || cockpit.ward === null || map === null) return <main className="ipdn ipdw" aria-busy="true" data-testid="ipd-ward-assign">{t("ipdWard.loading")}</main>;

  const live = map.status === "published" || map.status === "carried_over";
  const nameOf = (id: string): string => cockpit.candidates.find((c) => c.userId === id)?.name ?? cockpit.staff.find((s) => s.userId === id)?.name ?? id;
  const initialsOf = (id: string): string => cockpit.candidates.find((c) => c.userId === id)?.initials ?? cockpit.staff.find((s) => s.userId === id)?.initials ?? "—";
  const occupied = cockpit.beds.filter((b) => b.admissionId !== null);
  const pointsOf = (bedId: string): number => cockpit.beds.find((b) => b.bedId === bedId)?.acuity?.points ?? 1;
  const codeOf = (bedId: string): string => cockpit.beds.find((b) => b.bedId === bedId)?.code ?? t("ipdWard.bed");
  const nurses = staff.filter((s) => s.kind !== "student");
  const students = staff.filter((s) => s.kind === "student");
  const unassigned = occupied.filter((b) => rows[b.bedId] === undefined);
  const ratioNeeded = Math.ceil(occupied.length / cockpit.ratio.patientsPerRn);
  const rnCount = staff.filter((s) => s.kind === "rn" || s.kind === "float").length;
  const unpaired = students.filter((s) => s.pairedWithId === null || !nurses.some((n) => n.userId === s.pairedWithId));

  const take = (nurseId: string): void => {
    if (sel === null || live) return;
    setRows({ ...rows, [sel]: nurseId });
    setSel(null);
  };
  const addStaff = (): void => {
    const c = cockpit.candidates.find((x) => x.userId === add);
    if (c === undefined || staff.some((s) => s.userId === c.userId)) return;
    setStaff([...staff, { userId: c.userId, kind: c.kind === "student" ? "student" : c.kind === "incharge" ? "incharge" : "rn", pairedWithId: null }]);
    setAdd("");
  };
  const removeStaff = (userId: string): void => {
    setStaff(staff.filter((s) => s.userId !== userId).map((s) => (s.pairedWithId === userId ? { ...s, pairedWithId: null } : s)));
    setRows(Object.fromEntries(Object.entries(rows).filter(([, n]) => n !== userId)));
  };
  const draft = () => ({
    wardId: cockpit.ward!.id, shiftDate: slot.date, shift: slot.key as NurseShift,
    staff: staff.map((s) => ({ userId: s.userId, kind: s.kind, ...(s.kind === "student" && s.pairedWithId !== null ? { pairedWithId: s.pairedWithId } : {}) })),
    beds: Object.entries(rows).map(([bedId, nurseId]) => {
      const student = students.find((s) => s.pairedWithId === nurseId);
      return { bedId, nurseId, ...(student === undefined ? {} : { studentId: student.userId }) };
    }),
  });
  const act = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true); setErr(null); setNotice(null);
    try { setNotice(await work()); await load(); } catch (e) { const w = wardErrorOf(e); if (w === null) throw e; setErr(w); } finally { setBusy(false); }
  };
  const save = (): Promise<void> => act(async () => { await saveShiftMap(draft()); return t("ipdWard.assign.saved"); });
  const publish = (): Promise<void> => act(async () => {
    const d = await saveShiftMap(draft());
    const p = await publishShiftMap(d.mapId);
    return p.late ? t("ipdWard.assign.publishedLate") : t("ipdWard.assign.published");
  });
  const same = (): Promise<void> => act(async () => {
    const c = await copyShiftMap(cockpit.ward!.id, slot.date, slot.key);
    return c.copiedFrom === null ? t("ipdWard.assign.nothingToCopy") : t("ipdWard.assign.copied");
  });

  const chip = (bedId: string): React.ReactElement => (
    <button key={bedId} type="button" className={`ipdw-chip${sel === bedId ? " sel" : ""}`} aria-pressed={sel === bedId} disabled={live} onClick={() => setSel(sel === bedId ? null : bedId)} data-testid={`ipdw-chip-${bedId}`}>
      <b>{codeOf(bedId)}</b><span className="mono">{pointsOf(bedId) === 1 ? "" : `×${String(pointsOf(bedId))}`}</span>
    </button>
  );

  return (
    <main className="ipdn ipdw" data-testid="ipd-ward-assign">
      <WardDeskHeader cockpit={cockpit} active="assign" onPick={pick.choose} />
      <div className="ipdw-body">
        <div className="ipdw-bar">
          <h1>{t("ipdWard.assign.title")}</h1>
          <div className="ipdw-seg" role="group" aria-label={t("ipdWard.assign.which")}>
            <button type="button" className="ipdn-btn sm" aria-pressed={which === "this"} onClick={() => setWhich("this")}>{t("ipdWard.assign.thisShift")}</button>
            <button type="button" className="ipdn-btn sm" aria-pressed={which === "next"} onClick={() => setWhich("next")}>{t("ipdWard.assign.nextShift")}</button>
          </div>
          <span className="mono dim">{t(`ipdNursing.shift.${slot.key}`)} · {slot.date} · {map.status === null ? t("ipdWard.assign.noMap") : t(`ipdWard.status.${map.status}`)}</span>
          <span className="grow" />
          <span className="mono">{sel === null ? t("ipdWard.assign.noSelection") : t("ipdWard.assign.selected", { bed: codeOf(sel) })}</span>
          <button type="button" className="ipdn-btn sm" disabled={busy || live} onClick={() => void same()} data-testid="ipdw-same">{t("ipdWard.assign.same")}</button>
          <button type="button" className="ipdn-btn sm" disabled={busy || live} onClick={() => void save()}>{t("ipdWard.assign.save")}</button>
          <button type="button" className="ipdn-btn pri" disabled={busy || live} onClick={() => void publish()} data-testid="ipdw-publish">{t("ipdWard.assign.publish")}</button>
        </div>
        {live ? <p className="ipdn-warn" role="status">{t("ipdWard.assign.liveNote")}</p> : null}
        {err !== null ? (
          <div className="ipdn-refusal" role="alert" data-testid="ipdw-error">
            {t(`ipdWard.err.${err.code}`, { defaultValue: t("ipdWard.err.other") })}
            {err.bedIds.length > 0 ? ` · ${err.bedIds.map(codeOf).join(", ")}` : ""}
          </div>
        ) : null}
        {notice !== null ? <p className="ipdn-ok" role="status">{notice}</p> : null}
        <div className="ipdw-grid">
          <section className="ipdw-col red" aria-label={t("ipdWard.assign.unassigned")}>
            <header><b>{t("ipdWard.assign.unassigned")}</b><span className="mono">{t("ipdWard.beds", { count: unassigned.length })}</span></header>
            {unassigned.map((b) => chip(b.bedId))}
          </section>
          {nurses.map((n) => {
            const mine = Object.entries(rows).filter(([, id]) => id === n.userId).map(([bedId]) => bedId).sort((x, y) => codeOf(x).localeCompare(codeOf(y), undefined, { numeric: true }));
            const load = mine.reduce((s, b) => s + pointsOf(b), 0);
            const student = students.find((s) => s.pairedWithId === n.userId);
            const over = load > 1.5 * cockpit.ratio.patientsPerRn;
            return (
              <section key={n.userId} className="ipdw-col" data-testid={`ipdw-nurse-${n.userId}`}>
                <header>
                  <b>{nameOf(n.userId)}</b>
                  <span className="mono dim">{t(`ipdWard.kind.${n.kind}`)}{student === undefined ? "" : ` + ${initialsOf(student.userId)}`}</span>
                  <span className={`mono${over ? " hot" : ""}`}>{t("ipdWard.assign.load", { points: load, count: mine.length })}</span>
                </header>
                {mine.map(chip)}
                <button type="button" className="ipdw-take" disabled={sel === null || live} onClick={() => take(n.userId)}>{t("ipdWard.assign.take")}</button>
                {live ? null : <button type="button" className="ipdn-btn sm ipdw-remove" onClick={() => removeStaff(n.userId)}>{t("ipdWard.assign.remove")}</button>}
              </section>
            );
          })}
          <aside className="ipdw-side">
            <div className="ipdw-box" data-testid="ipdw-checks">
              <b>{t("ipdWard.assign.checks")}</b>
              <span className={unassigned.length > 0 ? "hot" : "ok"}>{unassigned.length > 0 ? `✕ ${t("ipdWard.assign.checkUnassigned", { beds: unassigned.map((b) => b.code ?? t("ipdWard.bed")).join(", ") })}` : `✓ ${t("ipdWard.assign.checkAllNamed")}`}</span>
              <span className={unpaired.length > 0 ? "hot" : "ok"}>{unpaired.length > 0 ? `✕ ${t("ipdWard.assign.checkUnpaired")}` : `✓ ${t("ipdWard.assign.checkPaired")}`}</span>
              <span className={rnCount < ratioNeeded ? "hot" : "ok"}>{rnCount < ratioNeeded ? `✕ ${t("ipdWard.assign.checkRatio", { have: rnCount, need: ratioNeeded })}` : `✓ ${t("ipdWard.assign.checkRatioOk")}`}</span>
            </div>
            {live ? null : (
              <div className="ipdw-box">
                <b>{t("ipdWard.assign.staff")}</b>
                {cockpit.rosterFallback ? <span className="warn">⚠ {t("ipdWard.assign.rosterFallback")}</span> : null}
                <label className="ipdw-add">
                  <span className="sr">{t("ipdWard.assign.addNurse")}</span>
                  <select value={add} onChange={(e) => setAdd(e.target.value)} data-testid="ipdw-add">
                    <option value="">{t("ipdWard.assign.addNurse")}</option>
                    {cockpit.candidates.filter((c) => !staff.some((s) => s.userId === c.userId)).map((c) => (
                      <option key={c.userId} value={c.userId}>{c.name} · {t(`ipdWard.kind.${c.kind}`)}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="ipdn-btn sm" disabled={add === ""} onClick={addStaff}>{t("ipdWard.assign.add")}</button>
                {students.map((s) => (
                  <label key={s.userId} className="ipdw-pair">
                    <span>{nameOf(s.userId)} · {t("ipdWard.kind.student")}</span>
                    <select value={s.pairedWithId ?? ""} onChange={(e) => setStaff(staff.map((x) => (x.userId === s.userId ? { ...x, pairedWithId: e.target.value === "" ? null : e.target.value } : x)))}>
                      <option value="">{t("ipdWard.assign.pairWith")}</option>
                      {nurses.map((n) => <option key={n.userId} value={n.userId}>{nameOf(n.userId)}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <div className="ipdw-box dim">{t("ipdWard.assign.help")}</div>
          </aside>
        </div>
      </div>
    </main>
  );
}
