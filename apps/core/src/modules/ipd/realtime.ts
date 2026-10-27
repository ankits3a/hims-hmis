import { IPD_BEDS_TOPIC, IPD_NURSING_TOPIC } from "@hmis/contracts";
import { IPD_ADMISSION_BOARD_EVENT_NAMES } from "./admission-events";
import { IPD_BED_EVENT_NAMES } from "./bed-events";
import { IPD_TRANSFER_EVENT_NAMES } from "./transfer-events";
import { IPD_DISCHARGE_EVENT_NAMES } from "./discharge-events";
import { IPD_BEDS_VIEW, IPD_NURSING_VIEW } from "./manifest";
import { IPD_NURSING_EVENT_NAMES } from "./nursing-events";
import { IPD_EMAR_EVENT_NAMES } from "./emar-events";
import { IPD_WARD_SAFETY_EVENT_NAMES } from "./ward-safety-events";
import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * E1.1 (#718) — the bed board's live channel. One topic, `ipd_beds:board`, readable by whoever may view the board.
 * Every IPD bed act, and every registry change to a place (a bed loaded, a ward renamed, a kernel release), tells
 * the board to refetch; the board never patches itself from an event payload.
 */
export const IPD_TOPIC_SPACES: TopicSpace[] = [
  { prefix: IPD_BEDS_TOPIC.split(":")[0]!, permission: IPD_BEDS_VIEW },
  // E4.1 (#733) — the nurse station and my shift refetch on any nursing event (ids only in the payloads).
  { prefix: IPD_NURSING_TOPIC.split(":")[0]!, permission: IPD_NURSING_VIEW },
];

const RESOURCE_NAMES = [
  "resource.registered", "resource.updated", "resource.status_changed", "resource.assigned", "resource.released",
] as const;
const PLACE_KINDS = new Set(["floor", "ward", "hall", "room", "bed"]);

/** E1.2: an admission request raised, held, admitted or cancelled changes the board's waiting column. */
const BOARD_NAMES: readonly string[] = [
  ...IPD_BED_EVENT_NAMES, ...IPD_ADMISSION_BOARD_EVENT_NAMES,
  // E3.1 (#729): a transfer started, accepted or cancelled, a swap or a class change.
  ...IPD_TRANSFER_EVENT_NAMES,
  // E3.2 (#730): fit declared or cancelled, a gate pass out, a stay ended (the bed empties).
  ...IPD_DISCHARGE_EVENT_NAMES,
];

export const IPD_REALTIME_NAMES: string[] = [...BOARD_NAMES, ...RESOURCE_NAMES, ...IPD_NURSING_EVENT_NAMES, ...IPD_EMAR_EVENT_NAMES, ...IPD_WARD_SAFETY_EVENT_NAMES];

export function ipdTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  // E4.1 (#733): a bed act also moves the station (a patient arrives or leaves); a nursing act moves only the station.
  if (BOARD_NAMES.includes(e.name)) return [IPD_BEDS_TOPIC, IPD_NURSING_TOPIC];
  if (IPD_NURSING_EVENT_NAMES.includes(e.name)) return [IPD_NURSING_TOPIC];
  // E4.3 (#735): a dose, a verify, an issue moves the phone and the ward MAR (ids only in the payloads).
  if (IPD_EMAR_EVENT_NAMES.includes(e.name)) return [IPD_NURSING_TOPIC];
  // WM-2 (#983): a care check, restraint, line, crash cart or ward-stock act moves the ward screens (ids only).
  if (IPD_WARD_SAFETY_EVENT_NAMES.includes(e.name)) return [IPD_NURSING_TOPIC];
  const kind = (e.payload as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && PLACE_KINDS.has(kind) ? [IPD_BEDS_TOPIC] : [];
}

export const ipdTopicRouter: TopicRouter = { names: IPD_REALTIME_NAMES, topicsFor: ipdTopicsFor };
