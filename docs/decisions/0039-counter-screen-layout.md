# 0039 — Counter and desk screen layout: menu in the header, the patient in hand on the left, one unfiltered list on the right

- **Date:** 2026-09-25   **Status:** Ruled
- **Area:** web (every counter and desk screen: lab, pharmacy, front desk)

## Decision

The owner rejected the Lab Reception v1 layout (menu in a left sidebar, filter tabs on the patient list):

> *"as in Pharmacy or front desk dashboard, when a patient is selected, patient related details appear in the left
> lane. On the right sidebar, keep the list of patients on top and 'Clocks running' minimized by default. In the
> patient list, Do not add filters, like 'At the counter', 'Referred', 'Reports', 'home'... this makes the whole UI
> crash. Move the menu items on the header and not in left sidebar. Left sidebar is meant for details of the patient
> in hand."*

- **Header:** brand, nav items, status pills, the user.
- **Left lane:** the patient in hand, or "nobody in hand".
- **Centre:** the work.
- **Right:** ONE patient list, sorted by priority, a source chip per row, **no filter tabs**; below it "Clocks
  running", collapsed by default.

Further owner rulings the same day:
- *"when a patient is selected then the list of patients in the sidebar gets minimized and co-pilot zooms in."* With a
  patient in hand the list collapses to one line and the copilot panel opens below it in the right column.
- *"this dark color background is feeling so heavy to eyes. Keep it as a highlighter or for important stuff, instead
  of spreading to whole sidebar."* Panels are light cards; dark/mint only for accents. Do not paint whole rails dark.
- **Work starts from a VISIT.** A patient with two consultations has two jobs: one order and one ticket per visit; a
  test on both visits is billed in whichever order starts first and shows as shared at ₹0 in the other; the second
  visit joins the same lab token (one draw).
- **No buttons that only record presence** ("we are complicating this"). Opening a patient from the queue or a search
  MEANS they have arrived; a scan identifies automatically. Derive presence from the act of opening on every station.
- The collection draw table shows the barcode as on the 1 Sep Collection board.
- The bench drafts results two ways: many patients at once from an instrument run, or patient by patient by hand.

## Why

A counter is worked one patient at a time; the list must show everyone at a glance with no hidden tab state.

## Consequences / how to apply

- Boards: `docs/design/2026-09-01-lims-central-lab/Reception.dc.html` and `Collection.dc.html`,
  `docs/design/2026-09-18-pharmacy-desk/Desk.dc.html`, and `docs/design/2026-09-25-lims-stations/`.
- This supersedes the earlier doctor-desk "sidebar = menu" pattern for counter and desk screens, and partly
  supersedes 0029 (agent cards never in a sidebar; dark agent surfaces).
