import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// Plan 08.5 D8 — two new catalog names, module "worker". No per-tick events (Global
// Constraint 11): the heartbeat row is an UPDATE every 1-2 s; these events exist only for a
// THROWN run and a PARKED delivery, never for an ordinary successful tick.

// Appended by the scheduler (kernel/worker/scheduler.ts) when a job's run(now) throws.
export const sweepFailed = defineEvent(
  "sweep.failed",
  "worker",
  z.object({
    job: z.string(),
    error: z.string(),
    durationMs: z.number().int(),
  }),
);

// Appended inside the dispatcher's poison-parking transaction (T3, dispatcher.ts) once a
// delivery crosses maxAttempts. Defined here, on T2's own file, so T3 can import the shape
// without T2 and T3 colliding on the same source file — T2 does not append it itself.
export const consumerPoisoned = defineEvent(
  "consumer.poisoned",
  "worker",
  z.object({
    consumer: z.string(),
    seq: z.number().int(),
    eventId: z.string(),
    error: z.string(),
    attempts: z.number().int(),
  }),
);
