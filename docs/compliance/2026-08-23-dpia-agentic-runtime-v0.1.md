# Data Protection Impact Assessment — Agentic AI Runtime (Plan 12a)

**Version:** 0.1 DRAFT — internal draft for external DPDP-specialist review. Not yet reviewed, not yet signed. Items marked **[COUNSEL]** need the reviewer's ruling.
**Data Fiduciary:** [Hospital legal name]
**Scope of this DPIA:** the agentic runtime introduced by Plan 12a (agent grants, tool catalog, `InferenceClient`, prompt/playbook governance) and its first two activations — the Digest Writer (model-backed, tier T0) and the Leakage Auditor (deterministic automation, no inference). Per spec fix 42, this DPIA is re-run before each subsequent agentic phase (each new agent class or data-class change).

## 1. Processing overview

| Activation | What it does | Personal data involved |
|---|---|---|
| Digest Writer | Renders a daily owner digest from a deterministic fact sheet (revenue close, OPD counts, SLA breach counts, orphan/variance summaries) | **None in the inference request** — aggregates only (Class 0). Output delivered via the notification gateway to the owner. |
| Leakage Auditor | SQL over billing events; weekly orphan/variance trend report | Processes billing events internally; **no inference request at all** (deterministic). |

Future stages (not activated by this DPIA; each triggers a DPIA revision): T2 clinical drafters consuming Class-1 (de-identified) context.

## 2. Data classes and the governing design law

- **Class 0** — aggregates and operational figures containing no personal data.
- **Class 1** — de-identified, minimum-necessary, token-referenced context (no names, no identifiers; references resolvable only inside the permission-checked system).
- **Class 2** — identified personal/health data. **Design law: Class 2 never enters an inference request — any stage, any provider, ever.**

**Enforcement (technical, already specified):** every `InferenceClient` call site carries a caller contract; automated tests assert request bodies contain no identifier fields. Agent code is structurally API-only (lint-enforced: no database imports) and every agent-callable declares its data access in the tool catalog.

## 3. Inference locus and cross-border transfer

- **L0 (this DPIA):** managed cloud LLM API for Class 0 under a data-processing agreement with a contractual no-training commitment. Provider held as configuration behind the `InferenceClient` interface; the test/dev implementation is deterministic and offline (CI never contacts a provider).
- Cross-border: Class-0 payloads contain no personal data; transfer analysis is therefore not triggered by them. **[COUNSEL]** confirm this characterization.
- **L1 (future revision):** before any Class-1 request flows, this section is expanded with re-identification risk analysis, the chosen provider's processing locations, and DPDP §16 transfer analysis (no blacklisted jurisdictions).

## 4. Lawful basis and notices

- Patient data (Class-1 stage, future): basis mapping under DPDP (consent / legitimate uses) **[COUNSEL]**.
- **Staff data — flagged for review now:** two runtime mechanisms process employee behavioral data: (a) signer-engagement instrumentation (spec D-36 — dwell/edit signals on approvals, an automation-bias safeguard), and (b) the per-agent calibration record (accept/modify/reject histories used to govern agent autonomy). Purpose: safety governance of AI outputs, never individual performance evaluation (KPI design law: diagnostic, never auto-punitive). Required: staff notice text and purpose limitation statement **[COUNSEL]**.

## 5. Risks and mitigations

| Risk | Mitigation (shipped or specified) |
|---|---|
| Re-identification from inference payloads | Class system + test-asserted caller contract; token refs resolvable only inside RBAC |
| Prompt injection via hospital documents/messages | Untrusted-content boundary: external content is data, never instruction; policy only from versioned playbooks; enforcement outside the model (guards, tool catalog, propose→confirm); adversarial-content fixtures mandatory in every agent's eval suite |
| Hallucination becoming action | Narrow single-purpose tools; propose→confirm (human confirmation IS the API call); approvals ladders cannot be bypassed; T2 cap — models draft, only credentialed humans sign, permanently |
| Wrong/poisoned agent memory | Agents hold no private state; memory = read models over the audited event log; every fact carries provenance |
| Model/prompt change altering clinical behaviour | Versioned models, prompts, playbooks; eval suites gate activation; shadow-mode before promotion; instant rollback to prior version |
| Runaway agent | Per-agent kill switch (shipped), tiered halts (agent / class / high-risk tools / global), action budgets per run, heartbeats + watchdog |
| Breach of stored data | At-rest encryption; DB-held secrets sealed (AES-256-GCM); sealed-class records; append-only financials; access via permission strings with scopes, 2FA on signature/money classes, break-glass with mandatory review |

## 6. Data-subject rights

- **Access:** the event log reconstructs every action on a subject's data, including every agent action with model/prompt versions (provenance stamps).
- **Correction:** entered-in-error grammar and supersession flows (never destructive edits).
- **Erasure — the open question for counsel:** the platform's audit and medico-legal guarantees rest on an append-only event log; medical records also carry statutory retention periods. Where DPDP erasure applies and retention does not shield, the engineering answer is crypto-shredding (per-subject field encryption; erasure = key destruction). **[COUNSEL — key ruling needed: interplay of DPDP erasure, medical-record retention obligations, and audit immutability; whether crypto-shredding must be built and by when.]**
- **Retention:** monthly event partitions with archival honoring legal holds (deployment plan); retention schedule to be attached **[COUNSEL]**.

## 7. Governance and accountability

- Every autonomous action is attributable: actor identity (agents are first-class actors), causation chain, tool audit events, model/prompt/input/output provenance on drafts, human approver identity where approval occurred.
- Autonomy is governed data: per-(agent, action-class) levels, promoted only through human-approved proposals backed by the calibration record; demotion automatic on calibration breach, budget breach, eval regression, or operating-mode change.
- The eval harness + calibration record constitute standing algorithmic due-diligence evidence (relevant if the hospital is designated a Significant Data Fiduciary; SDF self-assessment window Nov 2026–Jan 2027 — if designated: India-based DPO appointment, independent audits, statutory DPIA on this template).
- DPIA lifecycle: revised before each agentic phase (fix 42); stored in `docs/compliance/`; reviewed version is the activation gate for Plan 12a.

## 8. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Internal author (draft) | — | 2026-08-23 | v0.1 draft |
| External DPDP reviewer | [COUNSEL] | | |
| Data Fiduciary (owner) | | | |
