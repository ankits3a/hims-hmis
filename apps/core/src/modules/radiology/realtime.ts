import { orderPlaced } from "../../kernel/orders/events";
import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";
import {
  imagingBookingChanged, imagingCriticalAcknowledged, imagingCriticalFlagged, imagingGateEvaluated,
  imagingImageViewed, imagingMediaRequested, imagingReportHandedOver, imagingReportPublished,
  imagingStudyAcquired, imagingStudyScheduled,
} from "./events";

/**
 * #1083 (IM6a) — **THE IMAGING LISTS' LIVE TOPICS.**
 *
 * Every imaging list polled at 30–60 s, so a STAT order could sit that long unseen while the gateway
 * that would have told the room was already running for OPD and the lab. Three topics, one per
 * family of screens; a frame is a HINT to refetch the list, never the row itself:
 *
 *   · `imaging:floor`   — the desk, the prep bay and the modality rooms: a new imaging order, a
 *                         booking and a booking change, a gate result, an acquisition;
 *   · `imaging:read`    — the reading room: an acquisition (a study joins the list), a release, a
 *                         critical flagged or acknowledged, and a reading claimed;
 *   · `imaging:release` — the hand-over desk: a release, a hand-over, a film or CD asked for.
 *
 * ═══ ONE SPACE, `imaging`, GATED ON `radiology.worklist.read` — DECIDED ═══
 *
 * The gateway finds a topic's space by the text before its FIRST colon (`gateway.ts` `allowed`), so
 * `imaging:floor`, `imaging:read` and `imaging:release` are one space with one grant. The grant is the
 * floor's — the one the desk and the rooms read their list with — and every seeded role that staffs
 * one of the five screens holds it (`radiology_receptionist`, `radiology_nurse`, `radiographer`,
 * `radiologist`, `radiology_resident`). What a holder receives is LESS than the floor list already
 * shows them: `events.ts` keeps every payload to ids and codes (no name, no phone, no finding; a
 * booking reason is "the desk's own words and never a finding"). A per-topic grant (the reading room
 * on `radiology.reports.write`, the hand-over desk on `radiology.schedule`) needs a longest-prefix
 * lookup in the kernel's gateway, which no module may edit alone; the slot is the space below.
 *
 * ═══ `order.placed` IS SHARED, AND ONLY `kind: "imaging"` IS OURS ═══
 *
 * The lab's and every later department's orders fire the same name. The payload carries `kind` for
 * exactly this question (`kernel/orders/events.ts`), and `consumers.ts` answers it the same way. The
 * study the desk lists is created by that consumer in the worker, a moment AFTER the event; the floor
 * is woken again by the booking, and each list's own poll stays the fallback either way.
 *
 * ═══ THE READING CLAIM IS AN IMAGE VIEW ═══
 *
 * There is no claim button and no claim event: `reading.ts` derives "Dr X is reading" from the image
 * view log, so `imaging.image_viewed` is the claim and routes to `imaging:read`. A view by somebody
 * who writes no reports wakes the list without changing it; that costs one refetch, not a disclosure
 * (`studyId`, `viewerId`, `via`).
 *
 * The gateway knows no module: `radiology.module.ts` registers the space and the router at init, the
 * `LabRealtimeRegistrar` shape.
 */
export const IMAGING_FLOOR_TOPIC = "imaging:floor";
export const IMAGING_READ_TOPIC = "imaging:read";
export const IMAGING_RELEASE_TOPIC = "imaging:release";

export const RADIOLOGY_TOPIC_SPACES: TopicSpace[] = [
  { prefix: "imaging", permission: "radiology.worklist.read" },
];

/** The kernel's shared envelope event; routed only for an imaging order. */
const ORDER_PLACED = orderPlaced.name;

/** Event name → the lists it wakes, in the order the topics are returned. */
const ROUTES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [ORDER_PLACED, [IMAGING_FLOOR_TOPIC]],
  [imagingStudyScheduled.name, [IMAGING_FLOOR_TOPIC]],
  [imagingBookingChanged.name, [IMAGING_FLOOR_TOPIC]],
  [imagingGateEvaluated.name, [IMAGING_FLOOR_TOPIC]],
  [imagingStudyAcquired.name, [IMAGING_FLOOR_TOPIC, IMAGING_READ_TOPIC]],
  [imagingReportPublished.name, [IMAGING_READ_TOPIC, IMAGING_RELEASE_TOPIC]],
  [imagingCriticalFlagged.name, [IMAGING_READ_TOPIC]],
  [imagingCriticalAcknowledged.name, [IMAGING_READ_TOPIC]],
  [imagingImageViewed.name, [IMAGING_READ_TOPIC]],
  [imagingReportHandedOver.name, [IMAGING_RELEASE_TOPIC]],
  [imagingMediaRequested.name, [IMAGING_RELEASE_TOPIC]],
]);

export const RADIOLOGY_REALTIME_NAMES: string[] = [...ROUTES.keys()];

export function radiologyTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const topics = ROUTES.get(e.name);
  if (topics === undefined) return [];
  if (e.name === ORDER_PLACED && (e.payload as { kind?: unknown } | null)?.kind !== "imaging") return [];
  return [...topics];
}

export const radiologyTopicRouter: TopicRouter = { names: RADIOLOGY_REALTIME_NAMES, topicsFor: radiologyTopicsFor };
