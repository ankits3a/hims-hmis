import { api } from "./api";

/* ═══ E2.2 (decision 0069) — MY LEAVE: `apps/core/src/modules/roster/leave.controller.ts`'s
 * `/roster/leave…`, transcribed from `leave.ts`. `from` / `to` are IST days, both inclusive. ═══ */

export const SELF_LEAVE_KINDS = ["CL", "EL", "ML", "comp_off"] as const;
export type SelfLeaveKind = (typeof SELF_LEAVE_KINDS)[number];
export type LeaveStatus = "requested" | "approved" | "rejected" | "cancelled";

export type WireMyLeave = {
  id: string; kind: string; from: string; to: string; days: number; status: LeaveStatus;
  reason: string | null; refusal: string | null; decidedBy: string | null; decidedAt: string | null;
  canCancel: boolean;
};

export type WireLeaveToDecide = {
  id: string; userId: string; name: string; department: string | null;
  kind: string; from: string; to: string; days: number; reason: string | null; requestedAt: string;
};

export const fetchMyLeave = () => api<WireMyLeave[]>("GET", "/roster/leave/mine");
export const fetchLeaveToDecide = () => api<WireLeaveToDecide[]>("GET", "/roster/leave/to-decide");
export const fileLeave = (b: { kind: SelfLeaveKind; from: string; to: string; reason?: string }) =>
  api<{ absenceId: string }>("POST", "/roster/leave", b);
export const cancelLeave = (id: string) => api<{ ok: true }>("POST", `/roster/leave/${encodeURIComponent(id)}/cancel`);
export const decideLeave = (id: string, approve: boolean, note?: string) =>
  api<{ ok: true }>("POST", `/roster/leave/${encodeURIComponent(id)}/decide`, approve ? { approve } : { approve, note });
