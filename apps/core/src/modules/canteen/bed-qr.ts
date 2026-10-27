import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { CANTEEN_BED_ORDERS_PER_HOUR, bedOrderInput, confirmBedOrderInput, issueBedQrInput, newId } from "@hmis/contracts";
import { randomToken, sha256Hex } from "../../kernel/crypto";
import { withTx } from "../../kernel/db/client";
import { canteenBedQrs, canteenSales, resources } from "../../kernel/db/schema";
import { canteenAdmissionFacts, familyVerifiedAdmission, openAdmissionAtBed } from "../ipd";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { istDate } from "./money";
import { CANTEEN_MANAGE, CANTEEN_SELL } from "./names";
import { draftSale, ownOpenSession, saleView, writeSale } from "./sales";
import { bedClassMealsPerDay, menuAt, outletOf, parse } from "./setup";
import type { Actor, CanteenBedMenu, CanteenPayment, CanteenSale } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { Opts } from "./setup";

/**
 * D3 — THE BED'S QR (no login). The QR names a bed and an outlet; the token is kept hashed. EVERY request finds the
 * admission whose open stay is on that bed NOW, so a discharge (or a bed move) closes the page at once. The page shows
 * the menu and the bed's label — never a patient's name, number or allergy.
 *
 * - Paid by UPI: the order waits (`awaiting_confirmation`) until the counter sees the reference on the payer's phone and
 *   takes it into its till session (`confirmBedOrder`); a UPI payment is not verified by a bank.
 * - Covered by the bed class: served at once, counted against the class's meals a day.
 * - On the IPD bill: only through the family's verified OTP session for that same admission
 *   (`familyVerifiedAdmission`); a photographed QR alone answers `needs_family_otp` (charge it at the counter instead).
 * - At most `CANTEEN_BED_ORDERS_PER_HOUR` orders an hour from one QR; the door also throttles per address.
 * - "For the patient" is checked against NPO and the patient's allergies (D4) like the counter.
 */
const BED_QR_ACTOR: Actor = { type: "system", id: "canteen-bed-qr" };
const HOUR_MS = 3_600_000;

type QrRow = typeof canteenBedQrs.$inferSelect;

export async function issueBedQr(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ qrId: string; token: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(issueBedQrInput, raw);
  const at = opts.now ?? new Date();
  const bed = (await db.select({ id: resources.id, kind: resources.kind }).from(resources)
    .where(input.bedId !== undefined ? eq(resources.id, input.bedId) : and(eq(resources.code, input.bedCode!), eq(resources.kind, "bed"))))[0];
  if (bed === undefined || bed.kind !== "bed") throw new CanteenRefusal("not_found", { bedId: input.bedId ?? null, bedCode: input.bedCode ?? null });
  const outlet = await outletOf(db, input.outletId);
  if (outlet.kind !== "in_house") throw new CanteenRefusal("mode_not_at_caterer", { outletId: outlet.id });
  const token = randomToken();
  const qrId = newId();
  await withTx(db, async (tx) => {
    await tx.update(canteenBedQrs).set({ revokedAt: at }).where(and(eq(canteenBedQrs.bedId, bed.id), isNull(canteenBedQrs.revokedAt)));
    await tx.insert(canteenBedQrs).values({ id: qrId, bedId: bed.id, outletId: outlet.id, tokenHash: sha256Hex(token), issuedBy: actor.id, issuedAt: at });
  });
  return { qrId, token };
}

async function liveQr(exec: Db | Tx, token: string): Promise<QrRow> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new CanteenRefusal("bed_qr_invalid");
  const qr = (await (exec as Db).select().from(canteenBedQrs).where(eq(canteenBedQrs.tokenHash, sha256Hex(token))))[0];
  if (qr === undefined || qr.revokedAt !== null) throw new CanteenRefusal("bed_qr_invalid");
  return qr;
}

/** The open admission at the QR's bed, or `admission_closed`. */
async function admissionAtQr(exec: Db | Tx, qr: QrRow) {
  const admissionId = await openAdmissionAtBed(exec, qr.bedId);
  const a = admissionId === null ? null : await canteenAdmissionFacts(exec, admissionId);
  if (a === null || a.closed !== null) throw new CanteenRefusal("admission_closed");
  return a;
}

export async function bedClassLeft(exec: Db | Tx, admissionId: string, billedClass: string | null, at: Date): Promise<number> {
  const perDay = await bedClassMealsPerDay(exec, billedClass);
  const start = new Date(`${istDate(at)}T00:00:00+05:30`);
  const used = (await (exec as Db).select({ n: sql<number>`count(*)::int` }).from(canteenSales).where(and(
    eq(canteenSales.admissionId, admissionId), eq(canteenSales.payMode, "bed_class"), sql`${canteenSales.state} <> 'cancelled'`,
    gte(canteenSales.soldAt, start), lt(canteenSales.soldAt, new Date(start.getTime() + 86_400_000)),
  )))[0]?.n ?? 0;
  return Math.max(0, perDay - used);
}

export async function bedMenu(db: Db, token: string, opts: Opts = {}): Promise<CanteenBedMenu> {
  const at = opts.now ?? new Date();
  const qr = await liveQr(db, token);
  const a = await admissionAtQr(db, qr);
  const bed = (await db.select({ name: resources.name }).from(resources).where(eq(resources.id, qr.bedId)))[0];
  const dishes = (await menuAt(db, qr.outletId, at)).filter((d) => d.prices.public !== undefined);
  return {
    bedLabel: bed?.name ?? "", outletId: qr.outletId,
    dishes: dishes.map((d) => ({ dishId: d.dishId, name: d.name, meal: d.meal, foodType: d.foodType, allergens: d.allergens, pricePaise: d.prices.public! })),
    bedClassMealsLeft: await bedClassLeft(db, a.admissionId, a.billedClass, at),
  };
}

export type BedOrderContext = Opts & {
  /** The family page's link token and its cookies, when the family has verified by OTP on this device. */
  family?: { token: string; device?: string; session?: string };
};

export async function placeBedOrder(db: Db, token: string, raw: unknown, ctx: BedOrderContext = {}): Promise<CanteenSale> {
  const input = parse(bedOrderInput, raw);
  const at = ctx.now ?? new Date();
  const saleId = await withTx(db, async (tx) => {
    const done = (await tx.select({ id: canteenSales.id }).from(canteenSales).where(eq(canteenSales.idempotencyKey, input.idempotencyKey)))[0];
    if (done !== undefined) return done.id;
    const qr = await liveQr(tx, token);
    // Serialise this bed's orders: the hourly cap and the bed-class count are read-then-write.
    await tx.select({ id: canteenBedQrs.id }).from(canteenBedQrs).where(eq(canteenBedQrs.id, qr.id)).for("update");
    const a = await admissionAtQr(tx, qr);
    const recent = (await tx.select({ n: sql<number>`count(*)::int` }).from(canteenSales)
      .where(and(eq(canteenSales.bedQrId, qr.id), gte(canteenSales.soldAt, new Date(at.getTime() - HOUR_MS)))))[0]?.n ?? 0;
    if (recent >= CANTEEN_BED_ORDERS_PER_HOUR) throw new CanteenRefusal("bed_qr_throttled");
    if (input.pay === "ipd_bill") {
      const verified = ctx.family === undefined ? null : await familyVerifiedAdmission(tx, ctx.family.token, ctx.family, at);
      if (verified !== a.admissionId) throw new CanteenRefusal("needs_family_otp");
    }
    const pay: CanteenPayment = input.pay === "upi" ? { mode: "upi", reference: input.upiReference! } : { mode: input.pay, admissionId: a.admissionId };
    const outlet = await outletOf(tx, qr.outletId);
    const draft = await draftSale(tx, {
      outlet, channel: "bed_qr", pay, lines: input.lines, forPatientOf: input.forPatient === true ? a.admissionId : null, at,
    });
    if (input.pay === "upi") {
      draft.state = "awaiting_confirmation";
      // The attendant's order names the admission (the kitchen delivers to the bed), whoever pays.
      draft.admission ??= a;
    }
    return writeSale(tx, BED_QR_ACTOR, draft, { sessionId: null, idempotencyKey: input.idempotencyKey, at, bedQrId: qr.id, soldBy: "bed-qr" });
  });
  return saleView(db, saleId);
}

/** The counter saw the UPI reference: the order joins the cashier's open session and goes to the kitchen. */
export async function confirmBedOrder(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<CanteenSale> {
  await requireAny(db, actor, CANTEEN_SELL);
  const input = parse(confirmBedOrderInput, raw);
  const at = opts.now ?? new Date();
  await withTx(db, async (tx) => {
    const session = await ownOpenSession(tx, actor, input.sessionId);
    const s = (await tx.select().from(canteenSales).where(eq(canteenSales.id, input.orderId)).for("update"))[0];
    if (s === undefined) throw new CanteenRefusal("not_found", { orderId: input.orderId });
    if (s.state !== "awaiting_confirmation") throw new CanteenRefusal("order_not_waiting");
    await tx.update(canteenSales).set({ state: "completed", sessionId: session.id, confirmedBy: actor.id, confirmedAt: at }).where(eq(canteenSales.id, s.id));
  });
  return saleView(db, input.orderId);
}

/** UPI bed orders waiting at the counter, oldest first. */
export async function waitingBedOrders(db: Db, actor: Actor): Promise<CanteenSale[]> {
  await requireAny(db, actor, CANTEEN_SELL);
  const rows = await db.select({ id: canteenSales.id }).from(canteenSales).where(eq(canteenSales.state, "awaiting_confirmation")).orderBy(canteenSales.soldAt);
  return Promise.all(rows.map((r) => saleView(db, r.id)));
}

/** The worker's sweep: a UPI bed order nobody confirmed within `maxAgeMinutes` is cancelled (never served). */
export async function cancelStaleBedOrders(db: Db, now: Date, maxAgeMinutes = 30): Promise<number> {
  const rows = await db.update(canteenSales).set({ state: "cancelled", cancelledAt: now, cancelReason: "not confirmed at the counter" })
    .where(and(eq(canteenSales.state, "awaiting_confirmation"), lt(canteenSales.soldAt, new Date(now.getTime() - maxAgeMinutes * 60_000))))
    .returning({ id: canteenSales.id });
  return rows.length;
}
