# Card reconcile board: notes (draft for approval, 28-Sep-2026)

Screen: `/counter/reconcile`, `apps/web/src/screens/instrument-reconcile.tsx`, permission `membership.reconcile.operate`.
Server: `apps/core/src/modules/membership/import/match-queue.ts` (`listMatchQueue`, `listLapsedRestores`, `resolveMatch`, `dismissMatch`); client `apps/web/src/lib/membership-api.ts`.

Layout: header menu (Recognise a card · Enrol · Reconcile · Cards · Imports), card holder in hand on the left (296), a numbered compare → choose → link flow in the centre with a pinned bar, one queue sorted oldest first on the right (352) with NEW CARD / CAP OVER / LAPSED RESTORE chips, and "Clocks running" collapsed. Below 1280 the queue becomes a drawer; below 1100 the menu becomes a Menu button.

## What changes and why
- **Candidates showed only name, UHID and "match 0.87".** Each patient sits beside the card field by field (name, age/DOB, sex, masked mobile, district, last visit), each marked agrees / differs / not on card, with an "n of 4" count.
- **Strength was a raw score.** It is now a word (Strong / Possible / Weak), worked out from the fields that agree. DECIDED: this overrides the code comment's "show the number, not a band" rule. The band never pre-selects, and the fields sit beside it.
- **Weak and strong matches had the same black button, placed raggedly.** You choose with a radio on each column, and nothing is pre-selected. One green act sits in a pinned bar and names the card and the UHID it will link.
- **A weak link cost one click.** Choosing Weak shows what differs, requires a "how do you know" reason plus a tick that the link is permanent and carries the clerk's name. The reason goes into the existing `note` on resolve.
- **Dismiss sat under Link with no reason asked up front.** It is now "None of these…", kept apart from Link, with preset reasons plus a line of text. It says the card stays unlinked and still works by its number.
- **Lapsed restores showed the raw key "consult-visits" and no date.** They join the one queue (LAPSED RESTORE chip). In hand they show the benefit in words, when it was given back, when the card ended, and the bill number.
- **The page was one stacked column.** It is now the house station layout.

## Needs server
1. Candidate details in the queue response: DOB/age, sex, masked mobile, district, last visit. Only `patientName`, `uhid`, `score` and `why` are sent today. This must still go through the same `visiblePatientIds` gate.
2. Holder side on the wire: `holderPhone` (stored on `membership_instances`, not returned, send it masked), partner name, valid from/to, and the card's members with relation (the importer has them, but `members` is not returned per item).
3. Holder DOB and sex: **not in the holder-book column map at all** (`column-maps.ts` fields: name, phone, card, plan, validity, members). They would need a new field in the column map and a new column. See question 2.
4. Match band (Strong/Possible/Weak) computed on the server from agreeing fields, so that web and any other client agree. Suggested: Strong = name close and DOB + mobile agree; Weak = name loose or sex/DOB differ; otherwise Possible.
5. A weak link needs a server rule: resolve refuses a Weak candidate unless it has a non-empty note. The client check alone is not enough.
6. Dismiss reason as a code (different people / not registered yet / partner file wrong / other) beside the free note. Today it is free text only.
7. Lapsed restore: a benefit title in place of `benefitKey`, the printed bill number in place of `invoiceId`, the card's end date and who gave it back. Also a "Mark checked" act, because there is no acknowledge route and nothing on the screen can clear a lapsed flag today.
8. Queue count and oldest age for the header pill and the clocks (these can be derived on the client from `at`).

## Questions for the owner
1. **A benefit given back on a card that has already ended: does the member keep it?** The system gives it back today and only raises a flag. Options: honour it until renewal / cancel it / honour it only if renewed within 30 days. (Money.)
2. **Should partners be required to send DOB and sex in the holder file?** Without them the card side only has name and mobile, so most matches can only reach Possible. (Partner agreement / procurement.)
