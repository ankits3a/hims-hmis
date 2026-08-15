export type QueueClass = 0 | 1 | 2 | 3 | 4; // danger · re-entry · due appointment · walk-in · future appointment
export type QueueEntryState = {
  id: string; tokenNo: number; kind: "appointment" | "walk_in"; appointmentAt: Date | null;
  eligibleAt: Date; seq: number; danger: boolean; reEntry: boolean; perk: boolean; skips: number;
};
export type QueuePolicy = { perkEveryNth: number | null };

/** §11.1 + E-32 + the re-entry class. Pure. */
export function classOf(e: QueueEntryState, now: Date): QueueClass {
  if (e.danger) return 0;
  if (e.reEntry) return 1;
  if (e.kind === "appointment" && e.appointmentAt !== null) return e.appointmentAt.getTime() <= now.getTime() ? 2 : 4;
  return 3;
}

function compare(a: QueueEntryState, b: QueueEntryState, now: Date): number {
  const ca = classOf(a, now), cb = classOf(b, now);
  if (ca !== cb) return ca - cb;
  const byAppt = ca === 2 || ca === 4;
  const ka = byAppt ? a.appointmentAt!.getTime() : a.eligibleAt.getTime();
  const kb = byAppt ? b.appointmentAt!.getTime() : b.eligibleAt.getTime();
  if (ka !== kb) return ka - kb;
  return a.seq - b.seq; // arrival order — the bigserial, never the ULID
}

/**
 * Full ordering of the WAITING entries. Danger → re-entry → due appointments (by slot; late keeps priority, never expires)
 * → walk-ins FIFO (by eligibleAt; a skip re-queues) → future appointments (a walk-in beats a future appointment, never a due one).
 * E-32 perk hook: on every Nth call the earliest class-3 perk entry heads the walk-ins — only when the plain head is a walk-in,
 * so danger, re-entry and due appointments are never overtaken. Plan 07 never sets perk; Plan 09 does.
 */
export function orderQueue(entries: QueueEntryState[], now: Date, policy: QueuePolicy, callsMade: number): QueueEntryState[] {
  const sorted = [...entries].sort((a, b) => compare(a, b, now));
  const n = policy.perkEveryNth;
  if (n !== null && n >= 1 && (callsMade + 1) % n === 0) {
    const head = sorted[0];
    if (head !== undefined && classOf(head, now) === 3) {
      const idx = sorted.findIndex((x) => x.perk && classOf(x, now) === 3);
      if (idx > 0) {
        const [p] = sorted.splice(idx, 1);
        sorted.unshift(p!);
      }
    }
  }
  return sorted;
}

export function nextInQueue(entries: QueueEntryState[], now: Date, policy: QueuePolicy, callsMade: number): QueueEntryState | null {
  return orderQueue(entries, now, policy, callsMade)[0] ?? null;
}
