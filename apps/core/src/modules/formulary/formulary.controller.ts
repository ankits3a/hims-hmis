import {
  BadRequestException, Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { FormularyError, formularyHttpStatus } from "./errors";
import {
  addInteraction, addMedicine, addSalt, listInteractions, listMedicines, listSalts,
  updateInteraction, updateMedicine, updateSalt,
} from "./masters";
import { admitStaging, getStagingRow, rejectStaging, searchStaging } from "./staging";
import { getCoverage, getPairOverrideRates } from "./curation";
import type { InteractionRow, MedicineWithSalts, SaltRow } from "./masters";
import type { StagingRow } from "./staging";
import type { Coverage, PairUsage } from "./curation";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * The formulary's masters surface.
 *
 * ═══ `toHttp` USES THE SHARED MAPPER, AND PLAN 09 IS WHY THAT SENTENCE IS HERE ═══
 *
 * A `MembershipError` reached a counter as a 500 because one controller's `toHttp` had a clause
 * for every module's error but that one. The mapper lives in `errors.ts` beside the codes; every
 * controller that can receive a `FormularyError` — this one today, T7's staging routes, and any
 * later module that calls `addMedicine` — maps through the same function rather than a private
 * copy of the table (§2.54).
 *
 * T7 extends this controller with the staging routes and T8 with the curation reads. The routes
 * below are the masters surface only.
 */
function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/** Unrecognized errors rethrow — a 500 is a genuine bug, loudly (the patients/opd convention). */
export function toHttp(e: unknown): never {
  if (e instanceof FormularyError) throw httpError(formularyHttpStatus(e.code), e.message, e.code, e.detail);
  throw e;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

/** Query flags arrive as strings; never z.coerce.boolean() — it reads "false" as true (§3.19). */
const flagQuery = z.enum(["true", "false"]).optional();
const activeQuery = z.object({ active: flagQuery });

const name = z.string().min(1).max(200);
const routeClass = z.enum(["systemic", "topical"]);
const scheduleFlag = z.enum(["H", "H1", "X", "OTC"]);
const severity = z.enum(["severe", "moderate"]);
const composition = z.array(z.object({
  saltId: z.string().min(1), strength: z.string().max(100).nullish(),
}));

const saltCreateBody = z.object({
  name, aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
  drugClass: z.string().min(1).max(200).nullish(), atcCode: z.string().min(1).max(20).nullish(),
});
const saltPatchBody = z.object({
  name: name.optional(), aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
  drugClass: z.string().min(1).max(200).nullish(), atcCode: z.string().min(1).max(20).nullish(),
  active: z.boolean().optional(),
});
const medicineCreateBody = z.object({
  brandName: name, form: z.string().min(1).max(100), routeClass: routeClass.default("systemic"),
  strengthLabel: z.string().min(1).max(100).nullish(), scheduleFlag: scheduleFlag.nullish(),
  salts: composition.min(1), stagingId: z.string().min(1).nullish(),
  acknowledgeIntraFdc: z.boolean().optional(),
});
const medicinePatchBody = z.object({
  brandName: name.optional(), form: z.string().min(1).max(100).optional(), routeClass: routeClass.optional(),
  strengthLabel: z.string().min(1).max(100).nullish(), scheduleFlag: scheduleFlag.nullish(),
  active: z.boolean().optional(), salts: composition.min(1).optional(),
});
const interactionCreateBody = z.object({
  saltAId: z.string().min(1), saltBId: z.string().min(1), severity,
  note: z.string().min(1).max(500), source: z.string().min(1).max(100),
  routeScope: z.literal("systemic_only").nullish(),
});
const stagingQuery = z.object({ q: z.string().max(200) });
const admitBody = z.object({
  brandName: name, form: z.string().min(1).max(100), routeClass: routeClass.default("systemic"),
  strengthLabel: z.string().min(1).max(100).nullish(), scheduleFlag: scheduleFlag.nullish(),
  salts: composition.min(1), acknowledgeIntraFdc: z.boolean().optional(),
});
const rejectBody = z.object({ reason: z.string().min(1).max(500) });

const interactionPatchBody = z.object({
  severity: severity.optional(), note: z.string().min(1).max(500).optional(),
  routeScope: z.literal("systemic_only").nullish(), active: z.boolean().optional(),
});

@Controller("formulary")
export class FormularyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("formulary.read", "hospital")
  @Get("salts")
  async salts(@Query() query: unknown): Promise<{ items: SaltRow[] }> {
    const q = parsed(activeQuery, query);
    return { items: await listSalts(this.db, { activeOnly: q.active === "true" }) };
  }

  @RequirePermission("formulary.manage", "hospital")
  @Post("salts")
  async createSalt(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ saltId: string }> {
    const b = parsed(saltCreateBody, body);
    try {
      return await withTx(this.db, (tx) => addSalt(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.manage", "hospital")
  @Patch("salts/:id")
  async patchSalt(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(saltPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateSalt(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.read", "hospital")
  @Get("medicines")
  async medicines(@Query() query: unknown): Promise<{ items: MedicineWithSalts[] }> {
    const q = parsed(activeQuery, query);
    return { items: await listMedicines(this.db, { activeOnly: q.active === "true" }) };
  }

  @RequirePermission("formulary.manage", "hospital")
  @Post("medicines")
  async createMedicine(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ medicineId: string }> {
    const b = parsed(medicineCreateBody, body);
    try {
      return await withTx(this.db, (tx) => addMedicine(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.manage", "hospital")
  @Patch("medicines/:id")
  async patchMedicine(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(medicinePatchBody, body);
    try {
      await withTx(this.db, (tx) => updateMedicine(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.read", "hospital")
  @Get("interactions")
  async interactions(): Promise<{ items: InteractionRow[] }> {
    return { items: await listInteractions(this.db) };
  }

  @RequirePermission("formulary.manage", "hospital")
  @Post("interactions")
  async createInteraction(
    @CurrentActor() actor: Actor, @Body() body: unknown,
  ): Promise<{ interactionId: string }> {
    const b = parsed(interactionCreateBody, body);
    try {
      return await withTx(this.db, (tx) => addInteraction(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  // ─────────────────── T8: the curation surfaces ───────────────────

  /**
   * DD5 — `formulary.read`, NOT `formulary.manage`, and the reason is a real caller: the CONSULT
   * screen reads this to decide whether the per-line "not in formulary" hint may render, and a
   * doctor holds `formulary.read` alone (DD10). Guarding it on `manage` would make the hint
   * invisible to exactly the people it is for.
   *
   * The response carries the raw `coverage` number as well as the boolean because a curator wants
   * to see how close the formulary is; the consult screen reads `noticeEnabled` and nothing else,
   * so the threshold lives in one place (`curation.ts`) and the client never re-derives it.
   */
  @RequirePermission("formulary.read", "hospital")
  @Get("coverage")
  async coverage(): Promise<Coverage> {
    return getCoverage(this.db);
  }

  /** The curator's view: which pairs are being clicked through. `manage`, not `read`. */
  @RequirePermission("formulary.manage", "hospital")
  @Get("pair-rates")
  async pairRates(): Promise<{ items: PairUsage[] }> {
    return { items: await getPairOverrideRates(this.db) };
  }

  // ─────────────────── T7: staging admission, pharmacist-gated ───────────────────

  /**
   * PULL-BASED (spec §1.1): a name search, never a queue. There is deliberately no route that
   * lists all pending rows — the mined mass is a dictionary of possibly tens of thousands of
   * entries, and a review-queue view would turn it into a backlog nobody could ever clear.
   */
  @RequirePermission("formulary.staging.review", "hospital")
  @Get("staging/search")
  async stagingSearch(@Query() query: unknown): Promise<{ items: StagingRow[] }> {
    const q = parsed(stagingQuery, query);
    return { items: await searchStaging(this.db, q.q) };
  }

  @RequirePermission("formulary.staging.review", "hospital")
  @Get("staging/:id")
  async stagingRow(@Param("id") id: string): Promise<StagingRow> {
    const row = await getStagingRow(this.db, id);
    if (row === null) toHttp(new FormularyError("staging_not_pending", `no staging row ${id}`));
    return row;
  }

  @RequirePermission("formulary.staging.review", "hospital")
  @Post("staging/:id/admit")
  async admit(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ medicineId: string }> {
    const b = parsed(admitBody, body);
    try {
      return await withTx(this.db, (tx) => admitStaging(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.staging.review", "hospital")
  @Post("staging/:id/reject")
  async reject(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(rejectBody, body);
    try {
      await withTx(this.db, (tx) => rejectStaging(tx, actor, id, b.reason));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("formulary.manage", "hospital")
  @Patch("interactions/:id")
  async patchInteraction(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(interactionPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateInteraction(tx, actor, id, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
