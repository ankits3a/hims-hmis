import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

export const OPD_TOPIC_SPACES: TopicSpace[] = [
  { prefix: "queue", permission: "opd.queue.read" },      // queue:<doctorId>:<serviceDate>
  { prefix: "display", permission: "opd.display.read" },  // display:<roomId>
  { prefix: "encounter", permission: "opd.visits.read" }, // encounter:<encounterId>
];
export const OPD_REALTIME_NAMES = [
  "queue.called", "queue.skipped", "patient.checked_in", "visit.opened", "visit.abandoned", "visit.transferred",
  "vitals.recorded", "vitals.danger_flagged", "consultation.started", "consultation.completed",
  // PLAN 07c T6 — the doctor-day opening and closing. They route on the same `queue:<doctorId>:<date>`
  // topic as everything else in the hall, which is what makes the desk's hall card go live on the
  // one fact it most needs: a session that has not opened yet.
  "queue_session.opened", "queue_session.closed",
  // RC-1 T3 — the board flip: UNPAID → PAID on the seat and the hall, without a poll.
  "queue.fee_settled",
];
type P = { doctorId?: string; fromDoctorId?: string; toDoctorId?: string; serviceDate?: string; roomId?: string | null; encounterId?: string };

export function opdTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const p = (e.payload ?? {}) as P;
  const out: string[] = [];
  if (p.serviceDate) {
    if (p.doctorId) out.push(`queue:${p.doctorId}:${p.serviceDate}`);
    if (p.fromDoctorId) out.push(`queue:${p.fromDoctorId}:${p.serviceDate}`);
    if (p.toDoctorId) out.push(`queue:${p.toDoctorId}:${p.serviceDate}`);
  }
  if (p.roomId) out.push(`display:${p.roomId}`);
  if (p.encounterId) out.push(`encounter:${p.encounterId}`);
  return out;
}
export const opdTopicRouter: TopicRouter = { names: OPD_REALTIME_NAMES, topicsFor: opdTopicsFor };
