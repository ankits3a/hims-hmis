import { z } from "zod";

export type Actor = { type: "user" | "agent" | "system"; id: string };

export type EventInput = {
  name: string;
  version: number;
  occurredAt: Date;
  actor: Actor;
  patientId?: string;
  encounterId?: string;
  correlationId?: string;
  causationId?: string;
  module: string;
  payload: unknown;
  siteId: string;
  idempotencyKey?: string;
};

export type MakeArgs = {
  actor: Actor;
  payload: unknown;
  occurredAt?: Date;
  patientId?: string;
  encounterId?: string;
  correlationId?: string;
  causationId?: string;
  siteId?: string;
  idempotencyKey?: string;
};

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type EventDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  module: string;
  version: number;
  payloadSchema: S;
  make: (args: MakeArgs) => EventInput;
};

export function defineEvent<S extends z.ZodTypeAny>(
  name: string,
  module: string,
  payloadSchema: S,
  version = 1,
): EventDef<S> {
  if (!NAME_RE.test(name)) {
    throw new Error(`event name "${name}" must be lowercase entity.verb_past`);
  }
  return {
    name,
    module,
    version,
    payloadSchema,
    make(args: MakeArgs): EventInput {
      const payload = payloadSchema.parse(args.payload);
      return {
        name,
        module,
        version,
        payload,
        actor: args.actor,
        occurredAt: args.occurredAt ?? new Date(),
        patientId: args.patientId,
        encounterId: args.encounterId,
        correlationId: args.correlationId,
        causationId: args.causationId,
        siteId: args.siteId ?? "main",
        idempotencyKey: args.idempotencyKey,
      };
    },
  };
}
