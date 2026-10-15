import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ER_OPEN_STATE_VALUES, erChargeLines, erEpisodes } from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { registerEpisodeChargeSink } from "../billing";
import { reverseIpdOrderCharge } from "../ipd";
import { resolvePatientId } from "../patients";
import { loadPricingContext, priceInvoiceLines } from "../tariff";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeChargeSink, EpisodeStanding } from "../billing";

/**
 * ER lane 3 (#810) — THE `ER` EPISODE FOR THE ORDERING DOOR, AND ITS CHARGE SINK (decision 0067: "an IPD or Emergency
 * module registers its series letter and calls it"; spec §3.11, §4.6; IPD's `encounter.ts` + `order-charges.ts` shape).
 *
 * - The resolver answers ONLY the ER number's grammar (`ER26-000123`): an order naming it belongs to the episode's patient
 *   (through the merge chain), payer `self` until lane 6 reads the scheme / road-accident / MLC payer.
 * - The sink: a lab or imaging order on an OPEN episode posts one line per item to `er_charge_lines` — never an invoice
 *   at a counter, never a report held for money (treat first, pay later: §3.5). Priced from the active tariff; a missing
 *   rate is recorded `rate_missing` for lane 6's bill desk, never a block on the order. A departed episode takes no new
 *   order (`ended`). A cancel before the work reverses the line.
 * - The ER issue and procedures post through `postErChargeIn` in their own transaction.
 * No clinical screen reads these lines (decision 0058).
 */
export const ER_EPISODE_PREFIX = "ER";
export const ER_EPISODE_NO_RE = /^ER\d{2}-\d{6}$/;

/** Registered by `EmergencyModule` (API); exported so a suite may register it without booting Nest. */
export function registerErEncounterResolver(): () => void {
  return registerEncounterResolver(ER_EPISODE_PREFIX, async (db, encounterNo) => {
    if (!ER_EPISODE_NO_RE.test(encounterNo)) return null;
    const e = (await db.select({ patientId: erEpisodes.patientId }).from(erEpisodes).where(eq(erEpisodes.episodeNo, encounterNo)))[0];
    if (e === undefined) return null;
    return { patientId: (await resolvePatientId(db, e.patientId)) ?? e.patientId, intendedPayer: "self" };
  });
}

const OPEN: readonly string[] = ER_OPEN_STATE_VALUES;

function standingOf(state: string | undefined): EpisodeStanding {
  if (state === undefined) return null;
  return OPEN.includes(state) ? "live" : "ended";
}

/** Prices one service on the tariff in force at `at`; null when the rate is missing (no item, ₹0 absent, a tariff refusal). */
async function priceOf(exec: Db | Tx, serviceId: string, at: Date): Promise<number | null> {
  try {
    const ctx = await loadPricingContext(exec as Db, { at });
    const svc = ctx.services[serviceId];
    if (svc === undefined || !svc.active) return null;
    const price = ctx.tariff.items[serviceId];
    if (price === undefined || price < 0) return null;
    // Lane 6 (#813): an ER line is part of the hospital's composite healthcare supply (the invoice prices it so too).
    const [line] = priceInvoiceLines(ctx, [{ lineId: newId(), serviceId, qty: 1, supplyContext: "composite_healthcare" }]);
    return line === undefined ? null : line.netPaise;
  } catch {
    return null;
  }
}

/** One charge line on the episode, in the caller's transaction (the issue and procedure seams; the sink's post). */
export async function postErChargeIn(tx: Tx, actor: Actor, line: {
  episodeId: string; source: "er.order" | "er.issue" | "er.procedure"; department?: string; orderId?: string; orderItemId?: string;
  issueId?: string; procedureId?: string; serviceId?: string; itemId?: string; qty: number; at: Date;
}): Promise<void> {
  // An issued item is priced by lane 6's bill desk (MRP and batch): recorded `rate_pending`, never invented here.
  const amount = line.serviceId === undefined ? null : await priceOf(tx, line.serviceId, line.at);
  const status = line.serviceId === undefined ? "rate_pending" : amount === null ? "rate_missing" : "posted";
  await tx.insert(erChargeLines).values({
    id: newId(), episodeId: line.episodeId, source: line.source, department: line.department ?? null,
    orderId: line.orderId ?? null, orderItemId: line.orderItemId ?? null, issueId: line.issueId ?? null,
    procedureId: line.procedureId ?? null, serviceId: line.serviceId ?? null, itemId: line.itemId ?? null, qty: line.qty,
    amountPaise: status === "posted" ? amount! * line.qty : null, status, postedBy: actor.id, postedAt: line.at,
  }).onConflictDoNothing();
}

export const erChargeSink: EpisodeChargeSink = {
  async standing(exec, encounterNo) {
    if (!ER_EPISODE_NO_RE.test(encounterNo)) return null;
    const e = (await (exec as Db).select({ state: erEpisodes.state }).from(erEpisodes).where(eq(erEpisodes.episodeNo, encounterNo)))[0];
    return standingOf(e?.state);
  },
  async lock(tx, encounterNo) {
    if (!ER_EPISODE_NO_RE.test(encounterNo)) return null;
    const e = (await tx.select({ id: erEpisodes.id }).from(erEpisodes).where(eq(erEpisodes.episodeNo, encounterNo)))[0];
    if (e === undefined) return null;
    // The episode's advisory lock (`core.ts` `lockEpisode`'s key) first, then the row: the ER acts' lock order.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`er_episode:${e.id}`}))`);
    const row = (await tx.select({ state: erEpisodes.state }).from(erEpisodes).where(eq(erEpisodes.id, e.id)).for("update"))[0];
    return standingOf(row?.state);
  },
  async post(tx, actor, input) {
    const e = (await tx.select({ id: erEpisodes.id }).from(erEpisodes).where(eq(erEpisodes.episodeNo, input.encounterNo)))[0];
    if (e === undefined) return;
    for (const item of input.items) {
      await postErChargeIn(tx, actor, {
        episodeId: e.id, source: "er.order", department: input.department, orderId: item.orderId, orderItemId: item.orderItemId,
        serviceId: item.serviceId, qty: 1, at: input.at,
      });
    }
  },
  async reverse(tx, _actor, input) {
    const line = (await tx.select().from(erChargeLines).where(eq(erChargeLines.orderItemId, input.orderItemId)).for("update"))[0];
    if (line === undefined) return "none";
    if (line.status === "reversed") return "none";
    // Lane 5 (#812, review #6): the line moved onto the IP running bill at hand-off — the cancel goes to IPD's own reversal
    // path (`reverseIpdOrderCharge`: a reversal line, or the bill desk's decision once the work started or it is billed).
    if (line.status === "moved") return (await reverseIpdOrderCharge(tx, _actor, input)).outcome;
    if (input.workStarted) return "work_done";
    await tx.update(erChargeLines).set({ status: "reversed", amountPaise: null, reversedAt: input.at, reverseReason: input.reason })
      .where(eq(erChargeLines.id, line.id));
    return line.status === "posted" ? "reversed" : "not_posted";
  },
  async covers(exec, orderItemId) {
    const rows = await (exec as Db).select({ id: erChargeLines.id }).from(erChargeLines)
      .where(and(eq(erChargeLines.orderItemId, orderItemId), ne(erChargeLines.status, "reversed")));
    return rows.length > 0;
  },
};

/** Registered by `EmergencyModule` (API) beside the resolver. */
export function registerErChargeSink(): () => void {
  return registerEpisodeChargeSink(ER_EPISODE_PREFIX, erChargeSink);
}

/** Lines of some episodes (lane 6's bill desk reads them; tests prove where an order landed). */
export async function erChargeLinesOf(db: Db | Tx, episodeIds: readonly string[]) {
  if (episodeIds.length === 0) return [];
  return (db as Db).select().from(erChargeLines).where(inArray(erChargeLines.episodeId, [...episodeIds]));
}
