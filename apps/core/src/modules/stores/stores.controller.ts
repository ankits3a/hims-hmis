import { Body, Controller, Get, Header, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { z } from "zod";
import {
  storesCategoryBody, storesCheckBody, storesImportBody, storesItemBody, storesItemPatchBody, storesOpenBody, storesParBody, storesReceiveBody,
  storesReorderBody, storesRequestBody, storesResolveBody, storesShelfBody, storesStoreBody, storesUndoBody, storesUseBody,
  storesApproveBody, storesAuditQuery, storesDeclineBody, storesIssueBody, storesReviewBody, storesTicketBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { STORES_MASTERS } from "./access";
import {
  createCategory, importStoresItems, listCategories, listNewItemRequests, listStoresItems, registerStoresItem, requestNewItem,
  resolveNewItemRequest, searchStoresItems, updateStoresItem,
} from "./items";
import { createShelf, createStoresStore, listShelves, listStoresStores, openShelf, openStore, setShelfPar } from "./shelves";
import { receiveAtShelf, recordShelfCheck, recordShelfUse, reverseShelfUse, saveReorderDraft, shelfReorderDraft } from "./use";
import { departmentChargeOn, floorShelfUseByMonth, myShelves, overBookCards, shelfView, storesPickers } from "./reads";
import { parsed, toHttp } from "./stores-http";
import {
  approveTicket, claimPicking, declineTicket, getTicket, issueTicket, reRaiseTicket, reviewEmergency, raiseTicket, ticketsToApprove, ticketsToPick,
  ticketsToReceive,
} from "./tickets";
import { ticketTimeline } from "./timeline";
import { storesAuditPack } from "./audit-pack";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/** The CSV half of the audit pack goes out as a file; the rest of the routes answer JSON. */
type CsvReply = { setHeader(name: string, value: string): unknown };

const id = z.string().min(1).max(64);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * STORES S1 (#1111) — `/stores/*`.
 *
 * Two kinds of route, and the difference is the scope:
 *   · the MASTERS (categories, items, stores, shelves, par, the new-item queue, the cards, a department's
 *     charge) carry `@RequirePermission("stores.masters.manage", "hospital")` — the materials head's desk;
 *   · the SHELF routes (`/stores/shelves/:shelfId/…`, `/stores/my-shelves`, the item search) carry NO
 *     route guard, the `roster/leave.controller.ts` posture: the department is a fact of the SHELF, not of
 *     the URL, and every Stores intent asks `stores.shelf.read` / `.work` at the shelf's department before it
 *     does anything (decision 7). The search returns item names and codes only, no stock and no money.
 */
@Controller("stores")
export class StoresController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ─────────────── masters (the materials head) ─────────────── */

  @Get("categories")
  @RequirePermission(STORES_MASTERS, "hospital")
  async categories(): Promise<unknown> {
    try { return { categories: await listCategories(this.db) }; } catch (e) { toHttp(e); }
  }

  @Post("categories")
  @RequirePermission(STORES_MASTERS, "hospital")
  async addCategory(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesCategoryBody, body);
    try { return await createCategory(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Get("items")
  @RequirePermission(STORES_MASTERS, "hospital")
  async items(@Query("categoryId") categoryId?: string): Promise<unknown> {
    try {
      return { items: await listStoresItems(this.db, categoryId === undefined || categoryId === "" ? {} : { categoryId: parsed(id, categoryId) }) };
    } catch (e) { toHttp(e); }
  }

  @Post("items")
  @RequirePermission(STORES_MASTERS, "hospital")
  async addItem(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesItemBody, body);
    try { return await registerStoresItem(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Post("items/import")
  @RequirePermission(STORES_MASTERS, "hospital")
  async importItems(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesImportBody, body);
    try { return await importStoresItems(this.db, actor, input.rows, { dryRun: input.dryRun }); } catch (e) { toHttp(e); }
  }

  @Post("items/:itemId")
  @RequirePermission(STORES_MASTERS, "hospital")
  async editItem(@CurrentActor() actor: Actor, @Param("itemId") itemId: string, @Body() body: unknown): Promise<unknown> {
    const { reason, ...patch } = parsed(storesItemPatchBody, body);
    try { await updateStoresItem(this.db, actor, parsed(id, itemId), patch, reason ?? null); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @Get("stores")
  @RequirePermission(STORES_MASTERS, "hospital")
  async stores(): Promise<unknown> {
    try { return { stores: await listStoresStores(this.db) }; } catch (e) { toHttp(e); }
  }

  @Post("stores")
  @RequirePermission(STORES_MASTERS, "hospital")
  async addStore(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesStoreBody, body);
    try { return await createStoresStore(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Post("stores/:code/open")
  @RequirePermission(STORES_MASTERS, "hospital")
  async openStoreRoute(@CurrentActor() actor: Actor, @Param("code") code: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesOpenBody, body);
    try { return await openStore(this.db, actor, parsed(id, code), input.lines, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("pickers")
  @RequirePermission(STORES_MASTERS, "hospital")
  async pickers(): Promise<unknown> {
    try { return await storesPickers(this.db); } catch (e) { toHttp(e); }
  }

  @Get("shelves")
  @RequirePermission(STORES_MASTERS, "hospital")
  async shelves(): Promise<unknown> {
    try { return { shelves: await listShelves(this.db) }; } catch (e) { toHttp(e); }
  }

  @Post("shelves")
  @RequirePermission(STORES_MASTERS, "hospital")
  async addShelf(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesShelfBody, body);
    try { return await createShelf(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Post("par")
  @RequirePermission(STORES_MASTERS, "hospital")
  async par(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesParBody, body);
    try { await setShelfPar(this.db, actor, input); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @Get("requests")
  @RequirePermission(STORES_MASTERS, "hospital")
  async requests(@CurrentActor() actor: Actor, @Query("status") status?: string): Promise<unknown> {
    try { return { requests: await listNewItemRequests(this.db, actor, status === undefined || status === "" ? {} : { status }) }; } catch (e) { toHttp(e); }
  }

  @Post("requests/:requestId/resolve")
  @RequirePermission(STORES_MASTERS, "hospital")
  async resolve(@CurrentActor() actor: Actor, @Param("requestId") requestId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesResolveBody, body);
    try { await resolveNewItemRequest(this.db, actor, parsed(id, requestId), input); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @Get("cards")
  @RequirePermission(STORES_MASTERS, "hospital")
  async cards(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { cards: await overBookCards(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("charge")
  @RequirePermission(STORES_MASTERS, "hospital")
  async charge(@Query("department") department?: string, @Query("day") onDay?: string): Promise<unknown> {
    try { return await departmentChargeOn(this.db, parsed(z.string().min(1).max(20), department), parsed(day, onDay)); } catch (e) { toHttp(e); }
  }

  /* ─────────────── the shelf (asked at the shelf's department inside each intent) ─────────────── */

  @Get("search")
  async search(@Query("q") q?: string): Promise<unknown> {
    try {
      const rows = await searchStoresItems(this.db, parsed(z.string().max(80), q ?? ""));
      return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, baseUom: r.baseUom, trackMode: r.trackMode })) };
    } catch (e) { toHttp(e); }
  }

  @Get("my-shelves")
  async mine(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { shelves: await myShelves(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("shelves/:shelfId")
  async shelf(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string): Promise<unknown> {
    try { return await shelfView(this.db, actor, parsed(id, shelfId), new Date()); } catch (e) { toHttp(e); }
  }

  @Get("shelves/:shelfId/month/:month")
  async shelfMonth(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Param("month") m: string): Promise<unknown> {
    try { return { rows: await floorShelfUseByMonth(this.db, actor, parsed(id, shelfId), parsed(month, m)) }; } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/receive")
  async receive(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const { transferId } = parsed(storesReceiveBody, body);
    try { return await receiveAtShelf(this.db, actor, transferId, new Date(), undefined, parsed(id, shelfId)); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/use")
  async use(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesUseBody, body);
    try { return await recordShelfUse(this.db, actor, { shelfId: parsed(id, shelfId), ...input }, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/undo")
  async undo(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesUndoBody, body);
    try { return await reverseShelfUse(this.db, actor, input.rowId, input.reason, new Date(), parsed(id, shelfId)); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/check")
  async check(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesCheckBody, body);
    try { return await recordShelfCheck(this.db, actor, { shelfId: parsed(id, shelfId), lines: input.lines }, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/open")
  async open(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesOpenBody, body);
    try { return await openShelf(this.db, actor, parsed(id, shelfId), input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })), new Date()); } catch (e) { toHttp(e); }
  }

  @Get("shelves/:shelfId/reorder")
  async reorder(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string): Promise<unknown> {
    try { return await shelfReorderDraft(this.db, actor, parsed(id, shelfId)); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/reorder")
  async saveDraft(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesReorderBody, body);
    try { return await saveReorderDraft(this.db, actor, parsed(id, shelfId), input.lines, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("shelves/:shelfId/requests")
  async request(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesRequestBody, body);
    try { return await requestNewItem(this.db, actor, { ...input, shelfId: parsed(id, shelfId) }); } catch (e) { toHttp(e); }
  }
  /* ─────────────── S2a (#1112): tickets — no route guard; each intent asks its own grant at the department ─────────────── */

  @Post("shelves/:shelfId/tickets")
  async raise(@CurrentActor() actor: Actor, @Param("shelfId") shelfId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesTicketBody, body);
    try { return await raiseTicket(this.db, actor, { ...input, shelfId: parsed(id, shelfId) }, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("tickets/to-approve")
  async toApprove(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { tickets: await ticketsToApprove(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @Get("tickets/to-pick")
  async toPick(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { tickets: await ticketsToPick(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @Get("tickets/to-receive")
  async toReceive(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { tickets: await ticketsToReceive(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  /** The ticket itself is read through its timeline's grant (shelf readers, approvers, keepers, auditors). */
  @Get("tickets/:indentId")
  async ticket(@CurrentActor() actor: Actor, @Param("indentId") indentId: string): Promise<unknown> {
    try {
      const timeline = await ticketTimeline(this.db, actor, parsed(id, indentId));
      return { ticket: await getTicket(this.db, timeline.indentId, new Date()), timeline };
    } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/approve")
  async approve(@CurrentActor() actor: Actor, @Param("indentId") indentId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesApproveBody, body ?? {});
    try { return await approveTicket(this.db, actor, parsed(id, indentId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/decline")
  async decline(@CurrentActor() actor: Actor, @Param("indentId") indentId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesDeclineBody, body);
    try { return await declineTicket(this.db, actor, parsed(id, indentId), input.reason, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/reraise")
  async reraise(@CurrentActor() actor: Actor, @Param("indentId") indentId: string): Promise<unknown> {
    try { return await reRaiseTicket(this.db, actor, parsed(id, indentId), new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/review")
  async review(@CurrentActor() actor: Actor, @Param("indentId") indentId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesReviewBody, body);
    try { return await reviewEmergency(this.db, actor, parsed(id, indentId), input, new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/claim")
  async claim(@CurrentActor() actor: Actor, @Param("indentId") indentId: string): Promise<unknown> {
    try { return await claimPicking(this.db, actor, parsed(id, indentId), new Date()); } catch (e) { toHttp(e); }
  }

  @Post("tickets/:indentId/issue")
  async issue(@CurrentActor() actor: Actor, @Param("indentId") indentId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(storesIssueBody, body ?? {});
    try { return await issueTicket(this.db, actor, parsed(id, indentId), input, new Date()); } catch (e) { toHttp(e); }
  }

  /** Decision 16: the audit pack, JSON or CSV; the intent asks `stores.audit.read` and writes one event per export. */
  @Get("audit-pack")
  @Header("Cache-Control", "no-store")
  async auditPack(@CurrentActor() actor: Actor, @Query() query: unknown, @Res({ passthrough: true }) res: CsvReply): Promise<unknown> {
    const q = parsed(storesAuditQuery, query);
    try {
      const pack = await storesAuditPack(this.db, actor, {
        ...(q.ticketId === undefined ? {} : { ticketId: q.ticketId }), ...(q.itemId === undefined ? {} : { itemId: q.itemId }),
        ...(q.personId === undefined ? {} : { personId: q.personId }), ...(q.storeId === undefined ? {} : { storeId: q.storeId }),
        from: new Date(q.from), to: new Date(q.to),
        ...(q.afterSeq === undefined ? {} : { afterSeq: q.afterSeq }), ...(q.limit === undefined ? {} : { limit: q.limit }),
      }, new Date());
      if (q.format !== "csv") return pack;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="stores-audit-pack.csv"');
      return pack.csv;
    } catch (e) { toHttp(e); }
  }
}
