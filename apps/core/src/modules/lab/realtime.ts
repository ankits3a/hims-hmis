import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * PLAN 17b T8 — **THE LABORATORY'S LIVE TOPICS.**
 *
 * ═══ TWO SPACES, AND THE SECOND ONE IS THE REASON THIS FILE EXISTS ═══
 *
 *   · `lab:<orderGroupId>` — the clinical act. A counter watching one patient's tests sees the
 *     order desked, the labels printed, the report published, amended, printed or HELD, and a
 *     reflex added — the events whose payloads actually name an order (see `LAB_REALTIME_NAMES`).
 *   · `lab_critical` — **the whole department**, gated on `lab.criticals.close`. A potassium of 6.8
 *     at 02:00 has to reach whoever is on the floor, and a topic keyed to the ordering doctor would
 *     reach a person who went home at six (02 F1 / E34).
 *
 * ═══ WHAT IS DELIBERATELY **NOT** BROADCAST ═══
 *
 * No result VALUE and no analyte name cross the socket. `TailedEvent` carries the event's payload
 * as it was appended, so the topics below are chosen from events whose payloads are structural —
 * ids, states, instants — with one exception: `lab.result_critical_flagged` carries the value, and
 * it is on the space a holder of `lab.criticals.close` subscribes to, which is exactly the person
 * the number is for. `lab.report_published` carries no values at all (T7 A7's own rule, one layer
 * down), so a counter screen going live costs nothing in disclosure.
 *
 * The gateway knows no module: the module registers its spaces and its router at init, which is
 * `OpdRealtimeRegistrar`'s shape transcribed rather than re-invented.
 */
export const LAB_TOPIC_SPACES: TopicSpace[] = [
  { prefix: "lab", permission: "lab.worklist.read" },
  { prefix: "lab_critical", permission: "lab.criticals.close" },
];

/**
 * ═══ ONLY THE NAMES THIS ROUTER CAN ACTUALLY ROUTE (CLOSE REVIEW M5) ═══
 *
 * This list carried sixteen names and SIX of them could never produce a topic:
 * `lab.specimen_collected`, `lab.specimen_received`, `lab.specimen_rejected`,
 * `lab.recollection_requested`, `lab.result_entered` and `lab.result_verified` declare neither
 * `orderId` nor `orderGroupId` in their payloads (`events.ts`), and `TailedEvent` carries only
 * `{seq, eventId, name, occurredAt, patientId, encounterId, payload}` — no correlation id. So
 * `labTopicsFor` returned `[]` for every one of them while this file's header promised a counter
 * would watch "the tube drawn, received, resulted, signed and published".
 *
 * `events.ts` is T2's frozen file and the payloads cannot be widened here (§8). **Declaring a name
 * that routes nowhere is worse than declaring a smaller set**: it is a promise in a manifest that
 * nothing keeps, and the next phase to read this file would build a screen on it. The six are
 * REMOVED and recorded as §9.2 F43; the phase that may edit `events.ts` adds `orderGroupId` to
 * their payloads and puts them back.
 */
/** The tube-and-result events the department-wide bench topic carries (17c T3). */
export const LAB_BENCH_NAMES = [
  "lab.specimen_collected", "lab.specimen_received", "lab.specimen_rejected",
  "lab.recollection_requested", "lab.result_entered", "lab.result_verified",
  /**
   * 17d T1 — a suspected swap is the one tube event the bench must see WITHOUT being asked. The
   * other half of the pair is in somebody else's hand at the same moment, and a flag that waits for
   * a refresh is a flag that arrives after the second tube has gone on the analyser.
   */
  "lab.tube_swap_suspected",
  /**
   * 17d T2 — the bench's neighbours see a tube re-labelled as it happens. The phlebotomist whose
   * label failed is the person who most needs to know the printer or the ice box is at fault.
   */
  "lab.specimen_relabelled",
] as const;

/**
 * `lab:bench` — the WHOLE department's tube traffic, under the `lab` space (`lab.worklist.read`).
 * A bench watching every group has no group to subscribe to; this is the topic it watches. It
 * exists beside the per-group topic, never instead of it.
 */
export const LAB_BENCH_TOPIC = "lab:bench";

export const LAB_REALTIME_NAMES = [
  "lab.order_desked", "lab.label_printed",
  "lab.report_published", "lab.report_amended", "lab.report_printed", "lab.report_print_blocked",
  "lab.result_critical_flagged", "lab.critical_acknowledged",
  "lab.reflex_added", "lab.sla_breached",
  /**
   * PLAN 17c T3 / D8 — THE SIX ARE BACK. 17b F43 removed them because their payloads named no
   * order; `events.ts` now carries `orderGroupId` on every one, so a counter watching one patient
   * AND the bench watching the whole department both see the tube drawn, received, rejected,
   * re-requested, resulted and signed. Structural payloads only — no value, no analyte name.
   */
  ...LAB_BENCH_NAMES,
];


type P = { orderGroupId?: string; orderId?: string; callId?: string };

export function labTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const p = (e.payload ?? {}) as P;
  const out: string[] = [];
  /**
   * The GROUP, not the order — a reflex order and its parent are one clinical act and one counter
   * conversation (phase 0 DD2). Events that carry only an `orderId` fall back to it, which is
   * correct for a single-order act and harmlessly narrow for a reflex.
   */
  if (p.orderGroupId) out.push(`lab:${p.orderGroupId}`);
  else if (p.orderId) out.push(`lab:${p.orderId}`);
  if (e.name === "lab.result_critical_flagged" || e.name === "lab.critical_acknowledged") {
    out.push("lab_critical");
  }
  if ((LAB_BENCH_NAMES as readonly string[]).includes(e.name)) out.push(LAB_BENCH_TOPIC);
  return out;
}

export const labTopicRouter: TopicRouter = { names: LAB_REALTIME_NAMES, topicsFor: labTopicsFor };
