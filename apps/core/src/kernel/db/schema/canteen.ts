import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";

/**
 * CN-1 CANTEEN (issue #977, decision 0088) — outlets, tills and their sessions, the menu and its append-only price lists,
 * the staff meal categories and their append-only finance rules, meal cards, cost centres, free-meal rules, bed-class
 * meal inclusion, bed QRs, sales and their append-only lines, charity grants and the caterer's rent invoices. Read and
 * written only by `modules/canteen` (the IPD bill line a canteen sale posts lives in `ipd_charge_lines`).
 *
 * Money is integer paise; menu prices are GST-inclusive. A sale's pay mode is NOT NULL and each mode is CHECK-tied to its
 * reference (D1); a staff-card sale carries the rule it used, copied (D2).
 */
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * The value lists the CHECKs name, retyped from `packages/contracts/src/canteen.ts` (drizzle-kit loads this file without
 * the workspace packages) and held equal to the contracts by `modules/canteen/lists-parity.test.ts`.
 */
export const CANTEEN_OUTLET_KIND_VALUES = ["in_house", "caterer"] as const;
export const CANTEEN_MEAL_VALUES = ["breakfast", "lunch", "snacks", "dinner", "all_day"] as const;
export const CANTEEN_FOOD_TYPE_VALUES = ["veg", "egg", "non_veg"] as const;
export const CANTEEN_ALLERGEN_VALUES = ["gluten", "crustacean", "milk", "egg", "fish", "peanut", "tree_nut", "soy", "sulphite"] as const;
export const CANTEEN_PRICE_LIST_VALUES = ["public", "staff", "subsidised"] as const;
export const CANTEEN_STAFF_PRICE_BASIS_VALUES = ["free", "staff", "subsidised", "public"] as const;
export const CANTEEN_STAFF_GST_VALUES = ["not_supply", "taxable"] as const;
export const CANTEEN_PAY_MODE_VALUES = ["cash", "upi", "staff_card", "ipd_bill", "bed_class", "cost_centre", "free_rule", "charity"] as const;
export const CANTEEN_GST_TREATMENT_VALUES = ["taxable", "exempt", "not_supply", "caterer"] as const;
export const CANTEEN_SALE_STATE_VALUES = ["completed", "awaiting_confirmation", "cancelled"] as const;
export const CANTEEN_SALE_CHANNEL_VALUES = ["counter", "bed_qr"] as const;
export const CANTEEN_SESSION_STATE_VALUES = ["open", "variance_pending", "closed"] as const;
export const CANTEEN_CHARITY_KIND_VALUES = ["free", "subsidised"] as const;

export const canteenOutlets = pgTable(
  "canteen_outlets",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** A caterer outlet: the caterer is the seller (its own GSTIN) and pays the hospital rent. */
    catererName: text("caterer_name"),
    catererGstin: text("caterer_gstin"),
    monthlyRentPaise: bigint("monthly_rent_paise", { mode: "number" }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("canteen_outlets_code_ux").on(t.code),
    check("canteen_outlets_kind_ck", sql`${t.kind} in (${inList(CANTEEN_OUTLET_KIND_VALUES)})`),
    check("canteen_outlets_caterer_ck", sql`${t.kind} = 'in_house' or (${t.catererName} is not null and ${t.catererGstin} is not null and ${t.monthlyRentPaise} is not null)`),
    check("canteen_outlets_rent_ck", sql`${t.monthlyRentPaise} is null or ${t.monthlyRentPaise} >= 0`),
  ],
);

export const canteenTills = pgTable(
  "canteen_tills",
  {
    id: text("id").primaryKey(),
    outletId: text("outlet_id").notNull().references(() => canteenOutlets.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canteen_tills_code_ux").on(t.code), index("canteen_tills_outlet_idx").on(t.outletId)],
);

export const canteenDishes = pgTable(
  "canteen_dishes",
  {
    id: text("id").primaryKey(),
    outletId: text("outlet_id").notNull().references(() => canteenOutlets.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    meal: text("meal").notNull(),
    foodType: text("food_type").notNull(),
    /** Only the FSSAI declared allergens (`CANTEEN_ALLERGENS`). */
    allergens: text("allergens").array().notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("canteen_dishes_code_ux").on(t.outletId, t.code),
    check("canteen_dishes_meal_ck", sql`${t.meal} in (${inList(CANTEEN_MEAL_VALUES)})`),
    check("canteen_dishes_food_type_ck", sql`${t.foodType} in (${inList(CANTEEN_FOOD_TYPE_VALUES)})`),
    check("canteen_dishes_allergens_ck", sql`${t.allergens} <@ array[${inList(CANTEEN_ALLERGEN_VALUES)}]::text[]`),
  ],
);

/** Append-only: a dish's price on one list is its newest row whose `effective_from` is not after the sale. */
export const canteenDishPrices = pgTable(
  "canteen_dish_prices",
  {
    id: text("id").primaryKey(),
    dishId: text("dish_id").notNull().references(() => canteenDishes.id),
    list: text("list").notNull(),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    setBy: text("set_by").notNull(),
  },
  (t) => [
    index("canteen_dish_prices_dish_idx").on(t.dishId, t.list, t.effectiveFrom),
    check("canteen_dish_prices_list_ck", sql`${t.list} in (${inList(CANTEEN_PRICE_LIST_VALUES)})`),
    check("canteen_dish_prices_price_ck", sql`${t.pricePaise} >= 0`),
  ],
);

export const canteenStaffCategories = pgTable(
  "canteen_staff_categories",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canteen_staff_categories_code_ux").on(t.code)],
);

/** Append-only, filled by finance: a category's rule is its newest row whose `effective_from` is not after the sale. */
export const canteenStaffRules = pgTable(
  "canteen_staff_rules",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull().references(() => canteenStaffCategories.id),
    priceBasis: text("price_basis").notNull(),
    dailyCap: integer("daily_cap").notNull(),
    nightMeal: boolean("night_meal").notNull(),
    salaryDeduction: boolean("salary_deduction").notNull(),
    gst: text("gst").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    setBy: text("set_by").notNull(),
  },
  (t) => [
    index("canteen_staff_rules_category_idx").on(t.categoryId, t.effectiveFrom),
    check("canteen_staff_rules_basis_ck", sql`${t.priceBasis} in (${inList(CANTEEN_STAFF_PRICE_BASIS_VALUES)})`),
    check("canteen_staff_rules_gst_ck", sql`${t.gst} in (${inList(CANTEEN_STAFF_GST_VALUES)})`),
    check("canteen_staff_rules_cap_ck", sql`${t.dailyCap} >= 0`),
  ],
);

/** One card per person; a reissue bumps `version`, which revokes every QR signed for the older one. */
export const canteenStaffCards = pgTable(
  "canteen_staff_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    categoryId: text("category_id").notNull().references(() => canteenStaffCategories.id),
    staffCode: text("staff_code").notNull(),
    /** The person's photo in the documents store, shown at the till. */
    photoDocumentId: text("photo_document_id"),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canteen_staff_cards_user_ux").on(t.userId), uniqueIndex("canteen_staff_cards_code_ux").on(t.staffCode)],
);

export const canteenCostCentres = pgTable(
  "canteen_cost_centres",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canteen_cost_centres_code_ux").on(t.code)],
);

export const canteenFreeRules = pgTable(
  "canteen_free_rules",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    perDay: integer("per_day").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canteen_free_rules_code_ux").on(t.code), check("canteen_free_rules_per_day_ck", sql`${t.perDay} > 0`)],
);

/** Attendant meals a bed class includes per IST day. */
export const canteenBedClassMeals = pgTable(
  "canteen_bed_class_meals",
  {
    bedClass: text("bed_class").primaryKey(),
    mealsPerDay: integer("meals_per_day").notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("canteen_bed_class_meals_ck", sql`${t.mealsPerDay} >= 0`)],
);

/** A bed's QR: the token is stored hashed; one live QR per bed. It orders only while the bed's admission is open. */
export const canteenBedQrs = pgTable(
  "canteen_bed_qrs",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    outletId: text("outlet_id").notNull().references(() => canteenOutlets.id),
    tokenHash: text("token_hash").notNull(),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("canteen_bed_qrs_token_ux").on(t.tokenHash),
    uniqueIndex("canteen_bed_qrs_live_ux").on(t.bedId).where(sql`${t.revokedAt} is null`),
  ],
);

/** One open session per till. A close with a variance waits for the billing manager's approval. */
export const canteenTillSessions = pgTable(
  "canteen_till_sessions",
  {
    id: text("id").primaryKey(),
    tillId: text("till_id").notNull().references(() => canteenTills.id),
    cashierId: text("cashier_id").notNull(),
    state: text("state").notNull(),
    openingCashPaise: bigint("opening_cash_paise", { mode: "number" }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    expectedCashPaise: bigint("expected_cash_paise", { mode: "number" }),
    countedCashPaise: bigint("counted_cash_paise", { mode: "number" }),
    closeNote: text("close_note"),
    varianceApprovedBy: text("variance_approved_by"),
    varianceApprovedAt: timestamp("variance_approved_at", { withTimezone: true }),
    varianceNote: text("variance_note"),
  },
  (t) => [
    uniqueIndex("canteen_till_sessions_open_ux").on(t.tillId).where(sql`${t.state} = 'open'`),
    index("canteen_till_sessions_till_idx").on(t.tillId, t.openedAt),
    check("canteen_till_sessions_state_ck", sql`${t.state} in (${inList(CANTEEN_SESSION_STATE_VALUES)})`),
    check("canteen_till_sessions_close_ck", sql`${t.state} = 'open' or (${t.closedAt} is not null and ${t.expectedCashPaise} is not null and ${t.countedCashPaise} is not null)`),
  ],
);

export const canteenSales = pgTable(
  "canteen_sales",
  {
    id: text("id").primaryKey(),
    saleNo: text("sale_no").notNull(),
    /** The counter token, per outlet per IST day. */
    token: integer("token").notNull(),
    outletId: text("outlet_id").notNull().references(() => canteenOutlets.id),
    sessionId: text("session_id").references(() => canteenTillSessions.id),
    channel: text("channel").notNull(),
    state: text("state").notNull(),
    payMode: text("pay_mode").notNull(),
    upiReference: text("upi_reference"),
    admissionId: text("admission_id"),
    patientId: text("patient_id"),
    /** Food for the patient of `admission_id` (NPO and allergy checked), not for the attendant. */
    forPatient: boolean("for_patient").notNull().default(false),
    staffCardId: text("staff_card_id").references(() => canteenStaffCards.id),
    staffUserId: text("staff_user_id"),
    staffRuleId: text("staff_rule_id").references(() => canteenStaffRules.id),
    /** The finance rule as it stood at the sale, copied (D2). */
    staffRule: jsonb("staff_rule"),
    nightMeal: boolean("night_meal").notNull().default(false),
    deductionPaise: bigint("deduction_paise", { mode: "number" }).notNull().default(0),
    costCentreId: text("cost_centre_id").references(() => canteenCostCentres.id),
    freeRuleId: text("free_rule_id").references(() => canteenFreeRules.id),
    freeNote: text("free_note"),
    grantId: text("grant_id"),
    bedQrId: text("bed_qr_id").references(() => canteenBedQrs.id),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    /** The sale at the public list: what a free, subsidised or staff meal was worth (the month's charity and subsidy figures). */
    menuValuePaise: bigint("menu_value_paise", { mode: "number" }).notNull(),
    tenderedPaise: bigint("tendered_paise", { mode: "number" }),
    idempotencyKey: text("idempotency_key").notNull(),
    soldBy: text("sold_by").notNull(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    uniqueIndex("canteen_sales_no_ux").on(t.saleNo),
    uniqueIndex("canteen_sales_key_ux").on(t.idempotencyKey),
    index("canteen_sales_session_idx").on(t.sessionId),
    index("canteen_sales_outlet_idx").on(t.outletId, t.soldAt),
    index("canteen_sales_admission_idx").on(t.admissionId, t.soldAt),
    index("canteen_sales_staff_idx").on(t.staffUserId, t.soldAt),
    index("canteen_sales_grant_idx").on(t.grantId),
    check("canteen_sales_channel_ck", sql`${t.channel} in (${inList(CANTEEN_SALE_CHANNEL_VALUES)})`),
    check("canteen_sales_state_ck", sql`${t.state} in (${inList(CANTEEN_SALE_STATE_VALUES)})`),
    check("canteen_sales_pay_mode_ck", sql`${t.payMode} in (${inList(CANTEEN_PAY_MODE_VALUES)})`),
    check("canteen_sales_upi_ck", sql`${t.payMode} <> 'upi' or ${t.upiReference} is not null`),
    check("canteen_sales_admission_ck", sql`${t.payMode} not in ('ipd_bill', 'bed_class') or ${t.admissionId} is not null`),
    check("canteen_sales_patient_ck", sql`not ${t.forPatient} or ${t.admissionId} is not null`),
    check("canteen_sales_staff_ck", sql`${t.payMode} <> 'staff_card' or (${t.staffCardId} is not null and ${t.staffRuleId} is not null and ${t.staffRule} is not null)`),
    check("canteen_sales_cost_centre_ck", sql`${t.payMode} <> 'cost_centre' or ${t.costCentreId} is not null`),
    check("canteen_sales_free_rule_ck", sql`${t.payMode} <> 'free_rule' or (${t.freeRuleId} is not null and ${t.freeNote} is not null)`),
    check("canteen_sales_charity_ck", sql`${t.payMode} <> 'charity' or ${t.grantId} is not null`),
    // Cash and UPI land in a drawer: a completed one belongs to a till session.
    check("canteen_sales_session_ck", sql`${t.state} <> 'completed' or ${t.payMode} not in ('cash', 'upi') or ${t.sessionId} is not null`),
    check("canteen_sales_money_ck", sql`${t.totalPaise} >= 0 and ${t.deductionPaise} >= 0 and ${t.deductionPaise} <= ${t.totalPaise}`),
  ],
);

/** Append-only: what was sold, at what inclusive price, and the tax split out of it (D6). */
export const canteenSaleLines = pgTable(
  "canteen_sale_lines",
  {
    id: text("id").primaryKey(),
    saleId: text("sale_id").notNull().references(() => canteenSales.id),
    dishId: text("dish_id").notNull().references(() => canteenDishes.id),
    dishName: text("dish_name").notNull(),
    foodType: text("food_type").notNull(),
    qty: integer("qty").notNull(),
    unitPaise: bigint("unit_paise", { mode: "number" }).notNull(),
    netPaise: bigint("net_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    gstTreatment: text("gst_treatment").notNull(),
    gstCategory: text("gst_category"),
    gstRateBps: integer("gst_rate_bps").notNull(),
  },
  (t) => [
    index("canteen_sale_lines_sale_idx").on(t.saleId),
    check("canteen_sale_lines_qty_ck", sql`${t.qty} > 0`),
    check("canteen_sale_lines_treatment_ck", sql`${t.gstTreatment} in (${inList(CANTEEN_GST_TREATMENT_VALUES)})`),
    check("canteen_sale_lines_sum_ck", sql`${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} = ${t.netPaise}`),
    check("canteen_sale_lines_taxed_ck", sql`${t.gstTreatment} = 'taxable' or (${t.cgstPaise} = 0 and ${t.sgstPaise} = 0)`),
  ],
);

/** A finance-approved family meal grant: the approval (kernel engine) decides; the sales count its use. */
export const canteenCharityGrants = pgTable(
  "canteen_charity_grants",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull(),
    admissionId: text("admission_id").notNull(),
    patientId: text("patient_id").notNull(),
    kind: text("kind").notNull(),
    meals: integer("meals").notNull(),
    mealLimitPaise: bigint("meal_limit_paise", { mode: "number" }).notNull(),
    validUntil: date("valid_until", { mode: "string" }).notNull(),
    note: text("note").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("canteen_charity_grants_approval_ux").on(t.approvalId),
    index("canteen_charity_grants_admission_idx").on(t.admissionId),
    check("canteen_charity_grants_kind_ck", sql`${t.kind} in (${inList(CANTEEN_CHARITY_KIND_VALUES)})`),
    check("canteen_charity_grants_meals_ck", sql`${t.meals} > 0 and ${t.mealLimitPaise} > 0`),
  ],
);

/** Append-only: the caterer's monthly rent invoice (the hospital is the supplier; forward charge, 18%). */
export const canteenRentInvoices = pgTable(
  "canteen_rent_invoices",
  {
    id: text("id").primaryKey(),
    invoiceNo: text("invoice_no").notNull(),
    outletId: text("outlet_id").notNull().references(() => canteenOutlets.id),
    month: text("month").notNull(),
    sacCode: text("sac_code").notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("canteen_rent_invoices_no_ux").on(t.invoiceNo),
    uniqueIndex("canteen_rent_invoices_month_ux").on(t.outletId, t.month),
    check("canteen_rent_invoices_sum_ck", sql`${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} = ${t.totalPaise}`),
  ],
);

/**
 * The canteen's own GST document series (DECIDED: a separate series, as GST allows): `sale` (tax invoices and bills of
 * supply) and `rent`, per fiscal year, moved by a single-winner UPDATE ... RETURNING. Also the per-outlet daily token.
 */
export const canteenSeries = pgTable(
  "canteen_series",
  {
    seriesKey: text("series_key").notNull(),
    period: text("period").notNull(),
    nextNo: integer("next_no").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.seriesKey, t.period] })],
);
