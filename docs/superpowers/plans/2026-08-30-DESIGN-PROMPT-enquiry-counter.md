# DESIGN PROMPT — Enquiry Counter dashboard, in depth

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis`.

---

## What we are doing

Designing the **Enquiry Counter dashboard** — one seat, properly, before any code is written.
This is the first of a seat-by-seat pass over every staff dashboard. Do not build the app. Do not
touch `apps/`. The output is a design canvas.

Load the `design` skill first. Make a **new canvas for this seat** — one canvas per seat, because
there will be a dozen of them and one giant canvas becomes unnavigable. Name it for the seat.

## Read this before designing anything

Two canvases already exist from the OPD flow work. Their **working files are HTML you can open and
lift exact values out of** — do that rather than re-deriving anything.

| | |
|---|---|
| v1 — the whole OPD flow, 14 artboards. **The current Enquiry console is here** | `docs/design/2026-08-29-opd-counter-flow/` · https://claude.ai/code/artifact/77df960d-83e1-40a7-b2d7-3dc2780cb6f1 |
| v2 — paper, Hindi, edge cases, speed, 16 artboards | `docs/design/2026-08-29-opd-counter-flow-v2/` · https://claude.ai/code/artifact/1d57ce0c-d9e3-42a8-83fe-5a15014bb1fa |

Read at minimum: `…-opd-counter-flow/EnquiryConsole.dc.html` (what exists today),
`…-v2/DevanagariSpec.dc.html` (the Hindi rules), and `apps/web/src/styles.css`.

## The design system — settled, do not re-open

Stock shadcn **new-york / neutral**. Greyscale on purpose. Resolved hexes, matching `styles.css`:

`#ffffff` bg · `#0a0a0a` fg · `#171717` primary · `#fafafa` primary-fg · `#f5f5f5` muted ·
`#737373` muted-fg · `#e5e5e5` border · `#a1a1a1` ring

Four state colours and **a hue means a state, never decoration**:
`--state-waiting #cb882e` · `--state-danger #e7000b` · `--state-settled #318f5a` · `--state-live #218cb5`

Radius `10px` (cards `14px`, buttons/inputs `8px`). Controls `h-9` = 36px, small 32, large 40.
Font: `ui-sans-serif, system-ui` — the app declares none, so this is what actually renders.

## The owner's rulings so far — carry these, do not relitigate

**Screens vs paper.** English leads on every staff screen. Hindi leads on anything a patient holds.

**Hindi, when it appears.** `line-height: 1.55` on every Devanagari run · never below 11 pt on a
203 dpi head · **Western digits always**, in their own span · never machine-transliterate a patient's
name, capture it or print Latin only · label columns sized by content, never by pixels.

**Paper, all settled.** 80 mm roll / 72 mm printable (272 px) for slips and receipts, same printer
for both · barcode under the address, no QR on the slip · patient block is exactly Patient, Age/Sex,
UHID, Encounter ID, Date · UNPAID is an **outlined box** — never a round stamp, never a filled black
band · three bold zones per slip, values 600 against labels 400, because **no grey survives a
monochrome print** · dot matrix and 2-part carbon for pharmacy · 4 × 6 labels dropped entirely ·
dates read `29-Aug-2026`.

**Flow.** Three counter sequences exist and the front desk switches between them: queue-first,
bill-first, and single-window (register + pay + token at one desk). Flow 3 is the likely choice.

**Method.** When something is genuinely open, pick the most defensible Indian-corporate-hospital
answer, mark it DECIDED with one line of reasoning, and keep moving. Stop only for money,
procurement or law.

## What is known about this seat

Ekta Gandhi, main lobby. **Read everything, write almost nothing** — the only two writes are raising
a grievance and notifying administration. The existing artboard covers: doctor availability with a
two-week leave calendar, bed availability by ward, UHID lookup by mobile number, and a "send them to
Counter 1 or Counter 3" handoff.

Three facts from the codebase:

- **There is no enquiry role.** `OPD_ROLE_KEYS` in `apps/core/src/modules/opd/config.ts` has
  `front_office`, titled "Front Office (registration / OPD desk)" — one role covering seats that
  should be separate. A read-everywhere / write-two-things seat does not exist yet.
- **Doctor schedules and leaves are built.** See `opdAdmin.tabs.schedules` in `apps/web/src/locales/en.json`.
  The availability answers are real data, not a mock.
- **Bed availability is not built.** There is no IPD bed module surfacing counts. Design it as if the
  data existed and flag it as a dependency — do not pretend it is there.

Confidential patients must show an alias and nothing more, to this seat above all others.

## What the existing artboard does not yet answer

Work these through. Most are more interesting than the happy path already drawn:

- **She is answering the phone as well as the counter.** Is the hotline this seat? A queue of people
  in front of her and a ringing phone is the actual job.
- **"How long will I have to wait?"** — the single commonest question, and the one the current design
  answers worst.
- **She cannot answer.** What is the escalation, and how does the patient not get bounced?
- **The doctor has just been called to Emergency.** She is the first person asked. What does she see,
  and how fast?
- **An attender asking about an admitted relative.** That is IPD and it is PHI — where is the line?
- **She speaks Bhojpuri, the screen is English, the patient reads neither well.** What does she point at?
- **Wayfinding.** "Where is Radiology?" is an enquiry-desk question and there is no floor plan anywhere.
- **What she must never say** — a diagnosis, a test result, whether someone is admitted at all. The
  screen should make the wrong thing hard, not just leave it uncollected.
- **The grievance she raises is the hospital's only unsolicited feedback channel.** It deserves more
  than a button.

## How the owner works

They open the published canvas and edit it directly — moving elements, changing weights, deleting
things. You will get an `artifact-changed` notification. **Re-read and extract before you republish**,
or you will clobber their work. Sync, tell them plainly what changed and whether you agree, and only
republish when they have asked for something.

Expect strong, specific, correct feedback about physical reality — printers, ink, paper cost, what a
clerk will actually do. When they push back on a design call, they are usually right about the
constraint; check whether they are also right about the fix before agreeing.

## Start here

Read the two canvases and `styles.css`, then come back with what you think the Enquiry seat is
actually for and where the current artboard is wrong — **before** you draw anything. Ask the one or
two questions that would change the design. Then build the canvas.
