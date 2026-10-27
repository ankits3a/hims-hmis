# PLAN — Laundry LD-1: laundry floor, rounds, bed-ready link, holds (#978)

Spec: `docs/specs/978-laundry-floor.md` (approved 2026-10-26). Rulings: decision 0087. Lane `laundry-978`, built on
`lane/ipd-train` (#967) with `lane/hk-rounds-973` (#973) merged in. It reuses HK-1's task-engine `eligible` hook, its
`rejectTask`, its round-clock shape, and its edit of `bedCleanVerified`. It merges after #966, #967 and #973, and stays
dark behind `HMIS_MODULES_ON`. Paths are under `apps/core/src/` unless they start with `apps/`, `packages/` or `docs/`.

## Decided by standard practice (none of these is money or law)

| Question | DECIDED |
|---|---|
| What "shelf" means | On-hand minus one set on each occupied bed (`units_per_set`). The book balance stays as built. |
| What "made" means | The last item on the HK-1 bed checklist is "made with a clean set". The linen gate runs when the clean is verified. |
| Infected linen counted by piece? | The ward declares pieces when it seals the bag, and the bag is never opened. The runner and the soiled room count bags and weight only (D1). |
| Thermal disinfection | Default 71 °C held 3 min, or 65 °C held 10 min (standard healthcare-laundry practice). Infection control can raise it in setup, and can set the chemical list. |
| Machines | Laundry keeps its own machine list until maintenance has an asset register. A breakdown is a maintenance ticket with the machine tag. |
| Who signs for CSSD | A new permission, `linen.cssd_receive`, granted to the OT nurse in-charge role. There is no CSSD module yet. |
| Round times | Pickup at 07:30, 13:30 and 19:30 per floor, plus on call. Delivery at 08:30 and 15:30, plus rush. A delivery to a ward at par is recorded as skipped. |
| MLC hold | Suggested on the pickup sheet when the bed's admission has `mlc = true`. Released only by a nurse in-charge recording the police receiver (name, rank, station), the same way as ER custody. |
| Chemotherapy hold | Placed by hand, released by the clock after 48 h. Suggesting it from an eMAR cytotoxic dose comes later, through one shared class test. |
| Radioactive hold | Placed by hand. Released only by the currently appointed RSO (`aerb/index.ts:appointedPerson`). |
| Theatre demand | From the OT list (`ot/index.ts:listForDay`) plus a manual set count. The main theatre list is owed by OT. |

## Data (one migration, numbered at merge; after HK-1's 0262)

New columns:
- `linen_items.stream`: ward, theatre, baby, mop, kitchen or uniform.
- `linen_laundry_batches`: `stream`, `mode` (in_house or vendor), new states `washing` and `qc`, and a unique key `(id, infected, stream)`.
- `linen_movements`: `round_id`, and `piece_id` (null; CHECK that a piece row has qty 1).

New tables:
- `linen_rounds`: done means the runner signed, and either the ward signed or it is runner-only with a reason.
- `linen_infected_bags`: tag, weight, sealed by, and the pieces the ward declared.
- `linen_machines`
- `linen_wash_cycles`: a composite FK to the batch's `(id, infected, stream)`, so one cycle cannot mix streams (D2, D7).
- `linen_qc_results`
- `linen_holds`: kind, bed, source reference, release kind checked per hold kind; never a patient name.
- `linen_bed_waits`
- `linen_pieces`: empty until tags arrive.

New ledger kinds: `return_held`, `hold_released`, `hold_handed_over`, `qc_rewash`, `qc_mend`, `mend_return`,
`issue_to_cssd`, `cssd_return`. The reads `bookBalances` and `weeklyVariance` count each one, so loss stays one sum (D6).

Shared files:
- `kernel/db/schema/linen.ts` and contracts `linen.ts`
- linen `manifest.ts`: permissions `linen.plant`, `linen.qc`, `linen.cssd_receive`, `linen.hold.release`
- `scripts/seed-roles.ts`, `test/seed-roles.test.ts` and the README prose it quotes
- `kernel/worker/worker.module.ts` (task kinds) and `kernel/worker/jobs.ts` (`whenModuleOn("linen", runLinenClock)`, beside HK-1's)
- `apps/web/src/router.tsx`, `test/caddyfile-parity.test.ts` and the Caddyfiles
- the en and hi locales
- `linen/MAP.md`

## Slices (red acceptance tests `spec #978 Dk` first)

0. Red acceptance tests D1–D7 in `modules/linen/acceptance/`. The five existing linen checks must stay green.
1. Migration, contracts, streams, ledger kinds and piece id, plus the read changes (D6).
2. Rounds:
   - pickup and delivery kinds, and the round clock
   - `signRound` with the ward PIN (`kernel/auth/identity.ts:verifyPin`), or runner-only with a reason
   - infected bags by tag and weight (D1)
3. Holds:
   - `placeHold` and `releaseHold`
   - pickup and `sendToLaundry` refuse held linen (D4)
   - the clock releases chemotherapy holds
4. Plant:
   - machines, and a breakdown raised as a ticket through `maintenance/index.ts:raiseTicket`
   - `startCycle` refuses a machine that is down, and its queued batches show "send to vendor" (D5)
   - `releaseBatch` refuses an infected batch that missed its temperature or time and sends it to rewash (D2)
5. Quality check and store:
   - pass, rewash, mend, or condemn (the four-eyes rule is built)
   - store receipt
   - theatre sets to CSSD with a CSSD PIN signature
   - baby linen in its own stream (D6, D7)
6. Bed-ready link: `bedCleanVerified` asks `linen/index.ts:bedReadyGate`.
   - If the shelf is short, the bed stays in cleaning with a wait row and a rush top-up is raised.
   - The top-up movement clears the wait and frees the bed (D3).
   - Check the import-boundary lint, since linen calls ipd.
   - The 09:00 rush demand comes from planned discharges (`ipd_discharges`) and the OT list.
7. Web screens:
   - `/linen` gains rounds, holds, machines, beds waiting for linen and the vendor queue.
   - `/linen/handle` (phone) gains the round sheet with two signatures, the sealed bag, and placing a hold.
   - New `/linen/plant` and `/linen/store`.
   - The Beds board gets a "waiting for linen" line.
   - Then a browser walk at 390 and 1440 px against the design board.

## Risks
- `jobs.ts`, `housekeeping/kinds.ts` and the seed-role counts are shared with HK-1. That is handled by building on it.
- Laundry's machine list may later duplicate a maintenance asset register.
- Using the ward PIN for signatures needs every ward nurse to have a PIN set.

## Verify
Targeted jest for linen, housekeeping, tasks and maintenance under the lock, plus web vitest for the touched screens.
Root typecheck and lint, and `node tools/arch/gen.mjs`. CI runs the full suites. Stage after #967 is on staging.
