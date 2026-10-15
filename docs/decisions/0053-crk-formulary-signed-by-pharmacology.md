---
type: decision
id: "0053"
title: "No paid drug database; the hospital builds its own formulary, drafted by AI and signed by the Pharmacology department"
description: "CIMS/MIMS is not licensed; an AI model drafts each medicine's entry from legally usable sources and a named Pharmacology reviewer signs it before anyone sees it."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [formulary, pharmacy, doctor, procurement]
supersedes: ["0052"]
superseded_by: []
sources: []
---
# 0053 — No paid drug database; the hospital builds its own formulary, drafted by AI and signed by the Pharmacology department

- **Date:** 2026-10-07   **Status:** Ruled (partly supersedes 0052: the CIMS quote is dropped)
- **Area:** formulary, pharmacy, doctor, procurement

## The owner's words (2026-10-07)

- He does not want to pay for a drug database.
- On who reviews the hospital's own medicine entries: "yes, Pharmacology department take it on."

## Decision

1. **No CIMS or MIMS licence.** The owner's email to CIMS for a quote (decision 0052) is dropped. CIMS
   stays noted only as a paid option.
2. **The hospital builds its own "CRK formulary".** The Pharmacology department of CRK Medical College
   reviews and signs medicine entries.
3. **The email to the Indian Pharmacopoeia Commission stays**, sent to the address published on
   ipc.gov.in.

## Decided by delegation (how the rulings are applied)

- **Drafting:** an AI model drafts a short structured entry per generic, only from sources we may
  legally use, every statement carrying its source. No source means the field stays empty. The model
  never computes a dose. About 300 medicines first.
- **Signing:** a named Pharmacology reviewer edits and signs (name, designation, date; audited;
  versioned). Re-review in 12 months or when a source changes. High-alert medicines take a second
  signature.
- **Showing:** only signed entries reach doctors, staff and patients, labelled "CRK Medical College
  formulary · reviewed by <name>, <date>". Unsigned drafts are seen only by reviewers.
- **Model-drafted clinical text is allowed only behind a named human signature.** This settles the
  open point in decision 0051 on summarising label text.
- **Model:** a strong model from OpenAI, the owner-approved vendor; public source texts only, no
  patient data; cost measured on the first 20 drafts.
- **PubChem** (US NIH) is added as a source for class, mechanism and description, using its
  public-domain annotations only.
- **Not done:** scraping Apollo, 1mg or Netmeds. 1mg's terms forbid it; Apollo's are unread and are
  the owner's legal call; a signed formulary makes it unnecessary.

## Why

A paid database is outside the budget, and free sources do not cover Indian medicines well or read
plainly on a phone. A medical college has the right reviewers in-house. A model's draft is quick; a
faculty signature is what makes it safe to show.

## Consequences / how to apply

- Plan: `docs/superpowers/plans/2026-10-07-self-improving-suggestions.md` §11a and §11c.
- The reviewed store `formulary_monographs` already exists, empty, with draft → reviewed states; it is
  reused. The owner names the faculty and residents who hold the review permission.
