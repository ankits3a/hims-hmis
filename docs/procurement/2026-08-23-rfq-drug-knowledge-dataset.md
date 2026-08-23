# Request for Quotation — Embedded Drug Knowledge Dataset

**Issued by:** [Hospital legal name], a multispecialty hospital in India (current: ~100 OPD/day; target: 610 beds, 2,000+ OPD/day, 10 operating theatres by 2027)
**Date:** 2026-08-23 · **Responses requested by:** [date + 4 weeks]
**Contact:** [name, email, phone]

## 1. What we are licensing

Machine-readable clinical decision-support content for embedding in our hospital management platform (in-house, TypeScript/PostgreSQL, on-premises deployment planned):

1. **Drug–drug interactions** with a documented severity scale
2. **Allergy cross-sensitivity classes** (e.g., penicillin → cephalosporin cross-reactivity)
3. **Dose ranges**, including **pediatric and neonatal** dosing sets
4. **Duplicate-therapy classes**
5. Optional: condition-based contraindications; IV compatibility

We are **not** purchasing a point-of-care reference app, a clinician-facing portal, or a SaaS screening service as the primary deliverable. Reference products may be quoted as optional line items.

## 2. Mandatory requirements

Responses not meeting these will not be evaluated:

| # | Requirement | Detail |
|---|---|---|
| M1 | **Data licence with local execution rights** | Content delivered as flat files / structured data feed (JSON, CSV, delimited, or documented proprietary format with a data dictionary). Screening logic runs **inside our system, on our servers, offline-capable**. An API is acceptable as the *update/distribution* channel only — never required in the live prescription-check path. |
| M2 | **Salt/ingredient-level join keys** | Content keyed at the active-ingredient (INN/salt) level, with ATC classification (or a documented mapping to ATC). We map our own item master (Indian brands, fixed-dose combinations) to salt level; we do not require Indian brand-name coverage, but it is a scoring advantage (see E1). |
| M3 | **Documented, stable severity scale** | Your interaction severity levels must be enumerable and stable across releases, so our clinical governance can map them to our own blocking/warning configuration. Include the scale's definition document. |
| M4 | **Versioned releases with changelogs** | Each content release carries a version identifier and a machine-readable or structured changelog. State your release cadence. Our governance re-validates clinical behaviour on every content update. |

## 3. Evaluation criteria (scored)

- **E1 — India relevance:** coverage of ingredients and fixed-dose combinations common in the Indian market at salt level; any Indian brand mapping available.
- **E2 — Pediatric/neonatal dosing:** depth and structure (age/weight bands, indications).
- **E3 — Integration effort:** data dictionary quality, sample-data availability, format simplicity.
- **E4 — Update cadence and delivery:** frequency, mechanism, and offline update path.
- **E5 — Licence scope and pricing model:** single facility; please quote for (a) current scale and (b) 610-bed scale — per-bed, per-facility, or flat; multi-year options.
- **E6 — Evaluation access:** trial dataset or sandbox for a 4–6 week technical evaluation before commitment.
- **E7 — Support and liability:** technical support terms; content-accuracy liability/indemnity position; notification process for urgent safety updates (e.g., market withdrawals).

## 4. What to include in your response

1. Content-set descriptions matching §1, with record counts and a sample data extract
2. Data dictionary and format documentation for the offered feeds
3. Severity-scale definition document (M3)
4. Release cadence and delivery mechanism (M4)
5. Licence terms and pricing per E5, in INR or USD
6. Evaluation-access offer per E6
7. Two reference customers embedding your data in a hospital information system (India or comparable market, if available)

## 5. Process

Shortlisted vendors will be invited to a technical evaluation: we load the sample dataset, run our own test suite against it (known-interaction fixtures, pediatric dose cases, allergy-class cases), and assess integration effort. Commercial closure follows technical acceptance.
