import { Body, Controller, ForbiddenException, Get, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { and, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { printJobs, users } from "../db/schema";
import { claimPrintJobs, reportFailed, reportPrinted } from "./claim";
import { enqueuePrintJob } from "./enqueue";
import { withTx } from "../db/client";
import { renderDocument } from "./render";
import { getPatient } from "../../modules/patients";
import { recordPhiAccess } from "../phi/audit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T2 — THE RELAY'S THREE ROUTES, AND THE ONLY THREE IT GETS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The relay runs inside the hospital and talks OUTWARD to this server: it claims work, prints it,
 * and says what happened. It never accepts a connection, so the hospital needs no inbound firewall
 * hole and no static address — which is the whole reason the relay design beat "the server submits
 * to a printer queue" once it turned out the server is in Helsinki and the printers are in Hajipur.
 *
 * ═══ WHY THESE ROUTES CARRY NO `@RequirePermission` ═══
 *
 * They authenticate as an AGENT (`x-agent-key`, `AuthGuard`), and `PermissionGuard` refuses every
 * non-user actor outright — *"agents hold no permissions yet"* — because agent permission grants
 * are Plan 12's seam and its `agent_permissions` table does not exist. A decorator here would
 * therefore refuse the relay 100% of the time, not protect it.
 *
 * So the check is explicit and in the handler: the actor MUST be an agent. That is narrower than it
 * sounds — an agent exists only when an administrator creates one, `createAgent` mints a random key
 * and stores only its SHA-256, and `AuthGuard` already honours the per-agent kill switch, so an
 * abused relay credential is revoked without a deploy.
 *
 * **STATED PLAINLY AS A LIMITATION, because it is one:** until Plan 12 lands agent permissions, ANY
 * agent may serve the print queue. Today that set is empty — nothing else in this system uses agent
 * auth — so the practical exposure is that a future agent created for another purpose could also
 * drain print jobs. Tightening this to a per-agent destination grant is the obvious first use of
 * `agent_permissions` when it exists.
 *
 * **AND THE RELAY IS A PHI PROCESSOR — SAID PLAINLY, BECAUSE T3 CHANGED THIS.** An earlier draft of
 * this header claimed a claim "returns identifiers, not patient data". That was true when the claim
 * returned only `params`; it is FALSE now that the rendered document travels with the claim, and it
 * has to be false — a relay that could not learn the patient's name could not print it on a slip.
 * What remains true is narrower and worth keeping: the QUEUE ROW stores identifiers only, so
 * `print_jobs` never becomes a second copy of the patient record at rest.
 */

const claimBody = z.object({
  /** Which destinations this relay can actually reach. A relay must not claim a printer it cannot see. */
  destinations: z.array(z.string().min(1)).min(1).max(10),
  limit: z.number().int().min(1).max(50).default(10),
});

const failedBody = z.object({
  jobId: z.string().min(1),
  /** Truncated on the way into the column; the relay's message is a diagnosis, not a payload. */
  error: z.string().min(1).max(2000),
});

const printedBody = z.object({ jobId: z.string().min(1) });

const reprintBody = z.object({
  jobId: z.string().min(1),
  reason: z.string().max(300).optional(),
});

/** What one claimed job looks like on the wire. `page` is the geometry the relay prints at. */
type PrintJobPayload = {
  id: string; document: string; destination: string;
  title: string; html: string;
  page: { widthMm: number; heightMm: number | null };
};

/**
 * FD-25 CLOSE — the actor this controller uses to RESOLVE a patient, never to decide about one.
 *
 * `recordPhiAccess` documents its `patientId` as *"the CANONICAL patient id — callers resolve the
 * merge chain before writing"*, and the legal-hold clamp in `prunePhiAccessLog` matches holds by
 * that column: a row filed under a merged-away id is invisible to an enquiry about the surviving
 * patient and unprotected by a hold placed on them. `getPatient` is the chain walk, and it takes an
 * actor — so the resolution needs one that is guaranteed to see the row. `system` is that actor by
 * `getPatient`'s own rule ("internal machinery must resolve"), and it is emphatically NOT the
 * §14 decision: who may see the NAME is decided per requester, in `displayNameForRelease`.
 */
const PRINT_AUDIT_ACTOR: Actor = { type: "system", id: "printing-audit" };

@Controller("print")
export class PrintingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The relay is an agent, never a person. Stated once, used by all three routes. */
  private relayId(actor: Actor): string {
    if (actor.type !== "agent") {
      throw new ForbiddenException("the print queue is served by a relay agent, not by a user");
    }
    return actor.id;
  }

  /**
   * Claim work. The relay polls this; an empty array is the ordinary answer and not an error.
   *
   * The response carries the RENDERED DOCUMENT, patient name and all — see the header. That is the
   * offline guarantee, and it is why this route is the one place in the system where an agent
   * credential reaches PHI.
   */
  @Post("claim")
  async claim(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ jobs: PrintJobPayload[] }> {
    const input = claimBody.parse(body);
    const relayId = this.relayId(actor);
    const jobs = await claimPrintJobs(this.db, {
      relayId,
      destinations: input.destinations,
      limit: input.limit,
    });

    /*
      ═══ FD-25, OWNER RULING 2026-09-05 — THE RENDERER IS TOLD WHO ASKED FOR THE PAPER ═══

      A §14 patient's slip carries their ALIAS unless the operator who asked for it has been through
      the grant, and `renderDocument` cannot know that from a job id. `print_jobs.requested_by` is the
      column that knows: `openVisitInTx` writes the clerk who opened the visit, and `reprint` below
      writes the clerk who asked for the second copy. Both write it ONLY for a user actor, so
      rebuilding a `user` actor from it is faithful rather than a guess — and a value that somehow was
      not a user id resolves to no permissions, which is the alias, which is the safe direction.

      IT IS A SECOND READ RATHER THAN A FIELD ON `ClaimedJob` because `claim.ts` belongs to another
      lane this session; the natural home for this is beside `patientId` on the claim itself, which
      already travels for exactly this kind of question. One indexed read per claim, not per job.

      A NULL REQUESTER IS NOT AN OMISSION — it is the answer for a row nobody signed, and the
      renderer's default treats it as such.

      ═══ FD-25 CLOSE — AND THE `user` TYPE IS RESOLVED, NOT ASSERTED ═══

      `print_jobs.requested_by` is nullable text with NO foreign key, deliberately: the enqueue rides
      the visit's own transaction, so an FK there would REFUSE THE WHOLE REGISTRATION for any actor
      with no `users` row — caught by `perf-opd-queue` before it shipped, and exactly what owner
      ruling R7 forbids (see the schema's own note). The check below is a READ and re-introduces
      none of that: nothing here can refuse an enqueue. So the column can hold any string, and this
      route USED to declare whatever it held to be a user id. Both of today's writers do guard it
      (`openVisitInTx` and `reprint`, each `actor.type === "user" ? actor.id : null`), and
      `break_glass_grants.user_id` carries a real FK to `users`, so no machine id could ever have
      inherited a person's grant — the manufactured type leaked nothing.

      IT IS RESOLVED NOW BECAUSE THE AUDIT BELOW ATTRIBUTES A DISCLOSURE TO THIS ID. A row in
      `phi_access_log` saying `actor_type = 'user'` over a nightly batch's id would be a false
      answer to the one question that log is asked, and the next producer to queue paper —
      `enqueue.ts` records that `opd_payment_receipt` still owes one — is one forgotten ternary
      away from writing it. An id that is not a live user resolves to NO requester, which is the
      alias and no attribution: the safe direction on both counts.
    */
    const requesters = new Map<string, string | null>();
    if (jobs.length > 0) {
      const rows = await this.db
        .select({ id: printJobs.id, requestedBy: printJobs.requestedBy })
        .from(printJobs)
        .where(inArray(printJobs.id, jobs.map((j) => j.id)));
      const claimedIds = rows.map((r) => r.requestedBy).filter((r): r is string => r !== null);
      const liveUsers = new Set<string>();
      if (claimedIds.length > 0) {
        const found = await this.db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, claimedIds), eq(users.active, true)));
        for (const u of found) liveUsers.add(u.id);
      }
      for (const row of rows) {
        const id = row.requestedBy;
        requesters.set(row.id, id !== null && liveUsers.has(id) ? id : null);
      }
    }

    /*
      ═══ THE DOCUMENT TRAVELS WITH THE CLAIM, AND THAT IS THE OFFLINE GUARANTEE ═══

      The brief's binding constraint is *"patient care must never depend on internet
      connectivity."* If the relay had to come back for the document, an outage between the claim
      and the print would mean no paper. Carrying the rendered HTML makes the relay autonomous the
      moment it holds a job: it can work through a queue with the uplink down.

      A DOCUMENT THAT WILL NOT RENDER IS FAILED HERE, NOT HANDED OVER HALF-BUILT. The commonest
      cause is a `vitals_slip`, which has no artboard yet and deliberately renders null — better an
      honest advisory failure the screen reports (R7) than a slip nobody designed.
    */
    const out: PrintJobPayload[] = [];
    for (const job of jobs) {
      const requestedBy = requesters.get(job.id) ?? null;
      const rendered = await renderDocument(
        this.db, job.document, job.params, new Date(),
        requestedBy === null ? null : { type: "user", id: requestedBy },
      );
      if (rendered === null) {
        await reportFailed(this.db, job.id, relayId, `no renderer produced a document for ${job.document}`);
        continue;
      }
      out.push({
        id: job.id, document: job.document, destination: job.destination,
        title: rendered.title, html: rendered.html, page: rendered.page,
      });
    }

    /*
      ═══ FD-24 CLOSE — THE DISCLOSURE THIS HEADER DESCRIBES IS NOW ALSO RECORDED ═══

      The header above says this route is "the one place in the system where an agent credential
      reaches PHI", and until now that was the whole of the treatment: noticed, written down, and
      not logged. An audit trail with a hole exactly where a machine credential reads patient data
      is worse than one that never claimed to cover it.

      ONE ROW PER PATIENT DISCLOSED, not one per job and not one per request. Two slips for the same
      person in one claim is one disclosure; a claim carrying eleven patients is eleven, and a claim
      that rendered nothing is none. That is `imaging.worklist`'s rule — the exact analogue, a
      machine-facing export to a device credential — and its close review arrived at it because a
      withheld study "left the process as nothing".

      AFTER the loop, so a job that failed to render is not logged as a disclosure: nothing left the
      building. `recordPhiAccess` swallows its own errors by design, so this cannot fail a claim the
      relay is waiting on — printing is advisory (R7) and an audit write must not become the thing
      that stops paper.

      ═══ FD-25 CLOSE — AND THE ROW SAYS WHAT WAS ACTUALLY DISCLOSED, AND ON WHOSE CLEARANCE ═══

      Two things were wrong with it, and they compounded. **`sealed` was left to default false**
      (`phi/audit.ts`), so a §14 patient's paper — which THIS route releases, the reprint only ever
      being the second copy — was filed as an ordinary read, and the enquiry the flag exists for
      ("who read SEALED records last month") answered no for the route that put the name on paper.
      The reprint was fixed for exactly this a few lines down; the first print was not.

      **And the row named the RELAY.** `relayId` guarantees the actor is an agent, so the only
      accountable party in the log was a machine, while the clearance that released the legal name
      belonged to a person who is on `pendingReviews` with their stated reason attached. "Who caused
      this patient's legal name to be printed, and under what justification" had no answer: the
      grant sat in `break_glass_grants` joined to no disclosure.

      SO A SEALED PATIENT'S RELEASE GETS A SECOND ROW PER REQUESTING OPERATOR, attributed to them.
      Not one per job — two slips for one person on one clearance is one disclosure — and NOT for
      an ordinary patient, whose claim is still exactly the one relay row it always was. That keeps
      the FD-24 rule ("one row per patient disclosed") for the 99.9% of paper this hospital prints
      and pays the extra write only where accountability for a §14 release is the actual question.
    */
    const disclosed = new Map<string, Set<string>>();
    for (const job of jobs) {
      if (job.patientId === null) continue;
      if (!out.some((o) => o.id === job.id)) continue;
      const askedBy = disclosed.get(job.patientId) ?? new Set<string>();
      const requestedBy = requesters.get(job.id) ?? null;
      if (requestedBy !== null) askedBy.add(requestedBy);
      disclosed.set(job.patientId, askedBy);
    }
    const claimed = `print relay ${relayId} claimed ${String(out.length)} document(s) for ${input.destinations.join(", ")}`;
    for (const [rawPatientId, askedBy] of disclosed) {
      /* THE CANONICAL ID, because that is what `recordPhiAccess` documents its column to be and
         what `prunePhiAccessLog`'s legal-hold clamp matches on. A print job carries the id the
         encounter had; a merge moves the person. */
      const resolved = await getPatient(this.db, PRINT_AUDIT_ACTOR, rawPatientId);
      const patientId = resolved === null ? rawPatientId : resolved.patient.id;
      const sealed = resolved !== null && resolved.patient.isConfidential;
      await recordPhiAccess(this.db, {
        actor,
        patientId,
        surface: "print.claim",
        sealed,
        reason: `${claimed} · requested by ${askedBy.size === 0 ? "nobody — the job carried no requester" : [...askedBy].join(", ")}`,
      });
      if (!sealed) continue;
      for (const userId of askedBy) {
        /* `getPatient` is asked AS THE OPERATOR, so the grant it reports is the one that actually
           opened this record for them — the justification, not merely the fact. It is the same call
           the reprint route logs from, and a second implementation of "which grant let them in"
           is how the two start disagreeing about a VIP. */
        const asRequester = await getPatient(this.db, { type: "user", id: userId }, patientId);
        const grant = asRequester === null ? null : asRequester.breakGlass;
        await recordPhiAccess(this.db, {
          actor: { type: "user", id: userId },
          patientId,
          surface: "print.claim",
          sealed: true,
          reason: [
            `paper released to print relay ${relayId} on this operator's clearance`,
            grant === null ? null : `break-glass ${grant.id}: ${grant.reason}`,
          ].filter((x) => x !== null).join(" · "),
        });
      }
    }
    return { jobs: out };
  }

  /** Paper came out. Guarded on the claim, so a relay whose lease lapsed cannot overwrite the winner. */
  @Post("printed")
  async printed(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ accepted: boolean }> {
    const { jobId } = printedBody.parse(body);
    return { accepted: await reportPrinted(this.db, jobId, this.relayId(actor)) };
  }

  /**
   * ═══ WHAT THE COUNTER SEES — owner ruling R7, and the reason this route exists at all ═══
   *
   * A print failure is ADVISORY: nothing in the money or queue path waits on a printer. But advisory
   * is not the same as silent. If the slip did not come out, the clerk has to KNOW, while the
   * patient is still standing there — otherwise "advisory" just means the hospital finds out from
   * the patient. This is the read the screen polls to say so.
   *
   * It is scoped to ONE ENCOUNTER, deliberately: this is the desk asking about the patient in front
   * of it, not a queue browser. `opd.visits.open` is the permission because opening the visit is
   * what queued the paper — anyone who may create the slip may see whether it printed.
   */
  @Get("jobs")
  @RequirePermission("opd.visits.open", "hospital")
  async jobsFor(@CurrentActor() actor: Actor, @Query("encounterId") encounterId: string): Promise<{
    jobs: { id: string; document: string; status: string; attempts: number; lastError: string | null; printedAt: string | null; createdAt: string }[];
  }> {
    if (typeof encounterId !== "string" || encounterId.trim() === "") return { jobs: [] };
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(eq(printJobs.encounterId, encounterId))
      .orderBy(desc(printJobs.createdAt));

    /**
     * ═══ FD-25 CLOSE — THE SAME §14 GATE THE REPRINT GOT, ON THE SAME PERMISSION ═══
     *
     * The reprint's gate below states the class and this route was the other instance of it:
     * `opd.visits.open` is held at HOSPITAL scope by every front-desk role, and this route took a
     * bare `encounterId`. It answered an encounter that does not exist with an empty list, and a
     * SEALED patient's encounter with document kinds, statuses, attempt counts, relay-authored
     * error text and print times. Encounter ids for sealed patients are on the queue board — which
     * aliases the NAME and not the ID — so that difference is an enumeration oracle: lift the ids
     * off the board, call this, and the shape of the answer says which of your colleagues' patients
     * are confidential.
     *
     * `getPatient` IS the decision, exactly as it is for the reprint, rather than a second
     * confidentiality rule written here. And the refusal is the SAME `{ jobs: [] }` an unknown
     * encounter gets (07a DD2): sealed and absent must be indistinguishable from outside.
     *
     * ONE INVISIBLE SUBJECT HIDES THE WHOLE LIST rather than filtering row by row. Every job on one
     * encounter is about one patient, so a partial answer could only ever be a partial answer about
     * a patient this caller may not know exists — which is the leak wearing a fix's clothes.
     *
     * A job with a NULL `patient_id` gates on nothing, and that is right rather than an omission:
     * `print_jobs.patient_id` is nullable precisely so a document about no person (a session
     * summary, a day's totals) need not invent one, and there is no confidentiality question to
     * ask about a document that names nobody. No producer writes one for an OPD encounter today.
     */
    const subjects = new Set(rows.map((r) => r.patientId).filter((p): p is string => p !== null));
    for (const patientId of subjects) {
      const visible = await getPatient(this.db, actor, patientId);
      if (visible === null) return { jobs: [] };
    }
    return {
      jobs: rows.map((r) => ({
        /*
          FD-25 — `createdAt` TRAVELS, so the screen does not have to trust this route's ORDER.

          The rows come back newest-first and the client's own comment said so, which made the
          summary's correctness depend on a sentence in a comment two files apart. A reprint is a
          NEW row for a document that already has one, so "which of these is the current state of
          the token slip" is a question the screen genuinely has to answer — and it should answer it
          from a value, not from an ordering somebody may change for a good reason later.
        */
        createdAt: r.createdAt.toISOString(),
        id: r.id,
        document: r.document,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        printedAt: r.printedAt === null ? null : r.printedAt.toISOString(),
      })),
    };
  }

  /**
   * ═══ REPRINT — A NEW ROW, NEVER A RESURRECTED ONE ═══
   *
   * A reprint is a NEW job with a NEW dedupe key and a NEW requester, not a `failed` row flipped
   * back to `queued`. Two reasons and the second is the one that matters:
   *
   *   · the dedupe key exists so the SAME slip is queued once; a reprint is deliberately a second
   *     slip, and re-using the key would make it silently do nothing;
   *   · "who printed this again, and when" is a question a hospital asks about a document carrying a
   *     patient's name. Reviving the row erases the first attempt; a new row keeps both.
   *
   * The paper is identical because the renderer resolves the record at render time — which is also
   * why a reprint after a name correction hands over the CORRECTED name.
   */
  @Post("reprint")
  @RequirePermission("opd.visits.open", "hospital")
  async reprint(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ id: string | null }> {
    const { jobId, reason } = reprintBody.parse(body);
    const rows = await this.db.select().from(printJobs).where(eq(printJobs.id, jobId));
    const original = rows[0];
    if (original === undefined) return { id: null };

    /**
     * ═══ FD-25 — THE §14 GATE THIS ROUTE DID NOT HAVE ═══
     *
     * `opd.visits.open` is held at HOSPITAL scope by every front-desk role, and this route took a
     * bare `jobId`. So any holder could reprint any job in the outbox — INCLUDING a document about
     * a patient whose record they cannot open. The paper carries a legal name, a UHID and an age;
     * the confidentiality model exists precisely to keep those from someone without the grant, and
     * `kernel/printing` contained zero references to it.
     *
     * `getPatient` IS the decision — merge chain, `patients.confidential.read`, and an active
     * break-glass grant if the reader has one — so the gate is that call rather than a second
     * confidentiality rule written here. A second implementation of "may this person see this
     * patient" is how the two start disagreeing.
     *
     * `{ id: null }` FOR BOTH REFUSALS, and that is 07a DD2 rather than laziness: a route that
     * answered differently for "sealed" and "no such job" would let a caller enumerate which of
     * their colleagues' patients are confidential by reprinting ids and reading the shape of the
     * refusal. Sealed and absent must be indistinguishable from outside.
     */
    const visible = original.patientId === null
      ? null
      : await getPatient(this.db, actor, original.patientId);
    if (original.patientId !== null && visible === null) return { id: null };

    const id = await withTx(this.db, (tx) => enqueuePrintJob(tx, {
      document: original.document as Parameters<typeof enqueuePrintJob>[1]["document"],
      params: original.params,
      // A fresh key: a reprint is a SECOND slip on purpose, and the original key would swallow it.
      dedupeKey: `reprint:${original.id}:${newId()}`,
      patientId: original.patientId,
      encounterId: original.encounterId,
      requestedBy: actor.type === "user" ? actor.id : null,
    }));
    /*
      FD-24 CLOSE — a reprint is a disclosure with a NAME on it, and it is logged as its own surface.

      A relay draining a queue is a machine printing work it was assigned; this is a clerk asking
      for a second copy of ONE patient's document, possibly hours later and possibly for somebody
      standing at the counter. "The relay printed 40 slips at 09:00" and "Sunita reprinted Farida
      Khatoon's prescription at 16:20" are materially different disclosures — see `PhiSurface`.

      The clerk's stated reason travels INTO the audit row rather than being discarded. It used to
      be `void`ed with a comment saying the request log carried it; the request log does not carry a
      patient id, so the one question this is asked — what did they see, and why did they say they
      needed it — could not be answered from either place.
    */
    if (original.patientId !== null && visible !== null) {
      await recordPhiAccess(this.db, {
        actor,
        /*
          FD-25 CLOSE — THE CANONICAL ID, WHICH `visible` ALREADY HOLDS AND `original` DOES NOT.
          `recordPhiAccess` documents this column as "the CANONICAL patient id — callers resolve the
          merge chain before writing", and `prunePhiAccessLog`'s legal-hold clamp matches holds by
          it. Writing the job's raw id filed the disclosure under a merged-away duplicate: invisible
          to an enquiry about the surviving patient, unprotected by a hold placed on them, and — in
          the same object literal — contradicted by a `sealed` flag read from the OTHER row.
        */
        patientId: visible.patient.id,
        surface: "print.reprint",
        encounterId: original.encounterId,
        /*
          FD-25 — `sealed` AND THE BREAK-GLASS REASON, both of which defaulted to nothing.
          `recordPhiAccess` defaults `sealed` to false, so every reprint of a confidential patient's
          document was logged as an ordinary read. The whole point of the flag is that an enquiry
          can ask "who read SEALED records", and it was answering no for the one route that had no
          gate at all — the two failures compounding rather than one covering the other.
        */
        sealed: visible.patient.isConfidential,
        reason: [
          `reprint of ${original.document} (job ${original.id})`,
          reason === undefined ? null : reason,
          visible.breakGlass === null ? null : `break-glass ${visible.breakGlass.id}: ${visible.breakGlass.reason}`,
        ].filter((x) => x !== null).join(" · "),
      });
    }
    return { id };
  }

  /**
   * Paper did not come out. Requeues with a backoff under the cap, then gives up — and giving up is
   * FINE (owner ruling R7): a print failure is advisory, the screen says so and offers a reprint,
   * and nothing in the money or queue path was ever waiting on this.
   */
  @Post("failed")
  async failed(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ outcome: string }> {
    const { jobId, error } = failedBody.parse(body);
    return { outcome: await reportFailed(this.db, jobId, this.relayId(actor), error) };
  }
}
