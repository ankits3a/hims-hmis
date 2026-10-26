import { z } from "zod";

/**
 * CN-1 CANTEEN (issue #977, decision 0088, spec docs/specs/977-canteen-counter.md) — the shared shape of the canteen:
 * outlets (in-house or run by a caterer who pays rent), tills and their day close, the menu with food type and allergens,
 * price lists, the staff meal card whose every rate is a finance row, attendant meals (counter, bed QR, IPD bill, bed
 * class), finance-approved charity meals, and the caterer's monthly rent invoice.
 *
 * Money is integer paise. Menu prices are GST-INCLUSIVE (Indian canteen practice); the canteen splits the tax out itself.
 * No diagnosis is shown at any till or on any order. The server parses every intent's input with these schemas; the web
 * reads only the TYPES and the refusal codes.
 */

export const CANTEEN_OUTLET_KINDS = ["in_house", "caterer"] as const;
export type CanteenOutletKind = (typeof CANTEEN_OUTLET_KINDS)[number];

export const CANTEEN_MEALS = ["breakfast", "lunch", "snacks", "dinner", "all_day"] as const;
export type CanteenMeal = (typeof CANTEEN_MEALS)[number];

/** Veg (green square), egg (yellow), non-veg (brown triangle): the FSSAI symbols, shown on the menu and the token. */
export const CANTEEN_FOOD_TYPES = ["veg", "egg", "non_veg"] as const;
export type CanteenFoodType = (typeof CANTEEN_FOOD_TYPES)[number];

/** The FSSAI declared allergens (Labelling and Display Regulations 2020). A dish lists only these. */
export const CANTEEN_ALLERGENS = ["gluten", "crustacean", "milk", "egg", "fish", "peanut", "tree_nut", "soy", "sulphite"] as const;
export type CanteenAllergen = (typeof CANTEEN_ALLERGENS)[number];

/**
 * The words a patient's free-text allergy is matched on, per allergen (English and the common Hindi words). A recorded
 * allergy "groundnut" blocks a dish that lists `peanut`. Matched on whole words, case-insensitive.
 */
export const CANTEEN_ALLERGEN_WORDS: Readonly<Record<CanteenAllergen, readonly string[]>> = {
  gluten: ["gluten", "wheat", "atta", "maida", "barley", "rye", "oats", "suji", "sooji", "semolina", "coeliac", "celiac"],
  crustacean: ["crustacean", "crustaceans", "shellfish", "prawn", "prawns", "shrimp", "shrimps", "crab", "crabs", "lobster", "jhinga"],
  milk: ["milk", "dairy", "lactose", "dudh", "doodh", "paneer", "curd", "dahi", "ghee", "butter", "cheese", "khoya", "casein"],
  egg: ["egg", "eggs", "anda", "ande"],
  fish: ["fish", "machli", "machhli", "seafood"],
  peanut: ["peanut", "peanuts", "groundnut", "groundnuts", "moongphali", "mungfali"],
  tree_nut: ["nut", "nuts", "tree nut", "cashew", "kaju", "almond", "badam", "walnut", "akhrot", "pistachio", "pista", "hazelnut"],
  soy: ["soy", "soya", "soybean", "soyabean", "tofu"],
  sulphite: ["sulphite", "sulphites", "sulfite", "sulfites", "sulphur dioxide"],
};

/** The FSSAI allergens a free-text allergy names (empty when it names none of them). */
export function allergensInText(text: string): CanteenAllergen[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  return CANTEEN_ALLERGENS.filter((a) => CANTEEN_ALLERGEN_WORDS[a].some((w) => t.includes(` ${w} `)));
}

export const CANTEEN_PRICE_LISTS = ["public", "staff", "subsidised"] as const;
export type CanteenPriceList = (typeof CANTEEN_PRICE_LISTS)[number];

/** How a staff category pays: free, or at one of the price lists. A finance row, never a literal (decision 0088 §4). */
export const CANTEEN_STAFF_PRICE_BASES = ["free", "staff", "subsidised", "public"] as const;
export type CanteenStaffPriceBasis = (typeof CANTEEN_STAFF_PRICE_BASES)[number];

/** Staff recovery under a contract (CBIC Circular 172/04/2022) is not a supply; contract or deputed staff may be taxed. */
export const CANTEEN_STAFF_GST = ["not_supply", "taxable"] as const;
export type CanteenStaffGst = (typeof CANTEEN_STAFF_GST)[number];

export const CANTEEN_PAY_MODES = ["cash", "upi", "staff_card", "ipd_bill", "bed_class", "cost_centre", "free_rule", "charity"] as const;
export type CanteenPayMode = (typeof CANTEEN_PAY_MODES)[number];

/**
 * Each sale line's GST treatment (D6). `taxable` carries its rate from `gst_config`; `exempt` is food to an in-patient as
 * part of the stay; `not_supply` is staff recovery finance marked so, an internal cost centre or a free meal; `caterer`
 * is a caterer outlet's own sale — the caterer is the seller and owes its own GST.
 */
export const CANTEEN_GST_TREATMENTS = ["taxable", "exempt", "not_supply", "caterer"] as const;
export type CanteenGstTreatment = (typeof CANTEEN_GST_TREATMENTS)[number];

/** The `gst_config` categories the canteen reads (rows, configured; the CA confirms). */
export const CANTEEN_GST_CATEGORIES = {
  food: "canteen_food",
  staffRecovery: "canteen_staff_recovery",
  rent: "canteen_rent",
  inpatientDiet: "inpatient_diet",
} as const;

/** Night-duty meal window, IST (DECIDED): 22:00 to 06:00, for a person on a roster slot at that moment. */
export const CANTEEN_NIGHT_FROM_MINUTE = 22 * 60;
export const CANTEEN_NIGHT_TO_MINUTE = 6 * 60;
/** The staff card QR lives this long; the app refreshes it. */
export const CANTEEN_STAFF_QR_SECONDS = 60;
/** At most this many orders from one bed QR in an hour. */
export const CANTEEN_BED_ORDERS_PER_HOUR = 6;
/** The IPD charge line's tariff service for a canteen meal (added by a tariff revision). */
export const CANTEEN_MEAL_SERVICE_CODE = "CANTEEN_MEAL";

export const CANTEEN_SALE_STATES = ["completed", "awaiting_confirmation", "cancelled"] as const;
export type CanteenSaleState = (typeof CANTEEN_SALE_STATES)[number];
export const CANTEEN_SALE_CHANNELS = ["counter", "bed_qr"] as const;
export type CanteenSaleChannel = (typeof CANTEEN_SALE_CHANNELS)[number];
export const CANTEEN_SESSION_STATES = ["open", "variance_pending", "closed"] as const;
export type CanteenSessionState = (typeof CANTEEN_SESSION_STATES)[number];
export const CANTEEN_CHARITY_KINDS = ["free", "subsidised"] as const;
export type CanteenCharityKind = (typeof CANTEEN_CHARITY_KINDS)[number];

const id = z.string().min(1).max(64);
const code = z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(2).max(80);
const paise = z.number().int().min(0).max(100_000_000);
const key = z.string().trim().min(8).max(64);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** GSTIN: 2-digit state, PAN, entity, Z, check (format only). */
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);
const lines = z.array(z.object({ dishId: id, qty: z.number().int().positive().max(50) }).strict()).min(1).max(30);

/* ═══ setup (canteen.manage) ═══ */

export const createOutletInput = z.object({
  code, name, kind: z.enum(CANTEEN_OUTLET_KINDS),
  catererName: name.optional(), catererGstin: gstin.optional(), monthlyRentPaise: paise.optional(),
}).strict().refine((v) => v.kind === "in_house" || (v.catererName !== undefined && v.catererGstin !== undefined && v.monthlyRentPaise !== undefined), {
  message: "a caterer outlet names the caterer, its GSTIN and the monthly rent",
});
export type CreateOutletInput = z.infer<typeof createOutletInput>;

export const createTillInput = z.object({ outletId: id, code, name }).strict();
export type CreateTillInput = z.infer<typeof createTillInput>;

export const createDishInput = z.object({
  outletId: id, code, name, meal: z.enum(CANTEEN_MEALS), foodType: z.enum(CANTEEN_FOOD_TYPES),
  allergens: z.array(z.enum(CANTEEN_ALLERGENS)).max(CANTEEN_ALLERGENS.length),
}).strict();
export type CreateDishInput = z.infer<typeof createDishInput>;

/** A new price for one list, from now (append-only: an older price stays on the sales that used it). */
export const setDishPriceInput = z.object({ dishId: id, list: z.enum(CANTEEN_PRICE_LISTS), pricePaise: paise }).strict();
export type SetDishPriceInput = z.infer<typeof setDishPriceInput>;

export const createCostCentreInput = z.object({ code, name }).strict();
export type CreateCostCentreInput = z.infer<typeof createCostCentreInput>;

/** A free meal by rule (a donor, a working lunch): at most `perDay` meals a day under it. */
export const createFreeRuleInput = z.object({ code, name, perDay: z.number().int().positive().max(1000) }).strict();
export type CreateFreeRuleInput = z.infer<typeof createFreeRuleInput>;

/** Attendant meals a bed class includes per day (0 = none). */
export const setBedClassMealsInput = z.object({ bedClass: z.string().trim().min(2).max(24), mealsPerDay: z.number().int().min(0).max(6) }).strict();
export type SetBedClassMealsInput = z.infer<typeof setBedClassMealsInput>;

/* ═══ finance (canteen.finance) ═══ */

export const createStaffCategoryInput = z.object({ code, name }).strict();
export type CreateStaffCategoryInput = z.infer<typeof createStaffCategoryInput>;

/** One staff category's meal rule, from now. Append-only; a sale copies the rule it used (D2). */
export const setStaffRuleInput = z.object({
  categoryId: id,
  priceBasis: z.enum(CANTEEN_STAFF_PRICE_BASES),
  /** Meals a day on the card (the night-duty meal is outside the cap). */
  dailyCap: z.number().int().min(0).max(10),
  /** A free meal for a person on a roster slot between 22:00 and 06:00 IST. */
  nightMeal: z.boolean(),
  /** The amount goes on the monthly payroll deduction list instead of being paid at the till. */
  salaryDeduction: z.boolean(),
  gst: z.enum(CANTEEN_STAFF_GST),
}).strict();
export type SetStaffRuleInput = z.infer<typeof setStaffRuleInput>;

export const issueStaffCardInput = z.object({
  userId: id, categoryId: id, staffCode: z.string().trim().min(1).max(24), photoDocumentId: id.optional(),
}).strict();
export type IssueStaffCardInput = z.infer<typeof issueStaffCardInput>;

/* ═══ till (canteen.sell) ═══ */

export const openTillInput = z.object({ tillId: id, openingCashPaise: paise }).strict();
export type OpenTillInput = z.infer<typeof openTillInput>;

/** UPI is not verified by a bank: the cashier types the reference the payer's phone shows. */
const upiReference = z.string().trim().min(6).max(40);

export const canteenPayment = z.discriminatedUnion("mode", [
  /** `grantId`: a finance-approved SUBSIDISED family meal — priced from the subsidised list. */
  z.object({ mode: z.literal("cash"), tenderedPaise: paise.optional(), grantId: id.optional() }).strict(),
  z.object({ mode: z.literal("upi"), reference: upiReference, grantId: id.optional() }).strict(),
  z.object({ mode: z.literal("staff_card"), qr: z.string().trim().min(10).max(400) }).strict(),
  z.object({ mode: z.literal("ipd_bill"), admissionId: id }).strict(),
  z.object({ mode: z.literal("bed_class"), admissionId: id }).strict(),
  z.object({ mode: z.literal("cost_centre"), costCentreId: id }).strict(),
  z.object({ mode: z.literal("free_rule"), freeRuleId: id, note: z.string().trim().min(3).max(200) }).strict(),
  /** A finance-approved FREE family meal. */
  z.object({ mode: z.literal("charity"), grantId: id }).strict(),
]);
export type CanteenPayment = z.infer<typeof canteenPayment>;

export const canteenSaleInput = z.object({
  sessionId: id,
  idempotencyKey: key,
  lines,
  pay: canteenPayment,
  /** The order is food FOR THE PATIENT of this admission: refused while NPO and for a dish with their allergen (D4). */
  forPatientOf: id.optional(),
}).strict();
export type CanteenSaleInput = z.infer<typeof canteenSaleInput>;

export const closeTillInput = z.object({ sessionId: id, countedCashPaise: paise, note: z.string().trim().max(200).optional() }).strict();
export type CloseTillInput = z.infer<typeof closeTillInput>;

export const approveVarianceInput = z.object({ sessionId: id, note: z.string().trim().min(3).max(200) }).strict();
export type ApproveVarianceInput = z.infer<typeof approveVarianceInput>;

export const canteenDayQuery = z.object({ date: day }).strict();
export const canteenMonthQuery = z.object({ month }).strict();

/* ═══ bed QR (public, no login) ═══ */

/** One QR per bed, ordering from one outlet (the in-house canteen that delivers to the wards). */
export const issueBedQrInput = z.object({ bedId: id, outletId: id }).strict();
export type IssueBedQrInput = z.infer<typeof issueBedQrInput>;

export const bedOrderInput = z.object({
  idempotencyKey: key,
  lines,
  pay: z.enum(["upi", "ipd_bill", "bed_class"]),
  /** The UPI reference the payer's phone shows; the counter confirms it before the food goes. */
  upiReference: upiReference.optional(),
  forPatient: z.boolean().default(false),
}).strict().refine((v) => v.pay !== "upi" || v.upiReference !== undefined, { message: "a UPI order carries the reference" });
export type BedOrderInput = z.input<typeof bedOrderInput>;

/** The counter takes a bed order into a till session: the UPI reference seen, or the IPD bill confirmed in person. */
export const confirmBedOrderInput = z.object({ orderId: id, sessionId: id }).strict();
export type ConfirmBedOrderInput = z.infer<typeof confirmBedOrderInput>;

/* ═══ charity (request: canteen.sell or canteen.manage; decide: canteen.finance on the approvals engine) ═══ */

export const requestCharityInput = z.object({
  admissionId: id,
  kind: z.enum(CANTEEN_CHARITY_KINDS),
  /** Meals the grant covers in all. */
  meals: z.number().int().positive().max(200),
  /** The most one meal may cost (the approval's amount is meals × this). */
  mealLimitPaise: paise.refine((p) => p > 0),
  /** The grant lapses at the end of this IST day. */
  validUntil: day,
  note: z.string().trim().min(3).max(300),
}).strict();
export type RequestCharityInput = z.infer<typeof requestCharityInput>;

/* ═══ caterer rent (canteen.finance) ═══ */

export const issueRentInvoiceInput = z.object({ outletId: id, month }).strict();
export type IssueRentInvoiceInput = z.infer<typeof issueRentInvoiceInput>;

/** Every refusal: a code, a sentence, and the fix (no dead ends). */
export const CANTEEN_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the entries and send again." },
  payment_mode_required: { sentence: "A sale needs a payment mode.", fix: "Pick how the meal is paid." },
  not_found: { sentence: "This record does not exist.", fix: "Refresh and pick again." },
  duplicate_code: { sentence: "This code is already used.", fix: "Pick another code." },
  outlet_inactive: { sentence: "This outlet is closed.", fix: "Pick an open outlet." },
  till_busy: { sentence: "This till already has an open session.", fix: "Close the open session first." },
  session_closed: { sentence: "This till session is closed.", fix: "Open the till again." },
  not_your_session: { sentence: "This till session is another cashier's.", fix: "Open your own session." },
  dish_not_on_outlet: { sentence: "This dish is not on this outlet's menu.", fix: "Pick from this outlet's menu." },
  price_missing: { sentence: "This dish has no price on the list this sale needs.", fix: "Ask the canteen manager to set the price." },
  gst_config_missing: { sentence: "The tax setting for this sale is missing.", fix: "Ask finance to set the canteen tax rows." },
  mode_not_at_caterer: { sentence: "A caterer outlet takes only cash or UPI.", fix: "Pay by cash or UPI, or use the hospital counter." },
  staff_card_invalid: { sentence: "This meal card QR is not valid.", fix: "Refresh the card in the staff app and scan again." },
  staff_card_expired: { sentence: "This meal card QR has expired.", fix: "Refresh the card in the staff app and scan again." },
  staff_rule_missing: { sentence: "Finance has not set the meal rule for this staff category.", fix: "Ask finance to set the rule." },
  staff_cap_reached: { sentence: "Today's meals on this card are used up.", fix: "Pay by cash or UPI." },
  admission_closed: { sentence: "This admission is not open.", fix: "Pay by cash or UPI." },
  ipd_bill_settled: { sentence: "This admission's final bill is settled.", fix: "Pay by cash or UPI." },
  not_covered_by_bed_class: { sentence: "This bed class includes no more meals today.", fix: "Pay by UPI or put it on the IPD bill." },
  patient_npo: { sentence: "The patient is nil by mouth.", fix: "Do not serve the patient; ask the ward nurse." },
  patient_allergen: { sentence: "This dish contains an allergen recorded for the patient.", fix: "Pick a dish without it." },
  charity_not_approved: { sentence: "This family meal is not approved by finance yet.", fix: "Wait for the approval, or pay by cash or UPI." },
  charity_used_up: { sentence: "This family meal grant is used up or has lapsed.", fix: "Ask for a new grant." },
  charity_meal_over_limit: { sentence: "This meal costs more than the grant allows.", fix: "Pick a cheaper dish." },
  charity_kind_mismatch: { sentence: "This grant is for another kind of meal.", fix: "Use the grant as approved." },
  free_rule_used_up: { sentence: "Today's free meals under this rule are used up.", fix: "Pay by cash or UPI." },
  bed_qr_invalid: { sentence: "This bed QR is not valid.", fix: "Ask the nurse for the bed's QR." },
  bed_qr_throttled: { sentence: "Too many orders from this bed in an hour.", fix: "Order at the counter." },
  needs_family_otp: { sentence: "Putting meals on the hospital bill needs the family's OTP login.", fix: "Log in on the family page, pay by UPI, or confirm at the counter." },
  order_not_waiting: { sentence: "This order is not waiting for confirmation.", fix: "Refresh the list." },
  variance_not_pending: { sentence: "This till close has no variance waiting.", fix: "Refresh the list." },
  approver_is_cashier: { sentence: "You closed this till; someone else must approve its variance.", fix: "Ask the billing manager." },
  rent_already_issued: { sentence: "This month's rent invoice is already issued.", fix: "Open the issued invoice." },
  not_caterer: { sentence: "Rent is issued only to a caterer outlet.", fix: "Pick a caterer outlet." },
  not_permitted: { sentence: "You do not have permission for this.", fix: "Ask the canteen manager." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type CanteenRefusalCode = keyof typeof CANTEEN_REFUSALS;

/* ═══ wire shapes ═══ */

export type CanteenSaleLine = {
  dishId: string; dishName: string; foodType: CanteenFoodType; qty: number;
  unitPaise: number; netPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
  gstTreatment: CanteenGstTreatment; gstCategory: string | null; gstRateBps: number;
};

export type CanteenSale = {
  saleId: string; saleNo: string; token: number; state: CanteenSaleState; channel: CanteenSaleChannel;
  outletId: string; payMode: CanteenPayMode; totalPaise: number; lines: CanteenSaleLine[];
  /** The staff meal rule copied onto the sale (D2), when paid by a staff card. */
  staffRule: { ruleId: string; priceBasis: CanteenStaffPriceBasis; nightMeal: boolean; salaryDeduction: boolean; gst: CanteenStaffGst } | null;
  /** Paise that go on the payroll deduction list (0 when paid at the till). */
  deductionPaise: number;
  nightMeal: boolean;
};

export type CanteenTillClose = {
  sessionId: string; tillId: string; state: CanteenSessionState;
  openingCashPaise: number; cashSalesPaise: number; expectedCashPaise: number; countedCashPaise: number; variancePaise: number;
};

export type CanteenTillDay = {
  tillId: string; tillCode: string; outletId: string; outletKind: CanteenOutletKind;
  sessions: CanteenTillClose[];
  expectedCashPaise: number; countedCashPaise: number | null;
  byMode: Partial<Record<CanteenPayMode, number>>;
};

export type CanteenDay = {
  date: string;
  tills: CanteenTillDay[];
  /** The hospital's own canteen takings: in-house tills only (D7). */
  hospital: { salesPaise: number; byMode: Partial<Record<CanteenPayMode, number>> };
};

export type CanteenRentInvoice = {
  invoiceId: string; invoiceNo: string; outletId: string; month: string; sacCode: string;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number; gstRateBps: number; issuedAt: string;
};

export type CanteenMonthIncome = {
  month: string;
  /** In-house sales (net of tax) on the hospital's tills; caterer sales are never here (D7). */
  salesPaise: number;
  /** Rent invoiced to caterers (taxable value). */
  rentPaise: number;
  /** Finance-approved family meals served in the month (D5): free and subsidised, with their menu value. */
  charity: { meals: number; valuePaise: number };
};

export type CanteenDeductionRow = { userId: string; staffCode: string; meals: number; amountPaise: number };

export type CanteenBedMenu = {
  bedLabel: string; outletId: string;
  dishes: { dishId: string; name: string; meal: CanteenMeal; foodType: CanteenFoodType; allergens: CanteenAllergen[]; pricePaise: number }[];
  bedClassMealsLeft: number;
};

export type CanteenCharityGrant = {
  grantId: string; approvalId: string; admissionId: string; kind: CanteenCharityKind; meals: number; mealsUsed: number;
  mealLimitPaise: number; validUntil: string; status: "pending" | "granted" | "rejected";
};
