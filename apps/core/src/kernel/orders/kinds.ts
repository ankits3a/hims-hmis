import { EPISODE_SERIES } from "../episodes/series";
import type { EpisodeSeriesKey } from "../episodes/series";
import type { ModuleRegistry } from "../modules/loader";
import { OrderError } from "./errors";

/**
 * PLAN 17 PHASE 0 T2 — THE KIND SEAM: what a module must say to become an ordering department.
 *
 * ═══ THE SET OF ORDER KINDS IS **OPEN**, AND THAT IS THE DIFFERENCE FROM `resourceKinds` ═══
 *
 * Read this boundary before adding anything, because the file it transcribes says the opposite and
 * the difference is a decision rather than an oversight.
 *
 * `kernel/resources/kinds.ts` closes its set at ten names and backs them with a CHECK constraint,
 * because a resource's STATUS vocabulary is per-kind and is written into `resource_status_history`
 * forever: an eleventh kind arrives with a vocabulary nothing has ever seen, and a name that is
 * declarable but unstorable fails at an INSERT instead of at boot.
 *
 * **An order kind has no such vocabulary.** Every kind — lab, imaging, medication, blood, diet,
 * nursing, transport, referral — runs the SAME four item states (DD4), and those four are the
 * envelope's own, identical for all of them. There is nothing an eleventh kind could corrupt. So
 * `orders.kind` carries NO CHECK (DD3), the set grows by manifest declaration alone, and no future
 * ordering department needs a kernel edit or a migration to exist.
 *
 * WHAT IS CLOSED INSTEAD IS THE DECLARATION — three boot refusals below — and WHO MAY PLACE, which
 * `placeOrder` decides per actor type (DD6, T3).
 *
 * ═══ TWO NAMES ARE RESERVED AND CLAIMED BY NOBODY ═══
 *
 * `medication` is reserved for Plan 16 (DD9): `modules/opd/prescriptions.ts` is live and printing
 * e-Rx today, and whether that prescription becomes an order of this kind is 16's decision on 16's
 * evidence. `package` is reserved for Plan 26's check-up packages, which will be the first kind to
 * declare `selfOrderable: true`. Reserving the NAMES is what stops either plan inventing a second
 * envelope; nothing in this file enforces the reservation, and the parity test in T6 — which pins
 * the claimed set as EMPTY today — is where a reviewer sees a kind arrive.
 */
export type OrderKindDecl = {
  /**
   * The kind name. OPEN (DD3) — `lab`, `imaging`, `medication`, `blood`, `package`, … — and unique
   * across installed manifests. It is stored on `orders.kind` with no CHECK behind it.
   */
  kind: string;
  /**
   * WHICH DAILY COUNTER MINTS THIS KIND'S `order_no` (DD7). `lab` declares `lab_order` (`L`),
   * `imaging` declares `radiology_order` (`R`). It must be a key `EPISODE_SERIES` already carries:
   * this phase adds no series and no counter.
   *
   * **`lab_specimen` (`S`) is not an order number and must never be declared here.** One order
   * yields several tubes and one tube serves several tests — `series.ts`'s own header says so — so
   * a specimen numbers itself, on the lab's own extension table.
   */
  seriesKey: EpisodeSeriesKey;
  /**
   * The module's OWN permission for placing this kind, e.g. `lab.orders.place`. It must be declared
   * by SOME installed manifest (usually the declaring one), and it is checked IN ADDITION to the
   * kernel's `orders.place`: holding the kernel permission does not make a pharmacist an imaging
   * requester (T3 A5).
   */
  placePermission: string;
  /**
   * DD6 — does this kind need a RESPONSIBLE CLINICIAN? An Indian hospital's medico-legal chain
   * needs the doctor who is answerable for the order distinct from the login that typed it, and a
   * nurse keying a consultant's verbal order is the normal case rather than the exception.
   */
  requiresClinician: boolean;
  /** DD6 / 18a — radiation justification. An imaging kind cannot be placed without a reason. */
  requiresIndication: boolean;
  /**
   * DD6 — may a `patient` actor place this kind themselves? `false` for 17 and 18a; Plan 26's
   * check-up package is what this field exists for. **No `hasPermission` lookup is ever performed
   * on a patient id** whatever this says (22c-A review D11: it returns false, and false aliases).
   */
  selfOrderable: boolean;
};

/**
 * Every order-kind declaration every INSTALLED manifest makes, collected at boot.
 *
 * THERE IS NO SECOND LIST — `ALL_MANIFESTS` already answers "which modules exist" (Plan 11d D2),
 * and `collectProviders` (kernel/search/registry.ts) and `collectResourceKinds`
 * (kernel/resources/kinds.ts) are the two shipped precedents for reading declarations off it rather
 * than growing a registry of one's own. §2.54 applied before the drift instead of after it.
 *
 * THREE REFUSALS, and all three are BOOT errors rather than write-time ones on purpose. A hospital
 * that boots with two modules claiming `lab` has already lost the argument about which one owns the
 * collection queue, and finding out at 09:00 with a phlebotomist waiting is worse than finding out
 * at startup:
 *
 *   · **A kind declared by TWO manifests throws** (`duplicate_kind`, the `duplicate_provider` and
 *     `duplicate_kind` precedents). Two declarations for one kind means `order_no`'s SERIES depends
 *     on which one a reader happened to find — an order numbered `R…` resolved by the lab.
 *   · **A `seriesKey` outside `EPISODE_SERIES` throws** (`unknown_series`). Without this the
 *     failure surfaces as `nextEpisodeNo` throwing INSIDE the placement transaction, at the first
 *     order of the day, with the counter having already been touched.
 *   · **A `placePermission` no manifest declares throws** (`undeclared_permission`, transcribed
 *     from `collectProviders`). `grantPermissionToRole` refuses a permission with no catalog row,
 *     so a kind gated on one is a kind NO role can ever place — silently, for ever.
 *
 * A kind NO installed manifest declares is not an error here — it is simply absent, and
 * `placeOrder` refuses it with `unknown_kind` (T3). That is the distinction A4 exists to prove:
 * `imaging` is a legal string and is not a kind THIS HOSPITAL HAS until Plan 18a installs the
 * manifest that claims it.
 */
export function collectOrderKinds(registry: ModuleRegistry): OrderKindDecl[] {
  const decls = registry.all().flatMap((m) => m.orderKinds ?? []);
  const seen = new Map<string, OrderKindDecl>();
  const declaredPermissions = new Set(registry.allPermissions());
  for (const d of decls) {
    if (seen.has(d.kind)) {
      throw new OrderError(
        "duplicate_kind",
        `two manifests declare the order kind "${d.kind}" — one kind has one series and one ` +
          "queue, and a second declaration makes the order number's letter depend on which " +
          "declaration a reader happened to find",
      );
    }
    if (!(d.seriesKey in EPISODE_SERIES)) {
      throw new OrderError(
        "unknown_series",
        `order kind "${d.kind}" declares seriesKey "${String(d.seriesKey)}", which EPISODE_SERIES ` +
          `does not carry — no number could be minted for it, and the failure would otherwise ` +
          "surface inside the first placement transaction of the day",
      );
    }
    if (!declaredPermissions.has(d.placePermission)) {
      throw new OrderError(
        "undeclared_permission",
        `order kind "${d.kind}" declares placePermission "${d.placePermission}", which no manifest ` +
          "declares — a kind gated on a permission nothing declares is a kind no role can ever place",
      );
    }
    seen.set(d.kind, d);
  }
  return [...seen.values()];
}

/** The declaration for one kind, or `undefined` when no installed manifest claims it. */
export function findOrderKindDecl(
  decls: readonly OrderKindDecl[],
  kind: string,
): OrderKindDecl | undefined {
  return decls.find((d) => d.kind === kind);
}
