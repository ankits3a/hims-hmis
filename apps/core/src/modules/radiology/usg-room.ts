import { evaluateReadiness, gateState, requireStudyGate, satisfyGate } from "./gates";
import type { Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS7 T3 — **THE SONOLOGIST CLOSES THE FORM F GATE HERSELF, AND ONLY THAT GATE.**
 *
 * The `form_f` gate takes NO evidence from the caller — `computeSatisfaction` reads the register
 * and refuses `form_f_missing` when no form exists — so there is nothing a sonologist could type to
 * clear it that the register does not already say. Yet the generic door (`…/gates/:kind/satisfy`)
 * is `radiology.gates.satisfy`, which the seeded `radiologist` does not hold (it is the
 * technologist's prep-bay grant), so a sonologist working alone in the room opened the form, and the
 * study then sat on `checked_in` until a technologist came in to press a button whose only input
 * was the form she had just written.
 *
 * This is that one kind, behind `pcpndt.form_f.write` — the grant of the person who writes the very
 * row the gate reads. No other gate can be reached through it, the gate's own evidence rule is
 * unchanged (`satisfyGate` → `computeSatisfaction`), the workflow edge already names `radiologist`,
 * and `form_f` stays unwaivable and un-overridable. Idempotent: a gate already satisfied is left
 * alone and readiness is simply evaluated again.
 */
export async function closeFormFGate(
  tx: Tx, actor: Actor, studyId: string, now: Date = new Date(),
): Promise<{ state: string; open: string[] }> {
  const gate = await requireStudyGate(tx, studyId, "form_f");
  if (await gateState(tx, gate.id) === "open") {
    await satisfyGate(tx, actor, gate.id, {}, now);
  }
  return await evaluateReadiness(tx, studyId);
}
