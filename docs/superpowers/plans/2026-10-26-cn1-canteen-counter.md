# PLAN — Canteen CN-1: counter, menu, staff meal card, attendant meals, charity (#977)

Spec: `docs/specs/977-canteen-counter.md` (approved 2026-10-26). Rulings: decision 0088. Lane `canteen-977`, built on
`lane/ipd-train` (#967), because it needs the diet module, the IPD charge lines and the family pages. It merges after #966
and #967, stays off behind `HMIS_MODULES_ON`, and copies HK-1's door-QR pattern rather than depending on that branch.
Paths are under `apps/core/src/` unless they start with `apps/`, `packages/` or `docs/`.

## Decided (standard practice; the CA confirms the tax lines)

| Question | DECIDED |
|---|---|
| Menu prices | Shown GST-inclusive, as Indian canteens do. The canteen splits the tax out of the inclusive price itself. The tariff engine's pharmacy-only inclusive rule is not touched. |
| Attendant meal put on the IPD bill | Taxed as a canteen sale at 5%, because it is for the attendant, not the patient. It is a non-payable for any TPA. |
| SAC codes | Configured rows in `gst_config`: canteen food 996331, rent 997212. The CA confirms them. |
| Rent invoice | Issued on the 1st of each month, forward charge (the hospital is the supplier). |
| Caterer outlet | The caterer is the seller and owes its own GST. Its sales are kept out of the hospital's totals (D7). It may use HMIS tills in caterer mode for its own report. |
| Till variance approver | `billing_manager`. Finance acts sit with this role today. |
| "Finance" (charity, staff rules) | A new permission `canteen.finance`, granted to `billing_manager`. |
| Allergen list | The FSSAI declared allergens: cereals with gluten, crustaceans, milk, egg, fish, peanuts, tree nuts, soybean, sulphite. Synonyms map the patients' free-text allergy words onto this list. |
| Food type | Veg, egg or non-veg, marked with three symbols. |
| Therapeutic diets (renal, diabetic) | A "for the patient" order only warns. Only NPO and allergy refuse (spec D4). |
| Night-duty meal | 22:00–06:00 IST, for a person on a roster night slot at that moment (`roster/index.ts:asKnownAt`). |
| Staff card QR | Signed and short-lived (60 s, refreshed in the app). The card version revokes it. |
| Bed QR | Valid only while that bed's admission is open, checked on every request. At most 6 orders per bed per hour, plus a per-address throttle. Without a login, an order from the bed QR can be paid by UPI or covered by bed class. Charging it to the IPD bill needs the family OTP session or a confirmation at the counter. The page never shows a patient's name or allergy. |
| Staff photo | A new `photo_document_id` on the meal card, stored through the documents store. |
| Payroll | Bought (decision 0075), so the monthly deduction list is a CSV keyed by staff code. |

## Owner questions still open (money): ask before slice S7 and S6 limits
1. **Caterer meals on the IPD bill or a staff card.** The hospital collects for the caterer. Is the caterer paid monthly,
   net of rent?
2. **Charity limits.** Is the limit per meal, or per admission per day? Is there one approver, or a higher approver above
   an amount?

## Data (one migration, numbered at merge)

New tables:
- `canteen_outlets` (in-house or caterer, caterer GSTIN, monthly rent)
- `canteen_tills`
- `canteen_dishes` (meals, food type, allergens checked against the fixed list, GST category)
- `canteen_dish_prices` (append-only; public, staff and subsidised lists)
- `canteen_staff_categories`
- `canteen_staff_rules` (append-only; filled by finance; price, cap, night meal, deduction, GST treatment)
- `canteen_staff_cards`
- `canteen_cost_centres`
- `canteen_free_rules`
- `canteen_bed_class_meals`
- `canteen_bed_qrs`
- `canteen_till_sessions` (one open session per till)
- `canteen_sales` (pay mode NOT NULL; each mode CHECK-tied to its reference; the staff rule is copied onto the sale, D2)
- `canteen_sale_lines` (append-only)
- `canteen_charity_grants`
- `canteen_rent_invoices`

New rows in `gst_config`: `canteen_food` 5%, `canteen_staff_recovery` (set by finance; no row means the sale is refused),
`canteen_rent` 18%, `inpatient_diet` exempt.

IPD changes:
- charge component `canteen` and source `ipd.canteen`, with their CHECKs widened
- a unique key per canteen sale line
- `canteen_food` added to the payer's non-payables
- one tariff service, `CANTEEN_MEAL`, added by tariff revision

Billing: export `nextDocNo` and the cash-math functions, and add the series `canteen_sale` and `canteen_rent`.

Shared files: schema index, `kernel/modules/manifests.ts`, `app.module.ts`, seed roles and their tests, the README prose,
caddyfile-parity and the Caddyfiles, `router.tsx`, the en and hi locales, `billing/index.ts` and `billing/config.ts`, the
ipd contracts and schema CHECKs, and `kernel/worker/jobs.ts` (stale bed-QR orders).

## Slices (red acceptance tests `spec #977 Dk` first)
0. Red acceptance tests D1–D7 in `modules/canteen/acceptance/`.
1. Foundation:
   - contracts, migration and module skeleton
   - permissions `canteen.sell`, `canteen.manage`, `canteen.finance` and `canteen.view`
   - roles `canteen_cashier` and `canteen_manager`
   - manifests and seed counts
   - the `gst_config` rows
2. Setup: outlets, tills, dishes, allergens, prices, cost centres and free rules (D6, plus D7's flag).
3. Counter till:
   - sessions; cash, UPI (`billing/upi.ts` QR and a typed reference), cost centre and free rule
   - token and GST invoice through the print kernel
   - day close per till with a variance approval
   - caterer tills kept out of the hospital's totals (D1, D6, D7)
4. Staff meal card:
   - finance rules and category assignment
   - photo and signed QR
   - at the till: cap, night meal through `asKnownAt`, and the rule copied onto the sale
   - monthly deduction CSV (D2)
5. Attendants and patients at the counter:
   - admission lookup
   - `diet:npoCovering` and the allergen match refuse an order (D4)
   - `ipd/canteen-charges.ts:postCanteenChargeIn`, using `counter-charge.ts` refusals
   - bed-class inclusion counted per day (D3)
6. Bed-QR public page `/canteen/bed#<token>`, copied from the `@Public()` door and family pattern:
   - checks the admission on every request
   - caps orders
   - UPI awaits the counter's confirmation
   - the IPD bill only with the family OTP or a counter confirmation
   - a worker sweep cancels stale unpaid orders (D3, D4)
7. Charity: approval type `canteen_charity_meal`, approved by `canteen.finance`, never act-first. A meal cannot be served
   without a grant, and grants are counted monthly (D5).
8. Caterer rent: the monthly 18% invoice, plus caterer reports (D6, D7).
9. Screens:
   - web `/canteen/till`, `/canteen/close`, `/canteen/setup`, `/canteen/finance`
   - public `/canteen/bed`
   - staff meal card in the Expo app (a home card beside attendance), with `QrRows`
   - then a browser walk at 390 and 1440 px against the design board

## Risks
- The shared billing and ipd files are touched; run `node tools/arch/gen.mjs` after the build.
- A UPI payment is not verified by a bank: it is served only after the reference is confirmed.
- A photographed bed QR cannot charge the IPD bill without the family OTP. Keep it that way.
- `docs/PROJECT-BRIEF-2026-08-30.md` still says the canteen is out of scope. Decision 0088 supersedes that line; update
  the brief in the build lane.
- The diet MAP cites decision 0058 for "no money on diet", but 0058 is about doctor screens. Correct the citation.

## Verify
Targeted jest for canteen, ipd charges, billing and diet under the lock; web vitest for the screens; the mobile suite for
the meal card; root typecheck and lint; `node tools/arch/gen.mjs`. CI runs the full suites. Stage after #967 is on
staging.
