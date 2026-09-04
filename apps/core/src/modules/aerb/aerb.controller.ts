import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { AERB_LICENCE_TYPES, AERB_PERSON_ROLES, QA_RESULTS } from "../../kernel/db/schema/aerb";
import { appointPerson, changeLicenceStatus, endAppointment, fileLicence } from "./licences";
import { appointments, licenceRegister, unlicensedDevices } from "./read";
import { qaRegister, recordQa } from "./qa";
import { collectResourceKinds } from "../../kernel/resources/kinds";
import { idSchema, isoDateSchema, parsed, toHttp } from "./aerb-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 18c T1 — the RSO's desk over HTTP.
 *
 * ═══ THE READ AND THE WRITE ARE DIFFERENT PERMISSIONS, AND THE INSPECTOR IS A READER ═══
 *
 * `aerb.registers.read` buys the book; `aerb.registers.manage` buys the pen. A quality manager
 * showing an inspector the file holds the first and not the second, and the separation is what
 * makes "who filed this licence" a question with one answer.
 *
 * There is deliberately **no route that edits a filed licence's number or dates**. A licence is a
 * document AERB issued: a correction is a status change plus a new row, so the register can always
 * be asked what it said on the day of a given scan. That is the `imaging_definitions` posture
 * (no edit of an active version) applied to a statutory record.
 */
const fileLicenceBody = z.object({
  deviceResourceId: idSchema,
  licenceType: z.enum(AERB_LICENCE_TYPES),
  licenceNo: z.string().min(1).max(64),
  eloraRef: z.string().max(64).nullish(),
  typeApprovalRef: z.string().max(64).nullish(),
  layoutApprovalRef: z.string().max(64).nullish(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema,
  rsoUserId: idSchema.nullish(),
  remarks: z.string().max(500).nullish(),
});

const statusBody = z.object({
  to: z.enum(["active", "suspended", "surrendered"]),
  reason: z.string().max(500).nullish(),
  decommissionRef: z.string().max(64).nullish(),
});

const appointBody = z.object({
  userId: idSchema,
  personRole: z.enum(AERB_PERSON_ROLES),
  approvalRef: z.string().max(64).nullish(),
  qualification: z.string().min(1).max(200),
  validFrom: isoDateSchema,
  validTo: isoDateSchema.nullish(),
});

const qaBody = z.object({
  deviceResourceId: idSchema,
  qaType: z.string().min(1).max(80),
  result: z.enum(QA_RESULTS),
  performedBy: z.string().min(1).max(120),
  performedOn: isoDateSchema,
  agencyRef: z.string().max(64).nullish(),
  values: z.record(z.string(), z.unknown()).optional(),
  nextDueOn: isoDateSchema.nullish(),
  remarks: z.string().max(500).nullish(),
});

@Controller("aerb")
export class AerbController {
  constructor(
    @Inject(DB) private readonly db: Db,
    /**
     * PLAN 18c T2 — the installed manifests, so the `device` kind's vocabulary comes from the
     * kernel's own collector rather than from a second copy in this module. `aerb` must not import
     * `RADIOLOGY_RESOURCE_KINDS`: the dependency runs radiology → aerb (D1), and importing back
     * would make a cycle out of a statute.
     */
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("licences")
  @RequirePermission("aerb.registers.read", "hospital")
  async licences(@Query("includeInactive") includeInactive?: string): Promise<unknown> {
    try {
      return { rows: await licenceRegister(this.db, { includeInactive: includeInactive === "true" }) };
    } catch (e) { toHttp(e); }
  }

  /**
   * The negative-space row (§14's own question): machines that emit and have no paper. It is a
   * READ of the same register and carries the same permission — an inspector is entitled to the
   * gap as much as to the file.
   */
  @Get("licences/gaps")
  @RequirePermission("aerb.registers.read", "hospital")
  async gaps(@Query("onDate") onDate?: string): Promise<unknown> {
    const date = parsed(isoDateSchema, onDate);
    try {
      return { rows: await unlicensedDevices(this.db, date) };
    } catch (e) { toHttp(e); }
  }

  @Post("licences")
  @RequirePermission("aerb.registers.manage", "hospital")
  async file(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(fileLicenceBody, body);
    try {
      return await withTx(this.db, (tx) => fileLicence(tx, actor, {
        ...input,
        eloraRef: input.eloraRef ?? null,
        typeApprovalRef: input.typeApprovalRef ?? null,
        layoutApprovalRef: input.layoutApprovalRef ?? null,
        rsoUserId: input.rsoUserId ?? null,
        remarks: input.remarks ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("licences/:id/status")
  @RequirePermission("aerb.registers.manage", "hospital")
  async status(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<unknown> {
    const licenceId = parsed(idSchema, id);
    const input = parsed(statusBody, body);
    try {
      await withTx(this.db, (tx) => changeLicenceStatus(tx, actor, licenceId, input.to, {
        reason: input.reason ?? null,
        decommissionRef: input.decommissionRef ?? null,
      }));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @Get("qa")
  @RequirePermission("aerb.registers.read", "hospital")
  async qa(@Query("deviceResourceId") deviceResourceId?: string): Promise<unknown> {
    try {
      return { rows: await qaRegister(this.db, deviceResourceId === undefined ? {} : { deviceResourceId }) };
    } catch (e) { toHttp(e); }
  }

  /**
   * Records the result AND moves the machine, in one transaction. A `fail` on a machine that is
   * mid-examination refuses (`already_occupied` from the registry, mapped to 409) and the record
   * rolls back with it — stopping a tube with a patient on the table is a decision a person makes
   * at the console, not one a register makes behind their back.
   */
  @Post("qa")
  @RequirePermission("aerb.registers.manage", "hospital")
  async recordQaResult(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(qaBody, body);
    const kinds = collectResourceKinds(this.registry);
    try {
      return await withTx(this.db, (tx) => recordQa(tx, actor, kinds, {
        ...input,
        agencyRef: input.agencyRef ?? null,
        nextDueOn: input.nextDueOn ?? null,
        remarks: input.remarks ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Get("persons")
  @RequirePermission("aerb.registers.read", "hospital")
  async persons(@Query("onDate") onDate?: string): Promise<unknown> {
    try {
      return { rows: await appointments(this.db, onDate ? { onDate } : { includeEnded: true }) };
    } catch (e) { toHttp(e); }
  }

  @Post("persons")
  @RequirePermission("aerb.registers.manage", "hospital")
  async appoint(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(appointBody, body);
    try {
      return await withTx(this.db, (tx) => appointPerson(tx, actor, {
        ...input,
        approvalRef: input.approvalRef ?? null,
        validTo: input.validTo ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("persons/:id/end")
  @RequirePermission("aerb.registers.manage", "hospital")
  async end(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const personId = parsed(idSchema, id);
    try {
      await withTx(this.db, (tx) => endAppointment(tx, actor, personId));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }
}
