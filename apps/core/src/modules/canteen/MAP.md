---
type: module-notes
title: "canteen — module notes"
description: "Why and traps of the canteen: in-house and caterer outlets, tills and the day close, GST-inclusive menu prices split by the canteen itself, staff meal rules per category copied onto each sale, the bed QR that checks the admission on every request, IPD-bill meals through one ipd door, finance-approved family meals, caterer rent."
resource: apps/core/src/modules/canteen
tags: [canteen, ipd, diet, billing, gst, payroll]
generated: { by: agent:claude, at: 2026-10-26 }
verified: []
stale_after: 2027-01-26
---
# canteen — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/canteen.md`. Paths are relative to `apps/core/src/modules/canteen/` unless they start with
a module name, `kernel/`, `packages/` or `apps/`. Spec `docs/specs/977-canteen-counter.md` (#977), decision 0088,
plan `docs/superpowers/plans/2026-10-26-cn1-canteen-counter.md`. CN-2 (#981): production, stores, waste, FSSAI log.

## 1. Purpose
The hospital canteen in HMIS: outlets (in-house, or a caterer who pays rent), tills, the menu with food type and FSSAI
allergens, three price lists, staff meal cards whose every rate is a finance row, attendant meals (counter, bed QR,
IPD bill, bed class), finance-approved family meals, and the caterer's monthly rent invoice. A leaf: it reaches into
`ipd`, `diet`, `patients`, `roster` and `tariff` through their indexes. Dark until `HMIS_MODULES_ON` names `canteen`.

## 2. Key files
- `names.ts` permissions and roles; `errors.ts` `CanteenRefusal` (code, sentence, fix from `CANTEEN_REFUSALS`).
- `setup.ts` outlets, tills, dishes, append-only prices (`priceAt`), cost centres, free rules, bed-class meals, staff
  categories, append-only staff rules (`staffRuleAt`), meal cards (a reissue bumps `version`).
- `staff-card.ts` the signed 60 s QR (`CNTS1.<card>.<version>.<exp>.<sig>`), key derived from `SECRET_KEY`.
- `sales.ts` `draftSale` (every rule, writes nothing) and `writeSale` (sale, lines, IPD lines), `sell`, `openTill`,
  `closeTill`, `approveVariance`. `bed-qr.ts` the public bed page and the counter's confirm. `charity.ts`,
  `approval-types.ts` (`canteen_charity_meal`), `rent.ts`, `reads.ts` (day, month, deductions, setup), `seed.ts`.
- ipd's side: `modules/ipd/canteen-charges.ts` (`canteenAdmissionFacts`, `openAdmissionAtBed`, `postCanteenChargeIn`),
  `modules/ipd/family-public.ts` `familyVerifiedAdmission`; `modules/ipd/payer-split.ts` makes component `canteen` non-payable for any payer.
- Tests: `acceptance/canteen-counter.acceptance.test.ts` (spec D1–D7), `lists-parity.test.ts`; fixture
  `apps/core/test/helpers/canteen.ts` (`mkCanteenWorld`).

## 3. Invariants and traps
- **Prices are GST-inclusive; the canteen splits the tax itself** (`money.ts` `splitInclusive`, CGST = SGST). The tariff
  engine refuses tax-inclusive lines outside pharmacy, so it is never asked to.
- **An IPD-bill meal is priced by the tariff engine**, from the taxable value as a prepaid quote, and the sale line takes
  the engine's figures, so the final bill's invoice (same engine) equals the stay's line to the paisa. The engine needs
  a tariff ITEM for `CANTEEN_MEAL` / `CANTEEN_DIET` in the admission's tariff version (any price): until the go-live
  tariff revision adds them, an IPD-bill sale answers `ipd_bill_not_ready`. Migration 0262 adds the services, not items.
- **The sale copies the staff rule** (`staff_rule` jsonb, `staff_rule_id`): a new finance row changes the next sale only.
- **Night-duty meal**: rule allows it, 22:00–06:00 IST, on a published roster slot at that instant (`publishedAsKnownAt`),
  one a night; free and outside the daily cap.
- **Bed QR**: every request finds the admission whose open stay is on the bed NOW; discharge closes it at once. The page
  carries no patient id, name, number or allergy. IPD bill only with the family's verified OTP session for the same
  admission (`/ipd/family/canteen/order`, under the family cookie path); UPI waits for the counter
  (`awaiting_confirmation`), and the worker's tick cancels one unconfirmed after 30 minutes.
- **Caterer outlets** take cash or UPI only (owner owes: collecting for the caterer on the IPD bill or a staff card);
  their lines are `caterer` and never enter `hospital` totals or the month's income. Only the rent does.
- **Family meals** never act-first: the grant's approval must be `granted` at every sale; one sale = one meal.
- Append-only (triggers): `canteen_dish_prices`, `canteen_staff_rules`, `canteen_sale_lines`, `canteen_rent_invoices`.
- The schema's CHECK lists are retyped (drizzle-kit loads the schema without the contracts): `lists-parity.test.ts`.

## 4. Owed
- Owner (money): caterer meals on the IPD bill or a staff card (monthly settlement net of rent?); charity limits (per
  meal or per admission per day) and any higher approver.
- Go-live: the tariff revision adding `CANTEEN_MEAL` and `CANTEEN_DIET`; register `canteen_charity_meal`; the CA
  confirms SACs 996331 / 997212 / 999311 and the staff recovery row.
