import { Body, Controller, Get, Header, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { z } from "zod";
import {
  storesAssetCloseRepairBody, storesAssetCodeBody, storesAssetCostBody, storesAssetDetailsBody, storesAssetDeviceBody, storesAssetFaultBody,
  storesAssetFoundBody, storesAssetOpenBody, storesAssetRepairBody, storesAssetRetagBody, storesAssetTransferBody, storesAssetVoidBody,
  storesTagUnitsBody, storesVerificationScanBody, storesVerificationStartBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { linesUnderRule } from "./asset-rules";
import { assetAdditions, assetsCostUnknown, assetsDue } from "./asset-reads";
import {
  STORES_ASSETS_EXPORT, acceptUnitTransfer, addAssetDetails, assetPassport, assetRegister, closeRepair, fillUnitCost, grnLineTagging, linkDevice, myAssets,
  openRepair, openUnit, proposeUnitTransfer, reportFault, reportFoundHere, retag, tagUnits, unitsToAccept, voidTag,
} from "./assets";
import { renderAssetLabel } from "./asset-label";
import { parsed, toHttp } from "./stores-http";
import { closeVerification, roundView, scanVerification, startVerification, verificationRounds } from "./verification";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

type CsvReply = { setHeader(name: string, value: string): unknown };
const id = z.string().min(1).max(64);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

/**
 * STORES S4a (#1114) — `/stores/assets/*`, the asset passport.
 *
 * Like the shelf routes, most carry NO route guard: the passport is read by a department's own shelf-grant holders
 * (department scope), by anyone with a shelf grant for "Belongs to … / Found here", and in full by
 * `stores.assets.read`; each intent asks its own grant (`assets.ts`). The export carries `stores.assets.export`.
 * Fixed paths are declared before `:unitId`.
 */
@Controller("stores/assets")
export class StoresAssetsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Register: every unit (stores.assets.read). */
  @Get("register")
  @Header("Cache-Control", "no-store")
  async register(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await assetRegister(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** Department assets on the phone: the units of the departments this person reads or works at. */
  @Get("mine")
  @Header("Cache-Control", "no-store")
  async mine(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      const now = new Date();
      return { rows: (await myAssets(this.db, actor, now)).rows, toAccept: (await unitsToAccept(this.db, actor, now)).rows };
    } catch (e) { toHttp(e); }
  }

  @Get("due")
  @Header("Cache-Control", "no-store")
  async due(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await assetsDue(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** Posted GRN lines that still owe tags (the Register tab's "Tag units"). */
  @Get("grns")
  @Header("Cache-Control", "no-store")
  async grns(): Promise<unknown> {
    try {
      const now = new Date();
      const lines = [];
      for (const l of await linesUnderRule(this.db)) {
        const t = await grnLineTagging(this.db, l.grnLineId, now);
        if (t !== null && t.decision === "tagged" && t.tagged < t.qty) lines.push(t);
      }
      return { lines };
    } catch (e) { toHttp(e); }
  }

  @Get("grn-lines/:grnLineId")
  @Header("Cache-Control", "no-store")
  async grnLine(@Param("grnLineId") grnLineId: string): Promise<unknown> {
    try { return await grnLineTagging(this.db, parsed(id, grnLineId), new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tag")
  async tag(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesTagUnitsBody, body);
    try { return await tagUnits(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  /** A scan or the typed last four: the passport, "Belongs to …", or two matches to pick from. */
  @Get("lookup")
  @Header("Cache-Control", "no-store")
  async lookup(@CurrentActor() actor: Actor, @Query("code") code?: string): Promise<unknown> {
    try { return await assetPassport(this.db, actor, { code: parsed(z.string().min(4).max(20), code) }, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("transfer/accept")
  async accept(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetCodeBody, body);
    try { return await acceptUnitTransfer(this.db, actor, { code: input.code }, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("opening")
  async opening(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetOpenBody, body);
    try { return await openUnit(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("cost-unknown")
  @Header("Cache-Control", "no-store")
  async costUnknown(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await assetsCostUnknown(this.db, actor); } catch (e) { toHttp(e); }
  }

  /** Decision 15: the month's additions for Tally, JSON or CSV (`format=csv`). One audit event per download. */
  @Get("exports/additions")
  @RequirePermission(STORES_ASSETS_EXPORT, "hospital")
  @Header("Cache-Control", "no-store")
  async additions(@CurrentActor() actor: Actor, @Query("month") m: string | undefined, @Query("format") format: string | undefined, @Res({ passthrough: true }) res: CsvReply): Promise<unknown> {
    try {
      const r = await assetAdditions(this.db, actor, parsed(month, m), new Date());
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="asset-additions-${r.month}.csv"`);
        return r.csv;
      }
      return { month: r.month, rows: r.rows };
    } catch (e) { toHttp(e); }
  }

  @Get("verification")
  @Header("Cache-Control", "no-store")
  async rounds(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await verificationRounds(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("verification")
  async startRound(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesVerificationStartBody, body);
    try {
      const { roundId } = await startVerification(this.db, actor, input, new Date());
      return await roundView(this.db, roundId);
    } catch (e) { toHttp(e); }
  }

  @Get("verification/:roundId")
  @Header("Cache-Control", "no-store")
  async round(@Param("roundId") roundId: string): Promise<unknown> {
    try { return await roundView(this.db, parsed(id, roundId)); } catch (e) { toHttp(e); }
  }

  @Post("verification/:roundId/scan")
  async scanRound(@CurrentActor() actor: Actor, @Param("roundId") roundId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesVerificationScanBody, body);
    try { return await scanVerification(this.db, actor, parsed(id, roundId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("verification/:roundId/close")
  async closeRound(@CurrentActor() actor: Actor, @Param("roundId") roundId: string): Promise<unknown> {
    try { return await closeVerification(this.db, actor, parsed(id, roundId), new Date()); } catch (e) { toHttp(e); }
  }

  /* ─────────────── one unit ─────────────── */

  @Get(":unitId")
  @Header("Cache-Control", "no-store")
  async passport(@CurrentActor() actor: Actor, @Param("unitId") unitId: string): Promise<unknown> {
    try { return await assetPassport(this.db, actor, { unitId: parsed(id, unitId) }, new Date()); } catch (e) { toHttp(e); }
  }

  @Get(":unitId/label")
  @Header("Cache-Control", "no-store")
  async label(@CurrentActor() actor: Actor, @Param("unitId") unitId: string): Promise<unknown> {
    try {
      await assetPassport(this.db, actor, { unitId: parsed(id, unitId) }, new Date());
      return await renderAssetLabel(this.db, { unitId });
    } catch (e) { toHttp(e); }
  }

  @Post(":unitId/fault")
  async fault(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetFaultBody, body);
    try { return await reportFault(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/repair")
  async repair(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetRepairBody, body);
    try { return await openRepair(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/repair/close")
  async repairClose(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetCloseRepairBody, body);
    try { return await closeRepair(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/details")
  async details(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetDetailsBody, body);
    try { return await addAssetDetails(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/device")
  async device(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetDeviceBody, body);
    try { return await linkDevice(this.db, actor, parsed(id, unitId), input.deviceId, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/found-here")
  async found(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetFoundBody, body);
    try { return await reportFoundHere(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/transfer")
  async transfer(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetTransferBody, body);
    try { return await proposeUnitTransfer(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/void-tag")
  async voidTag(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetVoidBody, body);
    try { return await voidTag(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/retag")
  async retag(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetRetagBody, body);
    try { return await retag(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/cost")
  async cost(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetCostBody, body);
    try {
      await fillUnitCost(this.db, actor, parsed(id, unitId), input.unitCostPaise, new Date());
      return await assetPassport(this.db, actor, { unitId }, new Date());
    } catch (e) { toHttp(e); }
  }
}
