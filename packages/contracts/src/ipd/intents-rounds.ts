import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdUserRefSchema, ipdInput, ipdIntent } from "./common";

/**
 * E4.2 (#734) — the round's companion intents (spec §4.5A): the consultant's co-sign of a resident's or intern's draft
 * round, and the cross-consult — another unit's consultant asked to see the patient, which puts the patient on that
 * consultant's rounds list (their visits bill as `cross_visit` through the charges seam; the doctor sees no money).
 */

/** The treating consultant co-signs a resident's or intern's draft round. Co-signing is not a visit. */
export const cosignRound = ipdIntent({
  input: ipdInput({ roundId: IpdIdSchema, note: IpdNoteSchema.optional() }),
  output: z.strictObject({
    roundId: IpdIdSchema, status: z.literal("signed"), cosignedBy: IpdUserRefSchema, cosignedAt: IpdInstantSchema,
  }),
  refusals: ["round_not_found", "round_not_awaiting_cosign", "not_treating_consultant"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.round.cosigned"],
  idempotent: true,
});

export const requestConsult = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    /** The consultant asked (a user on the doctor master). */
    consultantId: IpdUserRefSchema,
    question: IpdNoteSchema,
    urgency: z.enum(["routine", "urgent"]),
  }),
  output: z.strictObject({ consultId: IpdIdSchema, status: z.literal("open"), requestedAt: IpdInstantSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "not_treating_team", "consultant_not_found", "consult_already_open"],
  actors: ["doctor", "resident"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.consult.requested"],
  idempotent: true,
});

/** The consulted consultant signs off (or the treating team withdraws the ask): the patient leaves their list. */
export const closeConsult = ipdIntent({
  input: ipdInput({ consultId: IpdIdSchema, note: IpdNoteSchema.optional() }),
  output: z.strictObject({ consultId: IpdIdSchema, status: z.literal("closed"), closedAt: IpdInstantSchema }),
  refusals: ["consult_not_found", "consult_closed", "not_treating_team"],
  actors: ["doctor", "resident"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.consult.closed"],
  idempotent: true,
});
