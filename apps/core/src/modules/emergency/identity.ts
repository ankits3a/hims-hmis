import { eq } from "drizzle-orm";
import { ER_INTENTS } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { erEpisodes } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { PatientError, createMergeRequest, getPatient } from "../patients";
import { bandPerson } from "./bands";
import { alreadyOpen, lockEpisode, onceEr, openEpisodeOf, personRecords, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { erIdentityLinked } from "./events";
import { ER_IDENTITY_LINK } from "./names";
import type { Actor, ErIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db } from "../../kernel/db/client";

type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

const HOW_WORDS: Record<Input<"link_identity">["how"], string> = {
  family: "family", id_document: "an ID document", police: "police", abha: "ABHA", other: "other",
};

/**
 * ER lane 1 (#808) — `link_identity` (spec §2 Identity, §3.4, §4.1 edge "unknown later identified by family").
 *
 * The ER does not merge. It FILES the existing `patient_merge` request — unknown record (loser) into the true record
 * (winner) — through `patients.createMergeRequest`, in its own transaction with the episode's link, and the merge runs
 * where it always runs: behind the Medical Superintendent's approval (`patient_merge`, urgent, 240 min) and the merge
 * screen's execute. When it runs, the unknown record is frozen into the true one and everything filed under it follows
 * the merge chain: this episode (found under the true record, one open episode per PERSON), its band (the desk sees it
 * stale and reprints it with the true name), and what later lanes file under it (orders, bill, MLC).
 *
 * Asks `patients.merge` — the permission the merge screen's "Request merge" asks — not an ER string.
 */
export async function linkIdentity(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"link_identity">> {
  const input: Input<"link_identity"> = ER_INTENTS.link_identity.input.parse(raw);
  await requireErPermission(db, actor, ER_IDENTITY_LINK);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "link_identity", input.idempotencyKey, input, async () => {
    const e = await readEpisode(db, input.episodeId);
    const unknown = await bandPerson(db, e.patientId);
    // Not an unknown, or already merged into a true record (the chain resolves elsewhere): nothing to link.
    if (!e.unidentified || unknown.id !== e.patientId || !unknown.unidentified) throw new ErRefusal("not_unidentified");
    const found = await getPatient(db, actor, input.truePatientId);
    if (found === null) throw new ErRefusal("patient_not_found");
    if (found.patient.id === e.patientId) throw new ErRefusal("same_patient");
    if (found.patient.identityStatus === "unidentified") throw new ErRefusal("true_record_unidentified");
    // ER review (2026-10-15, DECIDED): a living unknown is not a deceased record, and a person already in the ER under
    // their own record is not this unknown — both point at the wrong record; the desk picks again.
    if (found.patient.deceasedAt !== null) throw new ErRefusal("patient_deceased");
    const winnerId = found.patient.id;
    const winnerIds = (await personRecords(db, winnerId))?.ids ?? [winnerId];
    const theirs = await openEpisodeOf(db, winnerIds);
    if (theirs !== undefined && theirs.id !== e.id) throw alreadyOpen(theirs);
    return withTx(db, async (tx) => {
      // A live request for this unknown is refused by the patients module (one live request per record); a REFUSED
      // earlier request is settled first there, so the desk can file again with the right record.
      await lockEpisode(tx, e.id);
      let filed: { mergeRequestId: string; approvalId: string };
      try {
        filed = await createMergeRequest(tx, actor, {
          winnerId, loserId: e.patientId,
          note: `Emergency ${e.episodeNo}: identified by ${HOW_WORDS[input.how]} — ${input.note}`,
        });
      } catch (err) {
        if (err instanceof PatientError && err.code === "merge_already_requested") throw new ErRefusal("merge_already_requested");
        throw err;
      }
      await tx.update(erEpisodes).set({
        identityMergeRequestId: filed.mergeRequestId, identityTruePatientId: winnerId, updatedAt: at,
      }).where(eq(erEpisodes.id, e.id));
      await appendEvent(tx, erIdentityLinked.make({
        payload: { episodeId: e.id, mergeRequestId: filed.mergeRequestId, provenance: provenanceOf(actor) },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return { episodeId: e.id, mergeRequestId: filed.mergeRequestId, approvalId: filed.approvalId, state: "merge_requested" as const };
    });
  }, at);
}
