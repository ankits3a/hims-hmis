import { z } from "zod";

/**
 * PLAN 22c-A T2 (DD1) — the fourth member, and its default is REFUSE.
 *
 * `patient` is the actor a person acts as on their own record: booking their own slot, reading
 * their own report, amending their own name. It exists because every step of the patient app is
 * currently refused BY DESIGN — 41 executable guard sites throw `user_actor_required` — and no
 * amount of front-end work changes that until the union has a fourth member.
 *
 * ADDING IT OPENS NOTHING, AND THAT IS THE POINT. Every guard that today asks
 * `actor.type !== "user"` keeps refusing a patient actor; 22c-B and 22c-C open them one at a
 * time, each with its own test. This phase's T2 is a proof of NON-change, which is the only kind
 * of proof that makes widening a union safe.
 *
 * `id` IS THE PHONE IDENTITY, NEVER A PATIENT (review G2, ruled). For `type: "patient"` the id is
 * the `patient_credentials` row — the verified phone — and the SUBJECT patient is always
 * `patientId` in the envelope below. One phone with three profiles booking for the mother stamps
 * the phone identity as actor and the mother as subject; anything else makes a household
 * unrepresentable. Two consequences that bit during this phase's audit:
 *
 *   1. A patient id is in no `users` row, so `hasPermission(actor.id, …)` is not merely useless
 *      against it — it returns FALSE, and false on a confidentiality check silently aliases a
 *      confidential patient TO THEMSELVES (review D11; four specimens live today). The rule: a
 *      patient actor is "self" for its own accessible set, and no permission lookup runs on a
 *      patient id.
 *   2. Desk surfaces resolving `bookedBy` to a staff name must tolerate an id that resolves to
 *      nobody (review G12).
 *
 * AND THE TRAP THIS UNION SETS FOR ITS OWN READERS. A four-member union turns every exhaustive
 * `if user … else if agent …` into a chain with a silent fall-through. `workflow/instances.ts`
 * carried exactly that shape and its fall-through was the trusted branch — see the note there.
 * When you widen this type, grep for the members you did NOT name.
 */
export type Actor = { type: "user" | "agent" | "system" | "patient"; id: string };

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
