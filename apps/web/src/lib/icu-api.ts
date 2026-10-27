import { ApiError, api } from "./api";
import type {
  IcuAlarmSeverity, IcuBedView, IcuBundleKind, IcuChartHourView, IcuChartView, IcuDecision, IcuHallSummary, IcuInchargeView,
  IcuLineKind, IcuMyBedsView, IcuNightView, IcuParam, IcuRequestSource, IcuRequestView, IcuStationView, IcuTile, IcuTrendView,
} from "@hmis/contracts";

/* ═══ ICU IC-1 (#984) — `apps/core/src/modules/icu/icu.controller.ts`'s `/icu…`. Reads poll every 5 s on the live screens;
 * every act answers the changed thing. ═══ */

export const ICU_POLL_MS = 5_000;

export const fetchIcuHalls = () => api<IcuHallSummary[]>("GET", "/icu/halls");
export const fetchIcuStation = (hallId: string) => api<IcuStationView>("GET", `/icu/station/${encodeURIComponent(hallId)}`);
export const fetchIcuBed = (admissionId: string) => api<IcuBedView>("GET", `/icu/beds/${encodeURIComponent(admissionId)}`);
export const fetchIcuTrends = (admissionId: string, hours = 24) => api<IcuTrendView>("GET", `/icu/trends/${encodeURIComponent(admissionId)}?hours=${String(hours)}`);
export const fetchIcuChart = (admissionId: string) => api<IcuChartView>("GET", `/icu/chart/${encodeURIComponent(admissionId)}`);
export const fetchIcuMyBeds = () => api<IcuMyBedsView>("GET", "/icu/my-beds");
export const fetchIcuNight = () => api<IcuNightView>("GET", "/icu/night");
export const fetchIcuIncharge = () => api<IcuInchargeView>("GET", "/icu/incharge");
export const fetchIcuRequests = () => api<IcuRequestView[]>("GET", "/icu/requests");

export const raiseIcuRequest = (body: { patientId: string; admissionId?: string; source: IcuRequestSource; priorityClass: number; reason: string; triage: Record<string, number> }) =>
  api<IcuRequestView>("POST", "/icu/requests", body);
export const decideIcuRequest = (requestId: string, body: { decision: IcuDecision; reason: string; monitoring?: string }) =>
  api<IcuRequestView>("POST", `/icu/requests/${encodeURIComponent(requestId)}/decision`, body);

export const ackIcuAlarm = (alarmId: string) => api<{ alarmId: string; state: string; deviceSilenced: false }>("POST", "/icu/alarms/ack", { alarmId });
export const setIcuLimit = (body: { admissionId: string; param: IcuParam; low?: number; high?: number }) =>
  api<{ limitId: string; expiresAt: string }>("POST", "/icu/limits", body);
export const confirmIcuLimitOnMonitor = (limitId: string) => api<{ ok: true }>("POST", `/icu/limits/${encodeURIComponent(limitId)}/on-monitor`, {});

export const prefillIcuHour = (admissionId: string, hourStart: string) => api<IcuChartHourView>("POST", "/icu/chart/prefill", { admissionId, hourStart });
export const signIcuHour = (hourId: string) => api<IcuChartHourView>("POST", "/icu/chart/sign", { hourId });
export const correctIcuValue = (hourId: string, param: IcuParam, value: number, reason: string) =>
  api<IcuChartHourView>("POST", "/icu/chart/correct", { hourId, param, value, reason });
export const enterIcuManualHour = (admissionId: string, hourStart: string, values: Partial<Record<IcuParam, number>>, happenedAt?: string) =>
  api<IcuChartHourView>("POST", "/icu/chart/manual", { admissionId, hourStart, values, ...(happenedAt === undefined ? {} : { happenedAt }) });

export const insertIcuLine = (admissionId: string, kind: IcuLineKind, site: string) => api<{ lineId: string }>("POST", "/icu/lines", { admissionId, kind, site });
export const removeIcuLine = (lineId: string) => api<{ ok: true }>("POST", "/icu/lines/remove", { lineId });
export const startIcuSepsis = (admissionId: string) => api<{ bundleId: string; dueAt: string }>("POST", "/icu/bundles/sepsis", { admissionId });
export const completeIcuBundle = (bundleId: string, checks: string[]) => api<{ ok: true }>("POST", "/icu/bundles/done", { bundleId, checks });
export const logIcuVisit = (body: { admissionId: string; startsAt: string; endsAt: string; visitorName: string; relation: string }) =>
  api<{ visitId: string }>("POST", "/icu/visits", body);
export const logIcuFamilyUpdate = (body: { admissionId: string; summary: string; givenTo: string; relation: string; mode: "in_person" | "phone" | "video" }) =>
  api<{ updateId: string }>("POST", "/icu/family-updates", body);
export const linkIcuDevice = (deviceScan: string, bandScan: string) =>
  api<{ linkId: string; deviceType: string; bedId: string }>("POST", "/icu/devices/link", { deviceScan, bandScan });
export const unlinkIcuDevice = (deviceScan: string) => api<{ linkId: string }>("POST", "/icu/devices/unlink", { deviceScan });

/** The refusal code an ICU door answered with, or null. The screen shows `icu.refusal.<code>`. */
export function icuRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/* The web imports only TYPES from `@hmis/contracts`, so the few numbers the screens need are repeated here. */
export const ICU_PARAM_ORDER: readonly IcuParam[] = ["hr", "spo2", "nibp_sys", "nibp_dia", "nibp_map", "abp_sys", "abp_dia", "abp_map", "rr", "temp", "etco2", "cvp", "vt", "peep", "fio2", "ppeak"];
export const ICU_CHART_ENTRY: readonly IcuParam[] = ["hr", "spo2", "nibp_sys", "nibp_dia", "rr", "temp"];
export const ICU_BUNDLE_ORDER: readonly IcuBundleKind[] = ["sepsis_hour1", "ventilator", "central_line", "catheter", "dvt", "pressure"];
const HOUR = 3_600_000;
const IST = 5.5 * HOUR;
/** The IST hour mark at or before `ms`, as an ISO instant. */
export const istHourOf = (ms: number): string => new Date(Math.floor((ms + IST) / HOUR) * HOUR - IST).toISOString();
/** "14:00" in IST. */
export const istHHMM = (iso: string): string => new Date(Date.parse(iso) + IST).toISOString().slice(11, 16);

export const severityRank = (s: IcuAlarmSeverity): number => ["life_threatening", "high", "medium", "low", "advisory"].indexOf(s);

/** Blood pressure as the tile shows it: "104/58 (73)" from whichever source (arterial first). */
export function bpOf(t: Pick<IcuTile, "latest">): { label: "ABP" | "NIBP"; text: string; sysDia: string; map: number | null } | null {
  const l = t.latest;
  for (const [label, sys, dia, map] of [["ABP", "abp_sys", "abp_dia", "abp_map"], ["NIBP", "nibp_sys", "nibp_dia", "nibp_map"]] as const) {
    if (l[sys] !== undefined) {
      const m = l[map]?.value ?? null;
      const sysDia = `${String(Math.round(l[sys].value))}/${l[dia] === undefined ? "–" : String(Math.round(l[dia].value))}`;
      return { label, sysDia, text: `${sysDia}${m === null ? "" : ` (${String(Math.round(m))})`}`, map: m };
    }
  }
  return null;
}

export const num = (v: number | undefined | null, digits = 0): string => (v === undefined || v === null ? "—" : v.toFixed(digits));
/** A charted value as a nurse writes it: whole numbers bare, others to one decimal. */
export const chartNum = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
