# Spreadsheet loaders — the shape, and the four defects the first one had

**Written 2026-09-07 by the pharmacy lane, after building `import:item-master` (#144) and then
fixing it (#163).** ROADMAP v2 §2 calls for loaders that "take his files, never invent rows, and run
against production only with his data" — the item master, the lab catalogue, and whatever follows.

**Read this before writing the second one.** `import-item-master.ts` is the working example and it is
the right thing to copy — but it shipped with a defect that its own header warned against, and
copying its shape without this note means inheriting that defect. **The rules below are numbered by
what they cost to learn, not by importance.**

---

## 0. What a loader is, and what it is not

**A loader is an OPERATOR COMMAND, not a seed.** The `import:holder-book` precedent (Plan 09 T5)
states it: a seed is configuration the deployment owns and re-running it changes nothing; a file the
hospital sent on one day is not that, and a deploy that imported one would be importing data nobody
asked it for.

So: **not in `deploy.sh`, not in `SEED_STEP_SCRIPTS`, registered in `package.json` only.** Adding one
therefore costs no census entry and breaks no parity pin — verified for `import:item-master`, which
added neither.

---

## 1. ONE TRANSACTION FOR THE WHOLE FILE — the defect #144 shipped with

**`import-item-master` opened a `withTx` PER ROW.** A failure at row 200 of 400 left rows 1–199
committed — the half-applied master its own header calls "the worst outcome available", produced by
the code that warns about it. Fixed in #163.

The general form, and it is the house's recurring lesson in a new place:

> **A plan is a judgement about a database that can change between planning and applying.** Somebody
> creating a code in that window turns a planned `create` into a duplicate-key throw, and no amount
> of care in the planner closes it. **The guarantee has to come from the transaction, not from the
> plan being right.**

Item masters and catalogues are hundreds of rows, not millions, and a loader runs at commissioning —
the transaction is short-lived and nothing else is writing that table while somebody imports it.

**The test for this has to be chosen, not written the obvious way.** Asserting that apply REJECTS
passes against BOTH versions — the throw happens either way. What discriminates is **the state of an
earlier row afterwards**. Induce the failure the way it would really happen: plan two creates, let
something else take the second code in the window, apply, then assert the FIRST row is absent.

---

## 2. DRY RUN BY DEFAULT, AND THE WHOLE FILE JUDGED BEFORE ANYTHING IS WRITTEN

Two separate properties and both are needed.

**Dry run**: without `--apply` it writes nothing and prints the plan — every row's verdict
(`create` / `update` / `unchanged` / `refuse`) and a summary. The operator sees what will happen to a
production table before it happens.

**Judged first**: every row is planned against the database, and **one bad row refuses the entire
import.** The operator cannot tell which half of a partial import landed, and re-running is not
obviously safe once the first half exists.

**And the judgement is only worth what it knows.** `import-item-master` had `medicine_brand` optional;
`registerItem` REFUSES a drug-class item that names no formulary medicine (DD3 — composition, salts
and the schedule flag live on the medicine and are never copied onto the item). So the import would
have died at APPLY time with a raw `MaterialsError` halfway through a file — **precisely what judging
the whole file first exists to prevent.** Before shipping a planner, read every refusal the write path
can raise and mirror it into the plan.

---

## 3. NEVER INVENT A VALUE — and blanks are the dangerous ones

**A blank cell is BLANK: not zero, not a default, not "sensible".**

The item loader's `gst_rate_bps` is the worked example. A blank leaves the slab null, which
`gstCategoryFor` maps to `pharmacy_exempt`, which bills the patient exactly the printed MRP. **A
loader that helpfully filled a blank with `1200` would make the counter bill 12% ABOVE the printed
MRP on every line it touched**, because pricing adds GST on top of a base that IS the tax-inclusive
MRP. Blanks are **counted and reported on every run**, not filled.

The same rule cuts the other way on an update: **the file saying nothing about a column must leave
that column alone.** Silently blanking a hospital's configured value is the same defect facing the
other direction.

---

## 4. AN UNKNOWN COLUMN IS REFUSED, NOT IGNORED

A file with `gst_rate` where the loader wants `gst_rate_bps` would otherwise import every row with a
blank slab and **report complete success** — the operator's entire tax column silently discarded,
discovered at a counter weeks later.

This is the census-row failure in a new place: **a thing that reads green while being false.** Refuse
the header, name the column, write nothing.

Refuse likewise: a value outside a closed set (a GST figure that is not one of the four medicine
slabs); a file that **contradicts itself** (two rows for one code — which one the operator meant is
theirs to say, and last-wins silently applies whichever sorted later); and an identifier that does not
resolve (a medicine brand with no formulary row — the item would be unlinked, unsellable, and look
entirely normal in a list).

---

## 5. WHAT IS IMMUTABLE MUST BE REFUSED, NOT QUIETLY SKIPPED

`updateItem` will not change an item's `base_uom`, because a strip becoming a tablet reinterprets
every `qty_base` already in the ledger. A loader that applied the rest of the row and skipped that
field would leave the operator believing the file went in as written. **Refuse the row and name both
values** — file and database.

---

## 6. IT MINTS NO CREDENTIALS AND NAMES ITS OPERATOR

`seed-staff` rejected env vars and an on-box file for credentials, so that the owner keeps the only
copy: *"a credential roster left on a box is an artefact nobody remembers to delete."* A loader
inherits that. Take `--actor <name>` as plain text for the provenance columns, exactly as
`import-holder-book` does — `imported_by` is a NAME on a record, never a foreign key, so an operator
can be identified without the script authenticating one.

---

## 7. FOR THE LAB CATALOGUE LOADER SPECIFICALLY — the price column

ROADMAP v2 §2 has this loader carrying test code, name, section, specimen/tube, unit, reference ranges
by age and sex **with source**, critical bands, and price.

**PRICES STAY DEV-PLACEHOLDER-FLAGGED UNTIL O6.** The loader must not let a price look signed when it
is not. That is the census-row failure with money attached: a figure that reads as a CA-approved
tariff while being a guess out of a spreadsheet. `seed-tariff` already carries the pattern —
`DEV PLACEHOLDER — CA sign-off required (§19)` sits beside the rows it writes, and
`gst_settings.ca_signed` is the single boolean that says whether anyone has signed anything.

And a reference range without its **source** is a clinical assertion with no provenance. Treat a blank
source the way §4 treats an unknown column: refuse it, rather than importing a range nobody can
attribute when a pathologist queries it.

---

## The four things `import-item-master` got wrong, in one place

| # | defect | fixed in |
|---|---|---|
| 1 | `withTx` per row — a half-applied master, warned about in its own header | #163 |
| 2 | `medicine_brand` optional, so DD3's refusal surfaced at apply time, not plan time | #144 (during review) |
| 3 | a comment reading "undefined, not null" above a line writing `?? null` — **a comment that disagrees with the line beneath it is the version a reader trusts** | #163 |
| 4 | no provenance: nothing records which file produced which row. `import-holder-book` keeps one and this does not. **Still open** — worth fixing in whichever loader is written next, and backporting. | — |
