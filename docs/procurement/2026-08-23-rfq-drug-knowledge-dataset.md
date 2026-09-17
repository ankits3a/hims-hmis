# Request for Quotation — Embedded Drug Knowledge Dataset

**Issued by:** [Hospital name], a multispecialty hospital in Bihar, India, operated by LEELAWATI DEVI EDUCATIONAL TRUST (GSTIN 10AAATL6484H1ZP) (current: ~100 OPD/day; target: 610 beds, 2,000+ OPD/day, 10 operating theatres by 2027)
**Date:** 2026-08-23, revised 2026-09-17 (§2 M5, §2A) · **Responses requested by:** [date + 4 weeks]
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
| M5 | **A licence for clinical use in a fee-charging hospital** | The licence must permit showing the content to our doctors and pharmacists, inside prescribing, dispensing and retail sale, in a hospital that charges patients. Research-only and non-commercial licences (for example CC BY-NC) do not qualify, whatever the price. |
| M6 | **Management advice, not only a level** | Every interaction record carries what the clinician should do: avoid, adjust the dose (by how much), separate the doses (by how long), or monitor (what, and when). A pair with a level and no advice is not a usable alert. |

## 2A. Coverage we will measure (benchmark, 2026-09-17)

We measured our own formulary against a public research interaction database. The hospital may not
use that database clinically, so it serves only as a benchmark. The offered dataset will be scored
against the same benchmark in the technical evaluation (§5).

| # | Target | Basis |
|---|---|---|
| C1 | Recognise the **1,429** active ingredients of our formulary that the benchmark covers | our national-release moiety list (NRCeS CD-India 2026-09): 2,178 moieties |
| C2 | Also cover the high-volume Indian molecules the benchmark lacks: aceclofenac, ornidazole, serratiopeptidase, domperidone, etoricoxib, nimesulide, gliclazide, tenofovir, vildagliptin, teneligliptin, candesartan, dabigatran | 641 of our moieties sold in India had no benchmark entry |
| C3 | A rated record, with advice (M6), for at least **95% of the 28,697** ingredient pairs the benchmark rates major among our ingredients; a pair you rate lower carries its reason | the benchmark's major pairs among our moieties |
| C4 | Every one of a **2,132-pair** priority list of major pairs among commonly stocked essential medicines | our shortlist (for example quinolone × tramadol, SSRI × linezolid, dual RAAS blockade) |
| C5 | Every one of the **179** pairs the hospital has already adopted | our current interaction book (157 adopted by the owner's resolution, plus the starter pairs) |
| C6 | No "unknown" severity level: every listed pair is rated | the benchmark leaves 18% of its pairs unrated |
| C7 | The route and formulation each record applies to (an eye drop is not a tablet; intrathecal contrast is not intravenous) | the benchmark records no route |

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

Shortlisted vendors will be invited to a technical evaluation. We load the sample dataset and run our
own test suite against it: known-interaction fixtures, pediatric dose cases, allergy-class cases,
and the §2A coverage measures. We also assess the integration effort. Commercial closure follows
technical acceptance.
