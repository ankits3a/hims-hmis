import { ER_BOARD_TOPIC, ER_WALL_TOPIC } from "@hmis/contracts";
import { ER_BOARD_EVENT_NAMES } from "./events";
import { ER_BOARD_VIEW, ER_BOARD_WALL } from "./names";
import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * ER lane 1 (#808) — the tracking board's live channel. One topic, `er:board`, readable by whoever may view the board.
 * Every arrival act tells the board (and the ER desk) to refetch; neither patches itself from an event payload, and
 * the payloads carry ids only. A merge (`patient.merged`) also refetches: an unknown's tile takes the true name.
 */
export const ER_TOPIC_SPACES: TopicSpace[] = [
  { prefix: ER_BOARD_TOPIC.split(":")[0]!, permission: ER_BOARD_VIEW },
  // ER review (2026-10-15) — the wall display's channel, on its own permission (the kiosk holds only that).
  { prefix: ER_WALL_TOPIC.split(":")[0]!, permission: ER_BOARD_WALL },
];

export const ER_REALTIME_NAMES: string[] = [...ER_BOARD_EVENT_NAMES, "patient.merged"];

export function erTopicsFor(e: Pick<TailedEvent, "name">): string[] {
  return ER_REALTIME_NAMES.includes(e.name) ? [ER_BOARD_TOPIC, ER_WALL_TOPIC] : [];
}

export const erTopicRouter: TopicRouter = { names: ER_REALTIME_NAMES, topicsFor: erTopicsFor };
