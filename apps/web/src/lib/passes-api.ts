import { api, ApiError, newIdempotencyKey } from "./api";
import type { PassAdmissionView, PassHolder, PassIssueKind, PassRefusalBody, PassScanAnswer, PassWard } from "@hmis/contracts";

/**
 * E1.3 (#720) — the passes wire. Shapes are the contract's (`packages/contracts/src/passes.ts`); paths are copied from
 * `PASS_ROUTES` because the web bundle imports the contract package for TYPES only. Every act carries a fresh
 * idempotency key in its body.
 */
const R = {
  admission: (id: string) => `/passes/admissions/${id}`,
  issue: "/passes/issue",
  visitor: "/passes/visitor",
  reissue: "/passes/reissue",
  pause: "/passes/pause",
  resume: "/passes/resume",
  custody: "/passes/custody",
  scan: "/passes/scan",
  wards: "/passes/wards",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export const getAdmissionPasses = (admissionId: string): Promise<PassAdmissionView> => api("GET", R.admission(admissionId));
export const issuePasses = (admissionId: string, holders: PassHolder[], kind?: PassIssueKind, babyAdmissionId?: string): Promise<{ passIds: string[] }> =>
  post(R.issue, { admissionId, holders, ...(kind === undefined ? {} : { kind }), ...(babyAdmissionId === undefined ? {} : { babyAdmissionId }) });
export const issueVisitorPass = (admissionId: string, holder: PassHolder): Promise<{ passIds: string[] }> => post(R.visitor, { admissionId, holder });
export const reissuePass = (passId: string, reason: "lost" | "damaged" | "holder_changed", holder?: PassHolder): Promise<{ passId: string; revokedPassId: string }> =>
  post(R.reissue, { passId, reason, ...(holder === undefined ? {} : { holder }) });
export const pausePasses = (admissionId: string, reason: string, scope: "visitors" | "all"): Promise<{ pausedPassIds: string[] }> =>
  post(R.pause, { admissionId, reason, scope });
export const resumePasses = (admissionId: string): Promise<{ resumedPassIds: string[] }> => post(R.resume, { admissionId });
export const setPoliceCustody = (admissionId: string, custody: boolean, note: string): Promise<{ policeCustody: boolean; revokedPassIds: string[] }> =>
  post(R.custody, { admissionId, custody, note });
export const scanPass = (token: string, wardId?: string): Promise<PassScanAnswer> =>
  api("POST", R.scan, { token, ...(wardId === undefined ? {} : { wardId }) });
export const listPassWards = (): Promise<PassWard[]> => api<{ items: PassWard[] }>("GET", R.wards).then((r) => r.items);

export function passRefusalOf(e: unknown): PassRefusalBody | null {
  if (!(e instanceof ApiError) || e.body === null || typeof e.body !== "object") return null;
  const b = e.body as Partial<PassRefusalBody>;
  return typeof b.rule === "string" && typeof b.code === "string" ? (b as PassRefusalBody) : null;
}
