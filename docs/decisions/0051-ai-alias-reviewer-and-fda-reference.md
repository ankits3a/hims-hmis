---
type: decision
id: "0051"
title: "An AI reviewer checks medicine aliases; US FDA labels are the first drug-reference layer"
description: "No person reviews learned medicine aliases — a chooser and a second AI model must agree, rules must pass, and use makes them trusted; FDA label text is loaded as labelled reference only, never feeding a dose or a safety check."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [formulary, opd, doctor, copilot, learning]
supersedes: []
superseded_by: []
sources: []
---
# 0051 — An AI reviewer checks medicine aliases; US FDA labels are the first drug-reference layer

- **Date:** 2026-10-07   **Status:** Ruled
- **Area:** formulary, opd, doctor, copilot

## The owner's words (2026-10-07)

- On who adds and approves aliases: "currently no one adds and no one approves. No body has anytime to
  do it and so I am looking this to be automated using advanced AI model."
- On a pharmacist reviewing medicine aliases: "I have no hope from him and so I would ask AI to get in
  this."
- On drug information from the measured FDA coverage, on the terms put to him: "yes add this to the
  plan. also, help me in filling Indian gap separately".

## Decision

1. **No person reviews a learned medicine alias.** An AI reviewer does the check.
2. **US FDA drug labels are loaded as the first layer of drug reference**, as labelled reference text.
3. **The Indian gap is filled separately**, from sources still being evaluated.

## Decided by delegation (how the rulings are applied)

- **Pipeline:** formulary candidates (exact, then trigram) → Jev chooses from that closed set or "none"
  → a second, stronger model answers one closed question (yes / no / unsure, with a fixed reason code)
  → rule checks (one target; a strength in the term equals the target's; never Schedule H1/X or NDPS;
  no look-alike conflict). Only when all agree does an alias appear, and only as a suggestion.
- **Trusted** (ranked first) only by composition-agreeing use by several different doctors
  (decision 0050). The reviewer re-audits monthly and on formulary changes; it can only demote.
- **Before go-live:** a held-out set of at least 200 labelled terms; zero wrong at the confidence line
  is the target; the measured numbers are stated first.
- **No patient data** reaches either model: the term and catalogue rows only. A model never writes
  free text into the product.
- **The owner's weekly list** shows what was learned with a one-tap undo. Nothing waits for a person.
- **FDA text** sits in its own reference layer, not the reviewed monograph store. Every entry reads
  "US FDA label · <product> · <effective date>" and "reference only — the US product may differ in
  strength, dose and approved use". It never feeds a dose or a safety check. Where nothing exists the
  screen says "No reference information yet"; the template bundle is never shown (decision 0050).

## Why

Nobody at the hospital has time to curate vocabulary, and a wrong medicine alias is a patient-safety
risk, so the check cannot be skipped. Two independent models agreeing, hard rules, and doctors' own
confirmed use replace the human step. For drug information the in-house bundle proved to be template
text; the FDA labels are real, public-domain, and cover 79% of the formulary and 91% of stocked items.

## Consequences / how to apply

- openFDA states its content is public domain under CC0 and also "Do not rely on openFDA to make
  decisions regarding medical care". The text is manufacturer-written. Showing it to clinicians as
  labelled reference is this ruling.
- Summarising label text for the phone is a model writing clinical text and needs a separate ruling.
- Plan: `docs/superpowers/plans/2026-10-07-self-improving-suggestions.md` §7a and §11.
