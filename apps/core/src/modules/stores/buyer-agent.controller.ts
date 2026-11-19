import { Body, Controller, Get, Header, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  storesAdvanceBody, storesBuyExceptionBody, storesDecideBody, storesMakePoBody, storesQuoteLineConfirmBody, storesQuoteReadBody, storesReasonBody,
  storesRfqDraftConfirmBody,
} from "@hmis/contracts";
import { CONFIG, DB, DOCUMENT_STORE } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { openAiCompatibleClient } from "../../kernel/inference/openai-compatible";
import { STORES_BUYING_MANAGE } from "./access";
import { decidePoAdvance, requestPoAdvance } from "./advances";
import { overBudgetList } from "./budgets";
import { advanceBuyException, getBuyException, refuseBuyException, requestBuyException } from "./buy-exceptions";
import {
  agentProposals, confirmGroupingProposal, confirmPoDraft, confirmRfqDraft, dismissProposal, draftPo, draftRfq, getProposal,
} from "./buyer-agent";
import { confirmQuoteLine, quoteReadDocument, readQuotePdf } from "./quote-reader";
import { quarterOf, supplierScorecard } from "./scorecard";
import { parsed, toHttp } from "./stores-http";
import type { AppConfig } from "../../kernel/config";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Actor, StoresAgentProposalKind, StoresAgentProposalStatus } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const id = z.string().min(1).max(64);
const kinds = z.enum(["grouping", "rfq_draft", "quote_read", "po_draft"]).optional();
const statuses = z.enum(["open", "confirmed", "dismissed", "superseded"]).optional();
const quarter = z.string().regex(/^\d{4}-Q[1-4]$/).optional();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/**
 * STORES S5c (#1115) — the buyer agent's drafts (`/stores/agent/*`), the RFQ and PO drafts of a group, a quote read from a
 * PDF, the supplier scorecard, single-source and emergency purchases, equipment advances and the owner's over-budget
 * list. Buyer routes carry `stores.buying.manage`; an exception's certificate and approval, an advance's decision and
 * the over-budget list carry none here: who may is a fact of the record or a role, asked inside the intent.
 */
@Controller("stores")
export class StoresBuyerAgentController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORE) private readonly documents: DocumentStore,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /* ─────────────── the agent's drafts ─────────────── */

  @Get("agent/drafts")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async drafts(@CurrentActor() actor: Actor, @Query("kind") kind?: string, @Query("status") status?: string): Promise<unknown> {
    const k = parsed(kinds, kind) as StoresAgentProposalKind | undefined;
    const s = parsed(statuses, status) as StoresAgentProposalStatus | undefined;
    try { return await agentProposals(this.db, actor, { ...(k === undefined ? {} : { kind: k }), ...(s === undefined ? {} : { status: s }) }); } catch (e) { toHttp(e); }
  }

  @Get("agent/drafts/:draftId")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async draft(@Param("draftId") draftId: string): Promise<unknown> {
    try { return await getProposal(this.db, parsed(id, draftId)); } catch (e) { toHttp(e); }
  }

  @Post("agent/drafts/:draftId/group")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async confirmGroup(@CurrentActor() actor: Actor, @Param("draftId") draftId: string): Promise<unknown> {
    try { return await confirmGroupingProposal(this.db, actor, parsed(id, draftId)); } catch (e) { toHttp(e); }
  }

  @Post("agent/drafts/:draftId/dismiss")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async dismiss(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(z.object({ reason: z.string().trim().max(300).nullish() }), body ?? {});
    try { return await dismissProposal(this.db, actor, parsed(id, draftId), b.reason ?? null); } catch (e) { toHttp(e); }
  }

  @Post("buying/groups/:groupId/rfq-draft")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async rfqDraft(@CurrentActor() actor: Actor, @Param("groupId") groupId: string): Promise<unknown> {
    try { return await draftRfq(this.db, actor, parsed(id, groupId)); } catch (e) { toHttp(e); }
  }

  @Post("agent/drafts/:draftId/rfq")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async confirmRfq(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesRfqDraftConfirmBody, body);
    try {
      return await confirmRfqDraft(this.db, actor, parsed(id, draftId), { vendorIds: b.vendorIds, replyBy: b.replyBy == null ? null : new Date(b.replyBy), deliveryDate: b.deliveryDate ?? null });
    } catch (e) { toHttp(e); }
  }

  @Post("buying/groups/:groupId/po-draft")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async poDraft(@CurrentActor() actor: Actor, @Param("groupId") groupId: string): Promise<unknown> {
    try { return await draftPo(this.db, actor, parsed(id, groupId)); } catch (e) { toHttp(e); }
  }

  @Post("agent/drafts/:draftId/po")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async confirmPo(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesMakePoBody, body ?? {});
    try { return await confirmPoDraft(this.db, actor, parsed(id, draftId), { reason: b.reason ?? null }); } catch (e) { toHttp(e); }
  }

  /* ─────────────── a quote read from a PDF ─────────────── */

  /** Upload and read (base64 in JSON, under the API's 1 MB body: a quotation PDF of up to ~700 KB). */
  @Post("quotes/read")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async readPdf(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesQuoteReadBody, body);
    try {
      return await readQuotePdf(this.db, {
        store: this.documents, inference: openAiCompatibleClient(this.cfg.copilot), model: this.cfg.copilot.model,
        prices: this.cfg.copilotSpend.prices, dailyCapInr: this.cfg.copilotSpend.dailyCapInr,
      }, actor, { rfqId: b.rfqId ?? null, groupId: b.groupId ?? null, vendorId: b.vendorId, pdf: Buffer.from(b.pdfBase64, "base64") });
    } catch (e) { toHttp(e); }
  }

  /** "Confirm line / लाइन सही": one tap per line; the last one enters the quote. */
  @Post("agent/drafts/:draftId/lines")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async confirmLine(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesQuoteLineConfirmBody, body);
    try { return await confirmQuoteLine(this.db, actor, parsed(id, draftId), b); } catch (e) { toHttp(e); }
  }

  /** The kept PDF, for the quote screen's left pane (base64 in JSON, the photo precedent). */
  @Get("agent/drafts/:draftId/pdf")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async pdf(@CurrentActor() actor: Actor, @Param("draftId") draftId: string): Promise<unknown> {
    try { return { pdfBase64: (await quoteReadDocument(this.db, this.documents, actor, parsed(id, draftId))).toString("base64") }; } catch (e) { toHttp(e); }
  }

  /* ─────────────── the scorecard ─────────────── */

  @Get("suppliers/:vendorId/scorecard")
  @Header("Cache-Control", "no-store")
  async scorecard(@CurrentActor() actor: Actor, @Param("vendorId") vendorId: string, @Query("quarter") q?: string): Promise<unknown> {
    const qq = parsed(quarter, q) ?? quarterOf(new Date());
    try { return await supplierScorecard(this.db, actor, parsed(id, vendorId), qq); } catch (e) { toHttp(e); }
  }

  /* ─────────────── single source and emergency (ruling 0101 Q4) ─────────────── */

  @Post("buying/exceptions")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async exception(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesBuyExceptionBody, body);
    try { return await requestBuyException(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("buying/exceptions/:exceptionId")
  @Header("Cache-Control", "no-store")
  async oneException(@CurrentActor() actor: Actor, @Param("exceptionId") exceptionId: string): Promise<unknown> {
    try { return await getBuyException(this.db, parsed(id, exceptionId), new Date(), actor); } catch (e) { toHttp(e); }
  }

  /** The next step's one tap: certify (user HOD), approve (materials head / owner / superintendent) or confirm (owner). */
  @Post("buying/exceptions/:exceptionId/sign")
  async signException(@CurrentActor() actor: Actor, @Param("exceptionId") exceptionId: string): Promise<unknown> {
    try { return await advanceBuyException(this.db, actor, parsed(id, exceptionId)); } catch (e) { toHttp(e); }
  }

  @Post("buying/exceptions/:exceptionId/refuse")
  async refuseException(@CurrentActor() actor: Actor, @Param("exceptionId") exceptionId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesReasonBody, body);
    try { return await refuseBuyException(this.db, actor, parsed(id, exceptionId), b.reason); } catch (e) { toHttp(e); }
  }

  /* ─────────────── equipment advances (ruling 0101 Q7) ─────────────── */

  @Post("buying/pos/:poId/advance")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async advance(@CurrentActor() actor: Actor, @Param("poId") poId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesAdvanceBody, body);
    try { return await requestPoAdvance(this.db, actor, parsed(id, poId), b); } catch (e) { toHttp(e); }
  }

  @Post("buying/advances/:advanceId/decide")
  async decideAdvance(@CurrentActor() actor: Actor, @Param("advanceId") advanceId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesDecideBody, body);
    try { return await decidePoAdvance(this.db, actor, parsed(id, advanceId), { approve: b.approve, reason: b.reason ?? null }); } catch (e) { toHttp(e); }
  }

  /* ─────────────── the owner's over-budget list ─────────────── */

  @Get("budgets/over")
  @Header("Cache-Control", "no-store")
  async overBudget(@CurrentActor() actor: Actor, @Query("month") m: string): Promise<unknown> {
    try { return await overBudgetList(this.db, actor, parsed(month, m)); } catch (e) { toHttp(e); }
  }
}
