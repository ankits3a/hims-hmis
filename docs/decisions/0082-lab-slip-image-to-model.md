---
type: decision
id: "0082"
title: "A photographed lab analyser slip may go to Gemini (OpenRouter as fallback) with the patient's name and UHID on it, on paid no-training terms"
description: "For reading lab analyser slips only, the owner allows the slip image to go to the configured model as photographed (name and UHID included) — Gemini on the paid tier, or OpenRouter with data collection denied when no Gemini key is configured, never an Anthropic model — with no masking pass and no other patient field in the request; 0048 and 0064 stay as they are for every other use."
generated: { by: agent:claude, at: 2026-10-21 }
verified: []
status: stable
ruling: ruled
tags: [lab, mobile, ai, privacy]
supersedes: ["0048", "0064"]
superseded_by: []
sources:
  - { id: spec-lab-slip-scan, resource: "docs/specs/934-lab-slip-scan.md", title: "Spec: scan the analyser's printed slip into the quick lab report" }
---
# 0082 — A photographed lab analyser slip may go to Gemini (OpenRouter as fallback) with the patient's name and UHID on it, on paid no-training terms

- **Date:** 2026-10-21   **Status:** Ruled. This partly supersedes 0048's "never the patient's name" and 0064's
  "no patient identifier goes to a model", for lab analyser slips only.
- **Area:** lab (Quick Bench slip scan, #934), phone app, privacy

## Question put to the owner

The lab slip scan (spec #934) photographs the printout of a lab analyser. The slip shows the patient's name and
often the UHID. Two rulings already apply:

- Decision 0048 says the patient's name never goes to an outside model.
- Decision 0064 says no patient identifier goes to a model, except under 0048/0049.

The owner was offered two options:

- **A.** A local pass on our server reads the name and UHID, paints over them, and sends only the painted copy.
- **B.** An owner exception lets the slip go as photographed.

## What is ruled (owner, 2026-10-21: "1B")

1. **Lab analyser slips only.** The image of a lab analyser's printed slip may be sent, as photographed, to read
   the slip's results and header. It may carry the patient's name and UHID.
2. **The provider is Gemini.** OpenRouter is used only when no Gemini key is configured. An Anthropic model is
   never used for this.
3. **Terms:**
   - Gemini only on a paid-tier (billing-enabled) account, never the free tier. Free-tier content may be used to
     improve the provider's products.
   - OpenRouter only with `data_collection: "deny"`, so no endpoint that keeps or trains on the request is used.
4. **Nothing else is sent.** The request carries the image and the analyser's name. No other patient field (phone,
   address, visit, history) is added.
5. **No masking pass.** The local painting-over of option A is not built.

## What this does not change

- 0048 and 0049 stay as they are for voice notes, and 0064 stays as it is for the copilot. For every other use, no
  patient name or identifier goes to a model.
- The slip image is kept inside the hospital's document store under spec #934's retention:
  - with the report it fed, for as long as the report exists;
  - 90 days for discarded or never-attached scans.
- Slip reads count toward 0064's ₹5,000/day AI cap.

## Owed (not ruled here)

- The DPIA revision (0064's R-6) and the patient privacy notice name this use before production reading starts.
- Before reading is switched on in production, issue #934 records that the configured key's account is on paid,
  no-training terms.
- No Gemini or OpenRouter key is configured on any server as of 2026-10-21.
