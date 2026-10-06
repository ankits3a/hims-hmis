# 0013 — Only the owner may issue credit, hospital-wide

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** billing, pharmacy, lab, opd, approvals

## Decision

- Owner, verbatim: "Inpatient (IPD) will get a plan of its own. No body can issue credit except owner."
- **Credit = owner only.** No role, cap or tier below the owner. Goods do not leave until the owner approves
  (no act-first).
- Applies to TPA, insurer and corporate credit too (credit to a payer is still credit) until the owner rules
  otherwise.
- **Scope: WHOLE HOSPITAL.** Every credit — OPD counter, lab, pharmacy — needs the owner's approval. Cashiers and lab
  roles lose the right to extend credit alone (before this, cashiers could extend credit up to a cap unapproved, and
  lab reception/bench/pathologist roles held `billing.credit.extend` for reflex and add-on bills).
- **IPD gets its own plan.** Ward issue, the IP patient list, IP bill charging and the OPD/IPD toggle leave the
  pharmacy plan.
- This supersedes ruling 12 of 0010 (billing manager releases an unpaid lab report): that release now needs the
  owner's approval.

## Why

Money ruling; the owner reserves credit to themselves.

## Consequences / how to apply

- Never add a credit tier, limit or delegated approver. A refusal names the owner as the next act.
- Built as kernel approval types with approver `owner` (PR #347): `billing_credit_owner` and
  `lab_release_unpaid_owner`. The old approval keys stay registered and unused (an approver cannot change in place).
  Precedent: `materials_vendor_bank_change` in `modules/materials/approval-types.ts`.
- `issueInvoice`: every credit remainder needs the owner's grant for the EXACT amount on the draft; the cap exempts
  nothing. `POST/GET /billing/credit-requests` — `billing.credit.extend` now means "may ask".
- DECIDED: "held until paid is not credit". An internal `holdUntilPaid` (unsettled, `credit_extended=false`) covers the
  lab desk, reflex and add-on bills, with the report held by the delivery interlock.
- The counter's ask screen is `OwnerCreditAsk` (`screens/owner-credit-ask.tsx`); reuse it for pharmacy credit.
- Paying a NEW bill from an advance now needs owner credit.
- Related: 0023 (a pharmacy return kept as the patient's own credit balance needs no approval; no money leaves).
