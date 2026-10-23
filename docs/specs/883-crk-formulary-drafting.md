---
issue: 883
status: approved
approved: 2026-10-23
---
# SPEC — CRK formulary: fetch public sources and draft the stocked generics (#883)

Status: APPROVED 2026-10-23 (the owner said yes to paid drafting; the first 20 drafts come back with a cost report before
the rest are drafted). Builds on #618's drafter (decision 0053).

## What

Fetchers read public drug-reference texts for a generic's substances. A batch job takes the stocked generics that have
no CRK entry yet and drafts each one through the existing drafter (#618). Every draft is a pending entry that waits for
a Pharmacology signature, and nothing is published by the job. A cost report gives the tokens per draft, the total at the
provider's list price, and a projection for about 300 drafts.

## Decisions

- **Sources and licences (DECIDED):**
  - openFDA drug labels: public domain (CC0). The dosing and overdose sections are not sent.
  - PubChem annotations are kept only from US federal sources: LiverTox and LactMed (US NLM, public domain), MeSH
    pharmacological classes (US NLM) and FDA Pharm Classes (US FDA).
  - Every other PubChem annotation is dropped: DrugBank, ChEMBL, StatPearls, HSDB (its excerpts quote copyrighted
    papers), WHO, HMDB and T3DB.
  - NHS (an API key for a non-UK organisation is unverified, decision 0052), EMA and Medsafe are not fetched yet.
  - Each source carries its own name and licence in its title, so the reviewer sees both.
- **Which generics:** generics with at least one stocked item, in name order. The job drafts 20 per run by default, at
  most 50, and skips a generic that already has an entry.
- **Model:** whatever `FORMULARY_DRAFT_MODEL` names, called with the drafter's key. With no model set, the job stops
  before it fetches anything.

## Done means

- **D1** openFDA: from a label search answer, the single-ingredient prescription label is chosen and becomes one
  `openfda` source. Its title names the licence, its url names the label's set id, and its date is the label's
  effective date. The dosing and overdose text is not in the source. No matching label gives no source.
- **D2** PubChem: only LiverTox, LactMed, MeSH and FDA Pharm Classes text is kept, each as its own source naming the
  original database and its licence. DrugBank, StatPearls, HSDB and ChEMBL text never reaches a source.
- **D3** The job picks only generics with a stocked item and no CRK entry, in name order, up to the limit. The limit is
  20 by default and is capped at 50.
- **D4** Each picked generic is drafted through the #618 drafter, and its tokens are stored on its row. A generic with
  no usable source is reported as `no_source` and the model is not called for it. One failed draft does not stop the
  rest.
- **D5** Nothing is published: after the job every entry is an unsigned draft on the worklist, and the doctor's reader
  returns nothing for it.
- **D6** With no model configured, the job refuses with `model_not_configured` before it fetches anything or writes
  anything.
- **D7** The cost report gives tokens in and out per draft, each draft's cost and the total in US dollars at the given
  per-million prices, and a projection for N drafts at the measured average.
