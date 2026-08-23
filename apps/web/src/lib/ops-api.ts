import { api, ApiError } from "./api";

/**
 * PLAN 11c T5 — THE OPS WIRE CONTRACT, transcribed from `ops.controller.ts` (T2/T3/T4) exactly as
 * `alerts-api.ts` and `billing-api.ts` transcribe theirs: this file describes the shape those
 * routes ship, it does not re-derive or widen it. Only the SURFACE this task's screens render is
 * covered — mode, config-validation, downtime kits. The interface registry (T3's `/ops/interfaces`)
 * has no screen in this wave (not in Task 5's File Structure) and is deliberately absent here.
 */

// ─────────────────────────────── operating mode (T1/T2, D1-D3) ───────────────────────────────

export const OPERATING_MODES = ["commissioning", "ramp", "normal", "degraded", "downtime"] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

/** `GET /ops/mode`'s body. `since`/`note`/`reportId` are null on a virgin deployment. */
export type WireModeView = {
  mode: OperatingMode;
  since: string | null;
  note: string | null;
  reportId: string | null;
};

export type WireModeChangeResult = {
  id: string;
  from: OperatingMode;
  to: OperatingMode;
  note: string | null;
  reportId: string | null;
};

export function getMode(): Promise<WireModeView> {
  return api("GET", "/ops/mode");
}

/** `ops.mode.set` at hospital scope (§7). A refusal carries `{code, detail, message}` — see below. */
export function changeMode(body: { to: OperatingMode; note?: string | null }): Promise<WireModeChangeResult> {
  return api("POST", "/ops/mode", body);
}

// ───────────────────────────── the D-17 aggregate (T2, D5) ─────────────────────────────

export type WireConfigError = { code: string; detail: string };

export type WireScopeResult = {
  scope: string;
  ok: boolean;
  caSigned: boolean | null;
  errors: WireConfigError[];
};

/** `POST /ops/config-validation`'s body — always 200; `ok: false` is a verdict, not a refusal. */
export type WireConfigValidationReport = {
  reportId: string;
  ok: boolean;
  at: string;
  scopes: WireScopeResult[];
  eventId: string;
};

export type WireLatestValidationReport = {
  id: string;
  ok: boolean;
  at: string;
  scopes: WireScopeResult[];
};

/** `ops.mode.set` at hospital scope — the one who may declare the hospital open runs the check. */
export function runConfigValidation(): Promise<WireConfigValidationReport> {
  return api("POST", "/ops/config-validation");
}

/** The gate state the mode desk renders. Authenticated-only. */
export function getLatestConfigValidation(): Promise<{ report: WireLatestValidationReport | null }> {
  return api("GET", "/ops/config-validation/latest");
}

// ─────────────────────────────── downtime kits (T4, D7/D9) ───────────────────────────────

/** D7's stage-1 form kinds — transcribed from `downtime-kit.ts`, not redeclared independently. */
export const DOWNTIME_FORM_KINDS = ["registration", "consultation", "receipt"] as const;
export type DowntimeFormKind = (typeof DOWNTIME_FORM_KINDS)[number];

export type WireDowntimeKitRange = {
  id: string;
  desk: string;
  formKind: DowntimeFormKind;
  startSerial: number;
  endSerial: number;
  count: number;
};

export type WireDowntimeKitView = {
  id: string;
  note: string | null;
  generatedBy: string;
  generatedAt: string;
  totalForms: number;
  ranges: WireDowntimeKitRange[];
};

export type WireGenerateDowntimeKitResult = WireDowntimeKitView & { eventId: string };

/** One sheet's printable line: what the corner shows, and what the QR encodes (D9). */
export type WireKitPrintForm = {
  formKind: DowntimeFormKind;
  serial: number;
  qr: string;
};

export type WireKitPrintRange = WireDowntimeKitRange & { forms: WireKitPrintForm[] };

export type WireKitPrintPayload = {
  kitId: string;
  note: string | null;
  generatedBy: string;
  generatedAt: string;
  totalForms: number;
  ranges: WireKitPrintRange[];
};

/** The generation request's per-desk shape — `downtimeKitRequestSchema`'s input, transcribed. */
export type DowntimeKitDeskInput = {
  desk: string;
  counts: Partial<Record<DowntimeFormKind, number>>;
};

/** `ops.downtime.generate` at hospital scope. A refusal carries `{code, message}` (no `detail`). */
export function generateDowntimeKit(body: {
  note?: string | null;
  desks: DowntimeKitDeskInput[];
}): Promise<WireGenerateDowntimeKitResult> {
  return api("POST", "/ops/downtime-kits", body);
}

/** `ops.downtime.generate` at hospital scope — the uniform permission shape (controller's header). */
export function listDowntimeKits(): Promise<{ kits: WireDowntimeKitView[] }> {
  return api("GET", "/ops/downtime-kits");
}

/** `ops.downtime.generate` at hospital scope. Returns every signed QR in the kit (D9's own reason). */
export function getKitPrintPayload(id: string): Promise<WireKitPrintPayload> {
  return api("GET", `/ops/downtime-kits/${id}`);
}

// ────────────────────────────────── error helpers ──────────────────────────────────
//
// The `billingErrorMessage`/`billingErrorCode`/`billingErrorDetail` precedent, transcribed as a
// SEPARATE function over the same `ApiError` shape rather than an import — `billing-api.ts:179`
// states the reason: so "align the two error conventions" can never become a one-line temptation.
// `ops.controller.ts`'s `toHttp`/`kitToHttp` bodies are `{code, detail?, message}` for a `ModeError`/
// `DowntimeKitError` refusal (400/409) and Nest's own `{statusCode, message, error}` for anything
// else (403 on a missing permission, a 400 from `parsed()`'s zod issues) — `opsErrorCode` returns
// null for the latter, which is correct: there is no machine code to render, only the message.

/** The displayable text of a failed ops call. */
export function opsErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

/** The machine `code` of a failed ops call, or null — screens branch on this, never on status. */
export function opsErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return null;
}

/** The `detail` a `ModeError` refusal carries (`GateDetail`, on `golive_gate_unsatisfied`), or null. */
export function opsErrorDetail(e: unknown): unknown {
  return e instanceof ApiError ? ((e.body as { detail?: unknown } | null)?.detail ?? null) : null;
}
