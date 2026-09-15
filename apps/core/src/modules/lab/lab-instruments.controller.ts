import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed, toHttp } from "./lab-http";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import {
  instrumentWorklist, LAB_INSTRUMENTS_MANAGE, LAB_INSTRUMENTS_READ, linkInstrumentInterface,
  listInstruments,
} from "./instruments";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T2 — THE ROUTE THE BRIDGE PULLS ═══
 *
 * `GET /lab/instruments` — the register, for a screen.
 * `GET /lab/instruments/:instrumentId/worklist?sampleId=S…` — what to run on this tube.
 *
 * Modelled on 18b's `radiology-mwl.controller.ts` deliberately: **a route the bridge PULLS**, not a
 * file a worker consumer writes into a directory that does not exist until somebody buys a host.
 * The same reasoning applies here for a smaller reason — the bench PC is not this repository's
 * deployment target and never will be.
 *
 * ═══ THE BRIDGE IS A SERVICE **USER**, NOT AN AGENT — AND THAT IS NOT A PREFERENCE ═══
 *
 * This phase's D2 first said the bridge would authenticate as an agent, because `agents` +
 * `api_key_hash` + `kill_switch` already exist. It cannot: `kernel/auth/guards.ts` throws
 * `ForbiddenException("agents hold no permissions yet")` for any non-user actor BEFORE it reaches
 * `hasPermission`, so an agent cannot pass `@RequirePermission` at all. The agent-permission table
 * is a declared Plan 12 seam that has not shipped.
 *
 * 18b had already met this and answered it: `modality_bridge` is a role holding exactly one
 * permission, and its title in `seed-roles.ts` says what it is — *"a MACHINE account: pulls the
 * worklist export; holds nothing else"*. `lab_bridge` is the same shape.
 *
 * `lab.instruments.read` is therefore SEPARATE from `lab.instruments.manage`. A machine account that
 * could also register machines and re-map codes could rename any test it reports.
 */
const worklistQuery = z.object({ sampleId: z.string().min(1).max(32) });

/**
 * ═══ 17-E T3 — THE TRANSMISSION, AS THE BRIDGE POSTS IT ═══
 *
 * One block, many patients. `transmissionRef` is the bridge's own id for the run and the server
 * treats a repeat as a no-op, because a bench PC that times out waiting for our response and
 * re-sends is the ordinary case rather than the exotic one — the analyser has already aspirated the
 * sample and the bridge has nothing else to do.
 *
 * `instrumentAt` is accepted and stored and NEVER read for turnaround (D5). Analyser clocks drift,
 * are set wrong at install, and survive a power cut reading 00:00.
 */
/**
 * ═══ 17-E T7b — THE LINK, AND `null` IS A REAL VALUE ON THIS BODY ═══
 *
 * `.nullable()` and not `.nullish()`: unlinking a bridge is a decision an administrator makes, and a
 * body that omits the field entirely should not silently perform it. The caller must SAY `null`.
 */
const linkInterfaceBody = z.object({ interfaceId: z.string().min(1).max(64).nullable() });

const ingestBody = z.object({
  transmissionRef: z.string().min(1).max(64),
  rows: z.array(z.object({
    position: z.number().int().nonnegative(),
    sampleId: z.string().max(64).nullish(),
    code: z.string().min(1).max(64),
    value: z.string().min(1).max(500),
    unit: z.string().max(32).nullish(),
    instrumentAt: z.coerce.date().nullish(),
  })).min(1).max(500),
});

@Controller("lab")
export class LabInstrumentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The register — a screen's read. Held by the lab head, not by the bridge. */
  @Get("instruments")
  @RequirePermission("lab.instruments.manage", "hospital")
  async register(): Promise<unknown> {
    try {
      return { items: await listInstruments(this.db) };
    } catch (e) { toHttp(e); }
  }

  /**
   * ═══ 17-E T7b — POINT A MACHINE AT ITS BRIDGE'S `interfaces` ROW ═══
   *
   * On `lab.instruments.manage`, the same grant the register read above is held on, and NOT on
   * `lab.instruments.read`: the bridge must not be able to re-point its own link — see the header's
   * reasoning about the code map, which is the same act in a different table.
   *
   * **THIS IS THE ONLY WRITE DOOR THE MACHINE REGISTER HAS.** `registerInstrument` and
   * `mapInstrumentCode` are reachable from `seed-lab-demo.ts` and from nowhere else — a register with
   * a read route, a manage permission and no writer, which is the shape the launch census named. It
   * is disclosed here rather than fixed here: this task owns the link, not the register.
   */
  @Post("instruments/:instrumentId/interface")
  @RequirePermission(LAB_INSTRUMENTS_MANAGE, "hospital")
  async link(
    @CurrentActor() actor: Actor,
    @Param("instrumentId") instrumentId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const b = parsed(linkInterfaceBody, body);
    try {
      await linkInstrumentInterface(this.db, actor, { instrumentId, interfaceId: b.interfaceId });
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  /**
   * WHAT THIS ANSWER DOES NOT CARRY IS THE POINT: no patient name, no UHID, no date of birth, no
   * diagnosis, no order number. An analyser needs a test list, and a bench PC speaking ASTM in clear
   * text on a flat hospital LAN is the last place in the building to put PHI.
   */
  @Get("instruments/:instrumentId/worklist")
  @RequirePermission(LAB_INSTRUMENTS_READ, "hospital")
  async worklist(
    @CurrentActor() actor: Actor,
    @Param("instrumentId") instrumentId: string,
    @Query() raw: unknown,
  ): Promise<unknown> {
    const q = parsed(worklistQuery, raw);
    try {
      return await instrumentWorklist(this.db, actor, { instrumentId, sampleId: q.sampleId });
    } catch (e) { toHttp(e); }
  }

  /**
   * The block arrives here. Every row is resolved and written on its OWN transaction, so one
   * unreadable position parks that position and the other nine go on (D3) — the ESR's ten slots are
   * ten different patients, and the samples are already consumed.
   */
  @Post("instruments/:instrumentId/results")
  @RequirePermission(LAB_RESULTS_INTERFACE, "hospital")
  async ingest(
    @CurrentActor() actor: Actor,
    @Param("instrumentId") instrumentId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const b = parsed(ingestBody, body);
    try {
      return await ingestResults(this.db, actor, {
        instrumentId,
        transmissionRef: b.transmissionRef,
        rows: b.rows.map((r) => ({
          position: r.position, sampleId: r.sampleId ?? null, code: r.code,
          value: r.value, unit: r.unit ?? null, instrumentAt: r.instrumentAt ?? null,
        })),
      });
    } catch (e) { toHttp(e); }
  }
}
