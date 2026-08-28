import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { INestApplicationContext } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "../db/client";
import { loadConfig, AppConfig } from "../config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "../tokens";
import { ModuleRegistry } from "../modules/loader";
import { ALERTS_CONSUMER, alertsConsumer } from "../alerts/consumer";
import { alertsManifest } from "../alerts/manifest";
import { NOTIFY_CONSUMER, notifyConsumer } from "../notify/consumer";
import { notifyManifest } from "../notify/manifest";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import { PARTNERS_ACCRUAL_CONSUMER, accrualConsumer, partnersManifest } from "../../modules/partners";
import {
  MATERIALS_CONSUMPTION_CONSUMER, consumptionConsumer, materialsManifest,
} from "../../modules/materials";
import {
  OT_PATIENT_MERGED_CONSUMER, otManifest, patientMergedConsumer,
} from "../../modules/ot";
import { collectResourceKinds } from "../resources/kinds";
import type { Handler } from "../events/subscriptions";
import type { Scheduler } from "./scheduler";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

/**
 * D1 (FORK-A, RESOLVED by spike question A — see the plan's Spike verdicts block):
 * `createApplicationContext(WorkerModule)` boots, resolves `DB`, runs a sweep, and closes
 * cleanly; `AppModule` as a headless context dies at boot
 * (`RealtimeGateway.onApplicationBootstrap` reads a null HTTP adapter — gateway.ts:71). So the
 * worker gets its OWN providers-only module rather than reusing `AppModule`'s: NO `imports`
 * array at all, NO controllers, NO `RealtimeModule` — the worker structurally cannot start the
 * HTTP tail or the WS server (roadmap trap 2). `DB_BUNDLE` is a module-local `Symbol`;
 * `app.module.ts`'s copy is not exported, so this module declares its own (measured, spike A).
 *
 * EVERY PROVIDER HERE INJECTS BY TOKEN (`@Inject(...)`), with no exceptions. `start:worker` is
 * `tsx src/worker.ts`, and esbuild (tsx's transformer) does not emit `design:paramtypes` — a
 * class-typed constructor injection would silently receive `undefined` and fail later and
 * elsewhere (spike A measured exactly that booting `AppModule` under `tsx`: it died inside
 * `OpdRealtimeRegistrar.onModuleInit`, not at the point of injection, because the same class
 * resolves fine under ts-jest). This module has no class-typed providers to get wrong, and it
 * must stay that way.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_BUNDLE,
      useFactory: (cfg: AppConfig): DbBundle => createDb(cfg.databaseUrl),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (b: DbBundle): Db => b.db, inject: [DB_BUNDLE] },
    { provide: DB_POOL, useFactory: (b: DbBundle): Pool => b.pool, inject: [DB_BUNDLE] },
    {
      provide: MODULE_REGISTRY,
      useFactory: (): ModuleRegistry => {
        const registry = new ModuleRegistry();
        registry.install(authManifest);
        registry.install(workflowManifest);
        registry.install(approvalsManifest);
        registry.install(patientsManifest);
        registry.install(tariffManifest);
        registry.install(opdManifest);
        registry.install(billingManifest);
        // AMENDMENT 6, THE OTHER HALF OF WHICH IS IN `worker.ts`. This line and
        // `worker.ts`'s `{ [ALERTS_CONSUMER]: alertsConsumer(db) }` are ONE edit: this
        // manifest is the only one in the build that declares a subscription, and
        // `buildSubscriptionBus` turns a declaration with no matching handler into a BOOT
        // ERROR by design (jobs.ts). Install it here without passing the handler there and
        // the worker throws at startup — behind a fully green suite, because every seam test
        // that came before built its own private registry rather than reading THIS one.
        registry.install(alertsManifest);
        // PLAN 10 D13, THE SAME ONE EDIT ONE WAVE LATER: `notifyManifest` declares FIVE
        // subscriptions to `kernel.notify`, and `workerConsumers` below is the only place the
        // handler for that key is produced. Install without that entry and the worker throws at
        // startup (`buildSubscriptionBus`); pass the entry without installing and the gateway
        // hears nothing at all. Both halves live in this file now, which is the point.
        registry.install(notifyManifest);
        // PLAN 09 T6 / DD7, AND IT IS THE SAME ONE EDIT A THIRD TIME. `partnersManifest` declares
        // FOUR billing subscriptions to `partners.accrual`, and `workerConsumers` below is the only
        // place that key's handler is produced. T1 shipped this manifest APP-SIDE ONLY, with
        // `subscriptions: []`, precisely so that no commit ever existed in which a declared
        // subscription had no handler — `buildSubscriptionBus` makes that a BOOT ERROR by design.
        // The four names, this install, the `workerConsumers` entry and
        // `kernel/modules/manifests.test.ts`'s census are ONE commit (§6.0 S2, Plan 10 D13).
        //
        // IT IS INSTALLED UNCONDITIONALLY, AND THAT IS DD7's INVERSION. The obvious reading of
        // "the commission lane ships OFF" is to install this only when COMMISSION_ACCRUAL_ENABLED
        // is set — which is check-on-execute wearing a manifest's clothes and is silently LOSSY: a
        // subscription that never registered has no `event_cursors` row, so flipping the flag
        // later starts from `now` and every earlier payment is gone. The flag decides only whether
        // the handler WRITES; the cursor advances either way.
        registry.install(partnersManifest);
        // PLAN 14 T2 — MATERIALS, AND IT IS THE ONE-EDIT RULE A FOURTH TIME. This manifest ships
        // `subscriptions: []` in THIS commit; T7 lands `consignment.deployed` →
        // `materials.consumption`, the handler in `workerConsumers` below, and the census as ONE
        // commit. It is installed here AND in `ALL_MANIFESTS` — unlike `ops`, `membership`,
        // `formulary` and `resources`, which the worker omits because each is check-on-execute with
        // nothing to consume — because materials carries a subscription (T7) and a daily job
        // (`sweepBatchExpiry`, T8). So `manifests.test.ts` leg 3 stays at FOUR: materials appears
        // on neither side of the difference, which is what "installed in both" looks like there.
        registry.install(materialsManifest);
        // PLAN 15 T2 — THE MINI-OT, AND IT IS THE ONE-EDIT RULE A FIFTH TIME. Unlike the four
        // before it, this manifest ships its subscription IN THIS COMMIT rather than an empty array:
        // `patient.merged` -> `ot.patient_merged`, with `patientMergedConsumer` in `workerConsumers`
        // below and the census in the same commit. The plan says so in as many words — a stub that
        // throws `not_implemented` is NOT acceptable — and the reason is `patient_merge`'s own
        // history: an unregistered approval type threw on every merge on the live box for months
        // because nothing failed loudly at boot. A consumer that boots and refuses is the same lie.
        //
        // It also carries `resourceKinds` (`theatre`), so `collectResourceKinds` below now has two
        // kind-declaring manifests to reconcile rather than one — which is what makes that call a
        // live check in this process rather than a formality.
        registry.install(otManifest);
        // ══ PLAN 13 CLOSE / M2's CARRY-FORWARD, CLOSED HERE (Plan 14 DD2, Spike Q6) ══
        //
        // This is `app.module.ts:73`'s line, in the process that did not have it. Plan 13's close
        // added the collector call to the API and named the worker as a known gap: the worker
        // installs its manifests by hand and called `collectResourceKinds` nowhere, so a manifest
        // declaring `resourceKinds` booted the worker with NEITHER of the seam's two refusals
        // active — a duplicate-kind deployment, or a declaration naming a status outside its own
        // vocabulary, would have started fine and been discovered at the first write.
        //
        // The gap was invisible until now for a precise reason: the only manifest carrying
        // `resourceKinds` was `resourcesManifest`, which the worker deliberately does NOT install.
        // **`materialsManifest` is the first kind-declaring manifest the worker holds**, so this
        // line and the install above are one edit, and Spike Q6 is the evidence that the refusal
        // now exists in the running worker rather than only in a test.
        //
        // The return value is deliberately discarded — the THROW is the whole point, and the write
        // surface takes its declarations as a parameter (kernel/resources/registry.ts's header).
        collectResourceKinds(registry);
        return registry;
      },
    },
  ],
  exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY],
})
export class WorkerModule implements OnModuleDestroy {
  private poolClosed = false;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Own flag, not pg's pool.ended (missing from @types/pg): a double app.close() must stay
    // safe. Copied from AppModule's guard — the tail-vs-pool shutdown race gateway.ts:78-88
    // documents has no analogue here: no child module, no interval (spike A, measured).
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end();
  }
}

/**
 * THE PRODUCTION CONSUMERS MAP, AND THE ONE IMPORTABLE PLACE IT EXISTS.
 *
 * `worker.ts` calls `bootstrap()` at import time, so nothing may import the entry point — which
 * meant that for six commits its `{ [ALERTS_CONSUMER]: alertsConsumer(db) }` literal was
 * unobservable from any test, and a worker that dispatched to nobody survived two opus gates
 * behind a fully green suite (gate report, booked item 1). Every seam test built its OWN
 * registry and its OWN handler map, so none of them could see the map production actually
 * passes. This function is that map, importable, and `worker-runtime.e2e.test.ts` asserts the
 * pairs it produces against the registry a BOOTED `WorkerModule` hands over — so deleting either
 * entry below now fails a test instead of a hospital.
 *
 * It is a plain function, not a provider: `registerAllJobs` is called by the daemon and by the
 * assertions with a `Db` they already hold, and threading a Nest token through would buy a
 * second way to be wrong.
 */
export function workerConsumers(db: Db): Record<string, Handler> {
  return {
    [ALERTS_CONSUMER]: alertsConsumer(db),
    [NOTIFY_CONSUMER]: notifyConsumer(db),
    // PLAN 09 T6 — the other half of the install above. Deleting either fails
    // `worker-runtime.e2e.test.ts`'s whole-equality assertion instead of a hospital's ledger.
    [PARTNERS_ACCRUAL_CONSUMER]: accrualConsumer(db),
    // PLAN 14 T7 / DD13 — the consignment consumer, and it is the SAME ONE EDIT a fourth time.
    // `materialsManifest` declares `consignment.deployed -> materials.consumption` in the commit
    // that adds this line; `buildSubscriptionBus` turns a declaration with no matching handler into
    // a BOOT ERROR, so installing one without the other stops the worker at startup.
    //
    // The event is defined by THIS module and emitted by PLAN 15's mini-OT. Subscribing before a
    // publisher exists is deliberate: the consumer is the half of the interface Plan 14 owes, and
    // the cursor advances from the first boot so nothing is lost between the two phases.
    [MATERIALS_CONSUMPTION_CONSUMER]: consumptionConsumer(db),
    // PLAN 15 T2 / A5 — the other half of the install above. `otManifest` declares
    // `patient.merged` -> `ot.patient_merged` in the commit that adds this line; deleting either
    // fails `worker-runtime.e2e.test.ts`'s whole-equality assertion instead of leaving a merged
    // patient's theatre list pointing at a patient id the registry says does not exist.
    [OT_PATIENT_MERGED_CONSUMER]: patientMergedConsumer(db),
  };
}

/** Where a shutdown says what it did. `console` in the daemon; a recorder in the assertions. */
export type ShutdownLog = {
  log(message: string): void;
  error(message: string, err: unknown): void;
};

/**
 * THE DAEMON'S SIGTERM SEQUENCE — stop the scheduler (which awaits any in-flight run), then
 * close the context (whose `onModuleDestroy` above ends the pool exactly once).
 *
 * IT LIVES HERE, NOT INLINE IN `worker.ts`, FOR ONE REASON: `worker.ts` calls `bootstrap()` at
 * import time, so a test cannot import the entry point without starting a real worker. That is
 * precisely why the shape below shipped unasserted — and unasserted it was
 * EXECUTION-LESSONS §3.48 verbatim: `void (async () => { … })()` with NO `catch`, in the one
 * path that runs while the process is already on its way out. A rejection from
 * `scheduler.stop()` or `ctx.close()` had nobody holding it; node would report it against
 * whatever happened to be running, or lose it in the exit.
 *
 * THE RETURNED PROMISE NEVER REJECTS. Every failure is caught and REPORTED through `logger`,
 * so the caller may `void` it and a shutdown that goes wrong says so instead of vanishing.
 */
export function shutdownWorker(
  scheduler: Pick<Scheduler, "stop">,
  ctx: Pick<INestApplicationContext, "close">,
  logger: ShutdownLog,
): Promise<void> {
  return (async (): Promise<void> => {
    await scheduler.stop();
    logger.log("worker: scheduler stopped, closing context");
    await ctx.close();
    logger.log("worker: context closed, exiting");
  })().catch((err: unknown) => {
    logger.error("worker: shutdown failed", err);
  });
}
