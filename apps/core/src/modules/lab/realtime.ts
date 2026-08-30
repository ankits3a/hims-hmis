import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

/**
 * PLAN 17b T8 — **THE LABORATORY'S LIVE TOPICS.**
 *
 * ═══ TWO SPACES, AND THE SECOND ONE IS THE REASON THIS FILE EXISTS ═══
 *
 *   · `lab:<orderGroupId>` — the clinical act. A counter watching one patient's tests sees the
 *     tube drawn, received, resulted, signed and published without polling.
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

export const LAB_REALTIME_NAMES = [
  "lab.order_desked", "lab.label_printed", "lab.specimen_collected", "lab.specimen_received",
  "lab.specimen_rejected", "lab.recollection_requested", "lab.result_entered",
  "lab.result_verified", "lab.report_published", "lab.report_amended", "lab.report_printed",
  "lab.report_print_blocked", "lab.result_critical_flagged", "lab.critical_acknowledged",
  "lab.reflex_added", "lab.sla_breached",
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
  return out;
}

export const labTopicRouter: TopicRouter = { names: LAB_REALTIME_NAMES, topicsFor: labTopicsFor };
