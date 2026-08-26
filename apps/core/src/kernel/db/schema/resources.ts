import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigserial, check, index, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * PLAN 13 T1 — the RESOURCE REGISTRY: the first table in this system that knows what a PLACE is.
 *
 * ═══ WHY THIS IS A KERNEL TABLE AND NOT AN OPD ONE (DD1) ═══
 *
 * `opd_rooms` exists today and is a PRIVATE OPD table. The mini-OT's theatre and its two recovery
 * bays (spec §11.16-A), pharmacy stores, lab benches and analyzers, housekeeping rooms and BMW
 * collection points all need the same shape, and the IPD cluster's bed board (§11.2) is built on
 * nothing else. Built per module that is seven copies of one concept — ledger §2.54's mechanism
 * applied to a table instead of to a fact. Kernel-located by the shipped one-migration-dir
 * convention exactly as `opd.ts` is; ownership is code discipline (spec §4), and the owner here is
 * `kernel/resources/`, which T2–T5 build.
 *
 * ═══ ONE STATE COLUMN, AND THERE IS DELIBERATELY NO `active` BOOLEAN (DD2) ═══
 *
 * Every other master in this repo carries `active` — `opd_rooms`, `opd_departments`, `opd_doctors`,
 * `formulary_medicines`. This one does not, and the omission is the decision. A row that is
 * `active: false` and `status: 'available'` DISAGREES WITH ITSELF, and it is the bed board — the one
 * surface §11.2 builds on this table — that would read it wrong and offer a decommissioned bed to
 * the next admission. One column cannot drift against itself. Each kind declares a `retired` status
 * (T2's declarations); `opd_rooms.active` maps onto it at migration time in T6 (`true → available`,
 * `false → retired`). The cost, stated so nobody re-derives it: every board and picker query
 * excludes the retired status rather than filtering `active`, and that predicate lives in ONE mapper
 * (DD9), not in every caller's memory.
 *
 * ═══ THE KIND CHECK IS A CONSTRAINT AND NOT A CONVENTION (DD5, and 16a F3) ═══
 *
 * 16a's F3 ruled that closed sets ship as CHECK constraints, because an out-of-set value reads to
 * every downstream reader in the SAFE-LOOKING direction — "not a bed", "not occupied". That holds
 * here and it holds harder, because this phase WRITES ROWS THROUGH RAW SQL: T6's backfill inserts
 * from `opd_rooms` in a migration, where the application's own validation cannot see it. So the ten
 * roadmap kinds are a CHECK, defending every write path including that one.
 *
 * The write path additionally refuses a kind no INSTALLED manifest declares (T2/T3), which is
 * strictly stronger — it rejects a legal-but-unowned kind such as `theatre` before Plan 15 claims
 * it. Two copies of ten strings is §2.54's own mechanism, so it ships with §2.54's approved remedy:
 * `kinds.test.ts` (T2) compares this CHECK's list to the `ResourceKind` union, the `caddyfile-parity`
 * shape. **T1 RUNS FIRST, SO THAT PARITY LEG LANDS IN T2 AND NOT HERE** — the plan's T1 acceptance
 * says so in as many words rather than leaving it unpinned. What `resources.test.ts` pins today is
 * the ten strings as POSTGRES holds them, which is the half that can be measured before the union
 * exists.
 *
 * `status` gets NO check. Its vocabulary is per-kind — a bed is `cleaning`, a floor never is — and
 * it lives only in the manifest declarations T2 collects at boot. A CHECK over the union of every
 * kind's vocabulary would admit `cleaning` on a floor, which is worse than no constraint because it
 * would look like one.
 *
 * ═══ THE OCCUPANCY TRIAD CARRIES NO FOREIGN KEY, AND THAT IS NOT AN OVERSIGHT (DD6) ═══
 *
 * A bed's occupant is an admission; a recovery bay's is a day-care encounter; an analyzer's is a
 * run; a store's is nothing. A column that must point at two different parents can carry a foreign
 * key to NEITHER — the shipped precedent is `patient_merge_requests.approval_id` and
 * `import_quarantine.batch_id` (schema/membership.ts). `occupant_type` is what makes the ref
 * readable; without it the column is an id nobody can resolve. The three move together or not at
 * all, and that invariant is enforced at the write path (T3, A2), not here: no CHECK can express
 * "…and `status` is THIS KIND's occupied value" when the kind's vocabulary is per-kind.
 *
 * ═══ IDS ARE ULIDs AND ARE NEVER AN ORDERING KEY ═══
 *
 * `ids.ts`'s WARNING and ledger §3.26, the same rule `opd.ts`'s header states. History order is
 * `resource_status_history.seq` (bigserial); recency is a timestamp. **The ids being ULIDs is also
 * what makes T6 cheap**: globally unique, so the backfill PRESERVES them and neither
 * `opd_doctor_schedules.room_id` nor `opd_queue_sessions.room_id` needs a value rewrite — only the
 * foreign key's target changes (DD12).
 */

/**
 * THE TEN KINDS THE ROADMAP NAMES, and the list this table's CHECK enforces.
 *
 * Exported so T2's `kinds.ts` parity test can read the same array this constraint was built from
 * rather than a transcription of it. **This is not the closed union** — that is `ResourceKind` in
 * `kernel/resources/kinds.ts` (T2), which is where a reader looks for the type. The two lists being
 * equal is the assertion; one of them living here is what lets the constraint exist before the
 * subsystem does.
 *
 * An ELEVENTH kind is a kernel edit plus a migration plus that parity test, BY DESIGN (DD4's
 * amendment). The manifest seam is open for status vocabularies and for CLAIMING a kind; it is
 * closed for the SET of kinds.
 */
export const RESOURCE_KIND_VALUES = [
  "floor", "ward", "hall", "room", "bed", "theatre", "store", "bench", "analyzer", "device",
] as const;

/** The audit shape every master in this repo carries — `opd_departments`' columns, same names. */
const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Every physical place and station in the hospital, in one tree.
 *
 * `parent_id` is a NULLABLE SELF-REFERENCE and the tree it makes is cycle-bounded and depth-bounded
 * at the WRITE path (T3), not here: Postgres cannot express "not my own ancestor". `MAX_RESOURCE_DEPTH`
 * (T2, `kinds.ts`) is the one constant both the write guard and the tree reader read — and T4's A6
 * proves the READER terminates against a cycle inserted by raw SQL, because a reader whose
 * termination is an inference from the writer's correctness has not been tested.
 *
 * **There is deliberately no legal-parent-kind matrix** (DD7). A bed under a theatre is legal here,
 * because §11.16-A's two recovery bays may well hang exactly there. Containment rules belong to the
 * owning module — the roadmap's own trap line, "IPD owns admissions, assignment rules, gender
 * segregation, isolation, quota — rules OVER the registry", applied to structure instead of to
 * occupancy. Named as a seam, not built.
 *
 * **There is no `class` column** (§ 4A item 1, RULED 2026-08-26). Bed class carries tariff,
 * attendant policy, pass counts and a nursing ratio (§11.18, §11.2) — that is a governed table keyed
 * by class code in the TARIFF module, landing with the IPD cluster, not a scalar here and not a
 * foreign key on this row. A nullable column is the cheap thing to add later; `site_id` is the
 * expensive one, which is why that one ships today (DD3).
 */
export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(), // ULID via newId() — never an ordering key, see the header
    kind: text("kind").notNull(),
    /**
     * Self-reference. The `AnyPgColumn` return annotation is required by TypeScript, not by
     * drizzle: without it `resources` is referenced inside its own initialiser and the inferred
     * type is circular.
     */
    parentId: text("parent_id").references((): AnyPgColumn => resources.id),
    code: text("code").notNull(), // read off a door or a label — '12', 'B-4', 'OT-1'
    name: text("name").notNull(),
    /** Per-kind extras. `floor` lives here for a room (T6 maps `opd_rooms.floor` into it). */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull(), // a member of THIS KIND's declared vocabulary — see the header
    // ── the occupancy triad (DD6): all three, or none of the three ──
    occupantType: text("occupant_type"), // 'admission' | 'encounter' | 'run' | … — the owning module's word
    occupantRef: text("occupant_ref"), // the occupant's id, plain text, no FK — see the header
    since: timestamp("since", { withTimezone: true }), // when the CURRENT occupancy began
    /**
     * DD3, RULED BY THE OWNER 2026-08-26: exactly as `events.site_id` is already declared
     * (`schema/events.ts:38`). No `sites` table, no facilities table, no multi-site machinery in
     * this phase. Retrofitting a NOT NULL scope column onto a populated live kernel table later is
     * the expensive path; matching the column that already shipped costs nothing today.
     */
    siteId: text("site_id").notNull().default("main"),
    ...auditColumns,
  },
  (t) => [
    /**
     * DD13 — scoped, and case-insensitive. `opd_rooms_code_ux` is unique on RAW `code`, GLOBALLY;
     * that space cannot hold both a bed '12' and a room '12', which are different things in every
     * hospital. `lower()` because a code is read off a door and case is not identity (the
     * `formulary_salts_name_lower_ux` precedent). Scoped by `site_id` too, so the day a second site
     * exists its room '12' does not collide with this one's.
     */
    uniqueIndex("resources_site_kind_code_lower_ux").using("btree", t.siteId, t.kind, sql`lower(${t.code})`),
    index("resources_parent_idx").on(t.parentId), // the tree walk, both directions
    index("resources_kind_status_idx").on(t.kind, t.status), // the board: "every bed that is free"
    check("resources_kind_ck", sql`${t.kind} in ('floor', 'ward', 'hall', 'room', 'bed', 'theatre', 'store', 'bench', 'analyzer', 'device')`),
  ],
);

/**
 * Every transition a resource has ever made, append-only.
 *
 * **`seq` IS THE ORDERING KEY.** `id` is a ULID and ULIDs are never an ordering key (`ids.ts`
 * WARNING, ledger §3.26): two transitions minted in the same millisecond sort by their random tail,
 * and a bed board that renders "what happened to this bed" in the wrong order is a board an operator
 * stops trusting. `at` is not an ordering key either — it is the INJECTED now, and two rows can
 * carry the same instant.
 *
 * **`from_status` is NULLABLE, and null is a FACT rather than a missing value**: the creation row
 * has no previous status. Writing the initial status into both columns would make every row read
 * `from === to` at the point where the distinction first matters, and it is exactly the mutant A3
 * builds.
 *
 * `occupant_type` / `occupant_ref` record the occupancy AFTER this transition, so a release row
 * carries nulls and the assignment row before it carries the occupant. Without them the history
 * answers "when did this bed change state" but not "who was in it", which is the question an
 * incident review actually asks.
 *
 * **There is no update path and no delete path to this table anywhere in the codebase** (A3), and
 * that is the whole of what "append-only" means here — it is not enforced by a trigger, it is
 * enforced by there being no code that does it, and the assertion is a grep as much as it is a test.
 */
export const resourceStatusHistory = pgTable(
  "resource_status_history",
  {
    seq: bigserial("seq", { mode: "number" }).notNull(), // THE ordering key — see the header
    id: text("id").primaryKey(), // ULID via newId()
    resourceId: text("resource_id").notNull().references(() => resources.id),
    fromStatus: text("from_status"), // null on the creation row — a fact, not a gap
    toStatus: text("to_status").notNull(),
    occupantType: text("occupant_type"), // the occupancy AFTER this transition
    occupantRef: text("occupant_ref"),
    reason: text("reason"), // free text: 'discharge cascade', 'migrated by 0032', 'blocked for repair'
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id").notNull(), // plain text — the `approvals.ts` / `operating_mode_changes` precedent
  },
  (t) => [
    // The one read this table has: "this resource's history, oldest first". `resourceHistory` (T4)
    // is one indexed scan and nothing else.
    index("resource_status_history_resource_seq_idx").on(t.resourceId, t.seq),
  ],
);
