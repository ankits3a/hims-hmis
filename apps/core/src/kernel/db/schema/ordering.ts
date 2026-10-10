import { boolean, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { services } from "./tariff";

/**
 * ═══ THE OUTSIDE-TEST CATALOGUE (owner 2026-10-10, decision 0065) ═══
 *
 * *"Build Catalog for them. The patient would get the tests outside the hospital till the hospital
 * don't arrange the facility."* ECG, 2D echo, TMT, PFT, EEG, NCV, endoscopy and the like: a doctor
 * advises them like any test, and the slip prints them under "Tests to be done outside". No order and
 * no bill is made for an `outside` row. When the hospital starts one, the admin sets it `in_hospital`
 * and names the department that does it.
 *
 * The row IS a tariff service (`service_id` is the primary key and the foreign key), the
 * `lab_orderables` shape, so the doctor's advised test carries one id from the consult to the slip.
 */
export const OUTSIDE_TEST_SITES = ["outside", "in_hospital"] as const;
export type OutsideTestSite = (typeof OUTSIDE_TEST_SITES)[number];

export const outsideTests = pgTable(
  "outside_tests",
  {
    serviceId: text("service_id").primaryKey().references(() => services.id),
    code: text("code").notNull().unique(),
    nameEn: text("name_en").notNull(),
    site: text("site").notNull().default("outside"),
    /** Who does it in the hospital; required once `site` is `in_hospital`. */
    department: text("department"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outside_tests_active_idx").on(t.active),
    check("outside_tests_site_ck", sql`${t.site} in ('outside', 'in_hospital')`),
    check("outside_tests_department_ck", sql`${t.site} = 'outside' or ${t.department} is not null`),
  ],
);
