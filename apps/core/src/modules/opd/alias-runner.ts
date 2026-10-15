import { sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { proposeAlias } from "./alias-pipeline";
import type { AliasDeps } from "./alias-pipeline";
import { aliasDepsFrom, controlledToday, saveAliasProposal } from "./alias-store";
import { complaintAliasDepsFrom, runComplaintAliasProposals } from "./complaint-alias";
import type { AppConfig } from "../../kernel/config";
import { aliasRunCompleted } from "./events";
import { istDate, istDateTimeToUtc } from "./time";

/**
 * ═══ THE HOURLY RUNNER: UNMATCHED MEDICINE WORDS → PROPOSED NICKNAMES (decisions 0051, 0055) ═══
 *
 * Owner, 2026-10-08: "switch ON medicine nicknames." Nobody adds a nickname and nobody approves
 * one; this job reads the words doctors typed or said that the catalogue could not answer
 * (`opd_term_misses`, kind 'medicine') and puts each through `proposeAlias`.
 *
 * WITH `ALIAS_PIPELINE_ENABLED` OFF IT DOES NOTHING — not a query, not a model client (the caller's
 * `deps` has none). Switched on:
 *
 *   - a word is taken only when it was logged AT LEAST TWICE (twice by one doctor or once each by
 *     two): one stray keystroke is not vocabulary;
 *   - never a word that already has a nickname row — live, removed by the owner, crossed off by
 *     doctors — and a word the pipeline REFUSED is not asked about again for 30 days;
 *   - oldest first, at most `perRun` words a run and `perDay` an IST day;
 *   - a provider that is down is not an answer: the word is left exactly as it was for the next
 *     run, and three failures in a row end this run rather than spend the day's cap on an outage.
 *
 * It ends by writing ONE event of counts (`alias.run_completed`) — no word, no medicine, no doctor
 * — and only when it looked at something.
 */
export type AliasRunCaps = { perRun: number; perDay: number };
export type AliasRunReport = { ran: false } | { ran: true; proposed: number; suggestion: number; refused: number; failed: number };

export const RETRY_REFUSED_AFTER_DAYS = 30;
export const MIN_TIMES_TYPED = 2;
const STOP_AFTER_FAILURES = 3;
const RUNNER: Actor = { type: "system", id: "opd-alias-runner" };

/**
 * #613 — THE RULES TAKE A LIVE NICKNAME BACK. A nickname is live ('suggestion' or 'trusted') only while
 * its medicine is not controlled; the formulary can come to read it as controlled afterwards (a schedule
 * flag arrives, the pharmacy classifies a moiety, the cited NDPS list names it). Each run re-reads every
 * live nickname's medicine and demotes the controlled ones, saying why on the row. No model is asked.
 */
async function demoteControlledNicknames(db: Db, now: Date): Promise<number> {
  const live = await db.execute(sql`select id, medicine_id from cds_aliases where kind = 'medicine' and state in ('suggestion', 'trusted') and medicine_id is not null`);
  let demoted = 0;
  for (const r of live.rows) {
    const today = await controlledToday(db, String(r["medicine_id"]));
    if (today === null || !today.controlled) continue;
    const res = await db.execute(sql`
      update cds_aliases set state = 'demoted', rule_result = 'controlled_drug', refusal = 'controlled_drug', updated_at = ${now.toISOString()}
       where id = ${String(r["id"])} and state in ('suggestion', 'trusted')`);
    demoted += res.rowCount ?? 0;
  }
  return demoted;
}

export async function runAliasProposals(db: Db, deps: AliasDeps, caps: AliasRunCaps, now: Date = new Date()): Promise<AliasRunReport> {
  if (!deps.enabled) return { ran: false };
  await demoteControlledNicknames(db, now);

  const dayStart = istDateTimeToUtc(istDate(now), "00:00");
  const today = await db.execute(sql`select count(*)::int as n from cds_aliases where kind = 'medicine' and audited_at >= ${dayStart.toISOString()}`);
  const room = Math.min(caps.perRun, caps.perDay - Number(today.rows[0]?.["n"] ?? 0));
  if (room <= 0) return { ran: true, proposed: 0, suggestion: 0, refused: 0, failed: 0 };

  const retryBefore = new Date(now.getTime() - RETRY_REFUSED_AFTER_DAYS * 86_400_000);
  const due = await db.execute(sql`
    with typed as (
      select normalize(m.term, NFC) as term, count(*) as times, min(m.created_at) as first_at
        from opd_term_misses m
       where m.kind = 'medicine'
       group by 1
    )
    select t.term
      from typed t
     where t.times >= ${MIN_TIMES_TYPED}
       and not exists (
         select 1 from cds_aliases a
          where a.kind = 'medicine' and a.term = t.term
            and (a.state <> 'proposed' or a.audited_at is null or a.audited_at > ${retryBefore.toISOString()})
       )
     order by t.first_at asc, t.term asc
     limit ${room}
  `);

  const report = { ran: true as const, proposed: 0, suggestion: 0, refused: 0, failed: 0 };
  let failuresInARow = 0;
  for (const r of due.rows) {
    const proposal = await proposeAlias(deps, String(r["term"]));
    if (proposal.outcome === "off") break;
    report.proposed += 1;
    if (proposal.refusal === "chooser_unavailable" || proposal.refusal === "reviewer_unavailable") {
      report.failed += 1;
      failuresInARow += 1;
      if (failuresInARow >= STOP_AFTER_FAILURES) break;
      continue;
    }
    failuresInARow = 0;
    await saveAliasProposal(db, proposal, now);
    if (proposal.state === "suggestion") report.suggestion += 1; else report.refused += 1;
  }
  if (report.proposed > 0) {
    await db.transaction(async (tx) => {
      await appendEvent(tx, aliasRunCompleted.make({ actor: RUNNER, payload: { proposed: report.proposed, suggestion: report.suggestion, refused: report.refused, failed: report.failed } }));
    });
  }
  return report;
}

/**
 * THE SCHEDULER'S DOOR (`kernel/worker/jobs.ts`, `proposeMedicineNicknames`). `config` is the
 * server's whole config, or undefined for a caller that has none (a census test): then, and with
 * the switch off, nothing is built and nothing runs.
 */
export async function runAliasJob(db: Db, config: AppConfig | undefined, now: Date = new Date()): Promise<AliasRunReport> {
  if (config === undefined || !config.aliases.enabled) return { ran: false };
  const caps = { perRun: config.aliases.perRun, perDay: config.aliases.perDay };
  const medicines = await runAliasProposals(db, aliasDepsFrom(db, config), caps, now);
  // #613 — the complaint half, on its own caps and its own counts event.
  await runComplaintAliasProposals(db, complaintAliasDepsFrom(db, config), caps, now);
  return medicines;
}
