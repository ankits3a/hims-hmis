import { hkMonthOf } from "@hmis/contracts";
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { CONFIG, DB, DOCUMENT_STORE } from "../../kernel/tokens";
import { CurrentActor, Public, RequirePermission } from "../../kernel/auth/decorators";
import { IPD_BEDS_CLEAN, IPD_BEDS_MANAGE, IPD_BEDS_VIEW } from "../ipd";
import { TASKS_WORK, TaskError, TaskKindRefusal, taskHttpStatus } from "../tasks";
import { DoorAddressThrottle } from "./door-throttle";
import { supervisorBoard } from "./board";
import { confirmClean, nudgeClean, verifyClean } from "./cleans";
import { raiseDoorRequest } from "./door";
import { HousekeepingRefusal, housekeepingHttpStatus } from "./errors";
import {
  HOUSEKEEPING_CONFIRM, HOUSEKEEPING_ROTA_MANAGE, HOUSEKEEPING_SETUP_MANAGE, HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW,
} from "./names";
import { bedCleans, housekeepingBoard } from "./reads";
import { publishRota, rotaView, saveRota } from "./rota";
import { addContractor, areaQrToken, defineArea, revokeAreaQr, saveChecklist, setHkStaff, setupView } from "./setup";
import { finishWork, proofOf, storeWorkPhoto, workForm } from "./work";
import { floorConsumables, floorStoresView, linkFloorStore } from "./floor-stores";
import { inspectionsOf, recordInspection, storeInspectionPhoto } from "./inspections";
import { contractorSla, dailyReport, toCheck } from "./reports";
import type {
  Actor, BedCleansView, HkChecklistView, HkConsumablesView, HkDailyView, HkFloorStoreView, HkInspectionView, HkInspectionsView, HkSlaView,
  HkToCheck, HkContractorView, HkDoorAck, HkProofView, HkRotaView, HkSetupView, HkSupervisorView, HkWorkForm,
  HousekeepingBoardView,
} from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * THE HOUSEKEEPING DOORS. Every refusal answers `{ code, message, fix }` — housekeeping's own or the engine's.
 * The cleaners' own acts (accept, start, done) are the task engine's doors (`/tasks/:id/...`), on "My tasks".
 */
type Ack = { id: string; state: string; version: number };
const ack = (r: TaskRow): Ack => ({ id: r.id, state: r.state, version: r.version });
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HousekeepingRefusal) {
      const status = housekeepingHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    if (e instanceof TaskKindRefusal) {
      throw new HttpException({ statusCode: e.httpStatus, code: e.code, message: e.message, fix: e.fix }, e.httpStatus);
    }
    throw e;
  }
}

@Controller("housekeeping")
export class HousekeepingController {
  private readonly doorThrottle = new DoorAddressThrottle();
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
  ) {}

  /** The Beds board's cleaning clocks: whoever reads the board reads its clocks. */
  @Get("bed-cleans")
  @RequirePermission(IPD_BEDS_VIEW, "hospital", { alsoAdmits: [HOUSEKEEPING_VIEW] })
  async cleans(): Promise<BedCleansView> {
    return bedCleans(this.db);
  }

  @Get("board")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async board(): Promise<HousekeepingBoardView> {
    return housekeepingBoard(this.db);
  }

  /** A routine clean: `ipd.beds.clean` or the supervisor; a terminal clean: the supervisor (checked in the intent). */
  @Post("cleans/:id/verify")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital", { alsoAdmits: [HOUSEKEEPING_VERIFY_TERMINAL] })
  async verify(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await verifyClean(this.db, actor, { ...body(b), taskId: id })));
  }

  /** DECIDED: the bed manager, the ward nurse side and the housekeeping supervisor may nudge. */
  @Post("cleans/:id/nudge")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital", { alsoAdmits: [IPD_BEDS_CLEAN, HOUSEKEEPING_VIEW] })
  async nudge(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await nudgeClean(this.db, actor, { ...body(b), taskId: id })));
  }

  /* ═══ HK-1 (#973, decision 0086) ═══ */

  /** The supervisor board's housekeeping read: missed rounds, Needs you, the people on the rota. */
  @Get("supervisor")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async supervisor(): Promise<HkSupervisorView> {
    return supervisorBoard(this.db);
  }

  /** Pass or Fail: the ward nurse side, the supervisor, or infection control (the intent and the engine re-check). */
  @Post("tasks/:id/confirm")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital", { alsoAdmits: [HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL] })
  async confirm(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await confirmClean(this.db, actor, { ...body(b), taskId: id })));
  }

  /** What the checker sees before Pass or Fail: the newest attempt's proof, the photo inline (null: no proof recorded). */
  @Get("tasks/:id/proof")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital", { alsoAdmits: [HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW] })
  async proof(@Param("id") id: string): Promise<{ proof: HkProofView | null }> {
    return refusing(async () => ({ proof: await proofOf(this.db, this.store, id) }));
  }

  /** The attendant's checklist for a task, and whether it needs a photo. */
  @Get("tasks/:id/work-form")
  @RequirePermission(TASKS_WORK, "hospital")
  async form(@Param("id") id: string): Promise<HkWorkForm> {
    return refusing(() => workForm(this.db, id));
  }

  /** One photo of the cleaned place, base64 in JSON (the patients documents precedent). */
  @Post("tasks/:id/photo")
  @RequirePermission(TASKS_WORK, "hospital")
  async photo(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ photoKey: string }> {
    const x = body(b);
    if (typeof x.mimeType !== "string" || typeof x.imageBase64 !== "string") {
      throw new HttpException({ statusCode: 400, code: "bad_input", message: "A photo is needed.", fix: "Take the photo again." }, 400);
    }
    const bytes = Buffer.from(x.imageBase64, "base64");
    return refusing(() => storeWorkPhoto(this.db, this.store, actor, { taskId: id, mime: x.mimeType as string, bytes }));
  }

  /** Done with proof: the scanned QR, every checklist answer, the photo key. */
  @Post("tasks/:id/work")
  @RequirePermission(TASKS_WORK, "hospital")
  async work(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await finishWork(this.db, this.config.secretKey, actor, { ...body(b), taskId: id })));
  }

  /** The setup page, and the rota page's lists (floors, areas, beds, people). */
  @Get("setup")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital", { alsoAdmits: [HOUSEKEEPING_ROTA_MANAGE] })
  async setup(): Promise<HkSetupView> {
    return setupView(this.db);
  }

  @Post("areas")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async area(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: (await defineArea(this.db, actor, b)).id }));
  }

  /** The door QR's text (printed by the setup page): it names the area and nothing else. */
  @Get("areas/:id/qr")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async qr(@Param("id") id: string): Promise<{ token: string }> {
    return refusing(async () => ({ token: await areaQrToken(this.db, this.config.secretKey, id) }));
  }

  @Post("areas/:id/revoke-qr")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async revoke(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ id: string; qrVersion: number }> {
    return refusing(async () => {
      const r = await revokeAreaQr(this.db, actor, { areaId: id });
      return { id: r.id, qrVersion: r.qrVersion };
    });
  }

  @Post("checklists")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async checklist(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<HkChecklistView> {
    return refusing(() => saveChecklist(this.db, actor, b));
  }

  @Post("contractors")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async contractor(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<HkContractorView> {
    return refusing(() => addContractor(this.db, actor, b));
  }

  @Post("staff")
  @HttpCode(204)
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async staff(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<void> {
    await refusing(() => setHkStaff(this.db, actor, b));
  }

  /** A shift's rota (`?shift=<ISO start>`, default the shift now): the draft if one is being made, else the published. */
  @Get("rotas")
  @RequirePermission(HOUSEKEEPING_ROTA_MANAGE, "hospital", { alsoAdmits: [HOUSEKEEPING_VIEW] })
  async rota(@Query("shift") shift?: string): Promise<HkRotaView> {
    const at = shift !== undefined && !Number.isNaN(Date.parse(shift)) ? new Date(shift) : undefined;
    return rotaView(this.db, new Date(), at);
  }

  @Post("rotas")
  @RequirePermission(HOUSEKEEPING_ROTA_MANAGE, "hospital")
  async saveRota(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<HkRotaView> {
    return refusing(() => saveRota(this.db, actor, b));
  }

  @Post("rotas/:id/publish")
  @RequirePermission(HOUSEKEEPING_ROTA_MANAGE, "hospital")
  async publish(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<HkRotaView> {
    return refusing(() => publishRota(this.db, actor, { rotaId: id }));
  }

  /* ═══ HK-2 (#974, decision 0086) ═══ */

  /** Floors and their housekeeping stores, and the stores that may be linked (the setup page). */
  @Get("floor-stores")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital", { alsoAdmits: [HOUSEKEEPING_VIEW] })
  async floorStores(): Promise<{ floors: HkFloorStoreView[]; stores: { id: string; code: string; name: string }[] }> {
    return floorStoresView(this.db);
  }

  @Post("floor-stores")
  @RequirePermission(HOUSEKEEPING_SETUP_MANAGE, "hospital")
  async linkStore(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<HkFloorStoreView> {
    return refusing(() => linkFloorStore(this.db, actor, b));
  }

  /** What waits for a Pass or Fail (the staff app's check list): the ward nurse side, the supervisor, infection control. */
  @Get("to-check")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital", { alsoAdmits: [HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL] })
  async toCheck(): Promise<HkToCheck[]> {
    return toCheck(this.db);
  }

  /** This shift's random inspections. */
  @Get("inspections")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital", { alsoAdmits: [HOUSEKEEPING_CONFIRM] })
  async inspections(): Promise<HkInspectionsView> {
    return inspectionsOf(this.db);
  }

  /** One photo of the inspected area, base64 in JSON. */
  @Post("inspections/:id/photo")
  @RequirePermission(HOUSEKEEPING_CONFIRM, "hospital")
  async inspectionPhoto(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ photoKey: string }> {
    const x = body(b);
    if (typeof x.mimeType !== "string" || typeof x.imageBase64 !== "string") {
      throw new HttpException({ statusCode: 400, code: "bad_input", message: "A photo is needed.", fix: "Take the photo again." }, 400);
    }
    const bytes = Buffer.from(x.imageBase64, "base64");
    return refusing(() => storeInspectionPhoto(this.db, this.store, actor, { inspectionId: id, mime: x.mimeType as string, bytes }));
  }

  /** Score an inspection: the area's QR, every audit item, the photo key. A fail raises the floor team's rework. */
  @Post("inspections/:id")
  @RequirePermission(HOUSEKEEPING_CONFIRM, "hospital")
  async inspect(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<HkInspectionView> {
    return refusing(() => recordInspection(this.db, this.config.secretKey, actor, { ...body(b), inspectionId: id }));
  }

  /** A month's consumables per floor (`?month=YYYY-MM`, default this month). */
  @Get("reports/consumables")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async consumables(@Query("month") month?: string): Promise<HkConsumablesView> {
    return refusing(() => floorConsumables(this.db, month ?? hkMonthOf(new Date())));
  }

  /** The contractor SLA report (`?month=YYYY-MM`): a report only, no money. */
  @Get("reports/sla")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async sla(@Query("month") month?: string): Promise<HkSlaView> {
    return refusing(() => contractorSla(this.db, month ?? hkMonthOf(new Date())));
  }

  /** A floor's shift report (`?floor=<id>&at=<ISO instant in the shift>`, default the shift now). */
  @Get("reports/daily")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async daily(@Query("floor") floor?: string, @Query("at") at?: string): Promise<HkDailyView> {
    if (floor === undefined || floor === "") {
      throw new HttpException({ statusCode: 400, code: "bad_input", message: "A floor is needed.", fix: "Pick a floor." }, 400);
    }
    const when = at !== undefined && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date();
    return refusing(() => dailyReport(this.db, floor, when));
  }

  /**
   * THE PUBLIC DOOR (no staff session): a request from the door QR. The token travels in the BODY (the web page reads it
   * from the URL's fragment, which never reaches a log). Capped per address here and per area in the database.
   */
  @Public()
  @Post("door")
  async door(@Body() b: unknown, @Req() req: { ip?: string }): Promise<HkDoorAck> {
    const address = req.ip ?? "unknown";
    if (!this.doorThrottle.allow(address)) {
      throw new HttpException({ statusCode: 429, code: "too_many_requests", message: "Too many requests from here.", fix: "Wait a few minutes." }, 429);
    }
    return refusing(() => raiseDoorRequest(this.db, this.config.secretKey, b, { address }));
  }
}
