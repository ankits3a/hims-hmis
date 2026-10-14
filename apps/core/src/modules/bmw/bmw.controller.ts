import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { bmwMonthQuery, bmwYearQuery } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { contentDisposition } from "../../kernel/report/csv";
import { BmwError, bmwHttpStatus } from "./errors";
import { collectBag, generateBag, handOverManifest, recordCbwtfWeight, recordDeptWeight, resolveDispute, storeBag } from "./intents";
import { BMW_HANDLE, BMW_MANAGE, BMW_VIEW } from "./manifest";
import { bagByBarcode, bagCards, bmwBoard, bmwHandlerView } from "./reads";
import { formIvCsv, formIvReport, monthlyReport, monthlyReportCsv } from "./reports";
import type { Response } from "express";
import type {
  Actor, BmwBagCard, BmwBoardView, BmwDisputeCard, BmwFormIvReport, BmwHandlerView, BmwMonthlyReport, GenerateBagResult,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE BMW DOORS. The door checks the permission; the intent checks the bag's stage. A refusal answers
 * `{ code, message, fix }`. Every bag answer is its card — the phone shows the next step from its state.
 */
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BmwError) {
      const status = bmwHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix, details: e.details }, status);
    }
    throw e;
  }
}

function query<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, q: unknown): T {
  const r = schema.safeParse(q);
  if (!r.success) throw new HttpException({ statusCode: 400, code: "bad_period", message: "This month or year is not valid.", fix: "Pick a month or year from the list." }, 400);
  return r.data;
}

@Controller("bmw")
export class BmwController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(BMW_VIEW, "hospital", { alsoAdmits: [BMW_MANAGE] })
  async board(): Promise<BmwBoardView> {
    return bmwBoard(this.db, new Date());
  }

  @Get("handler")
  @RequirePermission(BMW_HANDLE, "hospital")
  async handler(@CurrentActor() actor: Actor): Promise<BmwHandlerView> {
    return bmwHandlerView(this.db, actor.id, new Date());
  }

  @Get("bags/:barcode")
  @RequirePermission(BMW_HANDLE, "hospital", { alsoAdmits: [BMW_VIEW, BMW_MANAGE] })
  async bag(@Param("barcode") barcode: string): Promise<BmwBagCard> {
    return refusing(() => bagByBarcode(this.db, barcode));
  }

  @Post("bags")
  @RequirePermission(BMW_HANDLE, "hospital")
  async generate(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<GenerateBagResult> {
    return refusing(async () => {
      const r = await generateBag(this.db, actor, b, new Date());
      return { bag: (await bagCards(this.db, [r.bag]))[0]!, label: r.label };
    });
  }

  @Post("bags/:barcode/weight")
  @RequirePermission(BMW_HANDLE, "hospital")
  async weigh(@CurrentActor() actor: Actor, @Param("barcode") barcode: string, @Body() b: unknown): Promise<BmwBagCard> {
    return refusing(async () => (await bagCards(this.db, [await recordDeptWeight(this.db, actor, { ...body(b), barcode }, new Date())]))[0]!);
  }

  @Post("bags/:barcode/collect")
  @RequirePermission(BMW_HANDLE, "hospital")
  async collect(@CurrentActor() actor: Actor, @Param("barcode") barcode: string, @Body() b: unknown): Promise<BmwBagCard> {
    return refusing(async () => (await bagCards(this.db, [await collectBag(this.db, actor, { ...body(b), barcode }, new Date())]))[0]!);
  }

  @Post("bags/:barcode/store")
  @RequirePermission(BMW_HANDLE, "hospital")
  async store(@CurrentActor() actor: Actor, @Param("barcode") barcode: string, @Body() b: unknown): Promise<BmwBagCard> {
    return refusing(async () => (await bagCards(this.db, [(await storeBag(this.db, actor, { ...body(b), barcode }, new Date())).bag]))[0]!);
  }

  @Post("manifests")
  @RequirePermission(BMW_MANAGE, "hospital")
  async handOver(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string; manifestNo: string; bags: number }> {
    return refusing(async () => {
      const m = await handOverManifest(this.db, actor, b, new Date());
      return { id: m.id, manifestNo: m.manifestNo, bags: m.bagCount };
    });
  }

  @Post("manifests/:id/cbwtf-weight")
  @RequirePermission(BMW_MANAGE, "hospital")
  async cbwtfWeight(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ disputes: number; gaps: unknown[] }> {
    return refusing(async () => {
      const r = await recordCbwtfWeight(this.db, actor, { ...body(b), manifestId: id }, new Date());
      return { disputes: r.disputes.length, gaps: r.gaps };
    });
  }

  @Post("disputes/:id/resolve")
  @RequirePermission(BMW_MANAGE, "hospital")
  async resolve(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Pick<BmwDisputeCard, "id" | "state">> {
    return refusing(async () => {
      const d = await resolveDispute(this.db, actor, { ...body(b), disputeId: id }, new Date());
      return { id: d.id, state: d.state as "resolved" };
    });
  }

  @Get("reports/monthly")
  @RequirePermission(BMW_MANAGE, "hospital")
  async monthly(@Query() q: unknown): Promise<BmwMonthlyReport> {
    const { month } = query(bmwMonthQuery, q);
    return refusing(() => monthlyReport(this.db, month));
  }

  @Get("reports/monthly.csv")
  @RequirePermission(BMW_MANAGE, "hospital")
  async monthlyCsv(@Query() q: unknown, @Res({ passthrough: true }) res: Response): Promise<string> {
    const { month } = query(bmwMonthQuery, q);
    const r = await refusing(() => monthlyReport(this.db, month));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`BMW-monthly-${month}.csv`));
    return monthlyReportCsv(r);
  }

  @Get("reports/form-iv")
  @RequirePermission(BMW_MANAGE, "hospital")
  async formIv(@Query() q: unknown): Promise<BmwFormIvReport> {
    const { year } = query(bmwYearQuery, q);
    return refusing(() => formIvReport(this.db, year, new Date()));
  }

  @Get("reports/form-iv.csv")
  @RequirePermission(BMW_MANAGE, "hospital")
  async formIvCsv(@Query() q: unknown, @Res({ passthrough: true }) res: Response): Promise<string> {
    const { year } = query(bmwYearQuery, q);
    const r = await refusing(() => formIvReport(this.db, year, new Date()));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`BMW-Form-IV-${year}.csv`));
    return formIvCsv(r);
  }
}
