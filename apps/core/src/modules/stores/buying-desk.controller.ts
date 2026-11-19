import { Body, Controller, Get, Header, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  storesAwardBody, storesBulkBody, storesGroupBody, storesGroupMoveBody, storesMakePoBody, storesQuoteBody, storesReasonBody, storesReplyByBody,
  storesRfqBody, storesRfqInviteBody, storesRfqSendBody, storesSeatBody, storesTechnicalBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { STORES_BUYING_MANAGE } from "./access";
import {
  approveAward, approvePoFromSheet, bulkApprove, committeeSeats, getAward, makePoFromAward, makePoFromGroup, objectAward, poSheet, proposeAward,
  sendStoresPo, setCommitteeSeat, submitStoresPo,
} from "./awards";
import { getBuyGroup, groupRequests, moveGroupLine } from "./buy-groups";
import { buyingDesk } from "./buying-desk";
import { comparativeStatement, requireBuyingReader } from "./comparative";
import { admitLateQuote, enterQuote, markTechnical, openQuote } from "./quotes";
import { closeRfq, createRfq, getRfq, inviteSuppliers, moveReplyBy, requireRfq, sendRfq } from "./rfq";
import { renderRfq } from "./rfq-print";
import { parsed, toHttp } from "./stores-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const id = z.string().min(1).max(64);

/**
 * STORES S5b (#1115) — `/stores/buying/*`, `/stores/rfqs/*`, `/stores/quotes/*`, `/stores/awards/*`, `/stores/committee/*`:
 * the buying desk by hand. Buyer routes carry `stores.buying.manage`. Award and PO approval routes carry no route guard:
 * the seat (a committee member, a delegate, the user HOD at the department) and the PO's tier are facts of the record,
 * asked inside the intent, as the S5a department routes are.
 */
@Controller("stores")
export class StoresBuyingDeskController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("buying/desk")
  @Header("Cache-Control", "no-store")
  async desk(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await buyingDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  /* ─────────────── groups and band A ─────────────── */

  @Post("buying/groups")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async group(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesGroupBody, body);
    try { return await groupRequests(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Post("buying/groups/move")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async move(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesGroupMoveBody, body);
    try { return await moveGroupLine(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("buying/groups/:groupId")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async oneGroup(@Param("groupId") groupId: string): Promise<unknown> {
    try { return await getBuyGroup(this.db, parsed(id, groupId)); } catch (e) { toHttp(e); }
  }

  @Post("buying/groups/:groupId/po")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async poFromGroup(@CurrentActor() actor: Actor, @Param("groupId") groupId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesMakePoBody, body ?? {});
    try { return await makePoFromGroup(this.db, actor, parsed(id, groupId), { reason: b.reason ?? null }); } catch (e) { toHttp(e); }
  }

  /* ─────────────── RFQs ─────────────── */

  @Post("rfqs")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async rfq(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRfqBody, body);
    try { return await createRfq(this.db, actor, { ...b, replyBy: new Date(b.replyBy) }); } catch (e) { toHttp(e); }
  }

  @Get("rfqs/:rfqId")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async oneRfq(@Param("rfqId") rfqId: string): Promise<unknown> {
    try { return await getRfq(this.db, parsed(id, rfqId)); } catch (e) { toHttp(e); }
  }

  @Post("rfqs/:rfqId/invite")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async invite(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRfqInviteBody, body);
    try { return await inviteSuppliers(this.db, actor, parsed(id, rfqId), b.vendorIds); } catch (e) { toHttp(e); }
  }

  /** Decision 6: the person's tap. Records the send and queues one PDF per invitee; HMIS mails nothing. */
  @Post("rfqs/:rfqId/send")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async send(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRfqSendBody, body);
    try { return await sendRfq(this.db, actor, parsed(id, rfqId), b); } catch (e) { toHttp(e); }
  }

  @Post("rfqs/:rfqId/reply-by")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async replyBy(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesReplyByBody, body);
    try { return await moveReplyBy(this.db, actor, parsed(id, rfqId), new Date(b.replyBy), b.reason); } catch (e) { toHttp(e); }
  }

  @Post("rfqs/:rfqId/close")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async close(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string): Promise<unknown> {
    try { return await closeRfq(this.db, actor, parsed(id, rfqId)); } catch (e) { toHttp(e); }
  }

  @Get("rfqs/:rfqId/comparative")
  @Header("Cache-Control", "no-store")
  async comparative(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string): Promise<unknown> {
    try { return await comparativeStatement(this.db, actor, parsed(id, rfqId)); } catch (e) { toHttp(e); }
  }

  /** Technical compliance (equipment): the user HOD and biomedical, asked inside. */
  @Post("rfqs/:rfqId/technical")
  async technical(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesTechnicalBody, body);
    try { await markTechnical(this.db, actor, { rfqId: parsed(id, rfqId), ...b }); return { ok: true }; } catch (e) { toHttp(e); }
  }

  /** The RFQ a supplier receives, for the buyer's own browser to print or save as PDF. */
  @Get("rfqs/:rfqId/print")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  @Header("Cache-Control", "no-store")
  async print(@CurrentActor() actor: Actor, @Param("rfqId") rfqId: string, @Query("vendorId") vendorId: string): Promise<unknown> {
    try {
      const r = await requireRfq(this.db, parsed(id, rfqId));
      await requireBuyingReader(this.db, actor, r.groupId);
      return await renderRfq(this.db, { rfqId: r.id, vendorId: parsed(id, vendorId) });
    } catch (e) { toHttp(e); }
  }

  /* ─────────────── quotes ─────────────── */

  @Post("quotes")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async quote(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesQuoteBody, body);
    try { return await enterQuote(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("quotes/:quoteId")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async openQuote(@CurrentActor() actor: Actor, @Param("quoteId") quoteId: string): Promise<unknown> {
    try { return await openQuote(this.db, actor, parsed(id, quoteId)); } catch (e) { toHttp(e); }
  }

  @Post("quotes/:quoteId/admit")
  async admit(@CurrentActor() actor: Actor, @Param("quoteId") quoteId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesReasonBody, body);
    try { return await admitLateQuote(this.db, actor, parsed(id, quoteId), b.reason); } catch (e) { toHttp(e); }
  }

  /* ─────────────── awards and the committee ─────────────── */

  @Post("awards")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async propose(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesAwardBody, body);
    try { return await proposeAward(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("awards/:awardId")
  @Header("Cache-Control", "no-store")
  async award(@CurrentActor() actor: Actor, @Param("awardId") awardId: string): Promise<unknown> {
    try {
      const a = await getAward(this.db, parsed(id, awardId), new Date(), actor);
      await requireBuyingReader(this.db, actor, a.groupId);
      return a;
    } catch (e) { toHttp(e); }
  }

  @Post("awards/:awardId/approve")
  async approve(@CurrentActor() actor: Actor, @Param("awardId") awardId: string): Promise<unknown> {
    try { return await approveAward(this.db, actor, parsed(id, awardId)); } catch (e) { toHttp(e); }
  }

  @Post("awards/:awardId/object")
  async object(@CurrentActor() actor: Actor, @Param("awardId") awardId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesReasonBody, body);
    try { return await objectAward(this.db, actor, parsed(id, awardId), b.reason); } catch (e) { toHttp(e); }
  }

  @Post("awards/:awardId/po")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async poFromAward(@CurrentActor() actor: Actor, @Param("awardId") awardId: string): Promise<unknown> {
    try { return await makePoFromAward(this.db, actor, parsed(id, awardId)); } catch (e) { toHttp(e); }
  }

  @Get("committee/seats")
  async seats(@CurrentActor() actor: Actor): Promise<unknown> {
    try { await requireBuyingReader(this.db, actor, null); return { seats: await committeeSeats(this.db) }; } catch (e) { toHttp(e); }
  }

  @Post("committee/seats")
  async setSeat(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesSeatBody, body);
    try {
      await setCommitteeSeat(this.db, actor, { seat: b.seat, userId: b.userId, from: new Date(b.from), to: b.to == null ? null : new Date(b.to) });
      return { seats: await committeeSeats(this.db) };
    } catch (e) { toHttp(e); }
  }

  /* ─────────────── POs made from awards ─────────────── */

  @Post("buying/pos/:poId/submit")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async submit(@CurrentActor() actor: Actor, @Param("poId") poId: string): Promise<unknown> {
    try { return await submitStoresPo(this.db, actor, parsed(id, poId)); } catch (e) { toHttp(e); }
  }

  /** "Send PO / PO भेजें": a person's tap. */
  @Post("buying/pos/:poId/send")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async sendPo(@CurrentActor() actor: Actor, @Param("poId") poId: string): Promise<unknown> {
    try { return await sendStoresPo(this.db, actor, parsed(id, poId)); } catch (e) { toHttp(e); }
  }

  /** The phone sheet: value, band, supplier, L-rank, the reason when not L1. Its tier is asked inside. */
  @Get("buying/pos/:poId")
  @Header("Cache-Control", "no-store")
  async sheet(@CurrentActor() actor: Actor, @Param("poId") poId: string): Promise<unknown> {
    try { return await poSheet(this.db, actor, parsed(id, poId)); } catch (e) { toHttp(e); }
  }

  @Post("buying/pos/:poId/approve")
  async approvePo(@CurrentActor() actor: Actor, @Param("poId") poId: string): Promise<unknown> {
    try { return await approvePoFromSheet(this.db, actor, parsed(id, poId)); } catch (e) { toHttp(e); }
  }

  @Post("buying/bulk-approve")
  async bulk(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesBulkBody, body);
    try { return { pos: await bulkApprove(this.db, actor, b) }; } catch (e) { toHttp(e); }
  }
}
