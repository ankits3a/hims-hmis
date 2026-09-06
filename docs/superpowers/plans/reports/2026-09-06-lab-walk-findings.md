# The central lab, stood up and walked — 2026-09-06

**Private dev stack.** `hmis_lims_dev` on `:5433` (never `:5434`), API on `:3020`, vite on `:5190`,
built from `lane/lims-range-book` so the walk saw my own fixes rather than the defects they close.
Five seats opened in a real Chromium, in English and in Hindi. No production system was touched.

**The headline: it works.** All five seats render, in both languages, onto real synthetic data. The
collection chair shows *"Sunita Devi · 2 tubes"*; the bench shows *"3 arrived, not received · 4 tubes
on this bench"* with live analyte grids; verify and delivery correctly show empty queues. **No raw
i18n keys on any seat.** A specimen went from bench entry → pathologist signature → published report,
and the delivery interlock held the patient's copy for ₹600 exactly as DD6 says it should.

---

## 1. THE ONE NO TEST COULD SEE — the lab is bilingual except where it matters most

With the UI in Hindi (`data-lang=hi`, every nav item, label and *"7 मिनट"* translated), the
absurd-value hard stop still reads:

> **HB 999 g/dL is outside the plausible envelope (1.0000 … 25.0000) — re-check the sample and the
> decimal point, or have a second enterer override it**

**The message is excellent** — it names the analyte, the value, the envelope and both ways out, and
it is written for the person at the bench rather than for a developer. It is also **English only**,
and it is the one text a Hindi-speaking technologist cannot read: the text that stops a wrong number
reaching a patient.

**The defect narrows to a single function signature** (the orchestrator confirmed this against
`pharmacy-api.ts`):

    lab-api.ts:495       export function labErrorText(e: unknown): string
    pharmacy-api.ts:50   export function pharmacyErrorText(e, t: (key: string) => string): string

`labErrorText` was never handed the translator, so it renders the server's English prose directly. It
**predates the pattern rather than omitting it** — and the irony is that pharmacy's own header
documents its vocabulary as following *"`LAB_ERROR_CODES`' shape"*. **Lab defined the convention and
pharmacy built the translation half lab never got.**

The backend needs nothing: `results.ts` already throws `LabError("absurd_value", <prose>, {
analyteCode, absurdLow, absurdHigh })` — a code *and* exactly the parameters a translated template
needs.

**NOT scoped, and deliberately not a lane's call:** whether the Hindi strings are clinically
acceptable. *"Re-check the sample and the decimal point"* is a clinical instruction and a
mistranslated hard stop is worse than an English one. That needs a clinician.

---

## 2. The reception seat asks for a permission its own role does not hold — every 30 seconds

    403 GET /api/lab/collection/queue?serviceDate=2026-09-06

`lab-desk.tsx:117` queries the collection queue unconditionally with `refetchInterval: 30_000`. The
route is gated on `lab.collection.operate`, which only `phlebotomist` holds. So **Abha's reception
screen fires a forbidden request twice a minute, for ever**, and renders *"The portal list could not
be loaded."*

The vocabulary mismatch is the real finding: reception wants to **read** the queue to answer *"has my
order reached?"* — the screen's own copy says so — and the only door is an **operate** grant (drawing
blood). `lab_reception` already holds `lab.worklist.read`.

**Not fixed here.** Widening `lab.collection.operate` to reception would let a clerk draw blood;
splitting the route is a design call. Reported.

---

## 3. Two places where a permission refusal renders as an absence rather than an explanation

**(a) The release register names no tests, for anybody.**

    "orderables": []      on a published report that plainly contains HBSAG

`reports.ts:1336` — *"Test names: ALL OR NOTHING by `orders.read.restricted` (close review pass 1,
F3)"*. **That rule is deliberate and the reasoning is excellent.** And `orders.read.restricted` is
held by **zero roles** — `seed-roles.ts:1359` parks it on purpose: *"a Class-A grant the runbook
hands to the owner … granting it to run a bench would decide, without anyone noticing, that a role
may read every restricted investigation in the building."*

So the control is right, the grant is correctly withheld, and **the consequence nobody had connected
to it is that the release register's test column is blank for every user in the system** — rendering
`Kavita Sharma · ·` rather than saying why.

**(b) The reception seat says *"could not be loaded"* when the truth is *"you may not see this."***

Same shape twice: a refusal presented as a failure. Both are small; both teach a user to ignore a
blank.

---

## 4. A raw zod string reaches the bench

Clicking Save on an empty analyte box shows the technologist:

    value: Too small: expected string to have >=1 characters

A developer string in a clinical UI. Same root cause as §1 — `labErrorText` falls through to a
zod-issue join with no translator and no rewrite.

---

## 5. Standing it up: four preconditions no document names

The runbook's §1–§4 name four acts. **None had a shell entry point**, which is why nobody had ever
opened the five seats. Walking them measured what the paper does not say:

1. **`approveDefinition` refuses `duplicate_approval` on `(definitionId, approverId)` — per PERSON,
   not per role key.** One account holding both `owner` and `medical_superintendent` **cannot** supply
   both keys. Activating `opd_visit` needs two distinct humans, so **owner item O1 is a hard gate on
   this laboratory** — measured by being refused, not inferred from a schema.
2. **`seed:lab-catalogue` needs `SEED_ACTOR_ID`** pointing at a real user holding
   `lab.catalogue.manage`, or it dies with a bare `permission_denied` naming nothing. Undocumented.
3. **`seed:lab-demo` needs an `opd_departments` row with code `LAB`**, which no seed creates.
4. **Every lab service is GST category `investigation`** and `seed:tariff` seeds eight categories
   without it. The first lab bill refuses `gst_config_missing` — reached **after**
   `tariff_item_missing`, which is why a stand-up meets the tariff refusal first and the two get
   confused. **The SAC code and the exemption are a money-and-law question** for the hospital's CA
   and the owner; `seed-tariff.ts` says the same of its own eight rows. A labelled dev placeholder
   only.

Written up as `apps/core/scripts/dev-lab-standup.ts` — idempotent, and refusing production two ways.

---

## What was proved rather than asserted

- **#126 works end to end on a real stack.** The published snapshot carries
  `letterhead: {"name": "CRK MEDICAL COLLEGE & HOSPITAL", …}` and
  `signatory: {"fullName": "Dr Meera Iyer", "registrationNo": "UPMC-45219"}`, with the username kept
  only as the audit handle.
- **11i T1's `seed:lab` really does activate the lab definitions** — the `activateLabDefinitions`
  charge from ROADMAP v2 §0 is closed in code.
- **The delivery interlock holds the right thing**: report published, doctor's screen unheld,
  patient's copy *"HELD · ₹600.00 · print waits for the slip"*.
- **The separation-of-duties controls are real**, not decorative: three of them refused me during a
  stand-up performed with the correct actors.

## Not walked

Settling the invoice to render the printed A4 in the browser. #126's substance is proved by the
stored snapshot above and by 7/7 component tests including the old-snapshot fallback; the remaining
step is the paper itself, and it needs a billing walk this session did not spend the box on.
