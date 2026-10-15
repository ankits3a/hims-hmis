import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { PatientError } from "../patients";
import { cancelPreAlert, preAlert, recordBroughtDead, registerArrival, registerUnidentified } from "./arrival";
import { printErBand, reprintErBand } from "./bands";
import { listErBays, listErDoctors, readErBoard, readErDesk, readErEpisode, searchErPatients } from "./board";
import { assignErDoctor, moveBay, placeInBay, reTriage, recordErVitals, triage } from "./triage";
import {
  answerCall, callSpecialty, cosignErNote, declareStabilised, giveErDose, issueErMed, returnErMed, placeErOrder, recordConsent, recordErNote,
  recordProcedure, signErVerbalOrder,
} from "./care";
import { listErItems, readErCare } from "./care-read";
import {
  addMlcAddendum, countersignMlc, handOverEvidence, openMlc, readMlc, readMlcDesk, recordBelongings, recordPoliceIntimation,
} from "./mlc";
import { openErEventAccount, priceErLines, readErBill, readErBillDesk, setErPayer, settleErBill, takeErAdvance } from "./bill";
import {
  arbitrateAdmission, decideDisposition, dischargeFromEr, recordSpecialtyRefusal, handToUnit, recordAbscond, recordErDeathIntent, recordLama, recordLwbs, referOut,
} from "./dispo";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import type { ModuleRegistry } from "../../kernel/modules/loader";
import { ErError, ErRefusal, erRefusalStatus } from "./errors";
import { linkIdentity } from "./identity";
import { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_BOARD_WALL, ER_CARE, ER_BILL, ER_DISPOSITION, ER_IDENTITY_LINK, ER_MLC, ER_TRIAGE } from "./names";
import type {
  Actor, ErBay, ErBoard, ErCareView, ErDeskView, ErDoctorOption, ErEpisodeView, ErBill, ErBillDesk, ErItemOption, ErMlcDesk, ErMlcDetail, ErPatientHit, ErRefusalBody,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 1 (#808) — the emergency routes (`ER_ROUTES`). Thin: each route is its intent function, and the function
 * re-checks the permission the guard checked (the copilot and devices reach the same functions without this controller).
 * A refusal answers its contract code with the rule, the fix and its data (`ErRefusalBody`).
 */
function toHttp(e: unknown): never {
  if (e instanceof ErRefusal) {
    const status = erRefusalStatus(e.code);
    const body: ErRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof ErError) {
    const status = e.code === "er_forbidden" ? 403 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof PatientError) {
    throw new HttpException({ statusCode: 422, code: e.code, message: e.message }, 422);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const boardQuery = z.object({ wall: z.enum(["0", "1", "true", "false"]).optional() });
const searchQuery = z.object({ q: z.string().max(80).default("") });

@Controller("er")
export class EmergencyController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  private orderKinds() { return collectOrderKinds(this.registry); }

  @Get("board")
  @RequirePermission(ER_BOARD_VIEW, "hospital")
  async board(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ErBoard> {
    try {
      const q = boardQuery.parse(query);
      return await readErBoard(this.db, actor, { wall: q.wall === "1" || q.wall === "true" });
    } catch (e) { toHttp(e); }
  }

  /** ER review (2026-10-15) — the wall display on its own permission (a kiosk holds only `er.board.wall`). */
  @Get("board/wall")
  @RequirePermission(ER_BOARD_WALL, "hospital")
  async boardWall(@CurrentActor() actor: Actor): Promise<ErBoard> {
    try { return await readErBoard(this.db, actor, { wall: true }); } catch (e) { toHttp(e); }
  }

  @Get("desk")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async desk(@CurrentActor() actor: Actor): Promise<ErDeskView> {
    try { return await readErDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("patients")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async patients(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ErPatientHit[]> {
    try { return await searchErPatients(this.db, actor, searchQuery.parse(query).q); } catch (e) { toHttp(e); }
  }

  @Get("doctors")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async doctors(@CurrentActor() actor: Actor): Promise<ErDoctorOption[]> {
    try { return await listErDoctors(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("pre-alerts")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async preAlert(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await preAlert(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("pre-alerts/cancel")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async cancelPreAlert(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelPreAlert(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async arrive(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await registerArrival(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals/unidentified")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async unidentified(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await registerUnidentified(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals/brought-dead")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async broughtDead(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordBroughtDead(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bands/print")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async printBand(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await printErBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bands/reprint")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async reprintBand(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reprintErBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("identity/link")
  @RequirePermission(ER_IDENTITY_LINK, "hospital")
  async linkIdentity(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await linkIdentity(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /* ═══ lane 2 (#809) — triage, vitals, bays, the ER doctor ═══ */

  @Get("episodes/:id")
  @RequirePermission(ER_TRIAGE, "hospital")
  async episode(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<ErEpisodeView> {
    try { return await readErEpisode(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Get("bays")
  @RequirePermission(ER_TRIAGE, "hospital")
  async bays(@CurrentActor() actor: Actor): Promise<ErBay[]> {
    try { return await listErBays(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("triage-doctors")
  @RequirePermission(ER_TRIAGE, "hospital")
  async triageDoctors(@CurrentActor() actor: Actor): Promise<ErDoctorOption[]> {
    try { return await listErDoctors(this.db, actor, ER_TRIAGE); } catch (e) { toHttp(e); }
  }

  @Post("triage")
  @RequirePermission(ER_TRIAGE, "hospital")
  async triage(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await triage(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("triage/again")
  @RequirePermission(ER_TRIAGE, "hospital")
  async reTriage(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reTriage(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("vitals")
  @RequirePermission(ER_TRIAGE, "hospital")
  async vitals(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordErVitals(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bays/place")
  @RequirePermission(ER_TRIAGE, "hospital")
  async place(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await placeInBay(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bays/move")
  @RequirePermission(ER_TRIAGE, "hospital")
  async move(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await moveBay(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("doctor")
  @RequirePermission(ER_TRIAGE, "hospital")
  async doctor(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await assignErDoctor(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /* ═══ lane 3 (#810) — care ═══ */

  @Get("care/:id")
  @RequirePermission(ER_CARE, "hospital")
  async care(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<ErCareView> {
    try { return await readErCare(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Get("items")
  @RequirePermission(ER_CARE, "hospital")
  async items(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ErItemOption[]> {
    try { return await listErItems(this.db, actor, searchQuery.parse(query).q); } catch (e) { toHttp(e); }
  }

  @Post("notes")
  @RequirePermission(ER_CARE, "hospital")
  async note(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordErNote(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("notes/cosign")
  @RequirePermission(ER_CARE, "hospital")
  async cosign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cosignErNote(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("orders")
  @RequirePermission(ER_CARE, "hospital")
  async order(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await placeErOrder(this.db, actor, body, { orderKinds: this.orderKinds() }); } catch (e) { toHttp(e); }
  }

  @Post("meds/issue")
  @RequirePermission(ER_CARE, "hospital")
  async issue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await issueErMed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("meds/dose")
  @RequirePermission(ER_CARE, "hospital")
  async dose(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await giveErDose(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /** ER review 2 (2026-10-15) — a medicine not given goes back unopened, or is recorded as wastage. */
  @Post("meds/return")
  @RequirePermission(ER_CARE, "hospital")
  async returnMed(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await returnErMed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("meds/sign-verbal")
  @RequirePermission(ER_CARE, "hospital")
  async signVerbal(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await signErVerbalOrder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("procedures")
  @RequirePermission(ER_CARE, "hospital")
  async procedure(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordProcedure(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("consents")
  @RequirePermission(ER_CARE, "hospital")
  async consent(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordConsent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("calls")
  @RequirePermission(ER_CARE, "hospital")
  async call(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await callSpecialty(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("calls/answer")
  @RequirePermission(ER_CARE, "hospital")
  async answer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await answerCall(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("stabilised")
  @RequirePermission(ER_CARE, "hospital")
  async stabilised(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await declareStabilised(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  // ═══ lane 4 (#811) — the medico-legal case ═══
  @Get("mlc")
  @RequirePermission(ER_MLC, "hospital")
  async mlcDesk(@CurrentActor() actor: Actor): Promise<ErMlcDesk> {
    try { return await readMlcDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("mlc/:id")
  @RequirePermission(ER_MLC, "hospital")
  async mlc(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<ErMlcDetail> {
    try { return await readMlc(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Post("mlc/open")
  @RequirePermission(ER_MLC, "hospital")
  async mlcOpen(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await openMlc(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mlc/addendum")
  @RequirePermission(ER_MLC, "hospital")
  async mlcAddendum(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await addMlcAddendum(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mlc/intimation")
  @RequirePermission(ER_MLC, "hospital")
  async mlcIntimation(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordPoliceIntimation(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mlc/countersign")
  @RequirePermission(ER_MLC, "hospital")
  async mlcCountersign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await countersignMlc(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mlc/belongings")
  @RequirePermission(ER_MLC, "hospital")
  async mlcBelongings(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordBelongings(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mlc/evidence")
  @RequirePermission(ER_MLC, "hospital")
  async mlcEvidence(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await handOverEvidence(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  // ═══ lane 5 (#812) — disposition and departure ═══
  @Post("dispo/decide")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoDecide(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await decideDisposition(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/discharge")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoDischarge(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await dischargeFromEr(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/admit")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoAdmit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await handToUnit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/refer")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoRefer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await referOut(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/lama")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoLama(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordLama(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/lwbs")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoLwbs(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordLwbs(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/abscond")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoAbscond(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordAbscond(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/death")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoDeath(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordErDeathIntent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/refused")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoRefused(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordSpecialtyRefusal(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("dispo/arbitrate")
  @RequirePermission(ER_DISPOSITION, "hospital")
  async dispoArbitrate(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await arbitrateAdmission(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  // ═══ lane 6 (#813) — the ER bill desk (money; never a clinical screen) ═══
  @Get("bill")
  @RequirePermission(ER_BILL, "hospital")
  async billDesk(@CurrentActor() actor: Actor): Promise<ErBillDesk> {
    try { return await readErBillDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("bill/:id")
  @RequirePermission(ER_BILL, "hospital")
  async bill(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<ErBill> {
    try { return await readErBill(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Post("bill/payer")
  @RequirePermission(ER_BILL, "hospital")
  async billPayer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await setErPayer(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bill/advance")
  @RequirePermission(ER_BILL, "hospital")
  async billAdvance(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await takeErAdvance(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bill/price")
  @RequirePermission(ER_BILL, "hospital")
  async billPrice(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await priceErLines(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bill/settle")
  @RequirePermission(ER_BILL, "hospital")
  async billSettle(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await settleErBill(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bill/event-account")
  @RequirePermission(ER_BILL, "hospital")
  async billEventAccount(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await openErEventAccount(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
