import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { linenMonthQuery, linenVarianceQuery } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { LinenError, linenHttpStatus } from "./errors";
import {
  approveCondemn, borrowBetweenWards, receiveFromLaundry, recordInfected, recordSoiled, recordWardCount, rejectCondemn,
  requestCondemn, sendToLaundry, setParLevel, topUpWard,
} from "./intents";
import { LINEN_CSSD_RECEIVE, LINEN_HANDLE, LINEN_HOLD_RELEASE, LINEN_MANAGE, LINEN_PLANT, LINEN_QC, LINEN_VIEW } from "./manifest";
import { linenBoard, linenHandlerView, weeklyVariance } from "./reads";
import { openRound, recentRounds, sealBag, sealedBags, signDelivery, signPickup, soiledRoomView, wardBeds, weighBag } from "./floor";
import { activeHolds, placeHold, releaseHold } from "./holds";
import {
  addMachine, finishCycle, handToCssd, markMachineDown, markMachineUp, mendReturn, plantView, recordQc, releaseBatch, routeToVendor,
  startCycle,
} from "./plant";
import { bedsWaitingForLinen, rushDemand } from "./gate";
import {
  addLinenVendor, approveBillExcess, approveRecovery, challanCards, checkVendorBill, istMonthOf, istMonthStart, raiseRecovery, recentBills,
  recentRecoveries, recordChallanReturn, refuseBillExcess, rejectRecovery, setLinenItemCost, setVendorRate, updateLinenVendor, vendorCards,
  vendorMonthReport,
} from "./vendor";
import { exchangeUniform, issueUniform, returnUniform, setUniformRole, uniformDues, uniformHoldings, uniformRoles } from "./uniforms";
import { registerPiece } from "./pieces";
import { linenSetupView } from "./setup";
import { chemicalUse, fileLicence, licenceCalendar } from "./plantcost";
import { LINEN_BILL_APPROVE, LINEN_RECOVERY_APPROVE, LINEN_UNIFORM, LINEN_VENDOR } from "./manifest";
import { mlcOccupiedBeds } from "../ipd";
import type {
  Actor, LinenActResult, LinenBagCard, LinenBedWait, LinenBoardView, LinenFloorView, LinenHandlerView, LinenLaundryView,
  LinenPlantView, LinenRoundCard, LinenVarianceRow, LinenBillCard, LinenSetupView, LinenUniformView, LinenVendorDeskView, LinenVendorMonthReport,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE LINEN DOORS. The door checks the permission; the intent checks the ledger. A refusal answers
 * `{ code, message, fix }` (spec IPD core §0A.5).
 */
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LinenError) {
      const status = linenHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix, details: e.details }, status);
    }
    throw e;
  }
}

type Decided = { id: string; state: string };

@Controller("linen")
export class LinenController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async board(): Promise<LinenBoardView> {
    return linenBoard(this.db, new Date());
  }

  @Get("handler")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async handler(): Promise<LinenHandlerView> {
    return linenHandlerView(this.db, new Date());
  }

  @Get("variance")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async variance(@Query() q: unknown): Promise<LinenVarianceRow[]> {
    const r = linenVarianceQuery.safeParse(q);
    if (!r.success) throw new HttpException({ statusCode: 400, code: "bad_input", message: "The request is not complete.", fix: "Pick a week from the list." }, 400);
    return weeklyVariance(this.db, new Date(r.data.from), new Date(r.data.to));
  }

  @Post("wards/:id/top-up")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async topUp(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => topUpWard(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/soiled")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async soiled(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordSoiled(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/infected")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async infected(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordInfected(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/count")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async count(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordWardCount(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/par")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async par(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ wardId: string; itemCode: string; par: number | null }> {
    return refusing(() => setParLevel(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("borrow")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async borrow(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => borrowBetweenWards(this.db, actor, b));
  }

  @Post("laundry/batches")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async send(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => sendToLaundry(this.db, actor, b));
  }

  @Post("laundry/batches/:id/receive")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async receive(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => receiveFromLaundry(this.db, actor, { ...body(b), batchId: id }));
  }

  @Post("condemn")
  @RequirePermission(LINEN_HANDLE, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async condemn(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await requestCondemn(this.db, actor, b); return { id: r.id, state: r.state }; });
  }

  @Post("condemn/:id/approve")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async approve(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await approveCondemn(this.db, actor, { ...body(b), requestId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("condemn/:id/reject")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async reject(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await rejectCondemn(this.db, actor, { ...body(b), requestId: id }); return { id: r.id, state: r.state }; });
  }

  /* ═══ LD-1 (#978, decision 0087) — the laundry floor ═══ */

  @Get("floor")
  @RequirePermission(LINEN_HANDLE, "hospital", { alsoAdmits: [LINEN_VIEW, LINEN_PLANT] })
  async floor(): Promise<LinenFloorView> {
    return {
      rounds: await recentRounds(this.db), holds: await activeHolds(this.db), soiledRoom: await soiledRoomView(this.db),
      bedsWaiting: await bedsWaitingForLinen(this.db), mlcBeds: await mlcOccupiedBeds(this.db),
      sealedBags: await sealedBags(this.db), beds: await wardBeds(this.db),
    };
  }

  @Get("laundry")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_MANAGE, LINEN_PLANT] })
  async laundry(): Promise<LinenLaundryView> {
    const now = new Date();
    return {
      serverNow: now.toISOString(), bedsWaiting: await bedsWaitingForLinen(this.db), holds: await activeHolds(this.db),
      rush: await rushDemand(this.db, now), plant: await plantView(this.db, now),
    };
  }

  /** The Beds board's "waiting for linen" line reads this too. */
  @Get("beds-waiting")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_HANDLE, "ipd.beds.view"] })
  async bedsWaiting(): Promise<LinenBedWait[]> {
    return bedsWaitingForLinen(this.db);
  }

  @Post("rounds")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async openRound(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenRoundCard> {
    return refusing(() => openRound(this.db, actor, b));
  }

  @Post("rounds/:id/pickup")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async pickup(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenRoundCard> {
    return refusing(() => signPickup(this.db, actor, { ...body(b), roundId: id }));
  }

  @Post("rounds/:id/delivery")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async delivery(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenRoundCard> {
    return refusing(() => signDelivery(this.db, actor, { ...body(b), roundId: id }));
  }

  @Post("bags")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async seal(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string; tag: string }> {
    return refusing(() => sealBag(this.db, actor, b));
  }

  @Post("bags/weigh")
  @RequirePermission(LINEN_HANDLE, "hospital", { alsoAdmits: [LINEN_PLANT] })
  async weigh(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenBagCard> {
    return refusing(() => weighBag(this.db, actor, b));
  }

  @Post("holds")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async hold(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await placeHold(this.db, actor, b); return { id: r.id, state: r.state }; });
  }

  @Post("holds/:id/release")
  @RequirePermission(LINEN_HOLD_RELEASE, "hospital")
  async releaseHold(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await releaseHold(this.db, actor, { ...body(b), holdId: id }); return { id: r.id, state: r.state }; });
  }

  @Get("plant")
  @RequirePermission(LINEN_PLANT, "hospital", { alsoAdmits: [LINEN_VIEW, LINEN_QC] })
  async plant(): Promise<LinenPlantView> {
    return plantView(this.db, new Date());
  }

  @Post("machines")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async machine(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await addMachine(this.db, actor, b); return { id: r.id, state: r.state }; });
  }

  @Post("machines/:id/down")
  @RequirePermission(LINEN_PLANT, "hospital")
  async down(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await markMachineDown(this.db, actor, { ...body(b), machineId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("machines/:id/up")
  @RequirePermission(LINEN_PLANT, "hospital")
  async up(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<Decided> {
    return refusing(async () => { const r = await markMachineUp(this.db, actor, { machineId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("cycles")
  @RequirePermission(LINEN_PLANT, "hospital")
  async cycle(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: (await startCycle(this.db, actor, b)).id }));
  }

  @Post("cycles/:id/finish")
  @RequirePermission(LINEN_PLANT, "hospital")
  async finish(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string; disinfected: boolean | null }> {
    return refusing(async () => { const r = await finishCycle(this.db, actor, { ...body(b), cycleId: id }); return { id: r.id, disinfected: r.disinfected }; });
  }

  @Post("laundry/batches/:id/release")
  @RequirePermission(LINEN_PLANT, "hospital")
  async release(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<Decided> {
    return refusing(async () => { const r = await releaseBatch(this.db, actor, { batchId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("laundry/batches/:id/vendor")
  @RequirePermission(LINEN_PLANT, "hospital")
  async vendor(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<Decided> {
    return refusing(async () => { const r = await routeToVendor(this.db, actor, { batchId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("laundry/batches/:id/qc")
  @RequirePermission(LINEN_QC, "hospital")
  async qc(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ batchId: string; movements: number; condemnRequests: number }> {
    return refusing(() => recordQc(this.db, actor, { ...body(b), batchId: id }));
  }

  /** The CSSD nurse signs with their PIN on the operator's screen; the door admits the operator or the CSSD receiver. */
  @Post("laundry/batches/:id/cssd")
  @RequirePermission(LINEN_PLANT, "hospital", { alsoAdmits: [LINEN_CSSD_RECEIVE] })
  async cssd(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ batchId: string; movements: number }> {
    return refusing(() => handToCssd(this.db, actor, { ...body(b), batchId: id }));
  }

  @Post("mending/return")
  @RequirePermission(LINEN_QC, "hospital")
  async mended(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ movements: number }> {
    return refusing(() => mendReturn(this.db, actor, b));
  }

  /* ═══ LD-2 (#979, decisions 0087 and 0092) — vendor laundry, uniforms, tags, licences ═══ */

  /** The laundry desk: vendors, open challans, the month's reports, bills, recoveries, licences and chemical use. */
  @Get("vendor-desk")
  @RequirePermission(LINEN_VENDOR, "hospital", { alsoAdmits: [LINEN_RECOVERY_APPROVE, LINEN_BILL_APPROVE] })
  async vendorDesk(@Query() q: unknown): Promise<LinenVendorDeskView> {
    const now = new Date();
    const asked = linenMonthQuery.safeParse(q);
    // The default month is the last one ended: the one whose report and bill are due now.
    const month = asked.success ? asked.data.month : istMonthOf(new Date(istMonthStart(now).getTime() - 1));
    const vendors = await vendorCards(this.db);
    const reports: LinenVendorMonthReport[] = [];
    for (const v of vendors) reports.push(await vendorMonthReport(this.db, v.id, month, now));
    return {
      serverNow: now.toISOString(), month, vendors, openChallans: await challanCards(this.db, now, { open: true }), reports,
      bills: await recentBills(this.db), recoveries: await recentRecoveries(this.db), licences: await licenceCalendar(this.db, now),
      chemicals: await chemicalUse(this.db, month),
    };
  }

  @Post("vendors")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async addVendor(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: (await addLinenVendor(this.db, actor, b)).id }));
  }

  /** The setup screen (#1014): vendors, rates, item costs, licences, uniform roles. */
  @Get("setup")
  @RequirePermission(LINEN_VENDOR, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async setup(): Promise<LinenSetupView> {
    return linenSetupView(this.db, new Date());
  }

  @Post("vendors/:id")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async updateVendor(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: (await updateLinenVendor(this.db, actor, { ...body(b), linenVendorId: id })).id }));
  }

  @Post("vendors/:id/rates")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async rate(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(() => setVendorRate(this.db, actor, { ...body(b), linenVendorId: id }));
  }

  @Get("vendors/:id/report")
  @RequirePermission(LINEN_VENDOR, "hospital", { alsoAdmits: [LINEN_RECOVERY_APPROVE] })
  async report(@Param("id") id: string, @Query() q: unknown): Promise<LinenVendorMonthReport> {
    const r = linenMonthQuery.safeParse(q);
    if (!r.success) throw new HttpException({ statusCode: 400, code: "bad_input", message: "The request is not complete.", fix: "Pick a month." }, 400);
    return refusing(() => vendorMonthReport(this.db, id, r.data.month, new Date()));
  }

  @Post("items/:code/cost")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async itemCost(@CurrentActor() actor: Actor, @Param("code") code: string, @Body() b: unknown): Promise<{ itemCode: string }> {
    return refusing(() => setLinenItemCost(this.db, actor, { ...body(b), itemCode: code }));
  }

  @Post("challans/:id/return")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async challanReturn(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ challanId: string; closed: boolean; condemnRequests: number }> {
    return refusing(async () => {
      const r = await recordChallanReturn(this.db, actor, { ...body(b), challanId: id });
      return { challanId: r.challanId, closed: r.closed, condemnRequests: r.condemnRequests };
    });
  }

  @Post("recoveries")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async raise(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await raiseRecovery(this.db, actor, b); return { id: r.id, state: r.state }; });
  }

  @Post("recoveries/:id/approve")
  @RequirePermission(LINEN_RECOVERY_APPROVE, "hospital")
  async approveRec(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await approveRecovery(this.db, actor, { ...body(b), recoveryId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("recoveries/:id/reject")
  @RequirePermission(LINEN_RECOVERY_APPROVE, "hospital")
  async rejectRec(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await rejectRecovery(this.db, actor, { ...body(b), recoveryId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("bills")
  @RequirePermission(LINEN_VENDOR, "hospital")
  async bill(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenBillCard> {
    return refusing(() => checkVendorBill(this.db, actor, b));
  }

  @Post("bills/:id/approve")
  @RequirePermission(LINEN_BILL_APPROVE, "hospital")
  async approveBill(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenBillCard> {
    return refusing(() => approveBillExcess(this.db, actor, { ...body(b), billId: id }));
  }

  @Post("bills/:id/refuse")
  @RequirePermission(LINEN_BILL_APPROVE, "hospital")
  async refuseBill(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenBillCard> {
    return refusing(() => refuseBillExcess(this.db, actor, { ...body(b), billId: id }));
  }

  @Post("pieces")
  @RequirePermission(LINEN_VENDOR, "hospital", { alsoAdmits: [LINEN_PLANT] })
  async piece(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(async () => ({ id: (await registerPiece(this.db, actor, b)).id }));
  }

  @Post("licences")
  @RequirePermission(LINEN_VENDOR, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async licence(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ id: string }> {
    return refusing(() => fileLicence(this.db, actor, b));
  }

  /** Uniforms: holdings, the roles issued uniforms, and the no-dues list of leavers. */
  @Get("uniforms")
  @RequirePermission(LINEN_UNIFORM, "hospital", { alsoAdmits: [LINEN_VIEW] })
  async uniforms(): Promise<LinenUniformView> {
    const now = new Date();
    return { serverNow: now.toISOString(), roles: await uniformRoles(this.db), holdings: await uniformHoldings(this.db), dues: await uniformDues(this.db, now) };
  }

  @Post("uniforms/issue")
  @RequirePermission(LINEN_UNIFORM, "hospital")
  async issueU(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ holding: number }> {
    return refusing(() => issueUniform(this.db, actor, b));
  }

  @Post("uniforms/exchange")
  @RequirePermission(LINEN_UNIFORM, "hospital")
  async exchangeU(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ holding: number }> {
    return refusing(() => exchangeUniform(this.db, actor, b));
  }

  @Post("uniforms/return")
  @RequirePermission(LINEN_UNIFORM, "hospital")
  async returnU(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ holding: number }> {
    return refusing(() => returnUniform(this.db, actor, b));
  }

  @Post("uniforms/roles")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async uniformRole(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ roleKey: string; entitled: boolean }> {
    return refusing(() => setUniformRole(this.db, actor, b));
  }
}

