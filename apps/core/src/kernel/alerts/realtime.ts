import type { TailedEvent } from "../realtime/tail";
import type { TopicRouter, TopicSpace } from "../realtime/gateway";

export const ALERTS_TOPIC_PREFIX = "alerts";

/**
 * The first topic space that is IDENTITY-scoped rather than permission-gated (D6). It declares
 * `authorize` and NOT `permission` — a space declares exactly one of the two, validated at
 * `registerTopicSpace`. `alerts:<userId>` is subscribable by that user and by nobody else, so
 * there is no role that can be granted to read another human's alerts.
 */
export const alertsTopicSpace: TopicSpace = {
  prefix: ALERTS_TOPIC_PREFIX,
  authorize: (userId, topic) => topic === `${ALERTS_TOPIC_PREFIX}:${userId}`,
};

export const ALERTS_REALTIME_NAMES = ["alert.raised"];

export function alertsTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const p = (e.payload ?? {}) as { userId?: string };
  return p.userId === undefined ? [] : [`${ALERTS_TOPIC_PREFIX}:${p.userId}`];
}

export const alertsTopicRouter: TopicRouter = {
  names: ALERTS_REALTIME_NAMES,
  topicsFor: alertsTopicsFor,
};
