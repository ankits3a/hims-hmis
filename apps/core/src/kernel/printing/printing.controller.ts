import { Body, Controller, ForbiddenException, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { claimPrintJobs, reportFailed, reportPrinted } from "./claim";
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
 * drain print jobs. It cannot read patient records through these routes: a claim returns
 * identifiers, and the renderer resolves the record separately. Tightening this to a per-agent
 * destination grant is the obvious first use of `agent_permissions` when it exists.
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
   * The response carries IDENTIFIERS, not patient data — `params` holds the encounter id and the
   * renderer resolves names at render time. A relay that is compromised therefore learns which
   * encounters printed, not who they are about.
   */
  @Post("claim")
  async claim(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ jobs: { id: string; document: string; destination: string; params: Record<string, unknown> }[] }> {
    const input = claimBody.parse(body);
    const jobs = await claimPrintJobs(this.db, {
      relayId: this.relayId(actor),
      destinations: input.destinations,
      limit: input.limit,
    });
    return { jobs: jobs.map(({ id, document, destination, params }) => ({ id, document, destination, params })) };
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
