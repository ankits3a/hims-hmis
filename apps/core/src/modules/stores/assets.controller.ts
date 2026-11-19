import { Body, Controller, Get, Header, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { z } from "zod";
import {
  storesAssetCloseRepairBody, storesAssetCodeBody, storesAssetCostBody, storesAssetDetailsBody, storesAssetDeviceBody, storesAssetFaultBody,
  storesAssetFoundBody, storesAssetOpenBody, storesAssetRepairBody, storesAssetRetagBody, storesAssetTransferBody, storesAssetVoidBody,
  storesCondemnBody, storesCondemnObjectBody, storesDisposeBody, storesMarkFoundBody, storesRegulationBody, storesRegulatorPaperBody, storesTagUnitsBody,
  storesVerificationScanBody, storesVerificationStartBody, storesWithdrawBody, storesWriteOffLossBody,
} from "@hmis/contracts";
import { newId } from "@hmis/contracts";
import { DOCUMENT_STORE } from "../../kernel/tokens";
import type { DocumentStore } from "../../kernel/documents/store";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { linesUnderRule } from "./asset-rules";
import { assetAdditions, assetsCostUnknown, assetsDue } from "./asset-reads";
import {
  STORES_ASSETS_EXPORT, acceptUnitTransfer, addAssetDetails, assetPassport, assetRegister, closeRepair, fillUnitCost, grnLineTagging, linkDevice, myAssets,
  openRepair, openUnit, proposeUnitTransfer, reportFault, reportFoundHere, retag, tagUnits, unitsToAccept, voidTag,
  addRegulatorPaper, returnToUse, setItemRegulation, unitState, withdrawUnit,
} from "./assets";
import {
  assetRemovals, condemnationsToSign, disposalBuyers, disposeUnit, getCondemnation, listCondemnations, markFound, objectCondemnation, proposeCondemnation,
  signCondemnation, writeOffLoss,
} from "./condemnation";
import { StoresError } from "./errors";
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
  constructor(@Inject(DB) private readonly db: Db, @Inject(DOCUMENT_STORE) private readonly documents: DocumentStore) {}

  // ═══ S4b (#1114): condemnation, loss, disposal — each intent asks its own grant (condemnation.ts) ═══

  /** The Condemnation tab: every proposal the reader may see. */
  @Get("condemnations")
  @Header("Cache-Control", "no-store")
  async condemnations(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await listCondemnations(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** The disposal form's buyers: active suppliers (the materials head). */
  @Get("condemnations/buyers")
  @Header("Cache-Control", "no-store")
  async buyers(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { vendors: await disposalBuyers(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  /** The signer's phone: proposals with a seat this person may still sign. */
  @Get("condemnations/to-sign")
  @Header("Cache-Control", "no-store")
  async toSign(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { rows: await condemnationsToSign(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @Get("condemnations/:id")
  @Header("Cache-Control", "no-store")
  async condemnation(@CurrentActor() actor: Actor, @Param("id") cid: string): Promise<unknown> {
    try { return await getCondemnation(this.db, actor, parsed(id, cid), new Date()); } catch (e) { toHttp(e); }
  }

  @Post("condemnations")
  async propose(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesCondemnBody, body);
    try { return await proposeCondemnation(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("condemnations/:id/sign")
  async sign(@CurrentActor() actor: Actor, @Param("id") cid: string): Promise<unknown> {
    try { return await signCondemnation(this.db, actor, parsed(id, cid), new Date()); } catch (e) { toHttp(e); }
  }

  @Post("condemnations/:id/object")
  async object(@CurrentActor() actor: Actor, @Param("id") cid: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesCondemnObjectBody, body);
    try { return await objectCondemnation(this.db, actor, parsed(id, cid), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("condemnations/:id/dispose")
  async dispose(@CurrentActor() actor: Actor, @Param("id") cid: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesDisposeBody, body);
    try { return await disposeUnit(this.db, actor, parsed(id, cid), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("condemnations/:id/write-off")
  async writeOff(@CurrentActor() actor: Actor, @Param("id") cid: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesWriteOffLossBody, body);
    try { return await writeOffLoss(this.db, actor, parsed(id, cid), input, new Date()); } catch (e) { toHttp(e); }
  }

  /** Decision 18: biomedical marks an item as regulated (radiation, ultrasound) or clears it. */
  @Post("items/:itemId/regulation")
  async regulation(@CurrentActor() actor: Actor, @Param("itemId") itemId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesRegulationBody, body);
    try {
      await setItemRegulation(this.db, actor, parsed(id, itemId), input.regulatedBy, new Date());
      return { itemId, regulatedBy: input.regulatedBy };
    } catch (e) { toHttp(e); }
  }

  /** Decision 15: the month's removals for Tally, JSON or CSV (`format=csv`). One audit event per download. */
  @Get("exports/removals")
  @RequirePermission(STORES_ASSETS_EXPORT, "hospital")
  @Header("Cache-Control", "no-store")
  async removals(@CurrentActor() actor: Actor, @Query("month") m: string | undefined, @Query("format") format: string | undefined, @Res({ passthrough: true }) res: CsvReply): Promise<unknown> {
    try {
      const r = await assetRemovals(this.db, actor, parsed(month, m), new Date());
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="asset-removals-${r.month}.csv"`);
        return r.csv;
      }
      return { month: r.month, rows: r.rows };
    } catch (e) { toHttp(e); }
  }

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

  /**
   * "Report fault": one line and an optional photo (a JPEG from the phone, base64, at most ~500 KB: `PhotoCapture` caps
   * it). The bytes go to the document store (never the database); the fault event names the key. A refused fault
   * removes the bytes it wrote.
   */
  @Post(":unitId/fault")
  async fault(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesAssetFaultBody.extend({ imageBase64: z.string().max(700_000).nullish() }), body);
    const now = new Date();
    let photoKey: string | null = null;
    try {
      if (input.imageBase64 != null && input.imageBase64 !== "") {
        const bytes = Buffer.from(input.imageBase64, "base64");
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new StoresError("bad_quantity", "the photo is a JPEG");
        const day = now.toISOString();
        photoKey = `${day.slice(0, 4)}/${day.slice(5, 7)}/${newId()}.jpg`;
        await this.documents.put(photoKey, bytes);
      }
      return await reportFault(this.db, actor, parsed(id, unitId), { text: input.text, photoKey }, now);
    } catch (e) {
      if (photoKey !== null) await this.documents.remove(photoKey).catch(() => undefined);
      toHttp(e);
    }
  }

  /** A fault's photo, for whoever may read the unit's passport. Base64 in JSON, the `getPhoto` precedent. */
  @Get(":unitId/fault-photo/:eventId")
  @Header("Cache-Control", "no-store")
  async faultPhoto(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Param("eventId") eventId: string): Promise<unknown> {
    try {
      const p = await assetPassport(this.db, actor, { unitId: parsed(id, unitId) }, new Date());
      if (p.access !== "full") throw new StoresError("not_permitted", "not your department");
      const s = await unitState(this.db, unitId);
      const e = s.events.find((x) => x.id === eventId && x.kind === "fault_reported");
      const key = (e?.data as { photoKey?: unknown } | undefined)?.photoKey;
      if (typeof key !== "string") throw new StoresError("unknown_unit", "no photo");
      return { mimeType: "image/jpeg", imageBase64: (await this.documents.get(key)).toString("base64") };
    } catch (e) { toHttp(e); }
  }

  @Post(":unitId/withdraw")
  async withdraw(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesWithdrawBody, body);
    try { return await withdrawUnit(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/return-to-use")
  async backInUse(@CurrentActor() actor: Actor, @Param("unitId") unitId: string): Promise<unknown> {
    try { return await returnToUse(this.db, actor, parsed(id, unitId), new Date()); } catch (e) { toHttp(e); }
  }

  @Post(":unitId/regulator-paper")
  async regulatorPaper(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesRegulatorPaperBody, body);
    try { return await addRegulatorPaper(this.db, actor, parsed(id, unitId), input, new Date()); } catch (e) { toHttp(e); }
  }

  /** A written-off unit found again (decision 13): `found` and one opening row naming the write-off. */
  @Post(":unitId/found")
  async foundAgain(@CurrentActor() actor: Actor, @Param("unitId") unitId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesMarkFoundBody, body);
    try {
      await markFound(this.db, actor, parsed(id, unitId), input, new Date());
      return await assetPassport(this.db, actor, { unitId }, new Date());
    } catch (e) { toHttp(e); }
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
