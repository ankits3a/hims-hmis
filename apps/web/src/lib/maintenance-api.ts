import { ApiError, api } from "./api";
import type {
  BedTicketsView, MaintenanceBoardView, MaintenanceItemKind, MaintenancePlace, MaintenanceUrgency, RaiseTicketResult,
} from "@hmis/contracts";

/* ═══ E1.5 MAINTENANCE (issue #722) — `apps/core/src/modules/maintenance/maintenance.controller.ts`. The paths and the
 * lists are the contract's `MAINTENANCE_ROUTES` / `MAINTENANCE_ITEM_KINDS`, copied: the web bundle imports the
 * contract package for TYPES only. ═══ */
const ROUTES = {
  tickets: "/maintenance/tickets",
  board: "/maintenance/board",
  bedTickets: "/maintenance/bed-tickets",
  places: "/maintenance/places",
  confirm: (id: string) => `/maintenance/tickets/${encodeURIComponent(id)}/confirm`,
  cancel: (id: string) => `/maintenance/tickets/${encodeURIComponent(id)}/cancel`,
  dispatch: (id: string) => `/maintenance/tickets/${encodeURIComponent(id)}/dispatch`,
} as const;

export const ITEM_KINDS: readonly MaintenanceItemKind[] = [
  "bed", "oxygen_point", "suction", "monitor", "fixture", "electrical", "plumbing", "ac", "other",
];
export const URGENCIES: readonly MaintenanceUrgency[] = ["routine", "urgent", "critical"];

export type TicketAck = { id: string; number: number; state: string; version: number };
export type RaiseInput = {
  placeResourceId: string; itemKind: MaintenanceItemKind; urgency: MaintenanceUrgency; description: string; itemTag?: string;
};

export const fetchMaintenanceBoard = () => api<MaintenanceBoardView>("GET", ROUTES.board);
export const fetchBedTickets = () => api<BedTicketsView>("GET", ROUTES.bedTickets);
export const searchPlaces = (q: string) => api<MaintenancePlace[]>("GET", `${ROUTES.places}?q=${encodeURIComponent(q)}`);
export const raiseTicketApi = (input: RaiseInput) => api<RaiseTicketResult>("POST", ROUTES.tickets, input);
export const confirmTicketApi = (id: string) => api<TicketAck>("POST", ROUTES.confirm(id), {});
export const cancelTicketApi = (id: string, reason: string) => api<TicketAck>("POST", ROUTES.cancel(id), { reason });
export const dispatchTicketApi = (id: string) => api<TicketAck>("POST", ROUTES.dispatch(id), {});

/** The refusal a maintenance, task or beds door answered with: its code and the server's words, or null. */
export function maintenanceRefusal(e: unknown): { code: string; message: string; fix: string } | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body as { code?: unknown; message?: unknown; fix?: unknown } | null;
  if (typeof b?.code !== "string") return null;
  return { code: b.code, message: typeof b.message === "string" ? b.message : "", fix: typeof b.fix === "string" ? b.fix : "" };
}

/** "3 h 20 min", "2 d 4 h", "12 min" — a ticket's age in words, from whole minutes. */
export function ageWords(minutes: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (minutes < 60) return t("maintenance.age.min", { m: minutes });
  const h = Math.floor(minutes / 60);
  if (h < 24) return t("maintenance.age.hmin", { h, m: minutes % 60 });
  return t("maintenance.age.dh", { d: Math.floor(h / 24), h: h % 24 });
}
