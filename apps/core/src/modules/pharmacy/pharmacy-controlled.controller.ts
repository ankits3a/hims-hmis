import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import {
  CONTROLLED_LICENCE_KINDS, CUSTODY_PERMISSION, LICENCES_PERMISSION, endEndPrescriber, listControlledLicences, listEndPrescribers,
  recordControlledLicence, recordEndPrescriber,
} from "./controlled";
import { checkSheet, controlledToday, readControlledBalance, readControlledRegister, recordCheck, witnessedAct } from "./controlled-office";
import { controlledRegisterDocument } from "./controlled-print";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { ControlledBalance, ControlledCheckResult, ControlledSheetLine } from "../materials";
import type { ControlledLicenceView, EndPrescriberView } from "./controlled";
import type { ControlledRegisterView, ControlledToday } from "./controlled-office";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const witness = z.object({ username: z.string().min(1).max(64), pin: z.string().min(1).max(32) });
const licenceBody = z.object({
  kind: z.enum(CONTROLLED_LICENCE_KINDS),
  licenceNo: z.string().max(80), form: z.string().max(40), issuingAuthority: z.string().max(160), holderName: z.string().max(160),
  responsiblePerson: z.string().max(160), validFrom: isoDate, validUntil: isoDate,
  documentRef: z.string().max(200).optional(), note: z.string().max(500).optional(),
});
const prescriberBody = z.object({ doctorId: idSchema, training: z.string().max(300) });
const endBody = z.object({ reason: z.string().max(300) });
const checkBody = z.object({
  witness,
  lines: z.array(z.object({ batchId: idSchema, countedQty: z.number().int().min(0).max(10_000_000) })).max(500),
  note: z.string().max(500).optional(),
});
const actBody = z.object({ witness }).and(z.discriminatedUnion("act", [
  z.object({ act: z.literal("grn_post"), grnId: idSchema }),
  z.object({ act: z.literal("transfer_receive"), transferId: idSchema, lines: z.array(z.object({ lineId: idSchema, qtyReceived: z.number().int().min(0) })).min(1).max(200) }),
  z.object({ act: z.literal("return_dispatch"), returnId: idSchema, controllerApprovalRef: z.string().max(120).optional() }),
  z.object({
    act: z.literal("write_off_post"), writeOffId: idSchema,
    disposal: z.object({ disposalAgency: z.string().max(160).optional(), manifestNo: z.string().max(80).optional(), disposalDate: isoDate.optional() }).optional(),
    officer: z.object({ name: z.string().max(120), designation: z.string().max(120), orderRef: z.string().max(120) }).optional(),
  }),
  z.object({ act: z.literal("adjustment_post"), approvalId: idSchema }),
]));
const rangeQuery = z.object({ from: isoDate, to: isoDate });
const registerQuery = rangeQuery.extend({ register: z.enum(["ndps", "x", "all"]).default("all"), patientId: idSchema.optional() });
const printQuery = rangeQuery.extend({ kind: z.enum(["form3h", "schedule_x", "form3e"]), patientId: idSchema.optional() });

/**
 * ═══ PHARMACY P6 — THE CONTROLLED-DRUG CABINET'S ROUTES (the office's Controlled side) ═══
 *
 * Reads that three kinds of person may make (the custodian, the licence keeper, the register reader) carry
 * no route permission and are refused inside the read by name; every write carries its grant here AND is
 * asked again in the act (`controlled.ts`, `controlled-office.ts`), so a caller that is not this
 * controller is held to the same rule. The witness's PIN travels in the body of the act it witnesses and
 * is read once, never stored or evented.
 */
@Controller("pharmacy/controlled")
export class PharmacyControlledController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("today")
  async today(@CurrentActor() actor: Actor): Promise<ControlledToday> {
    try { return await controlledToday(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("licences")
  async licences(@CurrentActor() actor: Actor): Promise<{ items: ControlledLicenceView[] }> {
    try { return { items: await listControlledLicences(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(LICENCES_PERMISSION, "hospital")
  @Post("licences")
  async recordLicence(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ControlledLicenceView> {
    const input = parsed(licenceBody, body);
    try { return await recordControlledLicence(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("prescribers")
  async prescribers(@CurrentActor() actor: Actor): Promise<{ current: EndPrescriberView[]; doctors: { id: string; name: string; registrationNo: string | null }[] }> {
    try { return await listEndPrescribers(this.db, actor); } catch (e) { toHttp(e); }
  }

  @RequirePermission(LICENCES_PERMISSION, "hospital")
  @Post("prescribers")
  async recordPrescriber(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ id: string }> {
    const input = parsed(prescriberBody, body);
    try { return await recordEndPrescriber(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(LICENCES_PERMISSION, "hospital")
  @Post("prescribers/:id/end")
  async endPrescriber(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const input = parsed(endBody, body);
    try { await endEndPrescriber(this.db, actor, id, input.reason, new Date()); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(CUSTODY_PERMISSION, "hospital")
  @Get("check")
  async sheet(@CurrentActor() actor: Actor): Promise<{ lines: ControlledSheetLine[] }> {
    try { return { lines: await checkSheet(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @RequirePermission(CUSTODY_PERMISSION, "hospital")
  @Post("checks")
  async check(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ControlledCheckResult> {
    const input = parsed(checkBody, body);
    try { return await recordCheck(this.db, actor, input, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(CUSTODY_PERMISSION, "hospital")
  @Post("acts")
  async act(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ act: string; refId: string }> {
    const { witness: w, ...input } = parsed(actBody, body);
    try { return await witnessedAct(this.db, actor, w, input, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("register")
  async register(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<ControlledRegisterView> {
    const input = parsed(registerQuery, q);
    try { return await readControlledRegister(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  /** The registers on A4 in the forms' layout, printed by the browser (the purchase order's path). */
  @Get("register/document")
  async document(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<RenderedDocument> {
    const input = parsed(printQuery, q);
    try { return await controlledRegisterDocument(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Get("balance")
  async balance(@CurrentActor() actor: Actor, @Query() q: unknown): Promise<ControlledBalance> {
    const input = parsed(rangeQuery, q);
    try { return await readControlledBalance(this.db, actor, input); } catch (e) { toHttp(e); }
  }
}
