import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { DIET_CATALOGUE, DIET_MEALS } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { TaskError, taskHttpStatus } from "../tasks";
import { DietRefusal, dietHttpStatus } from "./errors";
import { buildLists, dispatchList, markPrinted, serveLine } from "./lists";
import { DIET_KITCHEN, DIET_MANAGE, DIET_NPO, DIET_ORDER, DIET_SERVE, DIET_VIEW } from "./names";
import { completeConsult, liftNpo, orderDiet, requestConsult, setMealRound, startNpo } from "./orders";
import { consultQueue, dietWards, kitchenBoard, readList, wardSheet } from "./reads";
import { mealRounds } from "./rounds";
import type {
  Actor, DietCatalogueEntry, DietConsultView, DietKitchenBoardView, DietListView, DietMeal, DietMealRoundView, DietWard, DietWardSheetView,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE DIET DOORS. Every refusal answers `{ code, message, rule, fix }`. Each door names its permission; every intent
 * re-checks it (and the nurse's NPO-only rule) inside. The kitchen's routes carry no money (decision 0058).
 */
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DietRefusal) {
      const status = dietHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix, detail: e.detail }, status);
    }
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    throw e;
  }
}

@Controller("diet")
export class DietController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("catalogue")
  @RequirePermission(DIET_VIEW, "hospital")
  catalogue(): readonly DietCatalogueEntry[] {
    return DIET_CATALOGUE;
  }

  @Get("wards")
  @RequirePermission(DIET_VIEW, "hospital")
  async wards(): Promise<DietWard[]> {
    return dietWards(this.db);
  }

  @Get("wards/:wardId/sheet")
  @RequirePermission(DIET_VIEW, "hospital")
  async sheet(@CurrentActor() actor: Actor, @Param("wardId") wardId: string): Promise<DietWardSheetView> {
    return wardSheet(this.db, actor, wardId);
  }

  /** A diet: doctor or dietician. A nurse knocking here with "npo" starts NPO; anything else answers `nurse_npo_only`. */
  @Post("orders")
  @RequirePermission(DIET_ORDER, "hospital", { alsoAdmits: [DIET_NPO] })
  async order(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ kind: string; id: string }> {
    return refusing(() => orderDiet(this.db, actor, body(b)));
  }

  @Post("npo")
  @RequirePermission(DIET_NPO, "hospital")
  async npo(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: await startNpo(this.db, actor, body(b)) }));
  }

  @Post("npo/:id/lift")
  @RequirePermission(DIET_NPO, "hospital")
  async lift(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(() => liftNpo(this.db, actor, { ...body(b), npoId: id }));
  }

  @Get("consults")
  @RequirePermission(DIET_MANAGE, "hospital")
  async consults(@CurrentActor() actor: Actor): Promise<DietConsultView[]> {
    return consultQueue(this.db, actor);
  }

  @Post("consults")
  @RequirePermission(DIET_ORDER, "hospital", { alsoAdmits: [DIET_NPO] })
  async askConsult(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(() => requestConsult(this.db, actor, body(b)));
  }

  @Post("consults/:id/complete")
  @RequirePermission(DIET_MANAGE, "hospital")
  async complete(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(() => completeConsult(this.db, actor, { ...body(b), consultId: id }));
  }

  @Get("kitchen")
  @RequirePermission(DIET_KITCHEN, "hospital", { alsoAdmits: [DIET_VIEW] })
  async kitchen(@CurrentActor() actor: Actor, @Query("meal") meal?: string, @Query("date") date?: string): Promise<DietKitchenBoardView> {
    const m = (DIET_MEALS as readonly string[]).includes(meal ?? "") ? (meal as DietMeal) : undefined;
    const d = date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
    return kitchenBoard(this.db, actor, new Date(), { meal: m, date: d });
  }

  @Post("lists/build")
  @RequirePermission(DIET_KITCHEN, "hospital")
  async build(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ built: string[] }> {
    return refusing(async () => ({ built: await buildLists(this.db, actor, body(b)) }));
  }

  @Get("lists/:id")
  @RequirePermission(DIET_KITCHEN, "hospital", { alsoAdmits: [DIET_VIEW] })
  async list(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<DietListView> {
    const v = await readList(this.db, actor, id);
    if (v === null) return refusing(() => Promise.reject(new DietRefusal("list_not_found", { listId: id })));
    return v;
  }

  @Post("lists/:id/printed")
  @RequirePermission(DIET_KITCHEN, "hospital")
  async printed(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ id: string; printedAt: string }> {
    return refusing(() => markPrinted(this.db, actor, id));
  }

  @Post("lists/:id/dispatch")
  @RequirePermission(DIET_KITCHEN, "hospital")
  async dispatch(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ id: string; taskId: string }> {
    return refusing(() => dispatchList(this.db, actor, id));
  }

  @Post("lines/:id/serve")
  @RequirePermission(DIET_SERVE, "hospital")
  async serve(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string; served: string; consultOpened: boolean }> {
    return refusing(() => serveLine(this.db, actor, { ...body(b), lineId: id }));
  }

  @Get("rounds")
  @RequirePermission(DIET_VIEW, "hospital", { alsoAdmits: [DIET_KITCHEN] })
  async rounds(): Promise<DietMealRoundView[]> {
    return mealRounds(this.db);
  }

  @Post("rounds")
  @RequirePermission(DIET_MANAGE, "hospital")
  async setRound(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<DietMealRoundView[]> {
    return refusing(async () => { await setMealRound(this.db, actor, body(b)); return mealRounds(this.db); });
  }
}
