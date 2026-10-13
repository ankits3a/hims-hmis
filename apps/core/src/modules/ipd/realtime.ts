import { IPD_BEDS_TOPIC } from "@hmis/contracts";
import { IPD_BED_EVENT_NAMES } from "./bed-events";
import { IPD_BEDS_VIEW } from "./manifest";
import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * E1.1 (#718) — the bed board's live channel. One topic, `ipd_beds:board`, readable by whoever may view the board.
 * Every IPD bed act, and every registry change to a place (a bed loaded, a ward renamed, a kernel release), tells
 * the board to refetch; the board never patches itself from an event payload.
 */
export const IPD_TOPIC_SPACES: TopicSpace[] = [{ prefix: IPD_BEDS_TOPIC.split(":")[0]!, permission: IPD_BEDS_VIEW }];

const RESOURCE_NAMES = [
  "resource.registered", "resource.updated", "resource.status_changed", "resource.assigned", "resource.released",
] as const;
const PLACE_KINDS = new Set(["floor", "ward", "hall", "room", "bed"]);

export const IPD_REALTIME_NAMES: string[] = [...IPD_BED_EVENT_NAMES, ...RESOURCE_NAMES];

export function ipdTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  if ((IPD_BED_EVENT_NAMES as readonly string[]).includes(e.name)) return [IPD_BEDS_TOPIC];
  const kind = (e.payload as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && PLACE_KINDS.has(kind) ? [IPD_BEDS_TOPIC] : [];
}

export const ipdTopicRouter: TopicRouter = { names: IPD_REALTIME_NAMES, topicsFor: ipdTopicsFor };
