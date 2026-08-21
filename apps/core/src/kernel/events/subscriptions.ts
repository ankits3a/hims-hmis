export type DispatchedEvent = {
  seq: number;
  eventId: string;
  name: string;
  payload: unknown;
  patientId: string | null;
  correlationId: string | null;
  /**
   * THE EVENT'S OWN `occurred_at`, NEVER THE DISPATCHER'S CLOCK (Plan 10 D5). Every scheduling
   * and staleness decision a consumer makes reads THIS, so a replayed event computes the same
   * answer it would have computed the first time: a month-old booking expires instead of
   * sending, and a reminder is scheduled from the appointment's meaning rather than from
   * whenever the worker happened to catch up. `events.occurred_at` is NOT NULL
   * (schema/events.ts:10), so this is never absent; `dispatcher.ts` projects it and N11 pins
   * that a handler receives the inserted row's own instant.
   */
  occurredAt: Date;
};

export type Handler = (e: DispatchedEvent) => Promise<void>;

export class SubscriptionBus {
  private byConsumer = new Map<string, { events: Set<string>; handler: Handler }>();

  on(consumer: string, eventName: string, handler: Handler): void {
    const entry = this.byConsumer.get(consumer);
    if (entry) {
      entry.events.add(eventName);
    } else {
      this.byConsumer.set(consumer, { events: new Set([eventName]), handler });
    }
  }

  consumers(): { consumer: string; events: string[]; handler: Handler }[] {
    return [...this.byConsumer.entries()].map(([consumer, v]) => ({
      consumer, events: [...v.events], handler: v.handler,
    }));
  }
}
