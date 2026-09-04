import { Body, Controller, ForbiddenException, Get, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { printJobs } from "../db/schema";
import { claimPrintJobs, reportFailed, reportPrinted } from "./claim";
import { enqueuePrintJob } from "./enqueue";
import { withTx } from "../db/client";
import { renderDocument } from "./render";
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
      const rendered = await renderDocument(this.db, job.document, job.params);
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
    */
    const disclosed = new Set(jobs.filter((j) => out.some((o) => o.id === j.id)).map((j) => j.patientId).filter((p): p is string => p !== null));
    const reason = `print relay ${relayId} claimed ${String(out.length)} document(s) for ${input.destinations.join(", ")}`;
    for (const patientId of disclosed) {
      await recordPhiAccess(this.db, { actor, patientId, surface: "print.claim", reason });
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
  async jobsFor(@Query("encounterId") encounterId: string): Promise<{
    jobs: { id: string; document: string; status: string; attempts: number; lastError: string | null; printedAt: string | null }[];
  }> {
    if (typeof encounterId !== "string" || encounterId.trim() === "") return { jobs: [] };
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(eq(printJobs.encounterId, encounterId))
      .orderBy(desc(printJobs.createdAt));
    return {
      jobs: rows.map((r) => ({
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
    if (original.patientId !== null) {
      await recordPhiAccess(this.db, {
        actor,
        patientId: original.patientId,
        surface: "print.reprint",
        encounterId: original.encounterId,
        reason: `reprint of ${original.document} (job ${original.id})${reason === undefined ? "" : `: ${reason}`}`,
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
