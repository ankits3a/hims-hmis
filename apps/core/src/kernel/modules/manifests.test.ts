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
import { materialsManifest } from "../../modules/materials";
import { otManifest } from "../../modules/ot";
import { pcpndtManifest } from "../../modules/pcpndt";
import { radiologyManifest } from "../../modules/radiology";
import { labManifest } from "../../modules/lab";

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
  materialsManifest,
  otManifest,
  labManifest,
  pcpndtManifest,
  radiologyManifest,
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
  it("declares exactly twenty manifests, by key, in app.module.ts's original install order", () => {
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
      // PLAN 14 T2 — appended, so the thirteen above keep the order they were installed in.
      "materials",
      // PLAN 15 T2 — appended, so the fourteen above keep the order they were installed in.
      "ot",
      // PLAN 07c T9 — appended, so the fifteen above keep the order they were installed in. It is
      // KERNEL code carrying a manifest (like `auth`, `workflow`, `approvals`, `alerts`, `ops` and
      // `resources`): the §4 seam is where permissions are DECLARED, and `staff.reports.read` /
      // `staff.reports.drill` are strings nothing else could legitimately declare.
      "desk",
      // PLAN 17 PHASE 0 T5 — appended, so the sixteen above keep the order they were installed in.
      // Kernel code carrying a manifest, the `resources`/`desk` shape: the four `orders.*` strings
      // are declared here or no role can ever hold them.
      "orders",
      // PLAN 17 T2 — appended, so the seventeen above keep the order they were installed in. It is
      // the FIRST manifest to claim an order kind (`lab`), which is phase 0's contract taken up
      // with one field and no kernel edit.
      "lab",
      // PLAN 18a T2 — appended as a PAIR, so the eighteen above keep the order they were installed
      // in. `pcpndt` precedes `radiology` because the dependency runs that way: radiology's
      // `order.placed` consumer evaluates DD14's applicability rule and reaches into the statutory
      // register, and the register reaches into nothing. 15b and 62 install `pcpndt` WITHOUT
      // radiology, which is the whole reason it is a module of its own rather than a table inside
      // one.
      "pcpndt",
      // The SECOND manifest to claim an order kind (`imaging`), and the first to claim a RESOURCE
      // kind that no manifest had claimed before (`device` — the vocabulary the cath lab and
      // biomedical engineering inherit, because `collectResourceKinds` refuses a second declarer).
      "radiology",
      // PLAN 16c T1 — appended, so the twenty above keep the order they were installed in.
      "pharmacy",
    ]);
    expect(ALL_MANIFESTS).toHaveLength(21); // PLAN 16c T1: 20 -> 21, the pharmacy
    // Installable as a set: `ModuleRegistry.install` throws on a duplicate key, so this also
    // pins that no manifest appears twice.
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    expect(registry.all()).toHaveLength(21);
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

  it("the worker's registry differs from ALL_MANIFESTS in exactly six enumerated, intentional ways", () => {
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
    //
    // (1e) PLAN 14 T2 — **THE FOURTEENTH MANIFEST IS THE FIRST SINCE `partners` TO FALL ON NEITHER
    //      SIDE OF THIS DIFFERENCE, AND THE COUNT THEREFORE STAYS AT FOUR.** Every manifest named
    //      in (1)/(1a)/(1c)/(1d) is omitted from the worker because it is check-on-execute with
    //      nothing to consume and no route the worker serves. `materialsManifest` is the opposite
    //      on both counts: it carries a SUBSCRIPTION (T7's `consignment.deployed` →
    //      `materials.consumption`) and a daily JOB (`sweepBatchExpiry`, T8), so the worker
    //      installs it and it appears in NEITHER array below — it is in the SHARED list at the
    //      bottom, which grows from nine to ten.
    //
    //      A thirteenth manifest could not join `ALL_MANIFESTS` without somebody stating which
    //      side of this difference it fell on (the (1d) note). A FOURTEENTH still cannot: this
    //      paragraph is that statement, and the shared array below is where it is mechanically
    //      true. The test's title stays "four" because four is still the answer.
    //
    //  (1f) PLAN 15 T2 — the FIFTEENTH, `ot`, and it falls on the SHARED side for the same two
    //      reasons `materials` does: a subscription and a job. So this array is untouched and the
    //      answer stays four. What is different about it is worth one line, because it breaks a
    //      pattern the four notes above establish: `ot` ships its subscription AND its handler in
    //      the install commit, rather than `subscriptions: []` first, because the plan requires the
    //      real `patient.merged` consumer at T2. The one-edit rule is satisfied either way — what
    //      it forbids is a declared subscription with no handler, never a handler that arrives on
    //      time.
    //
    //      It ships `subscriptions: []` in T2 and lands the one subscription with its handler in
    //      T7 — the (1b) discipline, unchanged, a fourth time.
    //
    //  (1g) PLAN 07c T9 — the SIXTEENTH, `desk`, and it falls on the APP-ONLY side. It carries no
    //      subscription, no desk provider of its own and no job: what it exists for is two
    //      permission strings and one menu entry, and the worker serves no `/staff` route. The
    //      array below therefore GAINS an entry and the title's "four" becomes FIVE — the first
    //      time this list has moved since Plan 11d wrote it, which is why every note above says
    //      "the answer stays four".
    //
    //      **The worker not installing it is SAFE, and that was checked rather than assumed.**
    //      `syncPermissions` is a pure upsert with no delete (`kernel/auth/permissions.ts`), so a
    //      worker boot cannot retire a permission the api declared. And the nightly rollup job DOES
    //      reach the desk providers it needs: `collectDeskProviders` walks the worker's own
    //      registry, which installs `opd` and `billing` — the two manifests that actually carry a
    //      `desk` array. A worker registry missing those would roll EMPTY facts for every person,
    //      every night, silently.
    //
    //  (1h) PLAN 17 PHASE 0 T5 — the SEVENTEENTH, `orders`, and it falls on the APP-ONLY side. It
    //      carries no subscription, no job, no menu and no provider of any kind: what it exists for
    //      is four permission strings, and the worker serves no orders route. The array below
    //      therefore gains an entry and the title's "five" becomes SIX.
    //
    //      **The worker not installing it is SAFE, and that was checked rather than assumed**, the
    //      (1g) discipline: `syncPermissions` is a pure upsert with no delete
    //      (`kernel/auth/permissions.ts`), so a worker boot cannot retire a permission the api
    //      declared. And what the worker DOES need from this phase is not the manifest but the
    //      COLLECTOR — `collectOrderKinds(registry)` is called in `worker.module.ts` as well as in
    //      `app.module.ts`, so a module declaring `orderKinds` meets the seam's three boot refusals
    //      in both processes. Plan 13 shipped a collector the worker never called and Plan 14 had to
    //      close it; this one is wired into both in the commit that creates it.
    expect(allKeys.filter((k) => !workerKeys.includes(k))).toEqual(["ops", "membership", "formulary", "resources", "desk", "orders", "pharmacy"]); // PLAN 16c T1: app-side only until T3 lands its subscription with its handler

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
      // PLAN 14 T2 — see (1e). Installed in BOTH processes, so it is HERE rather than in either
      // difference array above. The worker installs it after `partners`, which is why it is last.
      "materials",
      // PLAN 15 T2 — installed in BOTH, the `materials` case exactly, and for the same two reasons:
      // it carries a SUBSCRIPTION (`patient.merged` → `ot.patient_merged`) and, from T4, a
      // scheduler job. It is the FIRST manifest on this list to ship its subscription and its
      // handler in the SAME commit as its install — the four before it shipped `subscriptions: []`
      // first — because the plan requires the real merge consumer at T2 rather than a stub.
      "ot",
      // PLAN 17 T2 — installed in BOTH, and it is the `formulary` shape rather than the `ot` one:
      // two scheduler jobs (T5's non-return and SLA sweeps) and NO subscription at all. It is also
      // the first manifest in either process to declare `orderKinds`, so `collectOrderKinds` in
      // `worker.module.ts` is a live check from this commit rather than a call over an empty set.
      "lab",
      // PLAN 18a T2 — installed in BOTH, and for a reason neither `ot` nor `lab` had: at this
      // commit both declare `subscriptions: []` and add NO scheduler job. They are in the worker
      // for `hasPermission` — T3's `order.placed` consumer runs in that process and asks whether an
      // actor holds `pcpndt.*`, and a registry that has never seen a permission cannot answer.
      // `pcpndt` before `radiology`, the same order and the same reason as `ALL_MANIFESTS`.
      "pcpndt",
      "radiology",
    ]);
    expect(workerKeys).toHaveLength(15);
  });
});
