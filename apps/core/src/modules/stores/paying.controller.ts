import { Body, Controller, Get, Header, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  storesBillTdsBody, storesHoldKeepBody, storesHoldReleaseBody, storesMsmeObjectionBody, storesMsmeObjectionCloseBody, storesPayBookBody,
  storesPayingSettingsBody, storesRecordPaymentBody, storesRunDecideBody, storesSesBody, storesTallyLedgersBody, storesTaxSignBody, storesTaxTableBody,
  storesTdsCertificateBody, storesFlagReviewBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor } from "../../kernel/auth/decorators";
import { assertNotRunAuthoriser, draftPaymentRun, recordVendorPayment } from "../materials";
import { holdsDryRun, holdsForBill, keepHold, releaseHold, requirePayingReader } from "./holds";
import { bookDraft, bookFromDesk } from "./paying-book";
import { decideRunFromPhone, payablesByGroup, payingDesk, runToAuthorise, submitRunFromDesk } from "./paying-reads";
import { payingSettings, setPayingSettings } from "./paying-settings";
import { confirmServiceEntry, myServiceDepartments, readServiceEntry, reverseServiceEntry, serviceEntriesAt, servicesToConfirm } from "./service-entries";
import { auditFlags, ownerMonthlyList, reviewFlag } from "./auditor-agent";
import { closeMsmeObjection, msmeDryRun, msmeDuesReport, msmeHalfOf, msmeObjections, recordMsmeObjection } from "./msme";
import { setStoresTallyLedgers, storesTallyLedgerNames } from "./tally-split";
import { addTdsCertificate, billTaxProposal, saveTaxTable, setBillTds, signTaxTable, payingSuppliers, taxTables, tdsCertificates, tdsDryRun } from "./tax-on-bill";
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

  @Get("settings/msme-dry-run")
  @Header("Cache-Control", "no-store")
  async msmeDry(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await msmeDryRun(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("settings/tds-dry-run")
  @Header("Cache-Control", "no-store")
  async tdsDry(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await tdsDryRun(this.db, actor); } catch (e) { toHttp(e); }
  }

  /* ─────────────── S6b: tax on the bill, MSME objections, Tally ledgers ─────────────── */

  @Get("tax-tables")
  @Header("Cache-Control", "no-store")
  async tables(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await taxTables(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("tax-tables")
  async saveTable(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesTaxTableBody, body);
    try { return await saveTaxTable(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Post("tax-tables/:tableId/sign")
  async signTable(@CurrentActor() actor: Actor, @Param("tableId") tableId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesTaxSignBody, body);
    try { return await signTaxTable(this.db, actor, parsed(id, tableId), b); } catch (e) { toHttp(e); }
  }

  @Post("tds-certificates")
  async certificate(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesTdsCertificateBody, body);
    try { return await addTdsCertificate(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("bills/:billId/tax")
  @Header("Cache-Control", "no-store")
  async billTax(@CurrentActor() actor: Actor, @Param("billId") billId: string): Promise<unknown> {
    try { return await billTaxProposal(this.db, actor, parsed(id, billId)); } catch (e) { toHttp(e); }
  }

  @Post("bills/:billId/tds")
  async billTds(@CurrentActor() actor: Actor, @Param("billId") billId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesBillTdsBody, body);
    try { return await setBillTds(this.db, actor, parsed(id, billId), b); } catch (e) { toHttp(e); }
  }

  @Post("msme-objections")
  async objection(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesMsmeObjectionBody, body);
    try { return await recordMsmeObjection(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Post("msme-objections/:objectionId/close")
  async closeObjection(@CurrentActor() actor: Actor, @Param("objectionId") objectionId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesMsmeObjectionCloseBody, body);
    try { return await closeMsmeObjection(this.db, actor, parsed(id, objectionId), b); } catch (e) { toHttp(e); }
  }

  @Get("tally-ledgers")
  @Header("Cache-Control", "no-store")
  async tallyLedgers(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await storesTallyLedgerNames(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("tally-ledgers")
  async setTallyLedgers(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesTallyLedgersBody, body);
    try { return await setStoresTallyLedgers(this.db, actor, b.names); } catch (e) { toHttp(e); }
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

  @Get("services/sheets")
  @Header("Cache-Control", "no-store")
  async serviceSheets(@CurrentActor() actor: Actor, @Query("departmentId") departmentId: string): Promise<unknown> {
    try { return await serviceEntriesAt(this.db, actor, parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }

  @Post("services/:sesId/reverse")
  async reverseSes(@CurrentActor() actor: Actor, @Param("sesId") sesId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesHoldReleaseBody, body);
    try { return await reverseServiceEntry(this.db, actor, parsed(id, sesId), b.reason); } catch (e) { toHttp(e); }
  }

  /* ─────────────── S6c: the auditor's flags, the MSME dues report, the tax screens' lists ─────────────── */

  @Get("flags")
  @Header("Cache-Control", "no-store")
  async flags(@CurrentActor() actor: Actor, @Query("status") status?: string): Promise<unknown> {
    const st = status === undefined || status === "" ? undefined : parsed(z.enum(["open", "upheld", "dismissed"]), status);
    try { return await auditFlags(this.db, actor, st === undefined ? {} : { status: st }); } catch (e) { toHttp(e); }
  }

  @Get("flags/owner-month")
  @Header("Cache-Control", "no-store")
  async ownerMonth(@CurrentActor() actor: Actor, @Query("month") month: string): Promise<unknown> {
    try { return await ownerMonthlyList(this.db, actor, parsed(z.string().regex(/^\d{4}-\d{2}$/), month)); } catch (e) { toHttp(e); }
  }

  @Post("flags/:flagId/review")
  async review(@CurrentActor() actor: Actor, @Param("flagId") flagId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesFlagReviewBody, body);
    try { return await reviewFlag(this.db, actor, parsed(id, flagId), b); } catch (e) { toHttp(e); }
  }

  @Get("msme-report")
  @Header("Cache-Control", "no-store")
  async msmeReport(@CurrentActor() actor: Actor, @Query("half") half?: string): Promise<unknown> {
    const h = half === undefined || half === "" ? msmeHalfOf(new Date()) : parsed(z.string().regex(/^\d{4}-H[12]$/), half);
    try { return await msmeDuesReport(this.db, actor, h); } catch (e) { toHttp(e); }
  }

  @Get("msme-objections")
  @Header("Cache-Control", "no-store")
  async objections(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await msmeObjections(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("suppliers")
  @Header("Cache-Control", "no-store")
  async suppliers(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await payingSuppliers(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("tds-certificates")
  @Header("Cache-Control", "no-store")
  async certificates(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await tdsCertificates(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("services/:sesId")
  async ses(@CurrentActor() actor: Actor, @Param("sesId") sesId: string): Promise<unknown> {
    try { return await readServiceEntry(this.db, actor, parsed(id, sesId)); } catch (e) { toHttp(e); }
  }
}
