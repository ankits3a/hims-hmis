# OPD day report — owner request 2026-09-19

> *"Give me an option in the dashboard to download the day report of the front desk. Total number
> patient consulted for specific day in pdf/csv exportable format. The pdf must have logo of the
> hospital, Name, address i.e, letter head's header content. The body needs to show department wise
> breakup of appointments consulted/booked with bifurcation of how many patients were revisit, new,
> renew patient. Then another pdf/csv for each department with brief of the department stats and then
> detailed breakup like details of patient name, short address, age, gender, type of patient."*

It did not exist. The 2026-09-14 staff-reports plan had ruled PDF out (its D8) — against this very
request — and never built the hospital-by-department view. This lane builds it.

## Owner rulings (2026-09-19)

- **"New" means new to the HOSPITAL, not to the department.** `opd_encounters.visit_type` is the fee
  branch and is per-department, so the report derives its own "New".
- **Who may pull it:** `front_office_supervisor`, `medical_superintendent`, `owner` — one new
  permission, `opd.reports.read`. It carries patient names (the owner asked for them).

## DECIDED (not money, procurement or law — standard answers, taken and recorded)

| # | Decision |
|---|---|
| D1 | **New** = no consultation *completed* on any earlier day, in any department, across the patient's merge family (both directions). A visit left unseen does not make somebody an old patient. Two departments on a patient's first day are both New. |
| D2 | **Revisit** = not New and `visit_type = 'revisit'` (the free follow-up). **Renewal** = not New and a fresh fee was due: the window lapsed, *or an existing patient's first visit to this department*. Three buckets were asked for; an existing patient paying a fresh fee is the renewal of their card. Printed as a footnote on every sheet. |
| D3 | **Booked** = appointments whose slot is on the day and stood (`booked`, `checked_in`, `no_show`); cancelled, rescheduled-away and needs-rebooking are not. Counted on the day they are FOR, unlike the desk brief (the day they were MADE). |
| D4 | **Consulted** = `status = 'completed'` on the day — the desk brief's own predicate. Open visits are reported as "still open" and the sheet says the day is not over, rather than a mid-day export passing for the close. |
| D5 | The laboratory walk-in "department" (`LAB`) is not a consultation and is left out. Every active department is listed (a zero is information); an inactive one only if it carried visits. |
| D6 | **PDF = the browser's Save-as-PDF** of a self-contained letterhead sheet the server renders — the owner's 2026-09-06 ruling, and the production image has no browser to make PDFs with. The window opens inside the click so a pop-up blocker cannot refuse it silently. |
| D7 | A department's patient list writes `day_report.patients_listed` (reader, day, department, format, row count) before the rows leave. Confidential patients are aliased against the READER's clearance and their address is withheld with the name. The hospital summary is integers and is not logged. |
| D8 | CSV cells of typed free text that a spreadsheet would run as a formula (`= + - @`) get a leading apostrophe. |
| D9 | The dashboard carries the report whole (figures + both downloads, Today/Yesterday/any day); the department-wise screen is `/reports/opd-day`. |

## Not done here

- No new index: `opd_encounters` has none on `service_date` alone, so the day query scans. At this
  hospital's volume that is milliseconds; measure before adding one (migrations are one per PR).
- No scheduled/e-mailed report. Asked for as a download; a nightly mail is a separate request.

---

# Periods — owner request 2026-09-20

> *"now that you have got the structure right, let the user download the report of "This Week" (week
> starts on Monday - Saturday) and "This Month" as well along with Today and Yesterday."*

## Owner ruling

- **A week is MONDAY TO SATURDAY.** Sunday is not part of a week.

## DECIDED

| # | Decision |
|---|---|
| D10 | **The server owns the period.** The caller asks for `period=day\|week\|month` on a `date` anchor; `rangeFor` turns that into days and the sheet prints the days it counted. A client that computed `from`/`to` would be a second definition of the week, and the first correction would land in only one of them. |
| D11 | **A period that contains today ends today.** "This week" on a Wednesday covers Monday to Wednesday, and the sheet says so, rather than heading three days of data "Mon–Sat". |
| D12 | **A week's Sunday is named, not dropped.** When the Sunday after a week's Saturday carried consultations, the screen and the sheet say how many and that a week runs Monday to Saturday. Otherwise a weekly total is quietly short of the month and both numbers lose their credit. Weeks only: a month covers its own Sundays. |
| D13 | **"This month" is the 1st to today** (month-to-date), not the whole calendar month. |
| D14 | **Over more than one day the patient list carries a Date column**; over a single day it would be a column of one repeated value. The CSV always carries it — a spreadsheet is data, not a page. |
| D15 | **The routes are `/opd/reports/consultations…`**, renamed from `…/day` on the day periods arrived. One day old, one consumer, and a route called `day` that serves a month is a lie a future reader has to discover. |

## Not done here

- No custom "from/to" range picker. Four named periods and a single-day picker cover what was asked;
  an arbitrary range is a different control and a different conversation.
- The month sheet for a department is long by construction (one row per consultation). Nothing is
  truncated — a register that silently stopped at N rows would be worse than a long PDF.
