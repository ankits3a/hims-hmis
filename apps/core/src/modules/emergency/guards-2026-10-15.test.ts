import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  erAdvances, erBills, erChargeLines, erCodes, erConsents, erDoses, erMedIssues, erMedReturns, erNotes, erProcedures, erTriageEntries,
} from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { registerUnidentified } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER guards (#881, migration 0236): the database holds the ER's own rules. Seven tables are append-only; notes, codes and
 * charge lines change only in the steps the intents take (each step below is the exact UPDATE the code issues), and
 * every other change is refused. Rows are written directly so each guard is tested alone.
 */
jest.setTimeout(120_000);

describe("ER guards — append-only and write-once in the database", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;
  let episodeId: string;
  let patientId: string;
  let me: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErWorld(db);
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: randomUUID(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" });
    episodeId = u.episodeId;
    patientId = u.patientId;
    me = w.erDoctor.id;
  });

  const now = () => new Date();
  const refused = (q: ReturnType<typeof sql>, msg: RegExp) => expect(db.execute(q)).rejects.toThrow(msg);

  it("triage entries, doses, med returns, procedures, consents, advances and settled bills are never edited or deleted", async () => {
    const issueId = newId();
    await db.insert(erMedIssues).values({
      id: issueId, episodeId, patientId, ownMedicine: "family supply", name: "Paracetamol", doseWords: "500 mg", route: "oral", units: 1,
      highAlert: false, batches: [], orderedBy: me, verbal: false, issuedBy: me, issuedAt: now(),
    });
    const ids: Record<string, string> = {};
    ids.er_triage_entries = newId();
    await db.insert(erTriageEntries).values({ id: ids.er_triage_entries, episodeId, kind: "vitals", recordedBy: me, recordedAt: now(), takenAt: now(), provenance: "test" });
    ids.er_doses = newId();
    await db.insert(erDoses).values({ id: ids.er_doses, issueId, outcome: "held", reason: "nil by mouth", recordedBy: me, recordedAt: now() });
    ids.er_med_returns = newId();
    await db.insert(erMedReturns).values({ id: ids.er_med_returns, issueId, episodeId, kind: "wasted", units: 1, reason: "dropped", recordedBy: me, recordedAt: now() });
    ids.er_procedures = newId();
    await db.insert(erProcedures).values({ id: ids.er_procedures, episodeId, name: "Suturing", performedBy: me, performedAt: now(), recordedBy: me, recordedAt: now() });
    ids.er_consents = newId();
    await db.insert(erConsents).values({ id: ids.er_consents, episodeId, kind: "procedure", about: "Suturing", signedBy: "patient", method: "signature", recordedBy: me, recordedAt: now() });
    ids.er_advances = newId();
    await db.insert(erAdvances).values({ id: ids.er_advances, episodeId, receiptId: newId(), amountPaise: 10_000, takenBy: me, takenAt: now() });
    ids.er_bills = newId();
    await db.insert(erBills).values({
      id: ids.er_bills, episodeId, settlement: "paid", payer: "self", totalPaise: 10_000, payerPaise: 0, patientPaise: 10_000, paidPaise: 10_000,
      duesPaise: 0, settledBy: me, settledAt: now(),
    });
    for (const [table, id] of Object.entries(ids)) {
      await refused(sql`update ${sql.identifier(table)} set id = id where id = ${id}`, new RegExp(`er_append_only: ${table} rows are never edited`));
      await refused(sql`delete from ${sql.identifier(table)} where id = ${id}`, new RegExp(`er_append_only: ${table} rows are never edited or deleted \\(DELETE`));
    }
  });

  it("a draft note changes once, by its co-signature; a signed note never changes", async () => {
    const id = newId();
    await db.insert(erNotes).values({ id, episodeId, kind: "progress", text: "Seen", authorId: me, status: "draft", recordedAt: now(), provenance: "test" });
    await refused(sql`update er_notes set text = 'Rewritten' where id = ${id}`, /er_notes_write_once: a draft changes only by its co-signature/);
    await refused(sql`update er_notes set status = 'signed', cosigned_by = ${me}, cosigned_at = now(), text = 'Rewritten' where id = ${id}`, /er_notes_write_once/);
    // cosign_er_note's own step.
    await db.execute(sql`update er_notes set status = 'signed', cosigned_by = ${me}, cosigned_at = now(), addendum = 'Agree' where id = ${id}`);
    await refused(sql`update er_notes set addendum = 'Changed my mind' where id = ${id}`, /er_notes_write_once: a signed note is never edited/);
    await refused(sql`delete from er_notes where id = ${id}`, /er_notes_write_once: notes are never deleted/);
  });

  it("a code's call, scribe, end and debrief are each written once; place follows the latest location", async () => {
    const id = newId();
    await db.insert(erCodes).values({ id, kind: "code_blue", episodeId, patientId, calledBy: me, calledAt: new Date(Date.now() - 60_000), team: [] });
    await refused(sql`update er_codes set team = '[{"userId":"x","name":"X"}]'::jsonb where id = ${id}`, /er_codes_write_once: the call/);
    await db.execute(sql`update er_codes set scribe_id = ${me} where id = ${id}`);
    await refused(sql`update er_codes set scribe_id = 'someone-else' where id = ${id}`, /er_codes_write_once: the scribe is set once/);
    await db.execute(sql`update er_codes set place = 'Bay 2' where id = ${id}`);
    await refused(sql`update er_codes set leader_id = ${me} where id = ${id}`, /er_codes_write_once: the end/);
    await refused(sql`update er_codes set debrief_at = now(), debrief_by = ${me}, debrief = '{}'::jsonb where id = ${id}`, /er_codes_write_once: the debrief/);
    // end_code's step.
    await db.execute(sql`update er_codes set ended_at = now(), outcome = 'rosc', leader_id = ${me}, note = 'ROSC at 12 min' where id = ${id}`);
    await refused(sql`update er_codes set outcome = 'died' where id = ${id}`, /er_codes_write_once: the end/);
    await refused(sql`update er_codes set ended_at = null, outcome = null where id = ${id}`, /er_codes_write_once: the end/);
    await db.execute(sql`update er_codes set place = 'Resus 1' where id = ${id}`); // a paper back-entry's location
    // record_code_debrief's step.
    await db.execute(sql`update er_codes set debrief = '{"wentWell":"a","improve":"b","actions":[]}'::jsonb, debrief_by = ${me}, debrief_at = now() where id = ${id}`);
    await refused(sql`update er_codes set debrief = '{"wentWell":"c","improve":"d","actions":[]}'::jsonb where id = ${id}`, /er_codes_write_once: the debrief/);
    await refused(sql`delete from er_codes where id = ${id}`, /er_codes_write_once: codes are never deleted/);
  });

  it("a charge line is priced once, reversed or moved once, and then final; what was charged never changes", async () => {
    const line = async (status: string, amountPaise: number | null = null) => {
      const id = newId();
      await db.insert(erChargeLines).values({ id, episodeId, source: "er.order", qty: 1, status, amountPaise, postedBy: me, postedAt: now() });
      return id;
    };
    const a = await line("rate_missing");
    await refused(sql`update er_charge_lines set qty = 2 where id = ${a}`, /er_charge_lines_write_once: what was charged is written once/);
    // The bill desk's pricing step.
    await db.execute(sql`update er_charge_lines set status = 'posted', amount_paise = 5000, service_id = 'svc' where id = ${a}`);
    await refused(sql`update er_charge_lines set amount_paise = 1 where id = ${a}`, /er_charge_lines_write_once: posted -> posted/);
    // The charge sink's reversal step.
    await db.execute(sql`update er_charge_lines set status = 'reversed', amount_paise = null, reversed_at = now(), reverse_reason = 'duplicate' where id = ${a}`);
    await refused(sql`update er_charge_lines set status = 'posted', amount_paise = 5000, reversed_at = null, reverse_reason = null where id = ${a}`, /er_charge_lines_write_once: a reversed line is final/);
    // The hand-off to IPD's move step.
    const b = await line("posted", 7000);
    await db.execute(sql`update er_charge_lines set status = 'moved', moved_to_admission_id = 'adm', moved_ipd_line_id = 'ipl' where id = ${b}`);
    await refused(sql`update er_charge_lines set status = 'reversed', reversed_at = now(), reverse_reason = 'x' where id = ${b}`, /er_charge_lines_write_once: a moved line is final/);
    const c = await line("rate_pending");
    await refused(sql`update er_charge_lines set status = 'moved', moved_to_admission_id = 'adm', amount_paise = 1 where id = ${c}`, /er_charge_lines_write_once: rate_pending -> moved/);
    await refused(sql`delete from er_charge_lines where id = ${c}`, /er_charge_lines_write_once: charge lines are never deleted/);
  });
});
