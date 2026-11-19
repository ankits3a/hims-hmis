import { Logger } from "@nestjs/common";
import { storesNudges } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { CARRIER_KINDS, chainsOf } from "./chain";
import { sourceKeepers } from "./custody";
import { runAssetReminders } from "./asset-reads";
import { notifyOverdueGatePasses } from "./gate-pass";
import { runLossProposals, settleCondemnations } from "./condemnation";
import { approversToTell, notify } from "./tickets";
import { sweepBudgetWarnings } from "./budgets";
import { runBuyerNightIfDue } from "./buyer-agent";
import { CLOCKS, boardCards } from "./tower";
import type { BoardCard } from "./tower";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S3 (#1113, decision 12) — THE CHASER: T1, INTERNAL NUDGES ONLY, ONE PER TICKET PER STEP
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Run by the worker every minute (`kernel/worker/jobs.ts` `sweepStoresChaser`). It reads the same board the tower
 * reads (`boardCards`), so a nudge and a card can never disagree, and it tells people inside the hospital only:
 *
 *   approval waiting 45 min  → one bell to the department's approvers (the stand-in when there is none).
 *                              At 60 min the ticket is Stuck and on the duty manager's Now card (`desk.ts`).
 *   pick past its clock      → one bell to the supplying store's keepers; it is on the store's Stuck card too.
 *   a transit leg past 30 min → one bell to the porter holding it, and to the store.
 *
 * "At most one nudge per ticket per step, recorded" is the `stores_nudges` primary key (ticket, step): the row is
 * inserted first, `on conflict do nothing`, and the bells go out only for the row this sweep won — in the same
 * transaction, so a failed bell leaves no row and the next minute tries again. A leg is its own step (`leg:<n>`,
 * the n-th carrier hand-off), so each porter's leg is chased once. Never a supplier, never a patient, never money.
 *
 * It also sends S2c's "Pass overdue" (`notifyOverdueGatePasses`, idempotent by its notice key), which until now ran
 * only when somebody opened the Passes list.
 */
export const APPROVAL_NUDGE_MIN = 45;

/** One line, a few words, English and Hindi (spec #1113 "Chaser bell, verbatim"). */
export const CHASER_WORDS = {
  approval: ["Indent waiting 45 min", "इंडेंट 45 मिनट से रुका"],
  pick: ["Pick overdue", "उठाने में देर"],
  leg: ["Leg over 30 min", "30 मिनट से ज़्यादा"],
} as const;

export type ChaserRun = { approval: number; pick: number; leg: number; passes: number; failed: number; /** S4 (#1114): asset reminders sent. */ assets?: number; /** S4b (#1114): condemnations settled, loss proposals made. */ condemnations?: number; losses?: number; /** S5a (#1115): budget warnings raised. */ budgets?: number;
  /** S5c (#1115): the buyer agent's night, on the minute it ran. */ night?: { proposals: number; shortfallPr: string | null; halted: boolean } };

const log = new Logger("stores-chaser");

const MIN = 60_000;

type Due = { card: BoardCard; step: string; words: readonly [string, string]; to: () => Promise<string[]> };

async function dueNudges(db: Db, now: Date, cards: readonly BoardCard[]): Promise<Due[]> {
  const chains = await chainsOf(db, cards.filter((c) => c.under === "in_transit").map((c) => c.card.id));
  const out: Due[] = [];
  for (const c of cards) {
    const t = c.ticket;
    const elapsed = (now.getTime() - c.since.getTime()) / MIN;
    if (c.under === "requested" && t.approval.state === "pending" && elapsed >= APPROVAL_NUDGE_MIN) {
      out.push({ card: c, step: "approval", words: CHASER_WORDS.approval, to: () => approversToTell(db, t.department.id, t.requestedBy.id) });
    } else if ((c.under === "approved" || c.under === "picking") && elapsed >= CLOCKS.pick[t.priority]) {
      out.push({ card: c, step: "pick", words: CHASER_WORDS.pick, to: () => sourceKeepers(db, t.source.id) });
    } else if (c.under === "in_transit" && elapsed >= CLOCKS.leg) {
      const legs = (chains.get(t.id)?.handoffs ?? []).filter((h) => CARRIER_KINDS.includes(h.kind)).length;
      out.push({
        card: c, step: `leg:${String(legs)}`, words: CHASER_WORDS.leg,
        to: async () => [...new Set([...(t.custody?.holder === null || t.custody === null ? [] : [t.custody.holder.id]), ...(await sourceKeepers(db, t.source.id))])].sort(),
      });
    }
  }
  return out;
}

export async function runStoresChaser(db: Db, now: Date = new Date()): Promise<ChaserRun> {
  const run: ChaserRun = { approval: 0, pick: 0, leg: 0, passes: 0, failed: 0 };
  const cards = await boardCards(db, now);
  // Pre-merge review S4: each ticket is chased on its own. One that fails (a bad row, a recipient lookup, a bell) is
  // logged and counted; the sweep goes on to the next ticket and to the overdue passes, and the failed nudge, having
  // written no row, is tried again next minute.
  for (const d of await dueNudges(db, now, cards)) {
    try {
      const recipients = await d.to();
      if (recipients.length === 0) continue;
      const sent = await withTx(db, async (tx) => {
        const won = await tx.insert(storesNudges).values({ indentId: d.card.card.id, step: d.step, sentAt: now, recipients })
          .onConflictDoNothing().returning({ indentId: storesNudges.indentId });
        if (won.length === 0) return false;
        for (const u of recipients) await notify(tx, u, d.words, { id: d.card.card.id, indentNo: d.card.card.indentNo }, `chase-${d.step}`, now);
        return true;
      });
      if (sent) run[d.step.startsWith("leg:") ? "leg" : (d.step as "approval" | "pick")] += 1;
    } catch (err) {
      run.failed += 1;
      log.error(`stores chaser: ticket ${d.card.card.indentNo} step ${d.step} failed; the sweep goes on`, err instanceof Error ? err.stack : String(err));
    }
  }
  try {
    // S4 (#1114, decision 7): AMC, warranty and calibration reminders, once each (source key), on the same minute sweep.
    run.assets = await runAssetReminders(db, now);
  } catch (err) {
    run.failed += 1;
    log.error("stores chaser: the asset reminders failed", err instanceof Error ? err.stack : String(err));
  }
  try {
    // S4b (#1114, decisions 12, 13): the approvals of raised condemnations read back, then each unit a round did not see
    // for 30 days proposed as a loss (once; no ledger row).
    run.condemnations = await settleCondemnations(db, now);
    run.losses = await runLossProposals(db, now);
  } catch (err) {
    run.failed += 1;
    log.error("stores chaser: the condemnation sweep failed", err instanceof Error ? err.stack : String(err));
  }
  try {
    run.passes = await notifyOverdueGatePasses(db, now);
  } catch (err) {
    run.failed += 1;
    log.error("stores chaser: the overdue gate-pass notices failed", err instanceof Error ? err.stack : String(err));
  }
  try {
    // S5a (#1115, decision 15): a department past 80 % / 100 % of its month's budget is told once each, within a minute.
    run.budgets = await sweepBudgetWarnings(db, now);
  } catch (err) {
    run.failed += 1;
    log.error("stores chaser: the budget warnings failed", err instanceof Error ? err.stack : String(err));
  }
  try {
    // S5c (#1115, decision 5): the buyer agent's night (22:00 IST: the owner's monthly over-budget list, the central
    // shortfall request, the grouping preview), once per night; nothing on any other minute.
    const night = await runBuyerNightIfDue(db, now);
    if (night !== null) run.night = { proposals: night.proposals.length, shortfallPr: night.shortfall.prId, halted: night.halted };
  } catch (err) {
    run.failed += 1;
    log.error("stores chaser: the buyer agent's night failed", err instanceof Error ? err.stack : String(err));
  }
  return run;
}
