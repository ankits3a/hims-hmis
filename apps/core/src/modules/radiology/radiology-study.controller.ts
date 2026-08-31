import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { checkIn } from "./checkin";
import {
  evaluateReadiness, overrideGate, readiness, requireStudyGate, satisfyGate, waiveGate,
} from "./gates";
import { parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T5 — **THE STUDY CONSOLE OVER HTTP: check-in, the ten gates, the readiness read.**
 *
 * ═══ GATES ARE ADDRESSED BY KIND, NOT BY ROW ID ═══
 *
 * A console knows it is clearing "the MRI safety gate on accession X26…"; it does not know a ULID.
 * `imaging_safety_screenings_study_kind_ux` makes `(studyId, kind)` unique, so the pair IS an
 * address, and resolving it here keeps the service functions keyed on the gate id the way
 * `ot/gates.ts` keys its own.
 *
 * ═══ THREE PERMISSIONS, AND THE SPLIT IS THE DEPARTMENT'S (manifest.ts's three separations) ═══
 *
 *   · `radiology.checkin` — the radiographer's. NOT the receptionist's: check-in is where the gate
 *     set opens from the patient's sex, age and the type's flags, and it is an act at the console.
 *   · `radiology.gates.satisfy` — the radiographer's, and NOT `radiology_receptionist`'s. *"The
 *     person who books the scan and takes the money does not get to record that the patient is not
 *     pregnant."*
 *   · `radiology.gates.override` — the radiologist's, and it guards the WAIVER as well as the
 *     override. A waiver is a clinical judgement that a gate does not apply, which is the same
 *     class of act as accepting a risk, and the imaging gate definition names `radiologist` alone
 *     on both edges.
 *
 * Both planes are consulted on every one of these: the guard reads the PERMISSION registry, and
 * `transition` reads `role_assignments`. Finding F9 is what that sentence is for — a separation
 * stated only on the plane the engine does not consult is not a separation.
 *
 * ═══ THE READINESS READ IS A GET AND TRANSITIONS NOTHING ═══
 *
 * `GET /readiness` reports; `POST /readiness` evaluates and may move the study `checked_in → ready`.
 * Two routes rather than one, because a screen that polled a GET which silently transitioned would
 * make the study's own history depend on who had a tab open.
 */
const reasonBody = z.object({ reason: z.string().min(1).max(400) });

@Controller("radiology/studies")
export class RadiologyStudyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The patient is at the door. Opens the derived gate set; never makes a study ready (B7). */
  @Post(":studyId/check-in")
  @RequirePermission("radiology.checkin", "hospital")
  async checkInStudy(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
  ): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => checkIn(tx, actor, { studyId }));
    } catch (e) { toHttp(e); }
  }

  /** Every gate with its state, and what is still holding the study. Reports; transitions nothing. */
  @Get(":studyId/readiness")
  @RequirePermission("radiology.worklist.read", "hospital")
  async readGates(@Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await readiness(this.db, studyId);
    } catch (e) { toHttp(e); }
  }

  /**
   * A6 — the evaluation, which is the ONLY thing that moves `checked_in → ready`, and it does so as
   * the `system` because the definition names `system` alone on that edge.
   */
  @Post(":studyId/readiness")
  @RequirePermission("radiology.gates.satisfy", "hospital")
  async evaluate(@Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => evaluateReadiness(tx, studyId));
    } catch (e) { toHttp(e); }
  }

  /**
   * The evidence body is deliberately `unknown` here and parsed per KIND inside `satisfyGate`: ten
   * kinds with ten shapes, and a controller that switched on the kind to pick a schema would be a
   * second place that knows which evidence belongs to which gate.
   */
  @Post(":studyId/gates/:kind/satisfy")
  @RequirePermission("radiology.gates.satisfy", "hospital")
  async satisfy(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    try {
      return await withTx(this.db, async (tx) => {
        const gate = await requireStudyGate(tx, studyId, kind);
        const result = await satisfyGate(tx, actor, gate.id, body);
        /** The console does not know which gate was the last one — see `evaluateReadiness`. */
        const after = await evaluateReadiness(tx, studyId);
        return { ...result, study: after };
      });
    } catch (e) { toHttp(e); }
  }

  /** A2/A6 — `form_f` and `identity_two_factor` are refused by KIND inside, before any read. */
  @Post(":studyId/gates/:kind/waive")
  @RequirePermission("radiology.gates.override", "hospital")
  async waive(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(reasonBody, body);
    try {
      return await withTx(this.db, async (tx) => {
        const gate = await requireStudyGate(tx, studyId, kind);
        const result = await waiveGate(tx, actor, gate.id, input.reason);
        const after = await evaluateReadiness(tx, studyId);
        return { ...result, study: after };
      });
    } catch (e) { toHttp(e); }
  }

  /** A3 — the radiologist's lane. A reason is required by the SERVICE, not only by this schema. */
  @Post(":studyId/gates/:kind/override")
  @RequirePermission("radiology.gates.override", "hospital")
  async override(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(reasonBody, body);
    try {
      return await withTx(this.db, async (tx) => {
        const gate = await requireStudyGate(tx, studyId, kind);
        const result = await overrideGate(tx, actor, gate.id, input.reason);
        const after = await evaluateReadiness(tx, studyId);
        return { ...result, study: after };
      });
    } catch (e) { toHttp(e); }
  }
}
