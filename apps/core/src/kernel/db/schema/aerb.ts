import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { resources } from "./resources";
import { users } from "./auth";

/**
 * PLAN 18c T1 — THE AERB REGISTERS. Their own module (`aerb`), for the same reason `pcpndt` is its
 * own: **the inspector reads ONE register, and the department that held the tube must not have to
 * install radiology to write to it.**
 *
 * ═══ WHY A SEPARATE MODULE, WHICH IS THE ONE STRUCTURAL DECISION IN THIS FILE (D1) ═══
 *
 * The Atomic Energy (Radiation Protection) Rules 2004 licence EQUIPMENT, not departments. The C-arm
 * in the cath lab (63), the LINAC in radiation oncology (64), the mobile X-ray a ward nurse wheels
 * to a bedside and the CT in the imaging suite all owe the same rows to the same file, and the same
 * radiographer's TLD badge covers them all. A table inside `modules/radiology` would make Plan 63
 * import a department to file a licence — which is exactly the coupling 18a's DD1 refused for the
 * PCPNDT register, with the same shape of consequence: two registers, and an inspector who is shown
 * one of them.
 *
 * The brainstorm's §4 sketch spelled these permissions `radiology.aerb.*`. They are `aerb.*` here,
 * and the deviation is deliberate and recorded in the phase doc's D1: INDEX §5 row 14 gives the
 * reason in its own words — *one register for one inspector*.
 *
 * ═══ WHAT THIS FILE DOES NOT DO ═══
 *
 * It reads nothing of radiology's. `radiation_dose_register` (T3) is written BY radiology through
 * `recordDose`, carrying the facts and the DRL comparison the caller already computed, rather than
 * joining `imaging_studies` from here. That is what keeps the dependency running one way.
 */

/** See `radiology.ts` for why this is transcribed rather than imported. */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

/**
 * eLORA issues two different things for diagnostic X-ray equipment and the difference is not
 * cosmetic: a plain radiography unit is REGISTERED, while CT, fluoroscopy, mammography and
 * interventional units are LICENSED (and a licence carries conditions — QA periodicity, the RSO,
 * the approved layout). Both are "the paper that lets this machine emit", so both live in this
 * table and `assertDeviceLicensed` treats them identically; the column exists so the register
 * PRINTS the truth to the inspector, who asks for them by name.
 */
export const AERB_LICENCE_TYPES = ["licence", "registration"] as const;

/**
 * `surrendered` is terminal and is how a decommissioned unit leaves the register without leaving
 * the record — AERB requires the decommissioning itself to be documented, so the row stays and the
 * two `decommission_*` columns fill in. `suspended` is the reversible one (a condition breached, a
 * renewal in flight).
 */
export const AERB_LICENCE_STATUSES = ["active", "suspended", "surrendered"] as const;

/**
 * The two roles the Rules name for a diagnostic facility. The RSO is approved by AERB for the
 * institution; the medical physicist is the qualified expert who performs and certifies the QA
 * (T2's records point at one). O-13 names the humans; this table holds the appointment.
 */
export const AERB_PERSON_ROLES = ["rso", "physicist"] as const;

export type AerbLicenceType = (typeof AERB_LICENCE_TYPES)[number];
export type AerbLicenceStatus = (typeof AERB_LICENCE_STATUSES)[number];
export type AerbPersonRole = (typeof AERB_PERSON_ROLES)[number];

/**
 * ═══ 1. THE EQUIPMENT LICENCE — and this phase SEEDS NONE OF IT ═══
 *
 * The licence number, the eLORA reference and the validity dates are LAW: they come off a document
 * the hospital holds, exactly as `pcpndt_registrations` does. There is no seed and no placeholder,
 * so **an ionising study on a machine nobody has filed a licence for is refused** — which is the
 * correct behaviour of a hospital that has not filed, rather than a default that lets an
 * unlicensed CT scan a patient because the row was convenient to invent.
 *
 * `rso_user_id` is PLAIN TEXT holding a `users.id`, the `pcpndt_registrations.incharge_user_id`
 * precedent: it is a stewardship record, not an access-control fact (the permission that lets
 * someone file a licence is `aerb.registers.manage`, held by a role), and an FK here would make
 * deactivating a leaver's account a foreign-key problem on a statutory row.
 */
export const aerbLicences = pgTable(
  "aerb_licences",
  {
    id: text("id").primaryKey(),
    /**
     * The registry row radiology schedules and acquires against — which is what makes "was this
     * machine licensed on the day of that scan" answerable by a join rather than by a file cabinet.
     */
    deviceResourceId: text("device_resource_id").notNull().references(() => resources.id),
    licenceType: text("licence_type").notNull(),
    /** As printed on the document. Unique across the hospital: two machines cannot share one. */
    licenceNo: text("licence_no").notNull().unique(),
    /** The eLORA portal's own reference for the application/consent. */
    eloraRef: text("elora_ref"),
    /** Type approval of the equipment model, and the approval of the room's shielding layout. */
    typeApprovalRef: text("type_approval_ref"),
    layoutApprovalRef: text("layout_approval_ref"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    /** T5's compliance calendar reads this; T1's gate reads it against the scan day. */
    validTo: date("valid_to", { mode: "string" }).notNull(),
    rsoUserId: text("rso_user_id"),
    status: text("status").notNull().default("active"),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
    decommissionRef: text("decommission_ref"),
    remarks: text("remarks"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * ONE ACTIVE LICENCE PER DEVICE — the `pcpndt_registered_machines_device_active_ux` shape, and
     * for the identical reason. Without it a machine could carry two active rows and
     * `activeLicenceFor` would return whichever Postgres happened to read first: §2.54's mechanism
     * with a regulator on the other end of it. A RENEWAL is therefore a status change on the old
     * row and a new row, never two live ones.
     */
    uniqueIndex("aerb_licences_device_active_ux")
      .on(t.deviceResourceId)
      .where(sql`${t.status} = 'active'`),
    /** The calendar's query: what expires, and when. */
    index("aerb_licences_status_validity_idx").on(t.status, t.validTo),
    check("aerb_licences_type_ck", inList(t.licenceType, AERB_LICENCE_TYPES)),
    check("aerb_licences_status_ck", inList(t.status, AERB_LICENCE_STATUSES)),
    /** A validity window that ends before it begins is a typo on a legal document. */
    check("aerb_licences_validity_ck", sql`${t.validTo} >= ${t.validFrom}`),
    /**
     * A decommissioned machine is `surrendered`, and a `surrendered` row carries the date. The
     * CHECK is the half that stops "we retired it" from being a status somebody set on a Tuesday
     * with nothing to show an inspector.
     */
    check(
      "aerb_licences_decommission_ck",
      sql`(${t.status} = 'surrendered') = (${t.decommissionedAt} is not null)`,
    ),
  ],
);

/**
 * ═══ 2. THE APPOINTED PEOPLE — the RSO and the medical physicist ═══
 *
 * `user_id` IS a foreign key here, unlike the licence's `rso_user_id` — because this row answers
 * "is there an approved RSO in post", which the QA register (T2) and the badge programme (T4) both
 * ask about a LOGIN, and a dangling id there is an appointment attributed to nobody.
 *
 * `valid_to` is nullable: an appointment runs until it is ended. AERB approvals of an RSO do carry
 * validity, so the column exists and the calendar reads it; a hospital whose approval letter names
 * no expiry leaves it null rather than inventing one.
 */
export const aerbPersons = pgTable(
  "aerb_persons",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    personRole: text("person_role").notNull(),
    /** AERB's approval reference for this person in this role at this institution. */
    approvalRef: text("approval_ref"),
    qualification: text("qualification").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One live appointment per person per role. A radiographer who is RSO cannot hold two open RSO
     * appointments; the same human MAY be both RSO and physicist where the approvals say so, which
     * is why the role is part of the key rather than the user alone.
     */
    uniqueIndex("aerb_persons_user_role_active_ux")
      .on(t.userId, t.personRole)
      .where(sql`${t.active} = true`),
    index("aerb_persons_role_idx").on(t.personRole, t.active),
    check("aerb_persons_role_ck", inList(t.personRole, AERB_PERSON_ROLES)),
    check("aerb_persons_validity_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);
