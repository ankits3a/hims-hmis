---
issue: 977
status: approved
approved: 2026-10-26
---
# SPEC — Canteen CN-1: counter, menu, staff meal card, attendant meals, charity (#977)

Status: APPROVED 2026-10-26 by the owner. The owner's rulings are in decision 0088, which brings the whole canteen into
HMIS. Patient diet already exists (decision 0058: no money on patient diet). The production plan, stores, waste, FSSAI
log, meeting catering and delivery round are CN-2 (#981).

## What

- **Outlets.** Each outlet is in-house or caterer-run. A caterer outlet carries a monthly rent invoice with GST.
- **Menu.** Each outlet has a menu per meal. Dishes are marked veg or non-veg and list their allergens. Prices come from
  price lists (public, staff, subsidised).
- **Counter till.** The till takes UPI, cash, a staff card, the IPD bill, a cost centre, or a free meal by rule. It
  prints a token and a GST invoice. The day close compares cash expected with cash counted.
- **Staff meal card.** A QR in the staff app, with the person's photo shown at the till. The price, daily cap, night-duty
  meal and salary deduction come from a table with one row per staff category, which finance fills. A monthly deduction
  list goes to payroll.
- **Attendant meals.** Ordered at the counter, or from the bed's QR without a login. They are paid by UPI, added to the
  IPD bill, or included by bed class. Food cannot be ordered for a patient who is NPO, and a patient's allergy blocks the
  matching dish.
- **Families who cannot pay.** A free or subsidised meal needs finance approval. It is recorded and counted monthly.

## Decisions

- Nothing about staff meals is hard-coded: every rate, cap and deduction is a row in the category table.
- GST (decision 0088, the CA confirms): an in-patient diet given on medical advice is exempt healthcare. A canteen sale
  is 5% without input tax credit. A caterer's rent is 18%. The treatment of staff recovery is set by finance per category.
- DECIDED by standard practice: the kitchen never takes cash. No diagnosis is shown at any till or on any order.

## Done means

- **D1** A sale cannot complete without a payment mode. The day close shows cash expected against cash counted for each
  till.
- **D2** A staff card takes its price, daily cap, night-duty meal and salary deduction from its category's row. Changing
  the row changes the next sale, not past ones.
- **D3** An attendant order from the bed QR works only while that admission is open. It is paid by UPI, put on the IPD
  bill, or covered by the bed class. An unpaid IPD-bill meal shows on the final bill.
- **D4** An order "for the patient" is refused while the patient is NPO, and refused for a dish that contains the
  patient's recorded allergen.
- **D5** A free or subsidised family meal needs a finance approval on record before it is served.
- **D6** Each sale carries its GST treatment: in-patient diet exempt, canteen sale 5%, staff recovery as finance sets
  it. A caterer outlet's monthly rent invoice carries 18%.
- **D7** A caterer outlet's sales never post to the hospital's till totals. Only its rent does.
