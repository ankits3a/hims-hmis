import { RadiologyError } from "./errors";
import type { Actor } from "@hmis/contracts";

/**
 * #1085 (IM6c) — **THE MORNING SWEEP'S ACTOR, AND THE ACTS IT MAY NEVER MAKE.**
 *
 * Every automated act of the 08:00 IST sweep (a no-show, a reminder, the digest, the register check,
 * a paid no-show's invoice carried to its rebooking) is written by this one system actor, so "what did
 * the machine do" is one query on the event log.
 *
 * System actors pass the workflow engine's role check by design (`kernel/workflow/instances.ts`: the
 * application's own automated moves). That is right for a no-show and wrong for every CLINICAL act — a
 * safety gate cleared, waived or overridden, a report signed, a critical acknowledged, an order placed
 * are a person's acts, and the value of each record is that a human asserted it. So each of those acts
 * calls `assertNotAutomation` FIRST, before it reads anything. Nothing else about any existing check
 * changes. A leaf file on purpose: the clinical acts import it, and it imports nothing of theirs.
 */
export const AUTOMATION_ACTOR: Actor = { type: "system", id: "radiology-automation" };

export function isAutomationActor(actor: Actor): boolean {
  return actor.type === AUTOMATION_ACTOR.type && actor.id === AUTOMATION_ACTOR.id;
}

export type ClinicalAct = "gate_satisfy" | "gate_waive" | "gate_override" | "sign" | "critical_acknowledge" | "order_place";

const ACT_WORDS: Record<ClinicalAct, string> = {
  gate_satisfy: "clear a safety gate", gate_waive: "waive a safety gate", gate_override: "override a safety gate",
  sign: "sign a report", critical_acknowledge: "acknowledge a critical finding", order_place: "place an order",
};

export function assertNotAutomation(actor: Actor, act: ClinicalAct): void {
  if (isAutomationActor(actor)) {
    throw new RadiologyError("automation_refused", `the morning sweep may not ${ACT_WORDS[act]} — that is a person's act`, { act });
  }
}
