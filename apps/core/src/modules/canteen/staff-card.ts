import { eq } from "drizzle-orm";
import { CANTEEN_STAFF_QR_SECONDS } from "@hmis/contracts";
import { loadConfig } from "../../kernel/config";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { canteenStaffCards, canteenStaffCategories } from "../../kernel/db/schema";
import { encodeQr } from "../../kernel/printing/qr";
import { CanteenRefusal } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * THE STAFF MEAL CARD QR (DECIDED): `CNTS1.<cardId>.<version>.<expiresAtSeconds>.<signature>`, HMAC-signed with a key
 * derived from the server secret, alive `CANTEEN_STAFF_QR_SECONDS` (the app refreshes it). A reissued card (version + 1)
 * or a deactivated one kills every QR signed before. A screenshot is useless a minute later; the till shows the photo.
 */
const PREFIX = "CNTS1";

let derived: Buffer | null = null;
function key(): Buffer {
  derived ??= Buffer.from(hmacSign(loadConfig().secretKey, "canteen-staff-qr"), "base64url");
  return derived;
}

export type StaffCardRow = typeof canteenStaffCards.$inferSelect;

export type StaffCardQr = {
  token: string; expiresAt: string; staffCode: string; category: string;
  /** The token's QR as rows ('1' dark), so the phone draws it with no QR library (`QrRows`). */
  qr: string[];
};

/** The holder's own QR (any logged-in person with a card). */
export async function staffCardQr(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<StaffCardQr> {
  const card = (await db.select().from(canteenStaffCards).where(eq(canteenStaffCards.userId, actor.id)))[0];
  if (card === undefined || !card.active) throw new CanteenRefusal("staff_card_invalid", { reason: "no_card" });
  const now = opts.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + CANTEEN_STAFF_QR_SECONDS;
  const payload = `${PREFIX}.${card.id}.${String(card.version)}.${String(exp)}`;
  const token = `${payload}.${hmacSign(key(), payload)}`;
  const category = (await db.select({ name: canteenStaffCategories.name }).from(canteenStaffCategories).where(eq(canteenStaffCategories.id, card.categoryId)))[0]?.name ?? "";
  return {
    token, expiresAt: new Date(exp * 1000).toISOString(), staffCode: card.staffCode, category,
    qr: encodeQr(token).map((row) => row.map((dark) => (dark ? "1" : "0")).join("")),
  };
}

/** The card a scanned QR names, or the refusal (forged, expired, or for an older card version). */
export async function cardOfQr(exec: Db | Tx, token: string, now: Date): Promise<StaffCardRow> {
  const parts = token.trim().split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new CanteenRefusal("staff_card_invalid");
  const [, cardId, version, exp, sig] = parts as [string, string, string, string, string];
  if (!hmacVerify(key(), `${PREFIX}.${cardId}.${version}.${exp}`, sig)) throw new CanteenRefusal("staff_card_invalid");
  if (Number(exp) * 1000 < now.getTime()) throw new CanteenRefusal("staff_card_expired");
  const card = (await (exec as Db).select().from(canteenStaffCards).where(eq(canteenStaffCards.id, cardId)))[0];
  if (card === undefined || !card.active || String(card.version) !== version) throw new CanteenRefusal("staff_card_invalid");
  return card;
}
