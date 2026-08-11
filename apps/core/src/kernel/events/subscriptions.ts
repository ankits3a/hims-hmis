export type DispatchedEvent = {
  seq: number;
  eventId: string;
  name: string;
  payload: unknown;
  patientId: string | null;
  correlationId: string | null;
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
