# 0019 — Pharmacy money: cash rounding, sale discount limits, refunds, two-person GRN, stock dating

- **Date:** 2026-09-30   **Status:** Ruled
- **Area:** pharmacy, billing, materials (GRN)

Answers to the five questions from the pharmacy's first live day.

## Decision

1. **Rounding (amended the same morning).** A cash payable rounds to the NEAREST whole rupee, half-up. The owner's
   examples: 33.60 → 34, 30.91 → 31, 30.49 → 30, 30.51 → 31 (and 30.50 → 31 by the ordinary half-up rule). UPI and
   card are collected to the paisa. A mixed tender that includes cash follows the cash rule. The owner's first answer,
   "round down", was replaced by these examples: cash may collect up to 49 paise above MRP, and that is the owner's call.
2. **Sale-side discount: YES.** The pharmacist may give up to 10% off MRP on a bill, with a reason. Above 10% needs
   the pharmacy in-charge's approval. Above 25% goes to the owner. A discount worth more than ₹25,000 on one bill
   also goes to the owner. This replaces the earlier DECIDED "no counter discount until the owner rules".
3. **Two-person GRN:** "the system should recommend to enforce two different people later via settings screen but
   currently admin login can do both". It is a setting, OFF by default, and the screen recommends turning it on.
4. **Refunds:** every refund goes to the billing manager; a refund above ₹25,000 escalates to the owner. This
   confirms 0016 ruling 2 (the server did not enforce it before).
5. **Daily stock dates a delivery by its challan date**, not its receipt date. Intended; it stays.

## Consequences / how to apply

These are money rulings: apply them exactly and cite this record in the PRs.
