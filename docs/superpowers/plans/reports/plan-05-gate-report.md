# Plan 05 — Patient Master & Registration · Gate Report

**Status: SHIPPED 2026-08-14. All 16 tasks gate-passed across three pipelines.**
Plan: [`2026-08-13-phase1-05-patient-master.md`](../2026-08-13-phase1-05-patient-master.md) · Ledger: [`EXECUTION-LESSONS.md`](EXECUTION-LESSONS.md)

Final state — **three workspaces, one green command**:

```
pnpm verify → exit 0
  packages/contracts   3 suites / 7 tests
  apps/web            11 files  / 37 tests      ← new this plan
  apps/core           54 suites / 269 tests
```

Baseline entering the plan was 45 suites / 208 tests. Every one of the 19 commits was observed CI-green, and every pipeline was verified independently by the main session (detached `pnpm verify` with the real exit code read from a file, per-commit `--stat` diffed against each task's Files list, frozen-path checks, CI observation) — never on agent self-reports alone.

---

## 1. Build environment — what changed since Plan 04

**This was the first dependency wave since Plan 01.** The backend added **zero** dependencies and **zero** env vars, exactly as scoped. Everything new is confined to `apps/web`, plus one root lint plugin.

Measured on the server this session: node **v22.23.2**, pnpm **10.34.5** on PATH — but the repo pins `packageManager: pnpm@10.0.0`, and **that pin is what actually runs**. T11 discovered this the useful way: `pnpm ignored-builds` does not exist on 10.0.0. Report the pinned version as the effective one; `pnpm --version` is not the answer.

`apps/web` is the third workspace, picked up automatically by the existing `packages: ["apps/*", "packages/*"]` glob. It declares 15 runtime and 13 dev dependencies; `pnpm-lock.yaml` is the pin of record and was committed with both dependency changes (T11's wave and T13's CLI-added Radix set).

| Added | Where | Note |
|---|---|---|
| react, react-dom ^19 | apps/web | |
| vite ^7, @vitejs/plugin-react ^5 | apps/web dev | |
| tailwindcss ^4, @tailwindcss/vite ^4 | apps/web | CSS-config-only; no `tailwind.config.*` exists |
| @tanstack/react-router ^1.90, @tanstack/react-query ^5.60 | apps/web | code-based routes; no codegen, no generated file |
| react-hook-form ^7.54, @hookform/resolvers ^5, zod ^4 | apps/web | zod range matches core and contracts, so it dedupes |
| i18next ^25, react-i18next ^15 | apps/web | |
| qrcode.react ^4.1 | apps/web | |
| vitest ^3, jsdom ^26, @testing-library/{react,jest-dom,user-event} | apps/web dev | Vitest is confined to apps/web; `jest.config.cjs` untouched |
| **@types/node ^22** | apps/web dev | **added by the stress pass — see §5.1** |
| radix-ui ^1.6.7, lucide-react ^1.31, class-variance-authority, clsx, tailwind-merge | apps/web | added by the shadcn CLI itself |
| eslint-plugin-react-hooks ^5.2 | **root** | root runs `eslint .`, so the plugin belongs at root |

**pnpm 10 denies dependency build scripts by default and no allowlist was added** — deliberately, following the argon2 precedent. Verify-by-execution flag ⑫ held: T11 confirmed esbuild's `bin/esbuild` is still the 9,350-byte JS shim (its postinstall never ran) and that `vite build` and `vitest` both succeed anyway, because esbuild ships its native binary as an optionalDependency. **No `onlyBuiltDependencies` key exists and `pnpm approve-builds` was never run.**

**`.github/workflows/*` was not touched by anyone** (owner decision Q2). CI needed no change: `apps/web`'s typecheck rides `pnpm -r exec tsc --noEmit`, its tests ride `pnpm -r test`, its lint rides the root `eslint .`.

---

## 2. Task outcomes

| # | Task | Tier | Attempts | Commit(s) |
|---|---|---|---|---|
| 1 | Schema — 6 tables, `uhid_seq`, migration 0006 | sonnet | 1 | `c66e76b` |
| 2 | Verhoeff check digit + UHID allocator + seed | sonnet | 1 | `2b8c6a9` |
| 3 | Events, types, manifest + registration service | opus | 1 | `45475fc` |
| 4 | Phone-first search + CI-gated perf budget | opus | 1 | `5011bc2` |
| 5 | Photos + allergies (entered-in-error grammar) | sonnet | 1 | `f9ebf15` |
| 6 | Guardians + the fourth unscheduled sweep | opus | **3** | `03cb9c4`, `97d04c8` |
| 7 | Signed QR — build/verify/reissue | sonnet | 1 | `02bceb4` |
| 8 | Merge & unmerge — approval-gated | opus | 1 | `2dfdb25` |
| 9 | Module surface — 21 routes, index, e2e | opus | 1 | `0a013d8` |
| 10 | Full-lifecycle e2e + docs | sonnet | **2** | `93d2883`, `6d01bee` |
| 11 | `apps/web` scaffold | opus | 1 | `7149579` |
| 12 | App shell — api, auth, i18n, router, keyboard | sonnet | 1 | `1fa4380` |
| 13 | shadcn/ui + keyboard-first form kit | sonnet | **2** | `1a982d9`, `a40c192` |
| 14 | Registration desk | opus | 1 | `a0a08ed` |
| 15 | Patient detail | sonnet | 1 | `17c90b7` |
| 16 | Merge review + approvals inbox + docs | sonnet | 1 | `92c3035` |

**13 of 16 first-attempt. All three retries were genuine gate catches — zero process-caused retries.** Every retried task's extra rung bought a real defect: T6 an untested branch plus a fixture that proved nothing, T10 an SoD assertion the route guard was actually satisfying, T13 a focus assertion a second framework mechanism was satisfying. Notably **all three are the same defect class** (see §5).

**Cost: 40 pipeline agents, 3,984,133 subagent tokens, ~7h22m of pipeline wall clock** (A 16 agents / 1,315,927 / ~2h46m · B 10 / 1,027,012 / ~1h39m · C 14 / 1,641,194 / ~2h57m), plus ~462k across six scouts and the 1M-row perf run. **Grand total ≈ 4.45M.** Against the plan's own 2.5–2.8M calibration that is **~42% over** — the overrun sits almost entirely in pipeline C's screen tasks (T15 229k, T16 236k, against a ~160k/task assumption). Calibrate UI plans higher: screens with many small files and stubbed network calls cost more than a backend service with one suite.

---

## 3. Shipped interfaces

Transcribed from the shipped source, not from the plan.

### 3.1 Backend — `apps/core/src/modules/patients/`

The first domain module, and the first real subject of Plan 01's module-isolation lint rule. `index.ts` is the **declared cross-module interface**; everything else in the folder is private.

```ts
// index.ts — the ONLY surface later modules may import
export { patientsManifest } from "./manifest";
export { PatientsModule } from "./patients.module";
export { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
export type { GuardianInput, PatientPatch, PatientRow, RegisterPatientInput } from "./registration";
export { searchPatients } from "./search";
export type { PatientSearchResult } from "./search";
export { NO_AUTHORITY, effectiveGuardianAuthority, sweepGuardianMajority } from "./guardians";
export type { GuardianAuthority, GuardianRow } from "./guardians";
export { isValidUhid, PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";
export * from "./events";
```

`qr.ts`, `merge.ts`, `allergies.ts` and `photos.ts` are deliberately **not** exported — the HTTP controller is their only external surface.

Key signatures (Db-vs-Tx is load-bearing):

```ts
registerPatient(tx: Tx, actor: Actor, input: RegisterPatientInput): Promise<{ patient: PatientRow; guardianId: string | null }>
updatePatient(tx: Tx, actor: Actor, patientId: string, patch: PatientPatch): Promise<{ patient: PatientRow; changed: string[] }>
getPatient(db: Db, actor: Actor, patientId: string): Promise<{ patient: PatientRow; resolvedFrom: string | null } | null>
resolvePatientId(db: Db, patientId: string): Promise<string | null>          // id mapping only — no gate, no demographics
searchPatients(db: Db, actor: Actor, q: string, limit = 20): Promise<PatientSearchResult[]>
effectiveGuardianAuthority(patient: PatientRow, guardian: GuardianRow, now?: Date): GuardianAuthority   // PURE
sweepGuardianMajority(db: Db, now?: Date): Promise<number>                   // the FOURTH unscheduled sweep
isValidUhid(uhid: string): boolean
class PatientError extends Error { constructor(readonly code: PatientErrorCode, message?: string) }
```

`PatientErrorCode` is a closed union of **22** literals defined once in `uhid.ts` and re-exported by `types.ts`.

**Schema** (`kernel/db/schema/patients.ts`, migration `0006_faithful_ultron.sql` — generated once in T1 and the last migration this plan produces): `patients` (28 columns, `uniqueIndex patients_uhid_ux`, three `text_pattern_ops` btree indexes including a `lower(name)` expression index), `patient_photos` (bytea, PK = patient_id, one current photo), `patient_allergies`, `patient_guardians`, `patient_merge_requests` (`snapshot` jsonb notNull, `movedRows` jsonb, partial `uniqueIndex … ON (loser_id) WHERE status = 'requested'`), `registration_config`, and the `uhid_seq` sequence. **`patient_merge_requests.approval_id` is plain text with no FK** — deliberate, so the table need not join two separate TRUNCATE groups (§3.12).

**Events — exactly nine names, all `module: "patients"`:** `patient.registered`, `patient.updated`, `patient.merged`, `patient.unmerged`, `guardian.linked`, `guardian.authority_changed`, `allergy.recorded`, `correction.entered_in_error`, `qr.signature_failed`. `patient.merged`/`.unmerged` carry `correlationId` = the backing approval's workflow instance id. **Nothing else emits.**

### 3.2 HTTP — 21 routes on one controller

`@Controller("patients")`, every route `@RequirePermission(…, "hospital")`, literal segments declared before `:id` routes (Nest matches in declaration order). Full wire contract:

```
GET    /patients/search?q=&limit=   -> { items: PatientSearchResult[] }
POST   /patients                    -> { patient, guardianId }              201
GET    /patients/:id                -> { patient, resolvedFrom }            404 when hidden/absent
PATCH  /patients/:id                -> { patient, changed: string[] }
PUT    /patients/:id/photo          { imageBase64 } -> { ok: true }
GET    /patients/:id/photo          -> { mimeType, imageBase64 }
GET    /patients/:id/qr             -> { payload, uhid, name, sex, dob }
POST   /patients/:id/qr/reissue     -> { qrVersion, payload }
POST   /patients/qr/verify          { payload } -> HTTP 200 ALWAYS:
                                       { ok:true, patient:{…} } | { ok:false, reason:… }
POST   /patients/:id/allergies      -> { allergyId }
GET    /patients/:id/allergies      -> { items: AllergyRow[] }
POST   /patients/:id/allergies/:allergyId/entered-in-error  { reason } -> { ok: true }
POST   /patients/:id/guardians      -> { guardianId }
GET    /patients/:id/guardians      -> { items: { guardian, effectiveAuthority }[] }
PATCH  /patients/:id/guardians/:guardianId -> { ok: true }
POST   /patients/:id/guardians/:guardianId/end -> { ok: true }
POST   /patients/merge-requests     { winnerId, loserId, note } -> { mergeRequestId, approvalId, instanceId }
GET    /patients/merge-requests/:id -> { request, approvalStatus, unmergeApprovalStatus }
POST   /patients/merge-requests/:id/execute         -> { winnerId, loserId }
POST   /patients/merge-requests/:id/unmerge-request { note, actFirst? } -> { approvalId, instanceId }
POST   /patients/merge-requests/:id/unmerge         -> { ok: true }
```

Permissions: `patients.register` · `patients.read` · `patients.update` · `patients.merge` · `patients.confidential.read`.

One `toHttp` mapper, defined once: `SodViolationError` → 403 · `*_not_found`/`unknown_merge_request` → 404 · `photo_too_large` → 413 · the ten state-conflict codes → 409 · `ApprovalError`/`WorkflowError` → 409 · everything else → 400 · unrecognised rethrows.

**`configureApp(app: NestExpressApplication)`** (`src/app.bootstrap.ts`, new) registers a **1 MB** json parser; callers create the app with `{ bodyParser: false }`. Photo transport is base64-in-JSON both directions — an `<img>` tag cannot send a bearer token, so the client fetches JSON and renders a data URL. No multipart, no new dependency. **Existing e2e suites keep their default parser and were not edited.**

### 3.3 Frontend — `apps/web` (49 files, 4,457 lines)

React 19 + Vite 7 SPA. Self-contained `tsconfig.json` (bundler resolution, `react-jsx`, DOM libs, **no project references** — a references-only config would make `tsc --noEmit` silently check nothing).

```ts
// lib/api.ts
class ApiError extends Error { constructor(readonly status: number, readonly body: unknown) }
getToken(): string | null · setToken(next: string | null): void
api<T>(method: string, path: string, body?: unknown): Promise<T>    // 401 clears the token

// lib/auth.tsx
type Actor = { type: "user" | "agent" | "system"; id: string }
AuthProvider({ children }) · useAuth(): { actor, ready, login(u,p), logout() }

// lib/i18n.ts        switchLanguage(lng: "en" | "hi"): void · default i18next
// lib/keyboard.tsx   KeyboardProvider · ShortcutLegend
// components/form-kit.tsx   FormKit · TextField · SelectField · CheckboxField
```

**Routes** (code-based, no codegen): `/login` is the only public route; a pathless layout route `id: "authed"` carries the guard (`beforeLoad` → no token ⇒ redirect `/login`) and wraps `/` (→ `/registration`), `/registration`, `/patients/$patientId`, `/merge`, `/approvals`.

**Keyboard-first** (§15): `/` focuses search · F2 registration · Alt+M merge · Alt+A approvals · **Enter advances to the next `[data-field]` instead of submitting** · **Alt+S submits from anywhere**. Errors render inline as `role="alert"`.

**i18n:** `en.json` and `hi.json` each hold **123 leaf keys** across 13 namespaces, and the key sets are **identical** — enforced mechanically by `i18n.test.ts`, so an incomplete Hindi tree fails the suite rather than silently falling back.

**shadcn/ui:** 12 CLI-generated components (914 lines) under `components/ui/` plus `lib/utils.ts`'s `cn()`. Registry-owned; accepted behaviourally, never byte-wise.

---

## 4. Deviations from the plan text (gate-ratified — do not "fix" these)

**4.1 — `POST /patients/qr/verify` carries `@HttpCode(200)`.** The plan's prose said 200 on `ok:false`; its own e2e block asserted Nest's POST default of 201. Two sources against one, and only the assertion executes. Resolved toward the stated intent. See §5.6.

**4.2 — `styles.css` carries the shadcn theme block.** `components.json` is hand-written, so `shadcn init` never ran and its second effect — the theme custom properties — had no owner. T13 added the `new-york`/`neutral` block **taken from the registry's own output**, with an inline comment recording where the values came from and why. Without it Tailwind 4 silently drops `bg-background`, `text-foreground`, `border-border`, `ring-ring`, and every component renders unstyled while the suite stays green.

**4.3 — `useParams({ from: "/authed/patients/$patientId" })`.** The plan wrote the URL path. Because the layout route is pathless with `id: "authed"`, TanStack Router's typed id for the child is `/authed/patients/$patientId`. The URL and `router.tsx` are unaffected.

**4.4 — The QR card's print CSS gained `height: 54mm`.** The plan's block set width only, while its own prose specified 85.6 × 54 mm. One declaration, to make the stated requirement true.

**4.5 — Enum-code labels render untranslated.** Guardian relationships (`father`/`mother`/…), ABHA verification statuses, and approval/merge status strings render as raw values, because T15/T16's Files lists exclude the locale files. Consistent across all three screens. A translation pass is an owner item at UAT.

**4.6 — Act-first unmerge eligibility is tracked in local component state.** `GET /patients/merge-requests/:id` carries no `actedFirst` field, and the merge screen deliberately holds no approvals-read permission. A page reload while an act-first unmerge is pending loses that hint. **The server remains authoritative in every case** — this is a v1 UI limitation, not a security gap.

**Inherited deviations, still not ours to fix** (gate reports 01–04 §4): `MODULE_REGISTRY` in `tokens.ts`, static imports in e2e, `@Public` at method level, duplicate import lines, argon2 under pnpm's denied build scripts, `decide<V>` generic, the three-code race set. All untouched.

---

## 5. Defects found in the plan itself

Eleven, every one caught before or during execution, every one disclosed rather than silently worked around. **Four are the same class** and that is the headline finding.

### The recurring class: an assertion that passes for the wrong reason

**5.1 — T6: a fixture where both sides are identical.** The plan proved "the event carries *effective* authority, not *stored* flags" on a **10-year-old**, where effective and stored are by definition the same. It would have passed against an implementation that simply echoed the row. It also never called `effectiveGuardianAuthority` with a non-active guardian. Ledger §3.14.

**5.2 — T10: the claimed mechanism was unreachable.** Leg 4 claimed to prove the `requester_approver` SoD pair over HTTP by asserting a 403 — but the clerk holds no approvals permission by design, so the **route guard** produced that 403 and `assertNotSodPair` never ran. Deleting the SoD subsystem would not have failed it. Ledger §3.14b.

**5.3 — T13: a second framework mechanism produced the same observable.** The Enter-advance test left the second field empty, so Enter triggered implicit submission, zod rejected the empty field, and react-hook-form's default `shouldFocusError` focused it — for validation reasons. The keyboard feature could have been deleted without failing the test. Ledger §3.14c. **The sharpest specimen in the ledger.**

**5.4 — T8: the fixture omitted the entities under test.** The execute test created no guardian and no photo, so "guardians move to the winner" and "photos do NOT move" were never asserted — it asserted `guardianIds` length **0**, the empty case. Forced into the open by a compiled acceptance criterion that named both invariants.

### The rest

**5.5 — T9: a positional `undefined` bound the wrong overload.** `createNestApplication<T>(undefined, { bodyParser: false })` — `@nestjs/testing` dispatches on argument *shape*, so a non-adapter first argument is **treated as the options bag** and `{ bodyParser: false }` was silently discarded. Express's default 100 kB parser would have rejected the 300 kB photo. The type error was the harmless half. Ledger §3.17.

**5.6 — T9: prose and the plan's own test block disagreed** on the qr/verify status (200 vs 201). Only the assertion executes. Ledger §3.18.

**5.7 — T14: `z.preprocess` disabled a safety rule behind a type error.** It makes the schema's *input* type `unknown` (TS2719), and the same mismatch meant `watch("ageYears")` returned the **string** `"10"`, so `typeof v.ageYears === "number"` was false and **the D-31 minor-needs-guardian section would never have rendered**. A minor could have been registered without guardian consent. Ledger §3.19.

**5.8 — T14: the jsdom stub list was incomplete.** The stress pass wrote "must stub THREE things" as if exhaustive; jsdom also has no Blob URLs, so capture died on `URL.createObjectURL` after the canvas stubs worked. A fourth stub was needed, hand-assigned because absent properties cannot be `vi.spyOn`-ed. **This one was mine.** Ledger §3.20.

**5.9 — T12: two identical strings, one query.** `App.test.tsx` asserted `findByText("Sign in")`, but `login.title` and `login.submit` carry the same literal, so the query matched both the heading and the button. Fixed with `findByRole("heading", …)`.

**5.10 — T8: a test count no correct implementation could satisfy** ("7 tests" against a 6-`it` suite), and **5.11 — T4: a criterion pinned to a jest path regex** the task's own later file would also match. Both are the §2.5 class; both were caught by the stress passes before any agent ran.

---

## 6. Process failures — what they cost

| What | Class | Cost |
|---|---|---|
| T6's retry blocked by the permission system mid-run; stalled twice, left the server tree dirty | Host/harness. The ladder handled it correctly — gate #2 failed it on the uncommitted file, the escalate rung ran verify-only and landed the fix as a **new** commit (tripwire 15 held) | ~116k |
| Main session read a wrapper's exit status as the command's verdict; SSH dropped mid-verify (exit 255) while the harness reported 0 | **Mine.** Became tripwires 17–18 | 0 agent tokens, ~10 min |
| Main session chained `git pull --rebase` ahead of `git commit` | **Mine.** §3.8 verbatim — written for a Plan 03 coder | ~0 |
| Six briefs quoted a fixed baseline SHA, stale from task 2 onward; four coders each wrote a paragraph reconciling it | **Mine.** §2.6 | 0 retries, four rounds of avoidable doubt |

**Zero API-529 failures. Zero process-caused retries.** All three retried tasks bought real defects.

**A pattern worth naming: four of the recorded process failures were the main session's own**, breaking rules this project had already written down for its agents. The tripwire block is pasted into every brief and never into the session's own habits. §2.5, §2.6, §3.20 and the two git slips above all sit on that side of the line.

---

## 7. Open items carried forward

1. **Production UHID prefix — Class A, owner.** Dev is seeded with `HMS`. It is printed on every card, so it is decided once and never changed: `UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration`. Blocked on the hospital/product name.
2. **`patient_merge` / `patient_unmerge` type registration is a go-live runbook step** (README, T10) — build each definition with `approvalFlowDefinition`, draft + activate through `/workflow/definitions` with **drafter ≠ activator**, then `POST /approvals/types`. There is no seed script and no boot-time registration, by design.
3. **Role grants for `patients.*`** — `patients.confidential.read` and `patients.merge` only to roles the owner designates.
4. **`sweepGuardianMajority` joins Plan 11's pg-boss list** — the fourth unscheduled sweep, alongside `runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`. Correctness never depends on it (majority is read-time enforced); it exists to flip row status and emit.
5. **Per-access break-glass eventing → the EMR plan.** Plan 02 pointed this at "record surfaces in Plan 05", but no catalog name exists for record access and the sealed clinical surfaces arrive with Plan 07+. The standing grant's `break_glass.used` remains the audit record.
6. **A latent 1-in-4096 CI flake in `qr.test.ts`.** The tampered payload is built as `slice(0, -2) + "xx"`, which only differs from the real base64url HMAC when the signature does not already end in `xx`. T9's coder found it, judged rewriting another task's shipped assertion out of scope, and flagged it. Make it deterministic in the next task that legitimately owns that file.
7. **Hindi translation pass at UAT** — `hi.json` is key-complete and mechanically enforced, but enum-code labels (§4.5) render untranslated.
8. **UI cost calibration.** Screen tasks ran ~40% above the per-task assumption; size the next UI plan accordingly.

---

## 8. Perf evidence at scale

CI gates at 200k rows (median-of-5 phone search < 300 ms, `getPatient` < 100 ms, plus `EXPLAIN (FORMAT JSON)` no-Seq-Scan plan-shape assertions). One 1M-row run was recorded on the server after pipeline B — reporting, not gating, and committing nothing:

| | At 1,000,000 rows | CI budget (200k) | Headroom |
|---|---|---|---|
| Seed | 1,000,000 rows in 13.2 s | — | — |
| Phone-prefix search, median-of-5 | **6.4 ms** (6.4 / 7.0 / 6.2 / 6.3 / 6.4) | 300 ms | ~47× |
| `getPatient`, median-of-5 | **1.6 ms** (3.3 / 2.0 / 1.5 / 1.6 / 1.4) | 100 ms | ~62× |

Both paths remain index-served at 5× the CI seed size — the phone predicate plans as `Bitmap Heap Scan / BitmapOr / Bitmap Index Scan ×2`, the name predicate as `Index Scan`, **no Seq Scan on `patients` in either**. The 200k gate is a floor with room above it, not a ceiling the design is pressed against.

---

## 9. What Plans 06 and 07 can rely on

- **`patient_id` is the join key, and demographics are never copied** (§6). Later modules call `getPatient` / `resolvePatientId` from `modules/patients/index` — the merge chain resolves through frozen losers automatically (depth-capped at 5 hops), so a stale id from any module still lands on the canonical record. `resolvePatientId` is the id-mapping surface with no confidential gate; `getPatient` is the read surface with one.
- **The module-isolation rule has a real subject and it holds.** `index.ts` is the declared interface; the root lint rule blocks cross-module internals. Import from the index or consume events — nothing else.
- **Nine patient events, stable and catalogued**, with `patientId` on every patient-scoped emission and `correlationId` = the workflow instance on merge/unmerge. Plan 07's encounter spine and Plan 08's charge-posting can subscribe against these names.
- **Approval-gating is a solved, demonstrated pattern.** Merge proves the full shape end to end: `requestApproval` on the caller's own transaction (Tx-first), check-on-execute against the approvals row, single-winner conditional UPDATE, snapshot-recorded moves, and E-15 act-first for the emergency path. Plan 08's refunds and discount overrides follow the same shape — **no engine work required**.
- **The confidential/VIP gate is enforced at the read surface**, and D-37 holds: the flag appears in no ORDER BY, no queue, no prioritization anywhere.
- **`apps/web` is the scaffold every later UI reuses** — router, auth, API client, i18n, keyboard kit, form kit, print isolation, and 12 shadcn components. A new screen is a new file plus a route swap; `router.tsx` is final. The approvals inbox is **generic over approval types**, so Plan 08's refund and discount approvals appear there with no UI work.
- **One green command covers three workspaces.** `pnpm verify` typechecks, lints and tests everything; CI needed no change to absorb a whole new frontend workspace, and will need none for the next.
