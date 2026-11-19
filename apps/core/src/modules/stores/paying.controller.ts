import { Body, Controller, Get, Header, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  storesHoldKeepBody, storesHoldReleaseBody, storesPayBookBody, storesPayingSettingsBody, storesRecordPaymentBody, storesRunDecideBody, storesSesBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor } from "../../kernel/auth/decorators";
import { assertNotRunAuthoriser, draftPaymentRun, recordVendorPayment } from "../materials";
import { holdsDryRun, holdsForBill, keepHold, releaseHold, requirePayingReader } from "./holds";
import { bookDraft, bookFromDesk } from "./paying-book";
import { decideRunFromPhone, payablesByGroup, payingDesk, runToAuthorise, submitRunFromDesk } from "./paying-reads";
import { payingSettings, setPayingSettings } from "./paying-settings";
import { confirmServiceEntry, myServiceDepartments, readServiceEntry, servicesToConfirm } from "./service-entries";
import { parsed, toHttp } from "./stores-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const id = z.string().min(1).max(64);

/**
 * STORES S6a (#1116) — `/stores/pay/*`: the paying desk (To book, Holds, Due, Runs, Payments, Exports), the owner's
 * phone authorisation, the switches and their dry runs, and the department's "Service to confirm". No route guard: the
 * desk is read by any of the payables readers, and each act asks its own grant inside the intent (materials' bill,
 * run and payment grants; `stores.holds.release`; `stores.ses.confirm` AT the department; the owner's role).
 */
@Controller("stores/pay")
export class StoresPayingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("desk")
  @Header("Cache-Control", "no-store")
  async desk(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await payingDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("by-group")
  @Header("Cache-Control", "no-store")
  async byGroup(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await payablesByGroup(this.db, actor); } catch (e) { toHttp(e); }
  }

  /* ─────────────── book ─────────────── */

  @Get("book/:kind/:docId")
  async draft(@CurrentActor() actor: Actor, @Param("kind") kind: string, @Param("docId") docId: string): Promise<unknown> {
    const k = parsed(z.enum(["grn", "ses"]), kind);
    try { return await bookDraft(this.db, actor, k, parsed(id, docId)); } catch (e) { toHttp(e); }
  }

  @Post("book")
  async book(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPayBookBody, body);
    try { return await bookFromDesk(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  /* ─────────────── holds ─────────────── */

  @Get("bills/:billId/holds")
  async billHolds(@CurrentActor() actor: Actor, @Param("billId") billId: string): Promise<unknown> {
    try { return await holdsForBill(this.db, actor, parsed(id, billId)); } catch (e) { toHttp(e); }
  }

  @Post("holds/:holdId/release")
  async release(@CurrentActor() actor: Actor, @Param("holdId") holdId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesHoldReleaseBody, body);
    try { return await releaseHold(this.db, actor, parsed(id, holdId), b.reason); } catch (e) { toHttp(e); }
  }

  @Post("holds/:holdId/keep")
  async keep(@CurrentActor() actor: Actor, @Param("holdId") holdId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesHoldKeepBody, body);
    try { return await keepHold(this.db, actor, parsed(id, holdId), b); } catch (e) { toHttp(e); }
  }

  /* ─────────────── runs and payments ─────────────── */

  @Post("runs/draft")
  async draftRun(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await draftPaymentRun(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("runs/:runId")
  @Header("Cache-Control", "no-store")
  async run(@CurrentActor() actor: Actor, @Param("runId") runId: string): Promise<unknown> {
    try { return await runToAuthorise(this.db, actor, parsed(id, runId)); } catch (e) { toHttp(e); }
  }

  @Post("runs/:runId/submit")
  async submit(@CurrentActor() actor: Actor, @Param("runId") runId: string): Promise<unknown> {
    try { return await submitRunFromDesk(this.db, actor, parsed(id, runId)); } catch (e) { toHttp(e); }
  }

  @Post("runs/:runId/decide")
  async decide(@CurrentActor() actor: Actor, @Param("runId") runId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRunDecideBody, body);
    try { return await decideRunFromPhone(this.db, actor, parsed(id, runId), b); } catch (e) { toHttp(e); }
  }

  @Post("runs/:runId/pay")
  async pay(@CurrentActor() actor: Actor, @Param("runId") runId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRecordPaymentBody, body);
    const run = parsed(id, runId);
    try {
      await assertNotRunAuthoriser(this.db, actor, run);
      return await recordVendorPayment(this.db, actor, run, b.vendorId, { mode: b.mode, reference: b.reference ?? null, paidOn: b.paidOn ?? null });
    } catch (e) { toHttp(e); }
  }

  /* ─────────────── switches ─────────────── */

  @Get("settings")
  async settings(@CurrentActor() actor: Actor): Promise<unknown> {
    try { await requirePayingReader(this.db, actor); return await payingSettings(this.db); } catch (e) { toHttp(e); }
  }

  @Get("settings/dry-run")
  @Header("Cache-Control", "no-store")
  async dryRun(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await holdsDryRun(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("settings")
  async setSettings(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPayingSettingsBody, body);
    try { return await setPayingSettings(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  /* ─────────────── service entry sheets ─────────────── */

  @Get("services")
  @Header("Cache-Control", "no-store")
  async services(@CurrentActor() actor: Actor, @Query("departmentId") departmentId: string): Promise<unknown> {
    try { return await servicesToConfirm(this.db, actor, parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }

  @Post("services")
  async confirm(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesSesBody, body);
    try { return await confirmServiceEntry(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("services/departments")
  @Header("Cache-Control", "no-store")
  async serviceDepartments(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await myServiceDepartments(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("services/:sesId")
  async ses(@CurrentActor() actor: Actor, @Param("sesId") sesId: string): Promise<unknown> {
    try { return await readServiceEntry(this.db, actor, parsed(id, sesId)); } catch (e) { toHttp(e); }
  }
}
