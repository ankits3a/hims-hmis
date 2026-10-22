---
issue: 934
status: built
approved: 2026-10-21
---
# SPEC — Scan the analyser's printed slip into the quick lab report (#934)

Status: BUILT 2026-10-21 (see "As built" at the end for what differs and what is owed). APPROVED 2026-10-21. The owner answered the five open questions: 1B, 2 yes, 3 yes, 4 yes, 5 yes. The answers
are under "Decisions" below, and the privacy ruling is decision 0082.

## What

The bench photographs the slip a lab machine prints (or picks a photo of it from the phone's gallery). The server
reads the slip and fills the matching parameters of that patient's open quick lab report **as a draft**. Lab staff
then check the draft and complete it in Quick Bench as today. Nothing is ever completed, verified or released by
the scan.

The example is a haematology CBC slip. Its header has Name, Gender, Age, Sample ID and Patient ID. Its body has
rows of Para / Result / Unit, with ↑ ↓ marks: `WBC 3.63 10^9/L ↓`, `HGB 10.6 g/dL ↓`, `PLT 127 10^9/L ↓`, plus
analyser codes such as `Lym#`, `Gran%`, `RDW-CV`, `P-LCR`.

**Why:** most analysers on the bench are not interfaced. Today a technician re-types 15–25 numbers per CBC from the
slip into Quick Bench. That is slow and it is where transposed digits come from.

## Scope

**In (v1):**
- Quick lab mode only, the lab's everyday path (decisions 0061/0068; spec 642).
- The phone Quick Bench (spec 630): Scan slip, Fill from slip, and a list of slips waiting for a patient.
- The web `/lab/qbench`: the same highlights, the slip image and the waiting list. The web can resolve a slip but
  cannot upload one.
- Analysers that print a parameter table: haematology first, then others through the same code map.

**Out (v1):** Full lab mode (owner 2026-10-21), upload from the web, printed reports from an outside lab,
handwritten slips, histograms and scatter plots, and offline queueing on the phone.

## Rules (DECIDED; standard practice, open to the owner's objection)

1. **The scan only writes drafts.** It never sets a quick report to `reported`, never writes `lab_results`, never
   opens a critical call and never starts the critical ladder. Quick-mode criticals stay outside the ladder
   (decision 0061). The human's **Save & Complete** is the only way out of draft.
2. **Nothing on the slip is silently dropped.** Every printed row ends up as exactly one of the following, and the
   counts add up:
   - placed in a field;
   - used as a cross-check;
   - ignored by the analyser's setting (shown and counted);
   - shown in the "not placed" panel;
   - ignored by a person, with a reason.
3. **The slip never overwrites what a person typed.** A slip value that differs from a typed value is shown next to
   it and highlighted.
4. **The guards still apply.** The absurd range, the numeric parse and the server-side formula parameters run on
   slip values exactly as on typed ones. A value the guards refuse is not placed. It shows in the panel with the
   reason.
5. **An exact ID or a person decides the patient.** Our sample number or UHID, typed on the analyser, is the
   primary path. Name, age and gender only *suggest*, and staff confirm. This is the same rule as the interface
   inbox (ingest D4: "never attach by guess").
6. **Only the configured provider reads the slip.** Gemini is used when its key is configured, otherwise OpenRouter
   with a non-Anthropic model. There is no switching between vendors at run time. With neither configured,
   reading is off and typing works as today.
7. **The slip image is kept** as the primary record of the values (see "Audit and retention").
8. **Permissions:**
   - Scan, attach, detach and resolve need `lab.results.enter`, the bench's grant.
   - Saving a code mapping or an ignore setting for an analyser needs `lab.instruments.manage`. The code map is
     administrative data (instruments.ts).

## Bench practice (owner 2026-10-21)

Before each run, the technician types **our sample number** (`S…`, stamped at Blood collected) into the analyser's
Patient ID field. Where the sample number is not at hand, they type the patient's **UHID** instead. The slip then
names its report exactly, and matching on name, age and gender becomes the fallback.

When a slip arrives with no ID, the result screen reminds the bench: "Next time, type the sample number S… into the
analyser's Patient ID." Each scan records how it was matched, so the share of exact matches can be seen.

## Phone flow

Entry points, all on the Quick Bench seat (`lab.results.enter`, quick mode only):

1. **Scan slip** (Quick Bench list header). The server finds the report.
2. **Fill from slip** (inside an open report's form). The target report is already known, so matching becomes a
   check.
3. **Slips waiting (n)** (Quick Bench list). These are scans that still need a patient.

Steps:

1. **Capture.**
   - **Camera:** reuses `SlipCamera` (`apps/mobile/src/slips/camera.tsx`) in single-shot mode, with the torch and
     the crop/straighten step (`crop.tsx`, `imaging.native.ts`).
   - **Choose from gallery:** opens the system photo picker for one image (new dependency `expo-image-picker`, set
     up so it requests no photo-library permission).
   - **Gallery photos older than 24 h,** or with no date, show "This photo is from <date>. Is it today's slip?"
     before upload. The date is read from EXIF on the phone and sent as `photoTakenAt`. It is stored and never
     trusted.
2. **Analyser.** A chip row of the lab's analysers that have a code map. The phone remembers the last one, and it
   is pre-chosen when only one exists.
3. **Upload.**
   - The straightened slip is a JPEG within `DOCUMENT_MAX_BYTES` (1.5 MB).
   - The long edge is up to 2400 px, not the prescription page's 1600 px. Slips are long and narrow, and their
     5-pt thermal text needs the pixels. The fixture set decides the final number.
   - The phone deletes its cached photo after upload, as the PDF share does (spec 705).
4. **Reading the slip…** takes up to 30 s, and then one of three outcomes:
   - **Attached:** the patient band (name, age/sex, UHID, sample no.) and "CBC draft · 2 rows need your eyes", with
     an **Open in Quick Bench** button.
   - **Pick the patient:** candidates with reason chips, or **Search patient**, **Keep for later** or **Discard**
     (reason required).
   - **Couldn't read:** "Not a result slip" or "Too blurred". The choices are **Retake** and **Read again**; Read
     again uses the stored image.
5. **No connection:** the upload fails with "No connection — try again". Nothing is queued on the phone.

Owner rules from spec 630 apply: text fits one line at 390 px, Hindi strings are present, and a new APK goes to
staging first.

App config:
- `app.config.ts` currently says "no photo library (no screen picks from the gallery)". That sentence changes.
- The Android build must not gain `READ_MEDIA_IMAGES` or `READ_EXTERNAL_STORAGE`, because the system picker needs
  neither. They are added to `blockedPermissions` if the plugin brings them.

## Server

New controller `lab-slips.controller.ts` under `/lab/slips`. All routes are `LabModeOnly("quick")` and
`lab.results.enter` unless noted.

| Route | Does |
|---|---|
| `POST /lab/slips` | Body `{ image (base64), mimeType, source: camera\|gallery, instrumentId, photoTakenAt?, quickReportId? }`. Stores the image, reads it, maps the rows, matches the report, and answers with the scan view. If the read is not finished in 30 s it answers `reading` and the phone polls the GET. Idempotent: the same bytes (sha256) within 7 days return the existing scan. |
| `GET /lab/slips/:id` | The scan view: header, rows with their mapping and checks, match outcome, candidates. |
| `GET /lab/slips?status=waiting` | Slips waiting for a patient, newest first. |
| `GET /lab/slips/:id/image` | The stored image. One PHI access-log row per read (`recordPhiAccess`). |
| `POST /lab/slips/:id/attach` | `{ quickReportId }`. A person names the report. Refused if the report is `reported` or handed over. |
| `POST /lab/slips/:id/detach` | Only while the report is still a draft. Removes the slip-placed values that nobody edited, and the scan goes back to waiting. |
| `POST /lab/slips/:id/rows/:n` | Resolves a not-placed row: `place` (analyte of this report), `ignore` (reason required), `map` or `ignore_always` (both `lab.instruments.manage`; save the code for this analyser, then re-map). |
| `POST /lab/slips/:id/reread` | Runs the reader again on the stored image (after a failure, or after a mapping change). |
| `POST /lab/slips/:id/discard` | `{ reason }`, required. The row is kept. |

**Timing.**
- The read runs inside the POST request, up to `LAB_SLIP_TIMEOUT_MS`.
- A scan left in `reading` for more than 2 min (for example after a server restart) is marked `failed` by the lab
  sweep and offers **Read again**.

**Bad replies.** A reply that fails the schema is retried once. After that the scan is `failed`
(`unreadable_reply`).

## Reading the slip: provider, prompt, schema

**Provider choice.** The provider is chosen at boot from configuration.
- A readable `HMIS_GEMINI_KEY_FILE` means Gemini.
- Otherwise, a readable `HMIS_OPENROUTER_KEY_FILE` means OpenRouter.
- Otherwise reading is off: `POST` answers `slip_reading_off` and the phone hides Scan.

The model is a pinned version, never a `-latest` alias, following the config's own rule for TRIAGE and COPILOT
models. The default is chosen by the eval (D13).

**What is sent (decision 0082):**
- the slip image as photographed (name and UHID included), plus the analyser's name;
- no other patient field (phone, visit, address, history) is ever added to the request.

**Gemini.** `POST https://generativelanguage.googleapis.com/v1beta/models/<LAB_SLIP_GEMINI_MODEL>:generateContent`.
- The key must belong to a paid-tier (billing-enabled) project, never the free tier (decision 0082).
- Header: `x-goog-api-key`. The key is read from the file on use, never from the environment.
- `systemInstruction` carries the prompt below.
- `contents` carries one `inlineData` part (`image/jpeg`) and one text part: `Analyser: <instrument name>. Return the
  JSON.`
- `generationConfig`: `{ temperature: 0, responseMimeType: "application/json", responseJsonSchema: <schema> }`. If
  the pinned model only accepts the older `responseSchema` subset, the build translates the schema to it
  (`nullable: true`). A contract test locks the request shape.

**OpenRouter.** `POST https://openrouter.ai/api/v1/chat/completions`, OpenAI-shaped.
- It extends `kernel/inference/openai-compatible.ts` with image content parts: `{ type: "image_url", image_url: {
  url: "data:image/jpeg;base64,…" } }`.
- `response_format: { type: "json_schema", json_schema: { name: "lab_slip", strict: true, schema } }`.
- `provider: { data_collection: "deny", require_parameters: true }`, so only endpoints that do not keep or train on
  the request are used (decision 0082).
- Boot refuses a `LAB_SLIP_OPENROUTER_MODEL` that starts with `anthropic/`. The intended model is a Gemini model
  served through OpenRouter, so the same prompt and eval apply.

**Prompt** (`lab-slip-v1`; the version is stored on each scan):

```text
You transcribe a photographed printout from a hospital laboratory analyser.
Copy what is printed. Do not interpret, correct, convert, round or calculate anything.

HEADER
Copy Name, Patient ID, Sample ID, Gender and Age exactly as printed. Use null for a field that is blank or absent.
Never guess a field that is not printed.

RESULTS
Return one entry per printed result row, top to bottom, in printed order.
- code: the parameter name exactly as printed, keeping case and the characters # % - (e.g. "Lym#", "Gran%",
  "RDW-CV", "P-LCR"). "Lym#" and "Lym%" are different rows.
- value: the characters of the result exactly as printed (e.g. "3.63", "127", "----"). Never add or drop digits.
- unit: as printed, or null.
- flag: "H" when ↑ or H is printed beside the value, "L" when ↓ or L is printed, otherwise null.
- legible: "clear" when every character of code and value is certain; "unsure" when any character could be
  another (1/7, 3/8, 5/6, 0/8, a faint or missing decimal point); "unreadable" when the value cannot be read
  (then value is null).
Never add a row that is not printed. Never move a value to another row.
Skip histograms, scatter plots, logos, signatures and footer text.

If the image is not an analyser result printout, set slipKind to "not_a_result_slip" and return no rows.
Return only JSON that matches the schema.
```

**Schema** (JSON Schema; mirrored by a zod schema in `packages/contracts` that validates every reply):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["slipKind", "analyserText", "header", "rows"],
  "properties": {
    "slipKind": { "enum": ["analyser_result", "not_a_result_slip"] },
    "analyserText": { "type": ["string", "null"], "description": "Model or brand line as printed" },
    "header": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "patientId", "sampleId", "gender", "age", "printedAt"],
      "properties": {
        "name": { "type": ["string", "null"] },
        "patientId": { "type": ["string", "null"], "description": "As printed; our sample no. or UHID when the bench typed one" },
        "sampleId": { "type": ["string", "null"] },
        "gender": { "type": ["string", "null"], "description": "As printed: M, F, Male, Female…" },
        "age": { "type": ["string", "null"], "description": "As printed with its unit: 34Y, 8 M, 20 D" },
        "printedAt": { "type": ["string", "null"], "description": "Date/time as printed" }
      }
    },
    "rows": {
      "type": "array",
      "maxItems": 60,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["code", "value", "unit", "flag", "legible"],
        "properties": {
          "code": { "type": "string" },
          "value": { "type": ["string", "null"] },
          "unit": { "type": ["string", "null"] },
          "flag": { "enum": ["H", "L", null] },
          "legible": { "enum": ["clear", "unsure", "unreadable"] }
        }
      }
    }
  }
}
```

## Turning slip rows into report fields

**The alias table already exists.** `lab_instrument_codes` (`instrumentId, instrumentCode → analyteId, unit,
factor`) is per analyser, never global. That is exactly what slips need:
- `GLU` means two different things on two different machines.
- On this hospital's catalogue, **slip `PCT` (plateletcrit) is not our `PCT` (Procalcitonin)**. A global
  name-based table would put a haematology number into a sepsis marker.

A slip-only analyser is registered like any other (`registerInstrument`, mode `typed_id`, no interface link), and
its codes are mapped on the existing instruments screen or from the slip's "not placed" panel.

**Ignored codes.** These are slip-only, so the interface ingest is untouched. A new small table
`lab_slip_ignored_codes` (`instrumentId, code, reason, setBy, setAt`) lists codes an analyser prints that the report
does not carry. A row with such a code is resolved as **"ignored by analyser setting"**:
- It is shown in a collapsed, counted list on the bench and needs no action.
- It is never printed.
- It is never mixed up with a row that is merely unmapped.

**Lookup.**
1. The ignore list first.
2. Then an exact match on the code as the model returned it.
3. Then a slip key on both sides: upper case, spaces removed, `‐ – —` → `-`, `µ`/`μ` → `U`, `O` → `0` only
   inside digit runs.
4. `#`, `%` and `-` stay significant: `Lym#` ≠ `Lym%`, and `RDW-CV` ≠ `RDW-SD`.
5. Two stored codes with the same slip key make the row **unmapped (ambiguous)**. The lookup never picks one.

**Units.** Units are normalised before comparing: superscripts → `^`, `×`/`x`/`*10` → `10^`, `uL` = `µL`, case.
- A slip unit equal to the mapping's unit: `value × factor`, placed.
- A slip unit that differs, for example `HGB` printed in `g/L` where the mapping says `g/dL`: **not placed**,
  panel reason "unit differs". It is never converted on a guess.
- An absent slip unit: placed, with a `no_unit` check.

**Formula parameters.** `ANC`, `LYMPH_ABS`, `GRAN_ABS`, `MID_ABS` and similar are computed by the server and cannot
be typed (saveQuickResults, DD3). A slip row mapped to one is never written. It becomes a **cross-check** on the
computed line ("slip says 1.21"), highlighted when it differs by more than 5% or 0.05, whichever is larger.

**The 3-part differential (owner 2026-10-21).** Four analytes join the standard catalogue and the CBC test:

| Code | Name | Type | Unit |
|---|---|---|---|
| `GRAN` | Granulocytes % | numeric | % |
| `GRAN_ABS` | Granulocytes, absolute | formula `WBC * GRAN / 100` | 10^3/µL |
| `MID` | Mid cells % | numeric | % |
| `MID_ABS` | Mid cells, absolute | formula `WBC * MID / 100` | 10^3/µL |

- This follows the existing `LYMPH`/`LYMPH_ABS` pattern.
- Their reference ranges are entered by the lab head from the analyser's insert, through the range book; none are
  invented here.
- A CBC from a 3-part slip fills `GRAN`/`MID` and leaves `NEUT`/`MONO`/`EOS`/`BASO` empty; a 5-part slip does the
  reverse.
- An empty parameter is not printed.
- `Gran` never fills `NEUT`.

**Map for a 3-part haematology analyser** (seeded as a suggestion; the lab head confirms each row):

| Slip code | Meaning | Our analyte | Slip unit → ours | Factor | Note |
|---|---|---|---|---|---|
| WBC | white cells | `WBC` | 10^9/L → 10^3/µL | 1 | same number |
| Lym% | lymphocytes % | `LYMPH` | % | 1 | |
| Lym# | lymphocytes abs | `LYMPH_ABS` | 10^9/L → 10^3/µL | 1 | formula: cross-check only |
| Gran% | granulocytes % | `GRAN` | % | 1 | |
| Gran# | granulocytes abs | `GRAN_ABS` | 10^9/L → 10^3/µL | 1 | formula: cross-check only |
| Mid% | mid cells % | `MID` | % | 1 | |
| Mid# | mid cells abs | `MID_ABS` | 10^9/L → 10^3/µL | 1 | formula: cross-check only |
| RBC | red cells | `RBC` | 10^12/L → 10^6/µL | 1 | same number |
| HGB | haemoglobin | `HB` | g/dL | 1 | g/L would need factor 0.1 on its own mapping |
| HCT | haematocrit | `HCT` | % | 1 | |
| MCV / MCH / MCHC | indices | `MCV` / `MCH` / `MCHC` | fL / pg / g/dL | 1 | |
| RDW-CV | | `RDW` | % | 1 | our `RDW` is RDW-CV |
| RDW-SD | | `RDW_SD` | fL | 1 | |
| PLT | platelets | `PLT` | 10^9/L → 10^3/µL | 1 | |
| MPV | | `MPV` | fL | 1 | |
| PDW, PCT, P-LCR, P-LCC | platelet indices | ignored by analyser setting | | | owner 2026-10-21; **never** `PCT` = Procalcitonin |

A 5-part analyser maps `NEU%`/`NEU#`, `MON%`, `EOS%`, `BAS%` to `NEUT`, `MONO`, `EOS`, `BASO` and their `_ABS`
formula lines in the same way.

**Checks.** Each check is deterministic and runs on the server. Every check highlights a row; no check ever drops
one.

| Check | Fires when |
|---|---|
| `unsure_read` | the model marked the row `unsure` |
| `no_value` | `unreadable`, or a printed `----`/`***` |
| `no_unit` | mapped row with no printed unit |
| `flag_differs` | the machine's ↑ and our range's flag point opposite ways (↑ vs L, ↓ vs H). A machine ↑/↓ against our `N` is shown as a chip only |
| `index_mismatch` | MCHC vs HGB/HCT×100 off by > 1.0 g/dL; MCV vs HCT/RBC×10 off by > 2 fL; MCH vs HGB/RBC×10 off by > 1 pg; the differential %s (3-part or 5-part) not summing to 100 ± 1.5; `#` vs WBC×`%`/100 off by > 5%. These catch most digit misreads |
| `duplicate_row` | the same code twice on one slip |
| `typed_differs` | a person already typed a different value in this report |
| `slip_replaced` | an earlier slip on this report had placed a different value (a rerun) |
| `rows_missing` | a code that this analyser's slips normally carry is absent (banner, not per row) |

The tolerances above are starting values, tuned on the fixture set at build.

Not placed, shown in the panel with the reason: `unmapped`, `ambiguous_code`, `unit_differs`, `not_numeric`,
`not_possible` (absurd range), `not_in_this_report` (mapped to an analyte none of the report's tests carry).

## Finding the report

**1. Exact ID: the primary path** (bench practice, owner 2026-10-21). The ID is the Patient ID field, normalised
(upper case; spaces, `-` and `/` removed), else the Sample ID field.
- **Our sample number:** if it equals an open quick report's `sampleNo`, that one report is the target
  (`matchKind = sample_no`).
- **UHID:** if it equals a patient's UHID, that patient is the target. Merged patients resolve to the survivor
  (`listMergedLoserIds`). Then step 3 finds the report (`matchKind = uhid`).
- **A machine counter:** a short digits-only Sample ID is the analyser's own counter. It is never compared with
  UHIDs or sample numbers, so `0023` cannot hit the end of a UHID.

**2. Agreement.** The printed gender and age, when present, must agree with the target patient:
- gender equal;
- age within ±1 year of the patient's age at collection (months or days for infants, using `ageInDaysIst`).

A printed name that is neither same nor close (step 4's test) also counts as disagreement. Any disagreement means
no automatic attach. Staff confirm, with the differing chip shown.

**3. Open report for a UHID.** These are the patient's quick reports that meet all of the following:
- `waiting` or `draft`;
- not handed over;
- collected since 00:00 IST yesterday;
- one of their tests carries at least one analyte mapped from this slip.

The outcome depends on how many there are:
- **One:** attach as a draft.
- **None:** "No open CBC for this patient". The slip waits; the counter can start one, then the slip is attached.
- **Several:** staff pick among them.

**4. Fallback: name, age and gender.** This applies when the slip carries no usable ID. Every open report as defined
in step 3, for any patient, is a candidate. Each candidate shows reason chips, never a percentage (the patient
search's design ruling):
- **Name:** same / close / differs / unread. To compare, both names are lower-cased with honorifics (mr, mrs, ms,
  smt, shri, sri, kumari, master, baby, b/o, s/o, d/o, w/o, dr), punctuation and digits removed.
  - *same* means the token sets are equal.
  - *close* means trigram similarity ≥ 0.6 (pg_trgm, already used by the patient search), or every slip token is
    an in-order prefix or initial of the patient's tokens. This handles thermal printers that cut names at 12–16
    characters.
- **Age:** same / ±1 / differs / unread.
- **Gender:** same / differs / unread.
- **Time:** "collected before the slip printed" when `printedAt` reads.

Candidates are ordered by chip strength, and at most 8 are shown, with **Search patient** (the desk finder) under
them. One candidate is pre-selected only when it alone has name same-or-close, same age and same gender, and no
other candidate has two of the three. **Staff always tap Confirm** (`matchKind = staff_pick`).

**5. Fill from slip** (the report is already chosen). The slip attaches to that report (`matchKind = from_report`).
If the slip's ID points to another report or patient, or the name, gender or age differ, the phone asks "This slip
says <differences>. Is it this patient's slip?" Staff must answer Yes, and the answer is recorded on the scan.

## Draft storage and the bench

**Attach** is one transaction holding the quick report's row lock:
1. Refuse if the report is `reported` or handed over.
2. For each placeable value: if a person typed a value for that analyte, keep theirs and add `typed_differs`.
   Otherwise write the value.
3. Status `waiting` becomes `draft`. Ranges and flags are resolved by the same code as `saveQuickResults` with
   `complete: false`; values the guards would refuse were already moved to the panel.

Drafts are invisible to doctors: `quickReportsForPatient` returns reported reports only.

**Line marker.** `QuickLine` (jsonb, no migration) gains an optional `slip: { scanId, row, checks: string[],
checkedBy?: string }`.

**The bench (web `/lab/qbench` and phone Quick Bench):**
- Slip-placed fields carry a small "slip" tag. A field with an open check is amber and says why in plain words,
  for example:
  - "Unsure reading"
  - "Machine says ↑, our range says low"
  - "Doesn't add up with HGB and HCT"
  - "You typed 10.6, the slip says 16.0"
- Editing the field, or tapping **Checked**, clears the check and records who.
- **From the slip, not placed** panel: one line per unplaced row with its raw code, value and unit and the reason.
  The actions are **Place in…**, **Map for this analyser** (lab head), **Always ignore on this analyser** (lab head)
  and **Ignore** (reason).
- **Ignored by analyser setting (n)**: a collapsed list of the rows the analyser's ignore list resolved.
- **View slip** opens the stored image with zoom, beside the form.
- **Save draft** is never refused.
- **Save & Complete** is refused with `slip_checks_open` while any slip check is open or any slip row is unresolved.
  That refusal is what turns "never silently dropped" into a guarantee.

## Audit and retention

- **Image:**
  - Stored once in the kernel `DocumentStore` under `YYYY/MM/<scanId>.jpg`, with its sha256 and size.
  - Reachable from the scan and from the quick report it fed ("View slip").
  - Every view writes a PHI access row.
- **Model reply:** kept verbatim (`raw_reply`), with provider, model, prompt version, latency and token counts.
  A mapping change re-maps from the stored reply without calling the model again.
- **Events:**
  - `lab.slip_scanned` (scanId, source, instrumentId, provider, model, promptVersion, row/mapped/check counts, ms)
  - `lab.slip_read_failed` (scanId, reason)
  - `lab.slip_attached` (scanId, quickId, `matchKind`: `sample_no | uhid | staff_pick | from_report`)
  - `lab.slip_detached`
  - `lab.slip_row_resolved` (`place | map | ignore | ignore_always`, with the reason)
  - `lab.slip_discarded` (reason)

  Payloads carry ids and counts only, never a name or a value, like `lab.quick_reported`.
- **A discard is a record, not a delete** (the inbox's rule). The database enforces that `discarded` ⇔ a reason
  and who.
- **Retention (owner 2026-10-21):**
  - An attached scan's image is kept for as long as the report it fed. It is the primary raw record of the values.
  - The image of a scan that was discarded, or never attached, is purged after 90 days by the lab sweep:
    `DocumentStore.remove`, with `image_purged_at` set.
  - The row, the model's reply and the events stay.

## Privacy (decision 0082)

The slip shows the patient's name and often the UHID. Decisions 0048 and 0064 keep names and identifiers away from
outside models. Decision 0082 makes one exception, for this use only: **the analyser slip image may go to the
configured provider as photographed.** The conditions are:
- **Gemini API on the paid tier only** (a billing-enabled project), never the free tier, whose content may be used
  to improve Google's products.
- **OpenRouter only with `data_collection: "deny"`,** and never an Anthropic model.
- **The request carries the image and the analyser's name.** No other patient field is added.
- **No copy is kept outside the hospital by our side.** The phone keeps no copy after upload. The image lives in
  the DocumentStore under the retention above.

There is no local masking pass (owner 2026-10-21).

## Configuration (names only; all optional)

| Name | Meaning |
|---|---|
| `HMIS_GEMINI_KEY_FILE` | Path of the Gemini API key file (paid-tier project). Read on use, like `HMIS_OPENAI_KEY_FILE`. |
| `HMIS_OPENROUTER_KEY_FILE` | Path of the OpenRouter key file. Used only when the Gemini key is absent. |
| `LAB_SLIP_GEMINI_MODEL` | Pinned Gemini model version. |
| `LAB_SLIP_OPENROUTER_MODEL` | Pinned OpenRouter model id. Refused at boot if it starts with `anthropic/`. |
| `LAB_SLIP_TIMEOUT_MS` | Default 30000. |

With no key, the feature is off, the worker says so once at boot, and nothing else changes. No key is wired on any
server yet (2026-10-21).

## Data model

One migration, holding two tables.

**`lab_slip_scans`:**
- `id`
- `status` (`reading | read | failed | waiting | attached | discarded`)
- `storage_key`, `mime_type`, `byte_size`, `sha256`, `image_purged_at`
- `source` (`camera | gallery`), `photo_taken_at` (theirs, never trusted)
- `captured_by`, `captured_at`
- `instrument_id` → `lab_instruments`
- `provider`, `model`, `prompt_version`, `latency_ms`, `tokens_in`, `tokens_out`
- `raw_reply` (jsonb, verbatim)
- `identity` (jsonb: name, patientId, sampleId, gender, age, as read)
- `rows` (jsonb: position, code, value, unit, machineFlag, legible, analyteId, placement, checks, resolution)
- `quick_report_id` → `lab_quick_reports`, `match_kind`, `matched_by`, `matched_at`, `confirm_note`
- `discard_reason`, `discarded_by`, `discarded_at`
- `error`
- Indexes: (`status`, `captured_at`) and (`sha256`).

CHECKs:
- attached ⇔ report + who;
- discarded ⇔ reason + who;
- the `match_kind` vocabulary.

**`lab_slip_ignored_codes`:** (`instrument_id`, `code`) primary key, `reason` not blank, `set_by`, `set_at`.

The four new analytes (`GRAN`, `GRAN_ABS`, `MID`, `MID_ABS`) and their place in the CBC test are catalogue data
(`scripts/data/lab-catalogue-standard.ts`). They reach the live catalogue the way catalogue changes do today, not
through the migration.

Spend: tokens and model are recorded on every scan. Slip reads count toward decision 0064's ₹5,000/day AI cap.
At the cap, reading pauses until midnight IST and the bench types as today.

## Reuse

- `apps/mobile/src/slips/*`: camera, crop, flatten.
- `kernel/documents/store.ts`: image bytes.
- `lab/instruments.ts` (`lab_instrument_codes`, `mapInstrumentCode`): the per-analyser code map.
- `lab/quick.ts` (`saveQuickResults`, `resolveRange`, `flagFor`, the formula lines): draft values.
- `lab/inbox.ts`: the name-or-discard pattern.
- `lab/ranges.ts` `ageInDaysIst`: age compare.
- `patients/search.ts`: pg_trgm and reason chips.
- `kernel/inference/openai-compatible.ts`: the OpenRouter shape.
- `kernel/phi/audit.ts`: image reads.

## Done means

- **D1** A slip whose Patient ID holds an open quick report's sample number, with agreeing gender and age. Uploading
  it (provider stubbed) leaves exactly that report `draft`, with the mapped values in its lines and their ranges
  and flags resolved. It is never `reported`. No `lab_results` row and no critical call exist afterwards.
- **D2** A slip whose Patient ID is a UHID: the patient's single open quick CBC becomes `draft`. With two open
  reports, nothing is attached and staff pick between them.
- **D3** A slip with a blank Patient ID and a machine-counter Sample ID attaches to nothing. Its view lists the open
  quick reports of the window as candidates, each with name, age and gender chips; reported and handed-over
  reports never appear. A report gets the slip only through `POST /lab/slips/:id/attach` by a `lab.results.enter`
  holder. A digits-only counter `0023` never matches a UHID or sample number.
- **D4** A sample number or UHID that matches, but whose printed name, gender or age disagrees, is not attached
  automatically. The view shows the differing chip and waits for a person.
- **D5** On a slip with an unmapped code and an `unsure` HGB, the bench read (`GET /lab/quick/reports/:id`, web and
  phone) shows HGB with its check and the unmapped row in "not placed". Save & Complete answers
  `slip_checks_open` until HGB is checked and the row is placed or ignored with a reason. Afterwards placed +
  cross-check + ignored-by-setting + ignored rows equal the slip's row count.
- **D6** The code map is per analyser. `Lym#` and `Lym%` map to different analytes. An `HGB` printed in `g/L`
  against a `g/dL` mapping is not placed and shows "unit differs". Two stored codes with the same slip key leave
  the row "ambiguous".
- **D7** A 3-part slip's report prints Granulocytes %/# and Mid cells %/# and no empty Neutrophils, Monocytes,
  Eosinophils or Basophils rows. The slip's `Lym#`, `Gran#` and `Mid#` are never written; each shows "slip says …"
  when it differs from the computed line beyond tolerance. `PDW`, `PCT`, `P-LCR` and `P-LCC` appear under "Ignored
  by analyser setting", are counted, are never printed, and `PCT` never reaches Procalcitonin.
- **D8** A slip value never replaces a value a person typed: the typed value stays and `typed_differs` is open. A
  slip cannot attach to a `reported` or handed-over report. Detach on a draft removes only the unedited
  slip-placed values.
- **D9** Provider choice:
  - with the Gemini key file present, the Gemini endpoint is called;
  - with only the OpenRouter key file, OpenRouter is called with `data_collection: "deny"`;
  - with neither, `POST /lab/slips` answers `slip_reading_off` and quick entry still works;
  - a model id starting with `anthropic/` fails boot;
  - no request ever goes to an Anthropic host (asserted on the outbound URL);
  - the request body carries the image and the analyser name, and no other patient field.
- **D10** The image is stored once: the same bytes uploaded twice return the same scan. "View slip" works from the
  quick report, and each view writes a PHI access row. The `lab.slip_*` events carry no name and no result value.
  A discard without a reason is refused, and the discarded row stays.
- **D11** On a fixture clock, a discarded or never-attached scan's image is removed from the DocumentStore at 90
  days and `image_purged_at` is set; its row and events stay. An attached scan's image is still readable at 91
  days.
- **D12** Phone:
  - Scan slip shows only for `lab.results.enter` in quick mode, and opens the camera or the gallery picker.
  - Uploads are ≤ 1.5 MB, and the cached photo is gone after upload.
  - Fill from slip on another patient's report asks for an explicit Yes.
  - Text fits at 390 px and Hindi strings are present.
  - Phone tests and typecheck pass, and the merged Android manifest has no `READ_MEDIA_IMAGES` or
    `READ_EXTERNAL_STORAGE`.
  - A new APK goes to staging first, then production after the owner's OK.
- **D13** `node dist/scripts/lab-slip-eval.js` runs the configured model over the repo's **synthetic** slip set and
  prints value-level and code-level accuracy, plus the share of wrong values that carried a check. The synthetic
  slips are printed with made-up names; no patient slip enters the repo. Production reading is switched on only
  when all of these hold:
  - exact values are ≥ 98% on clear photos;
  - every wrong value in the set carried a check;
  - #934 records that the configured key is on a paid-tier, no-training account.

  Like spec 595 D5, the production run is owed after deploy.

## Decisions (owner, 2026-10-21)

1. **Privacy — option B.** The slip image, name and UHID included, may go to Gemini, or to OpenRouter as the
   fallback, as photographed. This holds for this use only, on paid-tier / no-training terms, and there is no
   masking pass. Recorded as decision 0082, which amends 0048 and 0064 for this use only.
2. **Quick lab mode only for v1.** Full mode is out of scope.
3. **3-part differential.** Granulocytes %/# and Mid cells %/# become their own parameters. The platelet indices
   (PDW, plateletcrit, P-LCR, P-LCC) are ignored by analyser setting.
4. **Bench practice.** Staff type our sample number (`S…`) or the UHID into the analyser's Patient ID field. That
   is the primary match path; name + age + gender is the fallback, and staff always confirm it.
5. **Retention.** An attached slip image is kept with the report. Unattached or discarded scans are kept 90 days.

## As built (2026-10-21)

All done-means ids have locked acceptance tests: D1–D11 and D13 in
`apps/core/src/modules/lab/acceptance/slip-scan-934.test.ts`, D12 in
`apps/mobile/__tests__/acceptance/lab-slip-scan.test.tsx`.

**Owed after merge** (not tests):
- **D12:** the new APK goes to staging first, then production after the owner's OK.
- **D13:** the production eval run. `node dist/scripts/lab-slip-eval.js` (with `HMIS_EVAL_NETWORK=1`) runs once a
  paid-tier key is configured, and #934 records that the key is paid-tier and no-training. Reading stays off until
  then. `--render <dir>` writes the synthetic slips as PNGs to print and photograph. A photo saved as `<id>.jpg`
  beside its truth file is then used instead of the render.
- No server wires `HMIS_GEMINI_KEY_FILE` / `HMIS_OPENROUTER_KEY_FILE` yet (`docker/prod`, as the OpenAI key is). With
  no key, reading is off and the API logs that once at boot.
- **Web `/lab/qbench`:** the slip highlights, the waiting list and View slip are a follow-up (owner 2026-10-21). The
  API they need is built.

**Where the build differs from the text above:**
- **Data model.** `lab_slip_scans` gains `read_started_at`, so the sweep's two minutes run from the latest Read
  again, not from capture. It also gains `requested_report_id`, the report Fill from slip was started from. Migration
  `0224_lab_slip_scans`.
- **Reply schema.** The zod mirror lives in `modules/lab/slip-reader.ts`, not `packages/contracts`, because only the
  server parses a reply.
- **OpenRouter.** The request is built in `slip-reader.ts` in the shape of `kernel/inference/openai-compatible.ts`
  (`stream: false`, `temperature: 0`, plus the image part). The kernel client is text-only and is not extended.
- **Upload size.** The API's JSON body limit is 1 MB and the image travels as base64, so the phone flattens a slip
  to at most 720 kB at 2400 px. The server's refusal stays at 1.5 MB.
- **`GET /lab/slips/setup`** (added) says whether reading is on and which analysers have a code map. The phone hides
  Scan slip when reading is off or no analyser is mapped.
- **Checked** is `POST /lab/slips/:id/rows/:n` with `{ action: "checked" }`.
- **Not placed:** a row printed with no value is not placed with reason `no_value`, and carries the `no_value`
  check.
- **Cross-check:** a computed line that differs from the slip's `#` carries the open check `cross_check_differs`
  ("slip says …"), so it must be checked before Save & Complete.
- **PHI log.** A slip image read is logged under the existing `lab.quick_reports` surface. An image of a scan not yet
  attached is logged against `slip:<scanId>`, because no patient is known yet.
- **The lab sweep** runs inside the existing `sweepLabSla` job, so no new worker job is added.
- **Spend cap.** A slip read is refused at decision 0064's daily cap (copilot spend plus slip spend, ₹ estimates in
  `slip-reader.ts`). The copilot's own gate does not yet count slip spend (`kernel/copilot`). That is owed.
- **Name matching** uses pg_trgm's trigram similarity, computed in TypeScript (`slip-match.ts`).
- **The phone** has Scan slip, Fill from slip, Slips waiting, the slip tag with plain-word checks and Checked, the
  not-placed panel with Ignore (reason), the ignored-by-setting count and View slip. Place in…, the lab head's Map
  and Always ignore, and Search patient are on the API for the web follow-up.
- **Default models** are `gemini-2.5-flash` and `google/gemini-2.5-flash`. Both are pinned. The D13 run confirms or
  replaces them.

