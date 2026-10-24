import { z } from "zod";
import type { TaskState } from "./tasks";

/**
 * E1.5 MAINTENANCE (issue #722, decision 0072, spec SPEC-ipd-companions §9) — repair tickets for beds, rooms,
 * oxygen points and fixtures, worked through the shared task engine. A bed with a repair ticket is blocked until
 * the ticket is CLOSED, and a ticket closes only when a nurse confirms the fix (the repair task's check). On an
 * occupied bed the ticket is a request: the block applies when the bed is released. A third fault on one item in
 * thirty days flags the item for replacement.
 */

export const MAINTENANCE_ITEM_KINDS = [
  "bed", "oxygen_point", "suction", "monitor", "fixture", "electrical", "plumbing", "ac", "other",
] as const;
export type MaintenanceItemKind = (typeof MAINTENANCE_ITEM_KINDS)[number];

/** general = the engineering department's technicians; biomedical = biomedical engineering (equipment). */
export const MAINTENANCE_CATEGORIES = ["general", "biomedical"] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_URGENCIES = ["routine", "urgent", "critical"] as const;
export type MaintenanceUrgency = (typeof MAINTENANCE_URGENCIES)[number];

/** Who raised it: a person, a device alarm (a seam today), or an existing maintenance block on the bed. */
export const MAINTENANCE_SOURCES = ["person", "device", "block"] as const;
export type MaintenanceSource = (typeof MAINTENANCE_SOURCES)[number];

/** What the table stores. `assigned` / `in_progress` are read from the repair task (one truth), never stored. */
export const MAINTENANCE_STORED_STATES = ["open", "fixed", "closed", "cancelled"] as const;
export const MAINTENANCE_STATES = ["open", "assigned", "in_progress", "fixed", "closed", "cancelled"] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];
export const MAINTENANCE_OPEN_STATES = ["open", "fixed"] as const;

export const MAINTENANCE_KINDS = { general: "repair_general", biomedical: "repair_biomedical" } as const;
export type MaintenanceTaskKind = (typeof MAINTENANCE_KINDS)[keyof typeof MAINTENANCE_KINDS];
export const MAINTENANCE_KIND_LIST: readonly MaintenanceTaskKind[] = [MAINTENANCE_KINDS.biomedical, MAINTENANCE_KINDS.general];

/**
 * DECIDED (standard Indian corporate-hospital engineering SLA): the repair is due, and the blocked bed is expected
 * back, this many hours after the ticket — critical 4 h, urgent 24 h, routine 72 h.
 */
export const MAINTENANCE_RETURN_HOURS: Record<MaintenanceUrgency, number> = { critical: 4, urgent: 24, routine: 72 };
/** Spec §9 edge case: the third fault on one item inside this many days flags it for replacement. */
export const MAINTENANCE_REPEAT_WINDOW_DAYS = 30;
export const MAINTENANCE_REPEAT_THRESHOLD = 3;

/** Monitors and the like are biomedical by default; the raiser may override. */
export function defaultCategory(item: MaintenanceItemKind): MaintenanceCategory {
  return item === "monitor" || item === "suction" ? "biomedical" : "general";
}

const id = z.string().min(1).max(64);
export const raiseTicketInput = z.object({
  placeResourceId: id,
  itemKind: z.enum(MAINTENANCE_ITEM_KINDS),
  itemTag: z.string().trim().max(64).optional(),
  category: z.enum(MAINTENANCE_CATEGORIES).optional(),
  urgency: z.enum(MAINTENANCE_URGENCIES),
  description: z.string().trim().min(1).max(500),
  source: z.enum(["person", "device"]).optional(),
}).strict();
export type RaiseTicketInput = z.infer<typeof raiseTicketInput>;

export const ticketRefInput = z.object({ ticketId: id }).strict();
export const cancelTicketInput = z.object({ ticketId: id, reason: z.string().trim().min(1).max(280) }).strict();
export type CancelTicketInput = z.infer<typeof cancelTicketInput>;

/** What happened to the bed when the ticket was raised. */
export type MaintenanceBedEffect =
  | "blocked" | "block_on_release" | "joined_block" | "already_blocked" | "not_blocked_reserved" | "not_blocked_status" | "not_a_bed";

/** One ticket as the board and the Beds board see it. No patient, no money. */
export type MaintenanceTicketView = {
  id: string;
  number: number;
  placeResourceId: string;
  placeName: string;
  placeCode: string;
  placeKind: string;
  floorName: string | null;
  itemKind: MaintenanceItemKind;
  itemTag: string | null;
  category: MaintenanceCategory;
  urgency: MaintenanceUrgency;
  description: string;
  source: MaintenanceSource;
  state: MaintenanceState;
  /** The repair task's own state, or null when it was cancelled on the task board (needs dispatching again). */
  taskState: TaskState | null;
  taskId: string | null;
  bedBlockId: string | null;
  /** The bed's block is waiting for the bed to be released (the ticket was raised on an occupied bed). */
  blockOnRelease: boolean;
  replacementFlag: boolean;
  assigneeName: string | null;
  raisedByName: string | null;
  raisedAt: string;
  dueAt: string;
  fixedAt: string | null;
  closedAt: string | null;
  /** Whole minutes since raised, at `serverNow`. */
  ageMinutes: number;
  late: boolean;
};

export type MaintenanceBoardFloor = { floorName: string | null; tickets: MaintenanceTicketView[] };
export type MaintenanceBoardView = {
  serverNow: string;
  floors: MaintenanceBoardFloor[];
  /** Fixed, waiting for the nurse's confirmation. */
  toConfirm: MaintenanceTicketView[];
  /** Beds held out of service by an open ticket. */
  blockedBeds: { bedId: string; bedCode: string; ticketNumber: number; state: MaintenanceState; onRelease: boolean }[];
  /** Items flagged for replacement by a ticket of the last thirty days. */
  replacement: { placeName: string; itemKind: MaintenanceItemKind; itemTag: string | null; ticketNumber: number; raisedAt: string }[];
  counts: { open: number; critical: number; late: number; toConfirm: number; blockedBeds: number; notShown: number };
};

/** For the Beds board: the newest open ticket per bed. */
export type BedTicketView = {
  bedId: string; ticketId: string; number: number; state: MaintenanceState; urgency: MaintenanceUrgency;
  itemKind: MaintenanceItemKind; taskId: string | null; blockOnRelease: boolean;
};
export type BedTicketsView = { serverNow: string; tickets: BedTicketView[] };

export type RaiseTicketResult = { ticketId: string; number: number; merged: boolean; bed: MaintenanceBedEffect; replacementFlag: boolean };

export const MAINTENANCE_ROUTES = {
  tickets: "/maintenance/tickets",
  board: "/maintenance/board",
  bedTickets: "/maintenance/bed-tickets",
  places: "/maintenance/places",
  confirm: (ticketId: string) => `/maintenance/tickets/${encodeURIComponent(ticketId)}/confirm`,
  cancel: (ticketId: string) => `/maintenance/tickets/${encodeURIComponent(ticketId)}/cancel`,
  dispatch: (ticketId: string) => `/maintenance/tickets/${encodeURIComponent(ticketId)}/dispatch`,
} as const;

/** A place a ticket may be raised on, for the raise sheet's picker. */
export type MaintenancePlace = { id: string; kind: string; code: string; name: string; floorName: string | null };

export const MAINTENANCE_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  forbidden: { sentence: "You may not do this.", fix: "Ask the duty manager." },
  unknown_place: { sentence: "This place is not in the register.", fix: "Pick the bed, room or ward from the list." },
  place_retired: { sentence: "This place is retired.", fix: "Pick a place in service." },
  ticket_not_found: { sentence: "No repair ticket has this id.", fix: "Refresh the board." },
  ticket_closed: { sentence: "This repair ticket is already closed or cancelled.", fix: "Refresh the board." },
  already_fixed: { sentence: "The repair is already marked fixed.", fix: "Confirm the fix instead." },
  not_fixed_yet: { sentence: "The repair is not marked fixed yet.", fix: "Wait for the technician to finish." },
  task_still_open: { sentence: "The repair task is still being worked.", fix: "Nudge the technician or cancel the ticket." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type MaintenanceRefusalCode = keyof typeof MAINTENANCE_REFUSALS;
