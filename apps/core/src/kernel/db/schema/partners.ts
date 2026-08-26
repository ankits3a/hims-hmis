import { sql } from "drizzle-orm";
import {
  bigint, bigserial, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex,
} from "drizzle-orm/pg-core";
import { invoices } from "./billing";
import { patients } from "./patients";

/**
 * Plan 09 — the COUNTERPARTY side: partners, versioned agreements, attribution ids and their
 * mapping into a partner's own reference space, the append-only commission ledger and the
 * receivable expectations it settles against. `schema/membership.ts` holds the instrument side.
 *
 * Money is integer PAISE (bigint mode number — never floats).
 *
 * ═══ `external_rmp` IS UN-PAYABLE AT THE SCHEMA LEVEL (C-1, DD4) — HOW, AND WHAT WAS MEASURED ═══
 *
 * A referring RMP may EXIST — attribution and reporting need the row — but money owed to one must
 * not be expressible. Three constraints do it together, and the spike (§3 Q1, 2026-08-25) refused
 * all four bypass probes against exactly this shape:
 *
 *   1. `counterparties_id_payee_class_ux` — a UNIQUE index on `(id, payee_class)`. It is redundant
 *      against the primary key BY DESIGN and exists solely so a child row can point at the PAIR.
 *   2. `commission_accruals_counterparty_class_fk` — a COMPOSITE foreign key
 *      `(counterparty_id, payee_class) REFERENCES counterparties (id, payee_class)`, so the class
 *      denormalised onto a ledger row cannot disagree with the counterparty's own.
 *   3. `commission_accruals_payable_class_ck` — `CHECK (direction <> 'payable' OR payee_class IN
 *      ('channel_partner','staff_internal'))`.
 *
 * Measured, in this Postgres: an honest payable insert against an `external_rmp` counterparty is
 * refused by (3); a forged `payee_class` and a re-pointed `counterparty_id` are refused by (2);
 * and — the probe that decided the design — changing the PARENT's class to `external_rmp` while an
 * accrual row points at it is ALSO refused by (2), from the parent side, because the FK's default
 * `ON UPDATE NO ACTION` is checked in both directions. **T1 therefore adds no trigger to
 * `counterparties`, and Assertion Book row A3 is struck.**
 *
 * TWO CONSEQUENCES THE MIGRATION AND EVERY LATER TASK INHERIT:
 *
 *   - The FK ships with the DEFAULT `ON UPDATE NO ACTION` and the migration says so in a comment.
 *     Under `ON UPDATE CASCADE` the spike measured that the FK stays SATISFIED and only the
 *     child's CHECK refuses — so a later ledger table carrying the composite FK without that CHECK
 *     would be silently relabelled `external_rmp` by a cascade.
 *   - A counterparty's class is FROZEN while any accrual row exists, receivable rows included.
 *     So O-7's `terminated` path is `counterparties.status`, a different column, and nothing in
 *     this phase may implement a status change as a class change.
 *
 * ═══ ACTOR COLUMNS ARE PLAIN TEXT (DD17) ═══  See `schema/membership.ts`'s header for the whole
 * reasoning; it is one ruling taken once for both files.
 */

/**
 * A PARTNER, an internal payee, or a referring external RMP. Configuration (DD3): the code, the
 * name and the terms arrive at commissioning and appear nowhere in this repository.
 *
 * `payee_class` IS THE ONE COLUMN NOTHING MAY EVER UPDATE ONCE AN ACCRUAL EXISTS — see the header.
 * `status` is the column that DOES move (O-7): `suspended` freezes accrual into `escrowed` while
 * honouring continues untouched, because members are innocent; `terminated` stops new accruals at
 * the term date while each instrument runs to its own expiry.
 */
export const counterparties = pgTable(
  "counterparties",
  {
    id: text("id").primaryKey(), // ULID via newId()
    code: text("code").notNull(), // the partner's own code — DATA, seeded, never a constant
    name: text("name").notNull(),
    /** 'channel_partner' | 'staff_internal' | 'external_rmp'. FROZEN while any accrual exists. */
    payeeClass: text("payee_class").notNull(),
    /** O-7: 'active' | 'suspended' | 'terminated'. This is what a status change moves — never the class. */
    status: text("status").notNull().default("active"),
    gstin: text("gstin"),
    contact: jsonb("contact"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("counterparties_code_ux").on(t.code),
    // DD4 (1) — redundant against the primary key BY DESIGN: it is what lets a child point at the
    // PAIR, which is what makes a forged class on a ledger row impossible.
    uniqueIndex("counterparties_id_payee_class_ux").on(t.id, t.payeeClass),
    check(
      "counterparties_payee_class_ck",
      sql`${t.payeeClass} in ('channel_partner', 'staff_internal', 'external_rmp')`,
    ),
    check("counterparties_status_ck", sql`${t.status} in ('active', 'suspended', 'terminated')`),
  ],
);

/**
 * VERSIONED, EFFECTIVE-DATED AGREEMENTS — deliberately the same shape as `tariff_versions`,
 * because the same problem (a priced decision must be reproducible against the terms that were
 * live when it was made) already has a solved shape in this codebase (DD6).
 *
 * `terms` is the rates, the eligible service categories and the kicker thresholds AS DATA. No rate
 * appears in `apps/` (DD3), which is why this is one jsonb column rather than a rate column.
 *
 * `approval_id` is plain text with NO FK — the `tariff_versions.approval_id` precedent, and the
 * same reason: a cross-module reference that would otherwise drag this group into another group's
 * truncate statement.
 */
export const partnerAgreements = pgTable(
  "partner_agreements",
  {
    id: text("id").primaryKey(),
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    versionNo: integer("version_no").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }), // null = open-ended
    terms: jsonb("terms").notNull(), // rates, eligible categories, kicker thresholds — DATA
    status: text("status").notNull().default("draft"), // 'draft'|'active'|'superseded'
    approvalId: text("approval_id"), // plain text, no FK — tariff_versions precedent
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("partner_agreements_version_ux").on(t.counterpartyId, t.versionNo),
    index("partner_agreements_effective_idx").on(t.counterpartyId, t.effectiveFrom),
  ],
);

/**
 * ONE OUTBOUND REFERRAL'S ATTRIBUTION (DD13). Issued at referral time, to ONE partner, printed as
 * a code and a QR on the slip that the 11h barcode wedge reads back.
 *
 * V6 is a rule rather than a conflict to resolve: **the partner whose id is on the slip is the
 * partner with the claim**, so a statement line quoting a different partner's id is `disputed`.
 * That is only enforceable because the id is minted here, once, against one counterparty.
 *
 * `expires_at` is V5's unclaimed-slip window; the expectation it backs ages into `written_off`.
 */
export const attributionIds = pgTable(
  "attribution_ids",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // printed on the slip and encoded in the QR
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    patientId: text("patient_id").references(() => patients.id),
    serviceHint: text("service_hint"),
    state: text("state").notNull().default("issued"), // 'issued'|'claimed'|'expired'|'void'
    issuedBy: text("issued_by").notNull(), // plain text, DD17
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // V5
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("attribution_ids_code_ux").on(t.code),
    index("attribution_ids_counterparty_idx").on(t.counterpartyId),
  ],
);

/**
 * A PARTNER'S OWN REFERENCE SPACE, JOINED EXPLICITLY (DD13, V7).
 *
 * **Fuzzy joins are forbidden.** A fuzzy match that is wrong once in a thousand rows produces a
 * reconciliation nobody can audit and a dispute nobody can settle — so the only join between a
 * partner's reference and ours is a ROW SOMEBODY WROTE, and the unique index below is what makes
 * "the mapping table is the only join" a property rather than a promise.
 */
export const partnerRefMap = pgTable(
  "partner_ref_map",
  {
    id: text("id").primaryKey(),
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    partnerRef: text("partner_ref").notNull(), // the partner's own reference, verbatim
    attributionId: text("attribution_id").notNull().references(() => attributionIds.id),
    mappedBy: text("mapped_by").notNull(), // plain text, DD17
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("partner_ref_map_ref_ux").on(t.counterpartyId, t.partnerRef)],
);

/**
 * THE PER-INVOICE SERIALIZER DD12's rewrite requires — the seventeenth table, and it exists for
 * one reason.
 *
 * Two different events for one invoice can be processed by two dispatch cycles at once (the alerts
 * consumer's docstring records that being observed), and delta-to-target is a read-modify-write:
 * read `Σ` rows already appended, append the difference. Without a serializer both cycles read the
 * same sum and both append.
 *
 * So T6 UPSERTS the row below for `(invoice_id, direction)` and then locks it `FOR UPDATE`, with
 * the sum and the append inside the lock — DD10's shape reused, measured to block in this harness
 * (§3 Q6). Idempotency on `basis_event_id` stays as the second guard, exactly as DD10 keeps its
 * index behind its lock. **This task ships the table and its unique index; T6 writes the locking.**
 *
 * ═══ THE KEY IS `(invoice_id, direction, counterparty_id)` — PLAN 09a DD2, AS CORRECTED ═══
 *
 * Plan 09 keyed this `(agreement_id, invoice_id, direction)`, and Plan 09's independent reviewer
 * measured what that costs: an agreement amendment BACKDATED over an invoice already accrued
 * resolves to a different agreement id, opens a SECOND subject, finds no prior rows beneath it,
 * and appends the whole target again — `[5000, 10000]`, total 15 000 where 10 000 is correct.
 *
 * `agreement_id` STAYS AS A COLUMN and it is deliberately no longer part of the identity: it records
 * which version first opened the subject, which is provenance worth keeping and is not a key.
 * Nothing is lost by dropping it from the key, because every `commission_accruals` row carries its
 * OWN `agreement_id` and its own `rate_snapshot` (DD6) — so which terms priced which delta stays
 * reconstructible per ROW, at the grain where the question is actually asked.
 *
 * **AND `counterparty_id` IS IN THE KEY, WHICH THE FIRST VERSION OF THIS FIX GOT WRONG.** Keyed on
 * `(invoice_id, direction)` alone the subject stopped separating two COUNTERPARTIES — `agreement_id`
 * had been doing that silently, because an agreement belongs to exactly one of them. A second
 * partner attributed to the same invoice then found the first partner's subject, summed the first
 * partner's rows as its own prior (`Σ` is scoped by `subject_id`), and appended only the difference:
 * **the incoming partner was short-paid by exactly what the outgoing one had already been credited.**
 * Found by the independent review, reproduced through shipped code — `membership_instances`
 * `patient_id` is null until a human links it, `match-queue` links it later, and `attributeInvoice`
 * breaks ties on insert order, so a card imported earlier and linked later displaces the attributed
 * one. Ordinary operations, not an attack.
 *
 * **So the key is exactly one step coarser than the agreement and one step finer than the invoice**,
 * and both steps are load-bearing: coarser, so a backdated amendment for the SAME partner lands on
 * the subject its earlier rows are under; finer, so two partners can never pool. `subject_id` then
 * determines `counterparty_id`, which is what makes the unqualified `Σ` in `appendAccrualDelta`
 * correct. DD12's invariant is **Σ deltas = target per (invoice, direction, counterparty)**.
 */
export const commissionAccrualSubjects = pgTable(
  "commission_accrual_subjects",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull().references(() => partnerAgreements.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    direction: text("direction").notNull(), // 'payable'|'receivable'
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("commission_accrual_subjects_ux").on(t.invoiceId, t.direction, t.counterpartyId),
    check("commission_accrual_subjects_direction_ck", sql`${t.direction} in ('payable', 'receivable')`),
    /**
     * The target of `commission_accruals_subject_counterparty_fk` below — see there for why this
     * exists. `id` is already the primary key, so this adds no new uniqueness; it exists only so a
     * composite foreign key has something to reference.
     */
    unique("commission_accrual_subjects_id_counterparty_ux").on(t.id, t.counterpartyId),
  ],
);

/**
 * THE COMMISSION LEDGER — append-only by trigger (DD5), a stream of SIGNED DELTAS (DD12).
 *
 * What is payable for an invoice is the SUM of its rows. A reversal is a negative row naming its
 * own basis event; escrow is a state chosen at INSERT (O-7), never a later update; a statement's
 * late correction (V3) and the kicker's recompute (O-6) are both adjustment rows naming the period
 * they correct. "Total reversal never exceeds total accrual" is therefore STRUCTURAL rather than
 * checked: `target ≥ 0` and `Σ deltas = target`.
 *
 * `rate_snapshot` carries the RESOLVED NUMBERS, not a pointer (DD6) — the terms live when the
 * hospital billed are the terms that govern the commission on that bill, and a snapshot is what
 * makes that reproducible after an amendment. `occurred_at` is the EVENT's own instant, handed to
 * the consumer by the dispatcher, never the worker's clock.
 *
 * `payee_class` is denormalised for DD4's composite FK — see this file's header. `instrument_id`
 * is plain text with no FK: it names a `membership_instances` row, and an FK from the partners
 * group into the membership group would couple two module lifecycles for a reference the ledger
 * only reports on (the house cross-module precedent).
 */
export const commissionAccruals = pgTable(
  "commission_accruals",
  {
    id: text("id").primaryKey(),
    /** Null for an adjustment or a kicker row, which correct a PERIOD rather than an invoice. */
    subjectId: text("subject_id").references(() => commissionAccrualSubjects.id),
    counterpartyId: text("counterparty_id").notNull(), // FK is the COMPOSITE below, not a column FK
    payeeClass: text("payee_class").notNull(), // denormalised for DD4 — cannot disagree with the parent
    agreementId: text("agreement_id").notNull().references(() => partnerAgreements.id),
    direction: text("direction").notNull(), // 'payable'|'receivable'
    invoiceId: text("invoice_id").references(() => invoices.id),
    instrumentId: text("instrument_id"), // plain text — see header
    kind: text("kind").notNull(), // 'accrual'|'reversal'|'adjustment'|'kicker'
    state: text("state").notNull().default("accrued"), // 'accrued'|'escrowed' (O-7)
    /** SIGNED. The delta that brings this invoice's accrual to its correct total (DD12). */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    rateSnapshot: jsonb("rate_snapshot").notNull(), // DD6 — resolved numbers, never a pointer
    basisEventId: text("basis_event_id"), // the event this delta answers; null for an adjustment
    basisEventName: text("basis_event_name"),
    periodKey: text("period_key"), // O-6 / V3 — the period an adjustment corrects
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // the EVENT's instant (DD6)
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    // DD4 (2) — THE COMPOSITE FK, with the DEFAULT `ON UPDATE NO ACTION`. See this file's header
    // and the migration's own comment: under CASCADE the FK stays satisfied and only the CHECK
    // below refuses, so a later ledger table without that CHECK would be silently relabelled.
    foreignKey({
      name: "commission_accruals_counterparty_class_fk",
      columns: [t.counterpartyId, t.payeeClass],
      foreignColumns: [counterparties.id, counterparties.payeeClass],
    }),
    /**
     * PLAN 09a CLOSE — **A LEDGER ROW MAY NOT NAME A SUBJECT BELONGING TO ANOTHER COUNTERPARTY.**
     *
     * `appendAccrualDelta` sums the prior with `where subject_id = …` and NO counterparty predicate.
     * That is correct only because `counterparty_id` is in the subject's unique key, so `subject_id`
     * determines it — and "correct only because" is precisely the kind of invariant this phase just
     * proved a comment cannot hold. The first version of DD2's re-key dropped `counterparty_id` from
     * that key, and the unqualified `Σ` then silently summed one partner's rows as another's.
     *
     * This is the same shape as `commission_accruals_counterparty_class_fk` directly above, which
     * already stops a denormalised `payee_class` disagreeing with its parent — the table carried the
     * pattern and this column pair had simply not been given it. **`MATCH SIMPLE` is the default, so
     * kicker and statement rows (`subject_id` null) are unaffected**, which is what lets an
     * append-only ledger carry both invoice-scoped and period-scoped rows under one constraint.
     */
    foreignKey({
      name: "commission_accruals_subject_counterparty_fk",
      columns: [t.subjectId, t.counterpartyId],
      foreignColumns: [commissionAccrualSubjects.id, commissionAccrualSubjects.counterpartyId],
    }),
    // DD4 (3) — nothing is ever PAYABLE to an external RMP. A receivable from one is legitimate.
    check(
      "commission_accruals_payable_class_ck",
      sql`${t.direction} <> 'payable' or ${t.payeeClass} in ('channel_partner', 'staff_internal')`,
    ),
    check("commission_accruals_direction_ck", sql`${t.direction} in ('payable', 'receivable')`),
    // DD12's second guard: one delta per basis event per subject. A redelivered event finds its
    // own row already there. Nulls are distinct in Postgres, so adjustment rows are unaffected.
    uniqueIndex("commission_accruals_basis_event_ux").on(t.subjectId, t.basisEventId),
    index("commission_accruals_counterparty_idx").on(t.counterpartyId, t.direction, t.state),
    index("commission_accruals_invoice_idx").on(t.invoiceId),
    index("commission_accruals_period_idx").on(t.periodKey),
  ],
);

/**
 * WHAT A PARTNER OWES US, AND WHERE THAT CLAIM STANDS.
 *
 * DELIBERATELY NOT APPEND-ONLY, and deliberately a different table from the ledger (DD5). A
 * receivable genuinely WALKS `expected → matched → disputed → written_off`; the ledger records
 * MONEY and the expectation records a CLAIM, and mixing them is what makes an append-only ledger
 * need an UPDATE. This is the one table in this phase that is meant to be updated in place.
 *
 * `attribution_id` is NULLABLE because V1's disputed line is exactly the case where there is no
 * hospital attribution to point at: a statement line quoting an id we never issued becomes a
 * `disputed` row rather than an accrual, and it must still be recorded.
 *
 * The statement columns are the provenance a reconciliation needs (which statement, which period,
 * which line), and the partial unique index on them is what stops one statement being imported
 * twice.
 */
export const receivableExpectations = pgTable(
  "receivable_expectations",
  {
    id: text("id").primaryKey(),
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    attributionId: text("attribution_id").references(() => attributionIds.id), // null = V1's dispute
    agreementId: text("agreement_id").references(() => partnerAgreements.id),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    state: text("state").notNull().default("expected"), // 'expected'|'matched'|'disputed'|'written_off'
    statementRef: text("statement_ref"), // which statement claimed it
    statementPeriod: text("statement_period"),
    statementLineNo: integer("statement_line_no"),
    disputeReason: text("dispute_reason"),
    expectedAt: timestamp("expected_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }), // V5's configured window
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    writtenOffAt: timestamp("written_off_at", { withTimezone: true }),
    updatedBy: text("updated_by"), // plain text, DD17
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    index("receivable_expectations_state_idx").on(t.counterpartyId, t.state),
    index("receivable_expectations_attribution_idx").on(t.attributionId),
    uniqueIndex("receivable_expectations_statement_line_ux")
      .on(t.counterpartyId, t.statementRef, t.statementLineNo)
      .where(sql`${t.statementRef} is not null`),
    check(
      "receivable_expectations_state_ck",
      sql`${t.state} in ('expected', 'matched', 'disputed', 'written_off')`,
    ),
  ],
);
