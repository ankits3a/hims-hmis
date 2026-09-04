import { Body, Controller, ForbiddenException, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { claimPrintJobs, reportFailed, reportPrinted } from "./claim";
import { renderDocument } from "./render";
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
    return { jobs: out };
  }

  /** Paper came out. Guarded on the claim, so a relay whose lease lapsed cannot overwrite the winner. */
  @Post("printed")
  async printed(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ accepted: boolean }> {
    const { jobId } = printedBody.parse(body);
    return { accepted: await reportPrinted(this.db, jobId, this.relayId(actor)) };
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
