import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { storeIndentLines, storeIndents, storesTicketDetails } from "../../kernel/db/schema";
import { defineAct } from "../../kernel/copilot/types";
import { STORES_SHELF_WORK, recordAct } from "./access";
import { raiseTicket } from "./tickets";
import { shelfReorderDraft } from "./use";
import { workShelves } from "./copilot-tools";
import type { CopilotActCtx, CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db, Tx } from "../../kernel/db/client";
import type { CopilotAnswerKey, CopilotStoresReorderPick } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #1113 (S3, decision 9) — THE CONCIERGE'S ONE ACT: `stores.reorder`, behind propose → confirm (spec 580)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * S1's `shelfReorderDraft` (every `shelf` item at or under its reorder level, to max, rounded up to the issue pack)
 * becomes S2's `raiseTicket` — the same two functions the shelf's one-tap Reorder and Send use, called as the
 * confirming person, so the department's HOD still approves and a person still receives (autonomy T2).
 *
 * The ask WRITES NOTHING: it offers one option per shelf the asker works whose draft is not empty. Only
 * `POST /copilot/confirm` writes, and there, in one transaction with the `copilot_acts` row:
 *   recheck  re-reads the shelf's draft and whether a ticket for that shelf is already open (raised between
 *            propose and confirm, by anybody, by any channel) — either answers "State changed" and raises nothing;
 *   apply    raises the ticket (channel `copilot`) and appends ONE `copilot_reorder` act naming the confirm, so the
 *            ticket's audit pack shows the person and the ledger row together (D16);
 *   verify   reads the ticket's lines back.
 *
 * `raiseTicket`'s own guards stay the guarantee: the shelf-work grant AT the department, a Stores item per line.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });
const id = z.string().min(1).max(64);

const reorderArgs = z.object({
  shelfId: id,
  lines: z.array(z.object({ itemId: id, qtyBase: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(100),
}).strict();
type ReorderArgs = z.infer<typeof reorderArgs>;

/** A ticket for the shelf still waiting to be issued: a reorder now would ask twice. */
async function openTicketAt(exec: Db | Tx, shelfId: string): Promise<{ id: string; indentNo: string } | null> {
  const [row] = await (exec as Db).select({ id: storeIndents.id, indentNo: storeIndents.indentNo }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .where(and(eq(storesTicketDetails.shelfId, shelfId), eq(storeIndents.status, "requested"))).limit(1);
  return row ?? null;
}

const sameLines = (a: readonly { itemId: string; qtyBase: number }[], b: readonly { itemId: string; qtyBase: number }[]): boolean => {
  const key = (l: readonly { itemId: string; qtyBase: number }[]) => [...l].map((x) => `${x.itemId}:${String(x.qtyBase)}`).sort().join(",");
  return key(a) === key(b);
};

export const reorderTool: CopilotToolDecl = {
  intent: "stores.reorder",
  permission: STORES_SHELF_WORK,
  scopedGate: true,
  needsSubject: false,
  kind: "act",
  /** One option per shelf the asker works with a non-empty draft and no ticket already open. */
  async run(ctx) {
    const shelves = await workShelves(ctx.db, ctx.actor);
    if (shelves.length === 0) return say("copilot.answer.storesNoShelf");
    const options: { args: ReorderArgs; option: Omit<CopilotStoresReorderPick["options"][number], "proposal"> }[] = [];
    let open: string | null = null;
    for (const s of shelves) {
      const draft = await shelfReorderDraft(ctx.db, ctx.actor, s.id);
      if (draft.lines.length === 0) continue;
      const already = await openTicketAt(ctx.db, s.id);
      if (already !== null) { open ??= already.indentNo; continue; }
      options.push({
        args: { shelfId: s.id, lines: draft.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.proposed })) },
        option: { shelfId: s.id, shelf: s.name, lines: draft.lines.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.proposed })) },
      });
    }
    if (options.length === 0) {
      return open !== null ? say("copilot.answer.storesReorderOpen", { ticket: open }) : say("copilot.answer.storesReorderNone", { shelf: shelves.map((s) => s.name).slice(0, 3).join(", ") });
    }
    const pick: CopilotStoresReorderPick = { kind: "storesReorderPick", options: options.map((o, proposal) => ({ ...o.option, proposal })) };
    return { ...say("copilot.answer.storesReorderPick", { count: options.length }), payload: pick, proposeMany: options.map((o) => ({ args: o.args, subject: null })) };
  },
  act: defineAct<ReorderArgs>({
    args: reorderArgs,
    async recheck(tx, a, ctx: CopilotActCtx) {
      if ((await openTicketAt(tx, a.shelfId)) !== null) return "copilot.answer.storesStateChanged";
      const draft = await shelfReorderDraft(tx as unknown as Db, ctx.actor, a.shelfId);
      return sameLines(draft.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.proposed })), a.lines) ? null : "copilot.answer.storesStateChanged";
    },
    async apply(tx, a, ctx: CopilotActCtx) {
      const now = new Date();
      const t = await raiseTicket(tx as unknown as Db, ctx.actor, { shelfId: a.shelfId, lines: a.lines, priority: "routine", channel: "copilot" }, now);
      await recordAct(tx, ctx.actor, now, {
        act: "copilot_reorder", storeId: a.shelfId, refId: t.id,
        after: { tool: "stores.reorder", confirmId: ctx.confirmId ?? null, indentNo: t.indentNo },
        lines: a.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })),
      });
      return { answer: say("copilot.answer.storesReorderSent", { ticket: t.indentNo }), module: "stores", rowId: t.id, subjectPatientId: null };
    },
    verify: {
      /** The ticket as written: on that shelf, from the copilot, with exactly the confirmed lines. */
      async readBack(tx, a, result) {
        const [d] = await tx.select().from(storesTicketDetails).where(eq(storesTicketDetails.indentId, result.rowId));
        if (d === undefined || d.shelfId !== a.shelfId || d.channel !== "copilot") return false;
        const lines = await tx.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, result.rowId)).orderBy(asc(storeIndentLines.lineIdx));
        return sameLines(lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })), a.lines);
      },
    },
  }),
};
