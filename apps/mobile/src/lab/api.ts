import { ApiError, NetworkError } from "../api";
import type { LabMode } from "../seats";
import type { AstBlock, AstDraftRow } from "../../../../packages/contracts/src/lab-ast";

/**
 * QUICK LAB ON THE PHONE (spec 2026-10-12) — the wire contract of `lab-quick.controller.ts`, copied
 * from the web's `apps/web/src/lib/lab-quick-api.ts` (only what the three phone screens read). Same
 * routes, same server guards: nothing is decided on the phone. `previewFlag` is the server's
 * `flagFor`, line for line, so the colour while typing and the saved flag agree.
 */
export type Call = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T>;

export type QuickAnalyte = {
  analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
  decimals: number; absurdLow: string | null; absurdHigh: string | null;
  formula?: string | null; formulaGuard?: string | null;
};
export type QuickTest = { serviceId: string; code: string; nameEn: string; analyteIds: string[] };
export type QuickCatalogue = { tests: QuickTest[]; analytes: QuickAnalyte[] };
export type QuickRange = {
  analyteId: string; low: string | null; high: string | null; text: string | null;
  criticalLow: string | null; criticalHigh: string | null; note: string | null;
};
export type QuickFlag = "L" | "H" | "LL" | "HH" | "N" | null;
export type QuickLine = {
  analyteId: string; code: string; nameEn: string; unit: string | null;
  value: string; low: string | null; high: string | null; refText: string | null; flag: QuickFlag;
};
export type QuickChosenTest = { serviceId: string; code: string; nameEn: string };
export type QuickPatient = { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null };
export type QuickRow = {
  id: string; status: "waiting" | "draft" | "reported"; patient: QuickPatient; encounterNo: string | null;
  tests: QuickChosenTest[]; collectedAt: string; collectedBy: string;
  reportedAt: string | null; reportedBy: string | null;
  orderId?: string | null; orderNo?: string | null; sampleNo?: string | null;
  handedOverAt?: string | null; handedOverBy?: string | null;
};
/** The hospital header and the visit QR are read for Share PDF (owner 2026-10-12), the desk's printed page. */
export type QuickReport = QuickRow & {
  analyteIds: string[]; groups: { title: string | null; analyteIds: string[] }[]; lines: QuickLine[]; summary: string;
  collectedByName: string | null; reportedByName: string | null;
  hospital: { name: string; address: string; hotline: string; emergency: string; email: string; website: string };
  /** Server-drawn SVG of the visit number (the prescription footer's QR), or null with no visit. */
  visitQrSvg: string | null;
  /** Owner 2026-10-12 — each culture test's antibiotic sensitivity table (absent on older servers). */
  ast?: AstBlock[];
};
export type QuickCollectRow = {
  orderId: string; orderNo: string; encounterNo: string; placedAt: string; priority: string;
  patient: QuickPatient; tests: QuickChosenTest[];
};
export type SaveQuickResults = {
  lines: { analyteId: string; value: string }[]; summary: string; complete: boolean;
  ast?: { serviceId: string; rows: AstDraftRow[] }[];
};
export type QrVerifyResult = { ok: true; patient: { id: string; uhid: string; name: string } } | { ok: false; reason: string };

const enc = encodeURIComponent;

export function quickLabApi(call: Call) {
  return {
    mode: () => call<{ mode: LabMode }>("GET", "/lab/desk/mode"),
    collectQueue: () => call<QuickCollectRow[]>("GET", "/lab/quick/collect"),
    collect: (orderId: string) => call<QuickRow>("POST", `/lab/quick/collect/${enc(orderId)}`, {}),
    queue: () => call<{ waiting: QuickRow[]; reportedToday: QuickRow[] }>("GET", "/lab/quick/queue"),
    catalogue: () => call<QuickCatalogue>("GET", "/lab/quick/catalogue"),
    report: (id: string) => call<QuickReport>("GET", `/lab/quick/reports/${enc(id)}`),
    ranges: (patientId: string, analyteIds: readonly string[]) =>
      call<{ items: QuickRange[] }>("GET", `/lab/quick/ranges?patientId=${enc(patientId)}&analyteIds=${analyteIds.map(enc).join(",")}`),
    save: (id: string, body: SaveQuickResults) => call<QuickReport>("PUT", `/lab/quick/reports/${enc(id)}`, body),
    ready: () => call<{ ready: QuickRow[]; handedOverToday: QuickRow[] }>("GET", "/lab/quick/ready"),
    readyReport: (id: string) => call<QuickReport>("GET", `/lab/quick/ready/${enc(id)}`),
    handOver: (id: string) => call<QuickRow>("POST", `/lab/quick/reports/${enc(id)}/hand-over`, {}),
    sendBack: (id: string) => call<QuickRow>("POST", `/lab/quick/reports/${enc(id)}/send-back`, {}),
    /** Owner 2026-10-12 — the share sheet closed without an error: one audit record on the server. */
    shared: (id: string) => call<{ reportId: string; sharedAt: string }>("POST", `/lab/quick/reports/${enc(id)}/shared`, {}),
    verifyQr: (payload: string) => call<QrVerifyResult>("POST", "/patients/qr/verify", { payload }),
  };
}
export type QuickLabApi = ReturnType<typeof quickLabApi>;

const num = (s: string | null): number | null => (s === null ? null : Number(s));

export function previewFlag(value: string, r: QuickRange | undefined): QuickFlag {
  if (r === undefined || value.trim() === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const cl = num(r.criticalLow), ch = num(r.criticalHigh);
  if (ch !== null && v >= ch) return "HH";
  if (cl !== null && v <= cl) return "LL";
  const lo = num(r.low), hi = num(r.high);
  if (lo === null && hi === null) return null;
  if (hi !== null && v > hi) return "H";
  if (lo !== null && v < lo) return "L";
  return "N";
}

/** "12.0000" -> "12", "4.5000" -> "4.5". */
export function trimNum(s: string | null): string {
  if (s === null) return "";
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function refText(r: { low: string | null; high: string | null; text: string | null } | undefined): string {
  if (r === undefined) return "";
  if (r.low !== null && r.high !== null) return `${trimNum(r.low)} – ${trimNum(r.high)}`;
  if (r.low !== null) return `≥ ${trimNum(r.low)}`;
  if (r.high !== null) return `≤ ${trimNum(r.high)}`;
  return r.text ?? "";
}

const FLAG_WORD: Record<string, string> = { L: "low", H: "high", LL: "CRITICALLY LOW", HH: "CRITICALLY HIGH" };

/** The web's proposed summary, word for word (it prints in English): abnormal values first, then one line for the rest. */
export function draftSummary(lines: readonly QuickLine[]): string {
  const filled = lines.filter((l) => l.value.trim() !== "");
  if (filled.length === 0) return "";
  const abnormal = filled.filter((l) => l.flag !== null && l.flag !== "N");
  const normal = filled.filter((l) => l.flag === "N");
  const out = abnormal.map((l) => {
    const ref = refText({ low: l.low, high: l.high, text: l.refText });
    return `${l.nameEn} is ${FLAG_WORD[l.flag!]}: ${l.value}${l.unit ? ` ${l.unit}` : ""}${ref ? ` (ref ${ref})` : ""}.`;
  });
  if (abnormal.length === 0 && normal.length > 0) out.push("All reported parameters are within the reference range.");
  else if (normal.length > 0) out.push("Other reported parameters are within the reference range.");
  return out.join("\n");
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A refusal in a few words: known codes are named, anything else is the server's own word. */
export function labRefusal(e: unknown, t: T): string {
  if (e instanceof NetworkError) return t("quickLab.err.offline");
  if (e instanceof ApiError) {
    const known = ["lab_mode_off", "not_completed", "not_found", "forbidden"];
    if (known.includes(e.code)) return t(`quickLab.err.${e.code}`);
    if (e.status === 403) return t("quickLab.err.forbidden");
    if (e.status === 409) return t("quickLab.err.conflict");
    return e.code;
  }
  return t("quickLab.err.failed");
}
