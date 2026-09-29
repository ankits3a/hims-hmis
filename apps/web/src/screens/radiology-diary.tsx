import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import {
  cancelImagingStudy, fetchDeviceDiary, fetchImagingDevices, markNoShow, radiologyErrorCode, radiologyErrorText,
  rescheduleStudy,
} from "../lib/radiology-api";
import type { WireDiaryEntry, WireImagingDevice } from "../lib/radiology-api";
import { RadiologyStation } from "./radiology-station";
import { Refusal, SeatLink, deviceLabel, useNow } from "../components/radiology/imaging-counter";
import { istDay, istInputToIso, isoToIstInput } from "../components/radiology/desk-time";

/**
 * PLAN 18-S RS3 — **THE IMAGING DIARY: every machine × the day's time, on one grid.**
 *
 * Built over the existing `GET /radiology/studies/device/:id/diary` (widened in RS3 with each
 * booking's length, study type, priority and name) and the three desk acts that had zero web
 * callers — reschedule, no-show and cancel. **Each needs a reason**, and the server refuses
 * `reason_required` without one (RS3 made that true in every band), so the screen asks for it
 * before it offers the act.
 *
 * A machine that cannot take bookings — down, QA-blocked, in maintenance, or ionising with no AERB
 * licence today — gets a banner listing its booked studies, because those are the patients the
 * desk has to move.
 *
 * Money: a cancel before the room raises nothing here. Whatever the patient paid is refunded by the
 * billing office's existing refund request (`/billing/refunds/request`), not by this screen; a cancel
 * after the scan started is the room's act, and raises `performed_then_cancelled` there.
 */

const DAY_START_H = 7;
const DAY_END_H = 21;
const PX_PER_MIN = 0.9;
const REASONS = ["asked", "prep", "creatinine", "machine", "doctor", "absent"] as const;

type Block = WireDiaryEntry & { device: WireImagingDevice };

function closedWhy(d: WireImagingDevice): "down" | "not_licensed" | null {
  if (d.status !== "available" && d.status !== "in_use") return "down";
  if (d.ionising && d.licensedNow === false) return "not_licensed";
  return null;
}

const TONE: Record<string, string> = {
  scheduled: "bg-amber-50 border-amber-400",
  checked_in: "bg-orange-50 border-orange-500",
  ready: "bg-green-50 border-green-600",
  in_acquisition: "bg-sky-50 border-sky-600",
};

export function RadiologyDiary(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const qc = useQueryClient();
  const now = useNow();
  const [day, setDay] = useState(() => istDay(Date.now()));
  const [sel, setSel] = useState<string | null>(null);
  const [reasonKey, setReasonKey] = useState("");
  const [reasonOther, setReasonOther] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState<{ deviceResourceId: string; at: string }>({ deviceResourceId: "", at: "" });
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const devicesQ = useQuery({ queryKey: ["radiology", "devices"], queryFn: fetchImagingDevices });
  const devices = useMemo(() => devicesQ.data?.devices ?? [], [devicesQ.data]);
  const diaries = useQueries({
    queries: devices.map((d) => ({ queryKey: ["radiology", "diary", d.id], queryFn: () => fetchDeviceDiary(d.id) })),
  });
  const all: Block[] = devices.flatMap((d, i) => (diaries[i]?.data?.studies ?? []).map((s) => ({ ...s, device: d })));
  const today = all.filter((b) => b.scheduledAt !== null && istDay(b.scheduledAt) === day);
  const selected = all.find((b) => b.studyId === sel) ?? null;

  const reason = reasonKey === "other" ? reasonOther.trim() : reasonKey === "" ? "" : tEn(`radiology.diary.reason.${reasonKey}`);
  const reset = (): void => { setReasonKey(""); setReasonOther(""); setMoving(false); setError(null); };
  const after = (msg: string): void => {
    setDone(msg); reset(); setSel(null);
    void qc.invalidateQueries({ queryKey: ["radiology"] });
  };
  const fail = (e: unknown): void => { setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); };

  const move = useMutation({
    mutationFn: (b: Block) => rescheduleStudy(b.studyId, {
      deviceResourceId: moveTo.deviceResourceId, scheduledAt: istInputToIso(moveTo.at), reason,
    }),
    onSuccess: (_r, b) => after(t("radiology.diary.moved", { acc: b.accessionNo })),
    onError: fail,
  });
  const noShow = useMutation({
    mutationFn: (b: Block) => markNoShow(b.studyId, reason),
    onSuccess: (_r, b) => after(t("radiology.diary.noShowDone", { acc: b.accessionNo })),
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: (b: Block) => cancelImagingStudy(b.studyId, reason),
    onSuccess: (_r, b) => after(t("radiology.diary.cancelled", { acc: b.accessionNo })),
    onError: fail,
  });

  const hours: number[] = [];
  for (let h = DAY_START_H; h <= DAY_END_H; h += 1) hours.push(h);
  const height = (DAY_END_H - DAY_START_H) * 60 * PX_PER_MIN;
  const dayStartMs = new Date(`${day}T${String(DAY_START_H).padStart(2, "0")}:00:00+05:30`).getTime();
  const topOf = (iso: string): number => Math.max(0, (new Date(iso).getTime() - dayStartMs) / 60_000 * PX_PER_MIN);
  const nowTop = (now - dayStartMs) / 60_000 * PX_PER_MIN;

  const closed = devices.map((d) => ({ d, why: closedWhy(d) })).filter((x) => x.why !== null);
  const held = all.filter((b) => closedWhy(b.device) !== null);

  const needs = (
    <section aria-label={t("radiology.diary.needs")}>
      <h2 className="tag m-0 mb-2">{t("radiology.diary.needs")} · {held.length}</h2>
      {held.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.diary.nothingHeld")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {held.map((b) => (
          <li key={b.studyId} data-acc={b.accessionNo}>
            <button type="button" className="w-full rounded border bg-card p-2 text-left text-sm" onClick={() => { setSel(b.studyId); reset(); }}>
              <b>{b.patientName}</b> <span className="text-xs text-muted-foreground">· {b.studyTypeCode} · {b.device.code} · {b.scheduledAt === null ? "—" : `${istDay(b.scheduledAt)} ${fmtIst(b.scheduledAt)}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const busy = move.isPending || noShow.isPending || cancel.isPending;
  const sameKind = selected === null ? [] : devices.filter((d) => d.modality === selected.device.modality && closedWhy(d) === null);
  const deskCanCancel = selected !== null && ["scheduled", "checked_in", "ready"].includes(selected.status);
  const deskCanMove = selected !== null && ["scheduled", "checked_in"].includes(selected.status);

  return (
    <RadiologyStation
      station="diary"
      title={t("radiology.diary.title")}
      place={t("radiology.diary.place")}
      stats={[
        { label: t("radiology.diary.booked"), value: today.length },
        { label: t("radiology.diary.machines"), value: devices.length },
        { label: t("radiology.diary.closedMachines"), value: closed.length, tone: closed.length > 0 ? "danger" : "plain" },
      ]}
      list={needs}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs">
            {t("radiology.diary.day")}
            <input type="date" className="border px-2 py-1 text-sm" value={day} onChange={(e) => { if (e.target.value !== "") setDay(e.target.value); }} />
          </label>
          <div className="flex flex-wrap gap-2 text-xs" aria-label={t("radiology.diary.legend")}>
            {Object.entries(TONE).map(([k, cls]) => (
              <span key={k} className="inline-flex items-center gap-1"><i className={`inline-block h-3 w-3 rounded border ${cls}`} />{t(`radiology.counter.state.${k}`)}</span>
            ))}
          </div>
        </div>

        {closed.filter(({ d }) => all.some((b) => b.device.id === d.id)).map(({ d, why }) => {
          const toMove = all.filter((b) => b.device.id === d.id);
          return (
            <div key={d.id} role="alert" {...(why === "down" ? { "data-down": d.code } : { "data-gap": d.code })} className="rounded border border-red-300 bg-red-50 p-2 text-sm">
              <b>{why === "down" ? t("radiology.diary.downBanner", { machine: d.code, status: d.status }) : t("radiology.diary.unlicensedBanner", { machine: d.code })}</b>
              <p className="m-0 mt-1">
                {t("radiology.diary.toMove", { count: toMove.length, list: toMove.map((b) => `${b.patientName} (${b.scheduledAt === null ? "—" : fmtIst(b.scheduledAt)})`).join(", ") })}
              </p>
              {why === "not_licensed" && <SeatLink to="/radiology/radiation-safety">{t("radiology.counter.fix.licence")}</SeatLink>}
            </div>
          );
        })}
        {closed.some(({ d }) => !all.some((b) => b.device.id === d.id)) && (
          <p className="m-0 text-xs text-muted-foreground" data-testid="diary-closed-quiet">
            {t("radiology.diary.closedQuiet", {
              list: closed.filter(({ d }) => !all.some((b) => b.device.id === d.id))
                .map(({ d, why }) => `${d.code} (${why === "down" ? d.status : t("radiology.diary.badgeUnlicensed")})`).join(", "),
            })}{" "}
            {closed.some(({ d, why }) => why === "not_licensed" && !all.some((b) => b.device.id === d.id)) && (
              <SeatLink to="/radiology/radiation-safety">{t("radiology.counter.fix.licence")}</SeatLink>
            )}
          </p>
        )}

        {done !== null && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm">{done}</p>}

        {selected !== null && (
          <section className="rounded border bg-card p-3 space-y-2" data-acc={selected.accessionNo} data-testid="diary-act">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b>{selected.patientName} · {selected.studyTypeCode}</b>
              <span className="mo text-xs">{selected.accessionNo} · {selected.device.code} · {selected.scheduledAt === null ? "—" : `${istDay(selected.scheduledAt)} ${fmtIst(selected.scheduledAt)}`} · {t(`radiology.counter.state.${selected.status}`)}</span>
            </div>
            {selected.status === "in_acquisition" && <p className="m-0 text-sm">{t("radiology.diary.onTable")}</p>}
            <label className="flex max-w-md flex-col text-xs">
              {t("radiology.diary.reasonLabel")}
              <select className="border px-2 py-1 text-sm" value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} data-testid="diary-reason">
                <option value="">{t("radiology.diary.reasonPick")}</option>
                {REASONS.map((r) => <option key={r} value={r}>{t(`radiology.diary.reason.${r}`)}</option>)}
                <option value="other">{t("radiology.diary.reason.other")}</option>
              </select>
            </label>
            {reasonKey === "other" && (
              <input className="max-w-md border px-2 py-1 text-sm" maxLength={400} value={reasonOther} placeholder={t("radiology.diary.reasonOther")} onChange={(e) => setReasonOther(e.target.value)} />
            )}
            {moving && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 max-w-full flex-col text-xs">
                  {t("radiology.reception.device")}
                  <select className="max-w-full border px-2 py-1 text-sm" value={moveTo.deviceResourceId} onChange={(e) => setMoveTo((m) => ({ ...m, deviceResourceId: e.target.value }))}>
                    <option value="">{t("radiology.reception.devicePick")}</option>
                    {sameKind.map((d) => <option key={d.id} value={d.id}>{deviceLabel(t, d)}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-xs">
                  {t("radiology.counter.timeIst")}
                  <input type="datetime-local" className="border px-2 py-1 text-sm" value={moveTo.at} onChange={(e) => setMoveTo((m) => ({ ...m, at: e.target.value }))} />
                </label>
                <button
                  type="button" className="rounded bg-green-800 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy || reason === "" || moveTo.deviceResourceId === "" || moveTo.at === ""}
                  onClick={() => move.mutate(selected)}
                >
                  {t("radiology.diary.moveHere")}
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button" className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={!deskCanMove || busy}
                onClick={() => {
                  setMoving((m) => !m);
                  setMoveTo({ deviceResourceId: selected.device.id, at: selected.scheduledAt === null ? "" : isoToIstInput(selected.scheduledAt) });
                }}
              >
                {moving ? t("radiology.diary.stopMoving") : t("radiology.diary.move")}
              </button>
              <button type="button" className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={!deskCanMove || busy || reason === ""} onClick={() => noShow.mutate(selected)}>
                {t("radiology.diary.noShow")}
              </button>
              <button type="button" className="rounded border border-red-400 px-3 py-1 text-sm text-red-800 disabled:opacity-50" disabled={!deskCanCancel || busy || reason === ""} onClick={() => cancel.mutate(selected)}>
                {t("radiology.diary.cancel")}
              </button>
              <button type="button" className="px-2 text-sm underline" onClick={() => { setSel(null); reset(); }}>{t("radiology.diary.close")}</button>
            </div>
            {reason === "" && <p className="m-0 text-xs text-muted-foreground">{t("radiology.diary.reasonFirst")}</p>}
            <p className="m-0 text-xs text-muted-foreground" data-testid="refund-note">{t("radiology.diary.refundNote")}</p>
            {error !== null && <Refusal code={error.code} message={error.message} />}
          </section>
        )}
        <div className="overflow-x-auto rounded border bg-card" data-testid="diary-grid">
          <div className="flex" style={{ minWidth: 64 + devices.length * 104 }}>
            <div className="w-16 shrink-0 border-r">
              <div className="h-14 border-b" />
              <div className="relative" style={{ height }}>
                {hours.map((h) => (
                  <span key={h} className="absolute right-1 mo text-[10px] text-muted-foreground" style={{ top: (h - DAY_START_H) * 60 * PX_PER_MIN - 6 }}>
                    {String(h).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
            </div>
            {devices.map((d) => {
              const why = closedWhy(d);
              return (
                <div key={d.id} className="min-w-[104px] flex-1 border-r" data-testid={`diary-col-${d.code}`}>
                  <div className="h-14 overflow-hidden border-b px-2 py-1 text-xs leading-4">
                    <b>{d.code}</b>
                    <div className="truncate text-muted-foreground">{d.room ?? d.name}</div>
                    {why !== null && <span className="whitespace-nowrap rounded bg-red-700 px-1 text-[10px] text-white">{why === "down" ? t("radiology.diary.badgeDown") : t("radiology.diary.badgeUnlicensed")}</span>}
                  </div>
                  <div className="relative" style={{ height }}>
                    {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-dashed" style={{ top: (h - DAY_START_H) * 60 * PX_PER_MIN }} />)}
                    {today.filter((b) => b.device.id === d.id).map((b) => (
                      <button
                        key={b.studyId} type="button"
                        data-acc={b.accessionNo} data-state={b.status}
                        title={`${fmtIst(b.scheduledAt!)} ${b.patientName} · ${b.studyTypeCode}`}
                        className={`absolute inset-x-1 overflow-hidden text-ellipsis whitespace-nowrap rounded border-l-4 border px-1 text-left text-[11px] leading-tight ${TONE[b.status] ?? "bg-muted"} ${b.priority === "stat" ? "ring-2 ring-red-600" : ""} ${sel === b.studyId ? "outline outline-2 outline-black" : ""}`}
                        style={{ top: topOf(b.scheduledAt!), height: Math.max(16, b.durationMin * PX_PER_MIN - 2) }}
                        onClick={() => { setSel(b.studyId); reset(); setDone(null); }}
                      >
                        <b className="mo">{fmtIst(b.scheduledAt!)}</b> {b.patientName}
                      </button>
                    ))}
                    {day === istDay(now) && nowTop > 0 && nowTop < height && (
                      <div className="pointer-events-none absolute inset-x-0 border-t-2 border-red-600" style={{ top: nowTop }} aria-hidden="true" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </RadiologyStation>
  );
}
