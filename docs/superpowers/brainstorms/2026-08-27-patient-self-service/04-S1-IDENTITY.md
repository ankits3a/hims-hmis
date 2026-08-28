# S1 · Identity & household — segment deep-dive
**Date:** 2026-08-28 · **Status:** working document, not approved
**Plan:** kernel-P + 22c-T1 · **Parent:** `03-JOURNEY-SEGMENTS.md` §2

---

## 1. Scope

S1 answers one question in five channels: **who is this person, and do we already know them?**

It ends when a patient row exists with an assurance stamp, optionally linked to one or more
households. It does **not** cover identity *amendment* after the fact (that is
`00-RECORD-AND-PLAN.md` §2.1 and rulings R-01…R-07), and it does not cover merging
duplicates (Plan 05, shipped, approval-gated).

**The exit contract.** A patient row, findable by **phone · UHID · QR · name+DOB**, from
every channel, forever.

---

## 2. What each channel may do

The capability split *is* the design. Everything self-service cannot do must have a counter
path, and everything the counter does must be reachable when the app is down.

| Capability | `SELF` | `KIOSK` | `CNTR` | `CALL` | Why |
|---|:--:|:--:|:--:|:--:|---|
| Verify a phone by OTP | ✅ | ✅ | ✅ | ✅ | |
| Create a registration draft | ✅ | ✅ | ✅ | ✅ | |
| Complete a registration at `self_declared` | ✅ | ✅ | ✅ | ⚠️ | `CALL` cannot see the person; draft only, no completion |
| See **same-phone** duplicate candidates | ✅ | ✅ | ✅ | ✅ | The caller controls the number we already hold |
| See **cross-phone** duplicate candidates | ❌ | ❌ | ✅ | ❌ | **§4.3 — the non-disclosure rule** |
| Register a patient with **no phone** | ❌ | ❌ | ✅ | ❌ | D-34 designed path |
| Sight an ID → `id_verified` | ❌ | ❌ | ✅ | ❌ | Requires a human looking at a document |
| Set `isConfidential` / `alias` | ❌ | ❌ | ✅ | ❌ | §7.4 — and its absence is a live hazard |
| Set `sensitiveContext` | ❌ | ❌ | ✅ | ❌ | Sealed channel, D-31 |
| Register a **minor** | ❌ | ❌ | ✅ | ❌ | DPDP §9 verifiable guardian consent |
| Register unknown / unconscious | ❌ | ❌ | ✅ | ❌ | Identity *assignment*, never self-service |
| Link an adult to a household | request | request | ✅ | request | Needs that adult's own OTP consent |
| Unlink **silently** (abuse case) | ❌ | ❌ | ✅ | ❌ | S1-abuse; never notifies |
| Split a member onto their own number | ❌ | ❌ | ✅ | ❌ | Needs verification |
| Merge duplicates | ❌ | ❌ | ✅ | ❌ | Plan 05, approval-gated |

> **Counter-only capabilities are a feature, not a gap.** Nine of them. Each one is a case
> where a human looking at a person is the control, and no amount of app polish substitutes.

---

## 3. The registration draft

**No patient row until registration completes.** A half-patient in the master is worse than
no patient: it pollutes search, dedup, and every count the hospital reports.

```
registration_drafts
  id, phone_verified, phone,          -- the key; a draft is owned by a verified number
  payload jsonb,                      -- partial input, whatever has been entered
  channel, started_by,                -- 'self'|'kiosk'|'counter'|'call'; actor if staff
  gate_state,                         -- 'collecting'|'dedup_review'|'blocked_minor'|'blocked_no_phone'
  blocked_reason,
  state,                              -- 'open'|'completed'|'expired'|'abandoned'
  patient_id,                         -- set on completion
  created_at, expires_at, completed_at
```

| Rule | |
|---|---|
| **TTL** | 24 hours. Long enough to walk to the hospital, short enough not to accumulate |
| **Resumable in any channel** | A clerk opens it by phone. This is the S1-02 fix and it is the whole reason drafts exist |
| **Never searchable as a patient** | A draft is not in the patient master and cannot be booked against |
| **One open draft per phone** | A second attempt resumes the first |
| **Blocked drafts persist** | A minor's blocked attempt stays visible so the counter knows why they walked over |

States: `open → completed` · `open → expired` (TTL) · `open → abandoned` (explicit).

---

## 4. The dedup gate — the heart of S1

Everything else in this segment is data entry. This is where duplicate UHIDs are created or
prevented, and a duplicate is an identity break with no audit trail.

### 4.1 Signals

Deterministic rules, not inference (series design law 6: inference only for text drafting
and non-rule ranking).

| Signal | Strength | Notes |
|---|---|---|
| Verified phone == `phone` or `altPhone` | **strong** | But a household shares one number — strong for *the household*, not for *the person* |
| `abhaNumber` exact | **strong** | Nationally unique when present |
| Government ID last-4 + type | **strong** | Only ever captured at a counter |
| DOB exact, both non-estimated | moderate | |
| DOB year only, or either `dobEstimated` | weak | The common case: an age was entered, not a date |
| Name exact after normalisation | moderate | Case, spacing, honorifics, initials stripped |
| Name phonetic match (Indic-aware) | weak | Kavita / Kavitha / कविता must collide |
| Pincode match | weak | |
| `legacyUhid` typed by the patient | **strong** | The paper-era cross-reference already exists |

**Sex is not a gate.** A mismatch lowers the score but never eliminates a candidate — the
one case where it legitimately differs is a gender-marker amendment, which is precisely a
patient we must not fail to match (ties to R-05, splitting administrative gender from
clinical sex).

### 4.2 Bands

| Band | Trigger | Behaviour |
|---|---|---|
| **Same-phone match** | Verified phone matches a record, **and** (name phonetic **or** DOB) agrees | **Offer it:** *"We already have a record for Kavita P. (U12345013). Is this you?"* On confirm, link — **no new UHID**. Assurance is unchanged; confirming from a phone proves nothing new |
| **Cross-phone strong match** | Strong signals but the phone differs | **Never disclosed to a self-service caller.** Create the new record, emit `patient.duplicate_suspected` with the candidate, queue it for MRD |
| **Weak / none** | — | Create new |

### 4.3 The non-disclosure rule

> **Self-service must never reveal the existence of a record it cannot prove belongs to the
> caller.**

Telling an anonymous phone *"a Kavita Prasad born 3 May 1975 already exists here"* is a
disclosure — that she is our patient at all is health information. So a cross-phone match
produces a **silent duplicate flag**, not a prompt.

At a counter the rule inverts, because **the patient is standing there and the clerk can
ask.** The clerk sees cross-phone candidates and resolves them face to face.

> **The dedup gate shows more to a clerk with the patient present than to an anonymous
> phone.** This is the correct privacy boundary and most systems get it wrong in one
> direction or the other — either leaking existence to a stranger, or minting duplicates at
> the counter because the clerk was shown nothing.

### 4.4 Self-service never merges

A patient confirming *"yes, that's me"* is an identity claim by an unverified actor. Even in
the same-phone band, we **link to** an existing record; we never merge two records. Merging
stays where it already is: Plan 05, approval-gated, snapshotted, unmergeable.

Duplicates created despite all of this are resolved by the existing merge machinery, fed by
`patient.duplicate_suspected` and the nightly sweep (doc 20's Duplicate Sentinel).

---

## 5. The assurance ladder

```
0  self_declared   the patient typed it; OTP verified the phone and nothing else
1  staff_verified  a staff member saw the patient and confirmed the details
2  id_verified     a staff member sighted a government ID; type + last-4 recorded
3  abha_verified   ABDM asserted the demographics
```

| Rule | |
|---|---|
| Upgrades only | Never downward except by §5.1 |
| Staff actors only | Except the initial `self_declared` at creation |
| Every transition is evented | `patient.assurance_upgraded` with the evidence class |
| Gating | Anything with legal or financial weight beyond a consult fee — a claim, a certificate, an admission, an MLC — requires ≥ `staff_verified` |
| ABHA fields | At `abha_verified`, ABDM-asserted fields are **locally read-only**; correction happens at ABDM and is pulled, or they silently desync (S1-19) |

### 5.1 Amending a Class I field above `self_declared`

If a clerk changes name, DOB or sex on an `id_verified` record without new evidence, the
stamp is no longer true for that field.

> **Recommendation (ruling S1-R3):** amending a Class I field requires evidence of at least
> the record's current level, **or the record drops to `staff_verified`.** Honest, cheap,
> and it makes the stamp mean something.

---

## 6. Households

### 6.1 Many-to-many, and why

A married woman appears on her husband's phone and her father's. Model it one-to-many and
the second household is forced to create a duplicate UHID. This is `01-MEDANTA-TEARDOWN.md`
B6 and it is the un-retrofittable one in this segment.

```
households
  id, primary_phone, status, created_at

household_members
  household_id, patient_id,
  relationship,        -- self|spouse|father|mother|son|daughter|sibling|guardian|other
  access_class,        -- 'dependent' | 'adult_consented' | 'adult_pending'
  consent_actor,       -- who consented (the patient themselves, for adults)
  consent_at, consent_channel,
  revoked_at, revoked_by, revoke_silent boolean,
  added_by, added_at
  PRIMARY KEY (household_id, patient_id)
```

### 6.2 Access classes

| Class | Who | Access | Ends |
|---|---|---|---|
| `dependent` | A minor under a guardian, or an adult under documented legal guardianship | Full | **Automatically at 18** for minors (`MAJORITY_AGE_YEARS`, already modelled in `patientGuardians`); by document expiry for legal guardianship |
| `adult_consented` | An adult who OTP-consented to this household seeing their records | Full, revocable by them | On their revocation, effective on the next request |
| `adult_pending` | Invited, not yet consented | **None.** The name is not even shown | On consent or expiry |

**Default for any adult is `adult_pending`.** The obvious build — link anyone, show
everything — makes a wife's gynaecology history readable by whoever holds the phone.

### 6.3 Rules

1. **A household never owns a patient.** Unlinking removes a row in `household_members`; it
   never touches `patients`.
2. **`relationship` is descriptive; `access_class` is authoritative.** Medanta's Self/Others
   confusion (teardown D4) comes from conflating the two.
3. There is no "account holder person" — **the account is the phone.** The greeting shows
   the *active viewing profile*, never an owner.
4. Adult consent is revocable by the adult, from their own session, at any time.
5. **Silent revocation exists** for the abuse case: `revoke_silent` suppresses every
   notification, and only a counter can set it.
6. A member cap (default 8) with a counter-raisable override — a genuine joint family must
   not be punished by a control aimed at touts.

---

## 7. Edge cases, expanded

Each row carries the assertion a test must make. Extends `03-JOURNEY-SEGMENTS.md` §2.

### 7.1 Drafts and abandonment

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S1-01 | Abandoned at step 3 of 5 | Draft persists, no patient row | `select count(*) from patients` unchanged; one open draft on the phone |
| S1-02 | Abandoned, then walks to a counter | Clerk finds the draft by phone, completes it | Completion produces **one** patient; the draft moves to `completed` |
| S1-25 | Two devices open the same draft | Last write wins on `payload`; completion is idempotent | Two completions → one patient, second returns the first |
| S1-26 | Draft expires while the patient is in the queue at the counter | Expired drafts are still readable for 7 days and re-openable | Clerk can resume an expired draft; it does not vanish |
| S1-27 | Kiosk draft, next patient walks up | Hard clear on idle and on print | No `payload` survives a session end |

### 7.2 Dedup

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S1-04 | Counter-registered patient self-registers | Same-phone band → offered, linked | **No second UHID minted** |
| S1-05 | Registered under a relative's phone; own phone now | Cross-phone → **not disclosed**; new record + duplicate flag | Response is byte-identical to a no-match; `patient.duplicate_suspected` appended |
| S1-07 | Patient and relative register at two kiosks at once | Dedup runs **at insert** under the same ordered lock discipline the ledger uses | Concurrent inserts → one patient or two-with-flag, never two silently |
| S1-08 | Kiosk then counter, seconds apart | The clerk's screen surfaces the seconds-old record before writing | Candidate list includes records created < 60 s ago |
| S1-28 | Name in Devanagari vs Latin | Phonetic match crosses scripts | `कविता प्रसाद` matches `Kavita Prasad` as a candidate |
| S1-29 | Patient typed their old (re-minted) UHID | `legacyUhid` resolves | Old identifier finds the current record |
| S1-30 | The candidate is a **merged loser** | Chain resolves to canonical | Candidate list shows the canonical record only |
| S1-31 | The candidate is `isConfidential` | Not shown to self-service at all; at a counter, only with `patients.confidential.read` | An unprivileged clerk sees a no-match, not a hidden row |
| S1-32 | The candidate is deceased | Never offered as "is this you" | Deceased records are excluded from self-service candidates |
| S1-33 | Gender marker was amended; sex differs | Candidate survives on other signals | Sex mismatch alone never eliminates |

### 7.3 Assurance

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S1-03 | Self-registered patient reaches a counter | Clerk sights ID, upgrades; patient does not re-tell everything | Upgrade is one action; `patient.assurance_upgraded` carries the evidence class |
| S1-19 | ABHA-verified patient self-registers | ABDM fields locally read-only | A PATCH to an ABDM-asserted field on an `abha_verified` record is refused |
| S1-34 | Class I amendment on an `id_verified` record without evidence | Drops to `staff_verified` | Assurance after the amendment is 1, and the drop is evented |
| S1-35 | A `self_declared` patient tries to book something legally weighted | Refused with the upgrade path named | A certificate request at assurance 0 is refused, not silently allowed |

### 7.4 Privacy and the confidential hazard

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| **S1-21** | **A nurse self-registers as a patient** | She cannot set `isConfidential` from a public surface, so she lands **visible to her colleagues**. Needs a **confidential request** flow: a self-service flag that creates a counter task and applies a provisional alias immediately | A self-registered record flagged confidential is aliased from creation, before any staff action |
| S1-36 | A patient asks for a nickname in the app | Refused. One name, amended properly; an alias is a privacy control, not a preference | No display-name field exists on the patient row |
| S1-37 | Household member is `sensitiveContext` | Excluded from the household view entirely, and the absence is invisible | No count, no placeholder, no "hidden" label |
| S1-38 | A tout's number already carries 30 patients | Cap fires at 8; the implausibility flag (no shared surname, address or age structure) raises a task | The 9th link is refused with a counter path |

### 7.5 Households

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S1-15 | Two spouses self-register independently from one phone | One household, two members | Second registration joins the existing household |
| S1-16 | A patient in two households changes address | Service address is household-scoped; identity address is patient-scoped | Editing a service address leaves `patients.addressLine` untouched |
| S1-17 | A household member dies | `deceasedAt` — unbookable, unmessageable, records still reachable | Booking refused; the notification gateway hard-stops; records list still renders |
| S1-39 | A minor turns 18 overnight | Falls out of the guardian's view that day | Access at 18y+1d is denied without any job having run |
| S1-40 | Adult invited but never consents | `adult_pending` — their **name is not shown** | The inviter sees "invitation pending", never the patient's details |
| S1-41 | Adult revokes consent | Effective on the next request, not the next login | The very next read is denied |
| S1-42 | Silent unlink for abuse | No notification, no trace on the other party's device | Zero events reach the notification gateway |
| S1-43 | Legal guardianship of an adult (dementia) | Not the majority rule — a documented, counter-verified override with an explicit scope and expiry | Access ends at the document's expiry without intervention |

### 7.6 Channel and degradation

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S1-06 | Kiosk printer fails after the record is created | UHID on screen + SMS + findable at any counter by phone | A patient is never left with a record they cannot prove |
| S1-11 | Illiterate patient at a kiosk | Fails to a **specific** destination: "please go to counter 4" | No dead end, no half-flow |
| S1-12 | Patient has no phone | Counter mints a UHID with no phone (D-34) | Registration succeeds with `phone IS NULL`; the app is simply unavailable |
| S1-13 | A 15-year-old self-registers | Age gate → counter, and the blocked draft stays visible | Counter sees `blocked_minor` with the attempt |
| S1-14 | Unconscious patient | Staff-only; later identification is **assignment**, not amendment | The trauma encounter stays attached through identification |
| S1-18 | Outage: paper registration + a live self-registration | Duplicate, caught on backfill | Backfill runs the same dedup gate and flags |
| S1-20 | The UHID SMS never arrives | UHID is on screen and in the app | SMS is never the only delivery of an identifier |
| S1-22 | Self-registers while standing at the counter | Legitimate; the clerk sees it appear | Clerk's search finds it within one refresh |
| S1-44 | The app is down entirely | Every counter capability is unaffected | No counter path imports anything from the app module |

---

## 8. Data model summary

**New:** `registration_drafts` · `households` · `household_members`
**Extended:** `patients.identity_assurance` · `patients.identity_version_id`
**Reused unchanged:** `patientGuardians` (majority transition, authority scopes) ·
`patientMergeRequests` (approval-gated merge) · `patients.isConfidential` / `alias` /
`sensitiveContext` / `deceasedAt` / `legacyUhid`

**Events:** `registration.draft_started` · `draft_completed` · `draft_expired` ·
`patient.registered` *(exists)* · `patient.assurance_upgraded` ·
`patient.duplicate_suspected` · `household.created` · `household.member_linked` ·
`member_unlinked` · `consent_requested` · `consent_granted` · `consent_revoked`

**Permissions:** `patients.register` *(exists)* · `patients.assurance.upgrade` *(new,
staff)* · `patients.confidential.write` *(new — splitting `isConfidential` off
`patients.update`, ruling R-06)* · `households.manage` *(new)*

---

## 9. Rulings this segment needs

| # | Question | Recommendation |
|---|---|---|
| **S1-R1** | Does a same-phone match auto-link on confirm, or need staff review? | **Auto-link on confirm.** The caller controls the number we already hold. Requiring staff review here sends everyone to the counter and defeats the purpose |
| **S1-R2** | Household member cap | **8**, counter-raisable. Aimed at touts, must not punish a joint family |
| **S1-R3** | Class I amendment above `self_declared` without evidence | **Drops to `staff_verified`.** Honest, and it makes the stamp mean something |
| **S1-R4** | May a self-service caller request confidential status? | **Yes — and the alias applies immediately, provisionally**, before any staff action. Otherwise S1-21 exposes staff-as-patients on day one |
| **S1-R5** | Draft TTL and readable-after-expiry window | **24 h live, readable 7 days** |
| **S1-R6** | Can `CALL` complete a registration, or only draft one? | **Draft only.** A voice on a phone is not identity verification |

---

## 10. Build order within S1

1. `registration_drafts` + the resume-in-any-channel path *(unblocks S1-01/02, the most
   common real behaviour)*
2. The dedup gate + bands + the non-disclosure rule *(the whole point of the segment)*
3. `identity_assurance` + upgrade path *(cheap, and everything downstream gates on it)*
4. Households, many-to-many, with `adult_pending` as the default *(B6 — un-retrofittable)*
5. Consent, revocation, silent revocation
6. The confidential-request path *(S1-21 — a live hazard the moment self-registration opens)*

**Do not ship self-registration before 2, 4 and 6.** Without 2 it mints duplicates; without
4 it forces them; without 6 it exposes staff-as-patients.
