import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModuleManifest } from "./manifest";
import { ALL_MANIFESTS } from "./manifests";
import { ModuleRegistry } from "./loader";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { alertsManifest } from "../alerts/manifest";
import { notifyManifest } from "../notify/manifest";
import { opsManifest } from "../ops/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import { membershipManifest } from "../../modules/membership";
import { partnersManifest } from "../../modules/partners";
import { formularyManifest } from "../../modules/formulary";

/**
 * Plan 11d / D2, Book row V4 — `ALL_MANIFESTS` is the ONE list, and a manifest installed outside
 * it fails the build.
 *
 * WITHOUT THE SECOND TEST BELOW THIS FILE'S SUBJECT IS A REFACTOR. With it, it is the mechanism
 * that stops the tenth module repeating MAJOR 4: `seed-admin.ts` granted
 * `registry.allPermissions()` over a registry holding `authManifest` ALONE while `app.module.ts`
 * installed nine, so `admin` held six of fifty-nine declared permissions on a live hospital's
 * deployment and nothing anywhere said so.
 *
 * §2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT. Three things prevent it: both parsers THROW
 * rather than return `[]` on a shape they do not recognise (a missing `for … of ALL_MANIFESTS`
 * loop, a `registry.install()` argument this file cannot resolve to a manifest, an install block
 * with no calls at all); the first test pins the census — TWELVE manifests, by key, IN ORDER —
 * BEFORE anything is compared; and the identifier→manifest map below is deliberate friction, so
 * a new manifest cannot be installed anywhere without this file being edited in the same commit.
 *
 * THE WORKER'S SET IS DIFFERENT ON PURPOSE AND THE THIRD TEST SAYS SO IN AS MANY WORDS, because
 * an unexplained difference between two lists is indistinguishable from the drift D2 exists to
 * abolish.
 */
const SRC_ROOT = resolve(__dirname, "..", "..");
const APP_MODULE = resolve(SRC_ROOT, "app.module.ts");
const WORKER_MODULE = resolve(SRC_ROOT, "kernel", "worker", "worker.module.ts");

/**
 * Every manifest identifier this repository can install, by the NAME it is installed under.
 * An identifier absent from here is an error rather than a skip: silently ignoring an install
 * call the parser cannot resolve is exactly how a parity test passes vacuously.
 */
const MANIFEST_BY_IDENTIFIER: Record<string, ModuleManifest> = {
  authManifest,
  workflowManifest,
  approvalsManifest,
  patientsManifest,
  tariffManifest,
  opdManifest,
  billingManifest,
  alertsManifest,
  opsManifest,
  notifyManifest,
  membershipManifest,
  partnersManifest,
  formularyManifest,
};

/** The argument of every `registry.install(<identifier>)` call, in source order. Throws if there are none. */
function installArguments(source: string, label: string): string[] {
  const args: string[] = [];
  for (const match of source.matchAll(/registry\.install\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const arg = match[1];
    if (arg !== undefined) args.push(arg);
  }
  if (args.length === 0) {
    throw new Error(`${label}: no \`registry.install(<identifier>)\` call found — this parser is stale`);
  }
  return args;
}

/** The loop variable of `for (const <x> of ALL_MANIFESTS)`. Throws when the block no longer consumes the list. */
function allManifestsLoopVariable(source: string, label: string): string {
  const match = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+ALL_MANIFESTS\s*\)/.exec(source);
  const name = match?.[1];
  if (name === undefined) {
    throw new Error(
      `${label}: no \`for (const … of ALL_MANIFESTS)\` loop — the install block has stopped ` +
        `consuming the one list, which is the drift D2 exists to prevent`,
    );
  }
  return name;
}

/** Resolves install-call identifiers to manifest KEYS. Throws on an identifier this file does not know. */
function manifestKeys(identifiers: string[], label: string): string[] {
  return identifiers.map((identifier) => {
    const manifest = MANIFEST_BY_IDENTIFIER[identifier];
    if (manifest === undefined) {
      throw new Error(
        `${label}: registry.install(${identifier}) names a manifest MANIFEST_BY_IDENTIFIER does ` +
          `not carry. Add it there in the same commit that installs it — a manifest this test ` +
          `cannot resolve is a manifest this test cannot check.`,
      );
    }
    return manifest.key;
  });
}

describe("ALL_MANIFESTS is the one manifest list (Plan 11d D2)", () => {
  it("declares exactly thirteen manifests, by key, in app.module.ts's original install order", () => {
    expect(ALL_MANIFESTS.map((m) => m.key)).toEqual([
      "auth",
      "workflow",
      "approvals",
      "patients",
      "tariff",
      "opd",
      "billing",
      "alerts",
      "ops",
      // PLAN 09 T1 — appended, so the nine above keep the order they were installed in.
      "membership",
      "partners",
      // PLAN 16a T2 — appended, so the eleven above keep the order they were installed in.
      "formulary",
      // PLAN 13 T2 — appended, so the twelve above keep the order they were installed in.
      "resources",
    ]);
    expect(ALL_MANIFESTS).toHaveLength(13);
    // Installable as a set: `ModuleRegistry.install` throws on a duplicate key, so this also
    // pins that no manifest appears twice.
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    expect(registry.all()).toHaveLength(13);
  });

  it("V4: app.module.ts installs ALL_MANIFESTS and nothing else", () => {
    const source = readFileSync(APP_MODULE, "utf8");
    const loopVariable = allManifestsLoopVariable(source, "app.module.ts");
    const extras = installArguments(source, "app.module.ts").filter((arg) => arg !== loopVariable);
    // A manifest installed here and absent from ALL_MANIFESTS is MAJOR 4's mechanism: the api
    // would hold it, every seed script would not, and the permissions it declares would be
    // catalogued at boot and granted to nobody, for ever, silently.
    expect(manifestKeys(extras, "app.module.ts")).toEqual([]);
  });

  it("the worker's registry differs from ALL_MANIFESTS in exactly four enumerated, intentional ways", () => {
    const workerKeys = manifestKeys(
      installArguments(readFileSync(WORKER_MODULE, "utf8"), "worker.module.ts"),
      "worker.module.ts",
    );
    const allKeys = ALL_MANIFESTS.map((m) => m.key);

    // (1) The worker OMITS `ops`. `opsManifest` declares no subscription and the worker serves no
    //     ops route, so installing it there would catalog nothing new and subscribe to nothing.
    //
    // (1a) PLAN 09 T1 — the worker also omits `membership`, permanently and for the same reason:
    //      the module is check-on-execute and declares no subscription at all.
    //
    // (1b) PLAN 09 T6 — `partners` HAS NOW MOVED OUT OF THIS LINE and into the shared list at the
    //      bottom, which is what the one-commit rule below looks like once it has been discharged.
    //      T1 shipped `partnersManifest` with `subscriptions: []` and app-side only precisely so
    //      that no commit ever existed in which a declared subscription had no handler — that is a
    //      BOOT ERROR by design (`buildSubscriptionBus`, kernel/worker/jobs.ts). T6 landed the four
    //      DD7 names, `accrualConsumer` in `workerConsumers(db)`, the worker's install and THIS
    //      census as ONE commit (§6.0 S2, Plan 10 D13). The install is unconditional: DD7's whole
    //      inversion is that the consumer registers always and advances its cursor always, and the
    //      COMMISSION_ACCRUAL_ENABLED flag decides only whether the handler writes.
    //
    // (1c) PLAN 16a T2 — the worker also omits `formulary`, permanently and for the SAME reason as
    //      (1a): the module is check-on-execute. `resolveDrugTexts` is called by the prescription
    //      pipeline at issue time; nothing in it is driven by the event stream, so the manifest
    //      ships `subscriptions: []` and installing it in the worker would catalog nothing new and
    //      subscribe to nothing. If a later phase gives the formulary a consumer, its subscriptions
    //      and its worker install land in ONE commit — the (1b) discipline, unchanged.
    //
    // (1d) PLAN 13 T2 — the worker also omits `resources`, and this is the (1)/(1a)/(1c) reason a
    //      fourth time rather than a new one: `resourcesManifest` ships `subscriptions: []` and the
    //      worker serves no resources route, so installing it there would catalog nothing new and
    //      subscribe to nothing. **THE TEST'S OWN TITLE MOVED FROM "three" TO "four" WITH THIS
    //      LINE**, which is the friction working as designed — a thirteenth manifest cannot join
    //      ALL_MANIFESTS without somebody stating which side of this difference it falls on.
    //      If a later phase gives the registry a consumer (Plan 15's assignment stream is the
    //      candidate), its subscriptions and its worker install land in ONE commit — the (1b)
    //      discipline, unchanged.
    expect(allKeys.filter((k) => !workerKeys.includes(k))).toEqual(["ops", "membership", "formulary", "resources"]);

    // (2) The worker ADDS `notify`. It declares five `kernel.notify` subscriptions, and
    //     `buildSubscriptionBus` (kernel/worker/jobs.ts) makes a declared subscription with no
    //     matching handler a BOOT ERROR by design. The handler exists only in `worker.module.ts`'s
    //     `workerConsumers`, so `notifyManifest` may be installed ONLY where that handler is —
    //     installing it in `app.module.ts` would stop the api at startup.
    expect(workerKeys.filter((k) => !allKeys.includes(k))).toEqual(["notify"]);

    // Everything else is shared, and this is the assertion that makes the two lines above a
    // STATEMENT of the difference rather than a licence for any difference at all.
    expect(workerKeys.filter((k) => allKeys.includes(k))).toEqual([
      "auth",
      "workflow",
      "approvals",
      "patients",
      "tariff",
      "opd",
      "billing",
      "alerts",
      // PLAN 09 T6 — see (1b). It is LAST because the worker installs it last, and this array is
      // the worker's own source order rather than `ALL_MANIFESTS`'.
      "partners",
    ]);
    expect(workerKeys).toHaveLength(10);
  });
});
