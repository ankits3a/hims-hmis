# 0021 — Fee switches (free / charged), "₹0 (समाज सेवा छूट)", and who changes consultation prices

- **Date:** 2026-10-01   **Status:** Ruled
- **Area:** billing, tariff, opd, lab, front desk, printing

## Decision

- Owner: *"The OPD consultation fee is currently zero, tests are Free right now. Add a system (a toggle option) to
  enable disable any fees. The fees at later stage for OPD consultation would be Rs 100."*
- Owner: *"On the bill and receipt, clearly mention amount '₹0 (Samaj Seva Chhoot)' in hindi."* Free prints as
  "₹0 (समाज सेवा छूट)" on the token slip, a ₹0 receipt, and the bill (zero-priced line or wholly free total).
- One switch each for OPD consultation and laboratory tests (Billing back office → Fees). Off = free.
  - Consultation off: no fee and no bill.
  - Lab off: tests billed at ₹0, even when unpriced.
  - A visit opened while consultation was free stays free after charging is switched on.
- The future ₹100 consultation is a TARIFF VERSION (draft → approve → activate), not the switch.
- **Who changes consultation prices (ruled 2026-10-05, money):** *"The billing manager, admin can approve or admin
  can change it directly. Fix the gaps."*
  - The billing manager proposes, through the `billing.config.write` door.
  - The admin approves, or uses "Change now" with a required reason. Both go through the `tariff.versions.activate`
    door.
  - A direct change writes event `tariff.revision_applied_directly` (`direct: true`, note): created and activated by
    the same person, with no approval.
  - "Admin" here means the holder of the owner role. The `admin` ROLE stays the access administrator, not a price
    authority. Production's admin login must hold `owner`.

## Why

The hospital is not charging yet (social service) and wants to turn charging on later without a code change.

## Consequences / how to apply

- Fee switches (PR #433): flips are a ledger inside `billing_config.charge_rules.feeSwitches`, audited as
  `fee_switch.changed`; changing needs `billing.config.write` (billing_manager). Consultation off makes
  `feeServiceFor` return null.
- Prices page (PR #486, `billing/consult-prices.ts`, Billing office → Prices): edits New / Renewal / Revisit
  consultation prices; each change is a tariff version. Proposing needs `tariff.versions.draft`; approving needs
  `tariff.versions.activate` and the owner role plus a required note; the proposer can never approve (except the
  direct-change road above). Revisit is optional `charge_rules.opdConsult.revisit`, charged only while its active
  price is above ₹0.
- Desk One reads `GET /billing/consult-terms` (door `opd.visits.open`): with fees off, renewal says free and a priced
  revisit says no fee; if terms are unreadable, a neutral "Revisit"/"Renewal" with no fee claim.

## Open

- Imaging, procedures and pharmacy have no switch yet; the owner said "any fees", so expect to be asked.
- Whether production's admin login holds `owner` was unverified.
