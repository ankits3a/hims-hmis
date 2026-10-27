import { asc, eq, inArray } from "drizzle-orm";
import { newId, registerPieceInput } from "@hmis/contracts";
import { linenPieces } from "../../kernel/db/schema";
import { LinenError } from "./errors";
import { parse, requireItems, tx } from "./intents";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { Exec } from "./intents";

/**
 * ═══ PIECE TAGS (LD-2, #979, D6) ═══ — a barcode or RFID tag per piece (decision 0087: the tags are coming).
 *
 * A tag is unique across the hospital, for good: a condemned piece keeps its tag, and that tag is refused at every count
 * and cannot be registered again (`piece_condemned`). A scanned tag moves its piece as a ledger row of one with
 * `piece_id`; a bundle counted by hand moves the same totals without it. Both land in the one ledger.
 */
export type PieceRow = typeof linenPieces.$inferSelect;

export async function registerPiece(exec: Exec, actor: Actor, raw: unknown): Promise<PieceRow> {
  const input = parse(registerPieceInput, raw);
  return tx(exec, async (t) => {
    await requireItems(t, [{ itemCode: input.itemCode, qty: 1 }]);
    const seen = (await t.select().from(linenPieces).where(eq(linenPieces.tagUid, input.tagUid)))[0];
    if (seen !== undefined) throw new LinenError(seen.condemnedAt !== null ? "piece_condemned" : "tag_in_use", { tag: input.tagUid });
    return (await t.insert(linenPieces).values({ id: newId(), itemCode: input.itemCode, tagUid: input.tagUid, registeredBy: actor.id }).returning())[0]!;
  });
}

/** Scanned tags → one line of one per piece. Unknown (`unknown_piece`), condemned (`piece_condemned`), twice (`duplicate_item`). */
export async function pieceLines(t: Exec, tags: readonly string[]): Promise<{ itemCode: string; qty: 1; pieceId: string }[]> {
  if (tags.length === 0) return [];
  const dup = tags.find((x, i) => tags.indexOf(x) !== i);
  if (dup !== undefined) throw new LinenError("duplicate_item", { tag: dup });
  const rows = await t.select().from(linenPieces).where(inArray(linenPieces.tagUid, [...tags]));
  return tags.map((tag) => {
    const p = rows.find((r) => r.tagUid === tag);
    if (p === undefined) throw new LinenError("unknown_piece", { tag });
    if (!p.active || p.condemnedAt !== null) throw new LinenError("piece_condemned", { tag });
    return { itemCode: p.itemCode, qty: 1 as const, pieceId: p.id };
  });
}

/** The live piece a condemn request names by its tag; it must be of the request's item. */
export async function condemnPieceOf(t: Tx, tag: string, itemCode: string): Promise<string> {
  const [p] = await pieceLines(t, [tag]);
  if (p!.itemCode !== itemCode) throw new LinenError("piece_wrong_item", { tag, itemCode: p!.itemCode });
  return p!.pieceId;
}

export async function pieceList(exec: Exec, limit = 200): Promise<{ tag: string; itemCode: string; active: boolean; condemnedAt: string | null }[]> {
  return (await exec.select().from(linenPieces).orderBy(asc(linenPieces.tagUid)).limit(limit)).map((p) => ({
    tag: p.tagUid, itemCode: p.itemCode, active: p.active, condemnedAt: p.condemnedAt?.toISOString() ?? null,
  }));
}
