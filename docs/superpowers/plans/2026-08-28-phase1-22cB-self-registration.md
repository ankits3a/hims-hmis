# Plan 22c-B — Self-registration: OTP, drafts, the dedup gate, households

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** One ruling was taken at write time and is recorded where it bites: **the name matcher is not built, it is composed** (DD5, RULED — `patientFuzzyCondition` and `TRIGRAM_THRESHOLD` already ship, index-backed and measured). Every other decision was locked before this document existed, in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md).

**Roadmap:** Track C · the second of M1's three slices (`22c-A` → **`22c-B`** → `22c-C`). **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §6 (the patient master), §14 (confidential/VIP), §11.1 (registration entry lanes). **Brainstorm:** [`../brainstorms/2026-08-27-patient-self-service/04-S1-IDENTITY.md`](../brainstorms/2026-08-27-patient-self-service/04-S1-IDENTITY.md) — the segment, its 44 cases and its capability matrix; `06-RULINGS-LOCKED.md` §1 for every decision. **This plan argues from those and does not restate them.**

**Slot: hard-gated on 22c-A.** There is no `patient` actor until 22c-A lands, and every route in this phase is one. Do not start it early; there is nothing to start.

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 (lines 1132–1146) — then execute, on the build host, task by task. **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed on every tool call (v3 §9.1).** Entries that bite here: §2.101, §2.115, §2.120/§2.121.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT, at the top of the range.** Eight tasks — v3 §2's guide — one migration, no workflow definition, no approval band. It is not a module build: it extends `patients` and adds two small tables beside it.

**What makes it not a small phase is that five of the eight tasks are privacy or credential seams.** A defect in T2 is an authentication hole; a defect in T5 discloses that a stranger is our patient; a defect in T6 shows a woman's records to whoever holds the family phone. The lane sets dispatch, not verification depth (v3 §2) — **five of eight are CRITICAL** and carry executed mutants.

**The main session codes task by task** under AGENT-RULES in full, builds every mutant the inline Assertion Books name, watches CI with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh) by full SHA, and closes with reviewers spawned **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **700,000 tokens**, arithmetic shown

- **Per-task rate — 20,178** (Plan 16a, LIGHT, 9 tasks / 181,605; [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Same known bias as 22c-A: for a LIGHT phase this is a review cost wearing an execution cost's clothes, and main-session cost stays unmeasurable (runbook **O3**).
- **Task term:** `1.5 × (20,178 × 8) = 242,136`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`** (Plan 14 actuals).
- **Total: 700,627 → 700,000.**

Eight tasks price only 4.5% above 22c-A's seven, for the same reason: the review term dominates and does not scale with task count.

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| `04-S1-IDENTITY.md` + `06-RULINGS-LOCKED.md` §1 | ≈ 22,000 | 5,500 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

22c-A built an actor that can exist. This phase gives it a way in, a household to belong to, and a gate that stops it minting a second UHID for a patient we already have.

**It still ships nothing the public can reach.** The routes are built and tested; opening them to the internet is 22c-C's act, with the catalogue. That ordering is deliberate — a registration endpoint live before the dedup gate is proven is how a patient master fills with duplicates in a week.

### 1.1 The three hard gates this phase satisfies

From [`07-IMPLEMENTATION-PLAN.md`](../brainstorms/2026-08-27-patient-self-service/07-IMPLEMENTATION-PLAN.md) §6: *do not open self-registration before the dedup gate (T5), many-to-many households (T6) and the confidential-request path (T7).* **Without the first it mints duplicates; without the second it forces them; without the third it exposes staff-as-patients.** All three land here, which is why they are not spread across two phases.

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | why it matters |
|---|---|---|
| migrations | **36** on disk; 22c-A writes `0036`, so this phase writes **`0037`** | |
| **fuzzy name matching** | **ships.** `patientFuzzyCondition` (`modules/patients/search.ts:186`), `TRIGRAM_THRESHOLD = 0.3`, GIN index from migration 0021 | **DD5 — the matcher is composed, not built** |
| the trigram lesson, already paid for | the code uses `%` **and** `similarity(...)`: `%` is what the GIN index serves, the function form plans as a Seq Scan. Effective bar is `max(GUC, 0.3)`, and a test asserts the GUC | Re-deriving this would cost the four-second desk regression a second time |
| throttle | `auth_throttle(kind, subject)`; kinds today are **`login` | `pin`**; it is **backoff state, not lockout state** — `retry_after` passes on its own | DD4 adds kinds; it does not touch the shipped two |
| throttle's stated purpose | *"an attempt against a username that does not exist is throttled identically to one against a username that does, so the 429 cannot be used to ENUMERATE accounts"* | The same property is what T2 needs for phone numbers |
| notify gateway | `kernel/notify/` — template classes, `audience: patient|staff|owner`, quiet hours, promotional refused outright | Patient-scoped and suppressible ⇒ **DD1** |
| `@Public()` precedent | `auth.controller.ts` login / pin-switch / badge-switch, each throttled | The seam this phase's routes follow |
| patients permissions | after 22c-A: `register`, `read`, `update`, `merge`, `confidential.read`, `confidential.write`, `deceased.write` | T7 consumes `confidential.write` |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | Does `enqueueNotification` require a `patientId`, and does its suppression gauntlet run before or after channel selection? | Decides whether DD1's separate sender reuses the pump or only the adapters |
| **S2** | Which SMS adapter is wired, and can it be invoked outside the pump without breaking the ladder's accounting? | Same |
| **S3** | In production, what is the distribution of patients per distinct phone number? | Validates the household cap of 8 (S1-R2) against reality rather than against a guess |
| **S4** | How many production patients have `phone IS NULL`? | Sizes the D-34 population that this phase can never serve, and that the counter must |
| **S5** | How many production patients share `(normalised name, dob)` with another patient? | The duplicate baseline the gate must beat. Also tells us whether the merge queue is about to be handed more than it can work |
| **S6** | Does any shipped route read `actor.type === "user"` where a `patient` actor would now pass a permission check? | 22c-A's audit should have caught this; confirm before opening any patient-reachable route |

---

## 4. Design decisions

**DD1 — The OTP does not ride the patient notification gateway.** At send time there is **no patient** — only a phone number someone typed. The gateway is patient-scoped and runs a suppression gauntlet (quiet hours, the deceased hard stop, class refusal), and every one of those is wrong for a login code: an OTP at 11 p.m. must send. A separate transactional sender, reusing the same adapters, keeps the security path out of a gauntlet designed for clinical messaging. The corollary is a rule, not a preference: **nothing in the OTP path may consult `patients`.**

**DD2 — A patient session carries the verified phone, not the accessible patient set.** Access is resolved per request by `accessiblePatients(phone)`. This is what makes consent revocation effective on the next *request* rather than the next *login* — the locked ruling (R-09) — and it is why a long-lived token is safe: it grants identity, never scope.

**DD3 — PIN is convenience and never a factor on a new device.** First login from an unseen device is always OTP; PIN becomes available on that device afterwards. The locked ruling says plainly that PIN reset runs through OTP and therefore adds nothing against someone holding the handset — so it must not be allowed to *look* like a second factor.

**DD4 — New throttle kinds, never the shipped keyspaces.** `patient_otp` and `patient_pin` join `login` and `pin`. The schema's own comment says the split exists so a poisoned password counter cannot close the terminal switch a clinician uses mid-shift; the same reasoning forbids a patient-side flood from closing staff login. Throttle by **number** and by **device**, and — per the shipped enumeration property — an unregistered number is throttled identically to a registered one.

**DD5 — RULED: the name matcher is composed, not built.** `patientFuzzyCondition` + `TRIGRAM_THRESHOLD = 0.3` ship, are GIN-indexed, and carry a measured performance lesson. **Do not introduce Soundex, Metaphone or any phonetic library** — they are English-centric and wrong for Indic names, and this project already paid for the alternative. **Transliteration is solved at input, not at match time:** a name entered in Devanagari requires its Latin transliteration in the same form (S1-10), so matching always runs within one script.

**DD6 — The non-disclosure response is byte-identical, and produced on the same code path.** A cross-phone strong match returns exactly what a no-match returns. The `patient.duplicate_suspected` emission happens on the shared path so response latency does not fork — a timing difference is a disclosure too, in a slower and less obvious way.

**DD7 — A self-service confidential request applies its alias at creation.** Format `P-####`, derived deterministically from the patient id — stable, and not derivable from the name. The counter task is raised in the same transaction. **The alias must not wait for staff:** the window between "a nurse registers" and "a clerk acts" is exactly when her colleagues can see her.

**DD8 — One open draft per phone**, via a partial unique index — the house one-active-per-key precedent (`patient_merge_requests_pending_loser_ux`).

**DD9 — Households are joined, not created, when one already exists for the number.** Two spouses self-registering independently from one phone land in one household (S1-15). The household is a property of the number.

---

## 4A. ROUTED TO THE OWNER

**None.** S3 and S5 may return production numbers that argue for changing the household cap (S1-R2) or for sequencing merge capacity before launch — if they do, that is a §6.3 finding routed at close, not a blocker at kickoff.

---

## 5. Tasks

Eight. Five CRITICAL.

### T1 — Migration `0037`: drafts, households, members, patient credentials — **ROUTINE**

`registration_drafts` (payload jsonb, gate_state, blocked_reason, TTL; partial unique index on phone where `state = 'open'` per DD8) · `households` · `household_members` (composite PK, `access_class`, consent columns, `revoke_silent`) · `patient_credentials` (PIN hash, per-device trust) · two `auth_throttle` kinds (data, not schema).

### T2 — Patient OTP: send, verify, session — **CRITICAL**

Send to a **number**, never through the patient gateway (DD1). Verify with reissue-invalidates-predecessor. Session token per DD2.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | A reissued OTP invalidates its predecessor; the older code fails | Keep both valid → two live codes, and the window doubles |
| A2 | A used OTP cannot be replayed | Skip consumption → replay from an intercepted SMS |
| A3 | An unregistered number is throttled and answered identically to a registered one | Branch the response → the endpoint enumerates who is our patient |
| A4 | `patient_otp` throttle failures never touch the `login` keyspace | Share the kind → a patient-side flood closes staff login (the exact failure the shipped split prevents) |
| A5 | The OTP path reads nothing from `patients` (DD1) | Route it through `enqueueNotification` → an 11 p.m. login is suppressed by quiet hours |
| A6 | Code comparison does not short-circuit on the first differing character | Use `===` on the raw string with an early return → a timing oracle on a 6-digit space |

### T3 — PIN: set, verify, reset, and the new-device rule — **CRITICAL**

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A7 | A PIN cannot authenticate on a device that has never completed an OTP (DD3) | Allow it → PIN becomes a standalone credential, which the locked ruling says it is not |
| A8 | `patient_pin` throttle is its own keyspace | Share with `patient_otp` → a wrong PIN closes the OTP path, stranding the patient entirely |
| A9 | PIN reset requires a fresh OTP | Accept the current session → a handset holder rotates the PIN and locks out the owner |
| A10 | PINs are stored hashed with the project's existing password hasher | Store reversibly → a four-digit secret in plaintext, for every patient |

### T4 — Registration drafts, resumable in any channel — **ROUTINE**

Create, resume, complete, expire. **A clerk resumes by phone and completes** — the S1-02 path, and the reason drafts exist. Blocked drafts (`blocked_minor`) persist and are visible at the counter.

*Not CRITICAL, but note the seam:* DD8's partial unique index is the sole arbiter of one-open-draft-per-phone, and a concurrent second attempt must resume rather than fail.

### T5 — The dedup gate — **CRITICAL**

Candidate generation composing the shipped matcher (DD5), the three bands, and the non-disclosure rule (DD6).

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A11 | A same-phone match is offered, and confirming links to the existing record | Skip the band → **a second UHID is minted for a patient we already have**, the worst outcome in the product |
| A12 | A cross-phone strong match returns a response byte-identical to a no-match | Return candidates → the endpoint confirms to a stranger that a named person is our patient |
| A13 | The cross-phone case still emits `patient.duplicate_suspected` | Drop it → the duplicate is invisible to MRD and lives forever |
| A14 | A `isConfidential` candidate is never surfaced to self-service | Include it → the confidential flag is defeated by the registration form |
| A15 | A deceased candidate is never offered as "is this you" | Include it → a bereaved family is asked to confirm they are their dead relative |
| A16 | A merged-loser candidate resolves to its canonical record | Show the loser → the patient links to a frozen record |
| A17 | Confirming a match **links**; it never merges (self-service never merges) | Call the merge path → an unverified actor merges two records outside the approval gate |
| A18 | Sex mismatch alone never eliminates a candidate (R-05, DD4 of 22c-A) | Make it a gate → a patient whose gender marker was amended can never be matched again |

### T6 — Households: many-to-many, access classes, consent, silent revocation — **CRITICAL**

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A19 | One patient can belong to two households (B6) | Unique-constrain `patient_id` → a married woman on her father's phone forces a duplicate UHID |
| A20 | An adult's default `access_class` is `adult_pending`, and their **name is not shown** while pending | Default to consented → whoever holds the phone reads a wife's gynaecology history |
| A21 | Revocation takes effect on the **next request** | Cache the set in the token → revocation waits for a logout that may never come |
| A22 | A dependent's access ends on their 18th birthday with no job having run | Evaluate at link time → a 19-year-old's records stay open to a parent |
| A23 | A `sensitiveContext` patient is absent from the household view, **and the absence is invisible** | Render a count or a placeholder → "1 record hidden" is the disclosure the seal exists to prevent |
| A24 | `revoke_silent` emits nothing to the notify gateway | Send the standard unlink notice → in an abuse case, that message is the harm |
| A25 | Joining a number that already has a household adds a member (DD9) | Create a second household → the family fragments and the cap misfires |
| A26 | The 9th member is refused with a counter path, not a silent failure | Silently drop → a joint family cannot register its youngest |

### T7 — The confidential request path — **CRITICAL**

#### Assertion Book — T7

| # | Assertion | Mutant |
|---|---|---|
| A27 | A self-service confidential request applies the alias **in the creating transaction** (DD7) | Apply on staff approval → the exposure window is the whole point of the task |
| A28 | The alias is not derivable from the name | Derive it from initials → "P-KP" for Kavita Prasad defeats the alias |
| A29 | The counter task is raised in the same transaction | Raise it after commit → a crash leaves a permanently provisional record nobody reviews |
| A30 | Self-service cannot set `sensitiveContext` | Allow it → the sealed channel is settable by anyone with a phone |

### T8 — Routes, the counter surfaces, and the e2e — **ROUTINE**

`@Public()` OTP routes (throttled, following `auth.controller.ts`), patient-actor routes for profile and household, and the **counter** surfaces: resume-a-draft, complete-a-draft, see cross-phone candidates, act on a confidential task. Two e2e: *self-registers → abandons → clerk completes → one patient*; and *cross-phone duplicate → response identical to no-match → flag raised*.

**No route is exposed to the public internet in this phase** (§1).

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6, and whether S3/S5 argue for changing the household cap or sequencing merge capacity
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review
