import { withIdempotency } from "../billing";
import { listMergedLoserIds, registerPatient, resolvePatientId, searchPatients } from "../patients";
import type { MatchLane } from "../patients";
import { withTx } from "../../kernel/db/client";
import { hasPermission } from "../../kernel/auth/permissions";
import { openVisitInTx } from "./encounters";
import { OpdError } from "./errors";
import type { OpenVisitDeferredResult, OpenVisitInput, OpenVisitResult } from "./encounters";
import type { RegisterPatientInput } from "../patients";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07b T6 — THE WALK-IN, AS ONE ACT.
 *
 * A walk-in cost SEVEN backend calls in seven separate transactions, orchestrated by the browser.
 * Two of those steps carried real data defects rather than merely being slow:
 *
 *   · `registerPatient` has NO idempotency of any kind (only billing had it), so a request the
 *     network duplicated after the clerk stopped waiting minted a SECOND UHID for the same person.
 *   · It has NO duplicate check either — it allocates a UHID and inserts, unconditionally — so
 *     "search before you register" was a human convention, not a system rule. At sixteen counters
 *     that is a duplicate-UHID factory, and a duplicate UHID is a split medical record.
 *
 * ═══ WHAT THIS DOES AND DOES NOT PROMISE, STATED RATHER THAN IMPLIED ═══
 *
 * Registration and visit-opening happen in ONE transaction: either the patient exists and is in the
 * queue, or neither happened. That is the pair where a partial write left a person half-created.
 *
 * **BILLING IS NOT INSIDE THAT TRANSACTION**, and the plan's DD7 asked for it to be. The reason is
 * measured, not a shortcut: `issueInvoice` is a 330-line function whose entire body runs inside its
 * own `withTx`, and `withTx` takes a `Db`, never a `Tx`. Spanning it would mean restructuring the
 * transaction boundary of the hospital's money path — a change that deserves its own task and its
 * own review, not a quiet refactor bundled with a counter screen. DD7 named this outcome in advance
 * ("if T6 slips, the atomicity gap is stated, not hidden"), so it is stated here and in the close.
 *
 * The residual gap is exactly today's behaviour and no worse: a visit can be open and unbilled. The
 * pay-before-consult gate already refuses to let the doctor start in that state, so the patient
 * cannot be seen for free — the cost is a visit the counter must still collect on, which is what
 * the counter screen's DD2 exit banner exists to make visible.
 */
export type WalkInPatient = { existingId: string } | { register: RegisterPatientInput };

export type WalkInInput = Omit<OpenVisitInput, "patientId"> & {
  patient: WalkInPatient;
  /**
   * The clerk saw the near-matches and is registering anyway. DD8: the duplicate check is a WARNING
   * a human may override, never a gate — a real second Asha Devi on the same phone must still be
   * registrable, and a system that refuses her teaches the desk to invent phone numbers.
   */
  acknowledgedDuplicates?: boolean;
};

/**
 * ═══ FD-7 T1 — WHAT A CLERK NEEDS IN ORDER TO ANSWER THE QUESTION THEY ARE BEING ASKED ═══
 *
 * This used to be `{id, uhid, name}`, and FD-6 had already proved on 10,000 patients why that is
 * not enough: a list of rows reading "Ramesh Kale" beside an eleven-character UHID the patient
 * cannot recite tells the clerk nothing they can check against the person in front of them. Here it
 * matters more than it did on the search row, because this list is shown at the one moment somebody
 * decides whether to create a SECOND medical record for a person who already has one.
 *
 * Every field below was already in `nearMatches`'s hand and thrown away — this is the display
 * subset of `PatientSearchResult`, minus `hasPhoto` (the bytes are a second round trip). `matchedOn`
 * is the one that changes the list from a lineup into an answer: the seat renders it through the
 * same `matchReasonKeys` the search row uses, so a candidate says *why* it is a candidate.
 *
 * `isConfidential` travels so the seat can MARK the row. It is not the access control — that is
 * `searchPatients`, which refuses confidential rows to an actor without `patients.confidential.read`
 * before they ever reach this type, and `walk-in.test.ts` pins it.
 */
export type DuplicateCandidate = {
  id: string;
  uhid: string;
  name: string | null;
  phone: string | null;
  administrativeGender: string;
  dob: Date | null;
  isConfidential: boolean;
  matchedOn: MatchLane[];
};

export type WalkInResult = OpenVisitResult & {
  patientId: string;
  /** True when this call created the patient — the counter says "registered" rather than "found". */
  registered: boolean;
};

/**
 * RC-1 CLOSE M2 — what `join: "defer"` actually returns: the visit with NULL token/session/entry
 * (`joinQueue` fills them after billing). Spike S2 named this trap in as many words and T3 shipped
 * without it: the overloads below existed on `openVisitInTx` while this file still promised the
 * non-null shape for every call, so a deferred caller's `result.tokenNo` type-checked as `number`
 * and arrived `null`.
 */
export type WalkInDeferredResult = OpenVisitDeferredResult & { patientId: string; registered: boolean };

/**
 * The near-match probe. It reuses `searchPatients` rather than inventing a matcher: that function
 * already carries the phone/UHID/name lanes and the trigram fallback the desk searches with, so the
 * candidates a clerk is warned about are exactly the ones they would have found by searching — which
 * is the whole point of warning them.
 *
 * `duplicate_candidates` as a TABLE belongs to Plan 22, and this deliberately does not build one.
 */
async function nearMatches(db: Db, actor: Actor, input: RegisterPatientInput): Promise<DuplicateCandidate[]> {
  const probes = [input.phone, input.name].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const seen = new Map<string, DuplicateCandidate>();
  for (const probe of probes) {
    for (const hit of await searchPatients(db, actor, probe, 5)) {
      /*
       * FD-7 T1 — THE LANES ARE UNIONED ACROSS PROBES, NOT OVERWRITTEN.
       *
       * This loop runs `searchPatients` once per probe (the phone, then the name), and each call
       * reports only the lanes ITS OWN query fired. A bare `set` therefore kept whichever probe ran
       * LAST, so the person who matches on both — the most likely duplicate in the list, and the
       * only one the clerk should hesitate over — was labelled "same name" and never "same mobile".
       * The stronger signal was the one being dropped. Widening the type is what exposed this; the
       * old `{id, uhid, name}` had nowhere for it to show.
       */
      const before = seen.get(hit.id);
      seen.set(hit.id, {
        id: hit.id, uhid: hit.uhid, name: hit.name, phone: hit.phone,
        administrativeGender: hit.administrativeGender, dob: hit.dob,
        isConfidential: hit.isConfidential,
        matchedOn: [...new Set([...(before?.matchedOn ?? []), ...hit.matchedOn])],
      });
    }
  }
  return [...seen.values()];
}

export async function walkIn(
  db: Db, actor: Actor, input: WalkInInput & { join: "defer" }, idempotencyKey: string | undefined, now?: Date,
): Promise<WalkInDeferredResult>;
export async function walkIn(
  db: Db, actor: Actor, input: Omit<WalkInInput, "join"> & { join?: "queue" }, idempotencyKey: string | undefined, now?: Date,
): Promise<WalkInResult>;
export async function walkIn(
  db: Db, actor: Actor, input: WalkInInput, idempotencyKey: string | undefined, now?: Date,
): Promise<WalkInResult | WalkInDeferredResult>;
export async function walkIn(
  db: Db,
  actor: Actor,
  input: WalkInInput,
  idempotencyKey: string | undefined,
  now: Date = new Date(),
): Promise<WalkInResult | WalkInDeferredResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");

  return withIdempotency(
    db,
    { actorId: actor.id, route: "opd.walkIn", key: idempotencyKey },
    input,
    async () => {
      // The duplicate probe is a READ and happens before the transaction: it must not hold write
      // locks while a human decides, and its answer is advisory either way.
      const who = input.patient;
      /**
       * PLAN 07b T6 — the registration permission, asserted HERE because the guard cannot.
       * `@RequirePermission` writes one metadata key, so a second decorator would have overwritten
       * the first and left this route creating patients behind `opd.visits.open` alone. Checked only
       * on the branch that creates one: attaching an existing patient needs no such authority.
       */
      if ("register" in who && !(await hasPermission(db, actor.id, "patients.register", "hospital"))) {
        throw new OpdError("registration_not_permitted", "this account may open visits but not register patients");
      }
      if ("register" in who && input.acknowledgedDuplicates !== true) {
        const candidates = await nearMatches(db, actor, who.register);
        if (candidates.length > 0) {
          throw new OpdError(
            "duplicate_suspected",
            `${String(candidates.length)} existing patient(s) closely match this registration`,
            { candidates },
          );
        }
      }

      return withTx(db, async (tx) => {
        let patientId: string;
        let registered = false;
        if ("existingId" in who) {
          const canonical = await resolvePatientId(tx, who.existingId);
          if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${who.existingId}`);
          patientId = canonical;
        } else {
          const { patient } = await registerPatient(tx, actor, who.register);
          patientId = patient.id;
          registered = true;
        }
        const chainIds = [patientId, ...(await listMergedLoserIds(tx, patientId))];
        const opened = await openVisitInTx(tx, actor, { ...input, patientId, chainIds }, now);
        return { ...opened, patientId, registered };
      });
    },
    now,
  );
}
