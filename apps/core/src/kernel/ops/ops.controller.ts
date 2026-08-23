import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param,
  Post,
} from "@nestjs/common";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { withTx } from "../db/client";
import { operatingModeChanges } from "../db/schema";
import { OPERATING_MODES, ModeError, changeOperatingMode, getOperatingMode } from "./mode";
import { OPS_INTERFACE_MANAGE, OPS_MODE_SET } from "./manifest";
import { getLatestValidationReport, runConfigValidation } from "./validate";
import {
  InterfaceError, deactivateInterface, interfaceRegistrationSchema, listInterfaces,
  recordHeartbeat, registerInterface,
} from "./interfaces";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { ModeErrorCode, OperatingMode } from "./mode";
import type { ConfigValidationReport, LatestValidationReport } from "./validate";
import type { HeartbeatResult, InterfaceView } from "./interfaces";

// PLAN 11c — THE OPS HTTP SURFACE.
//
// FOUR ROUTES SHIPPED WITH T2 and their permission shape is argued below; T3 HAS SINCE ADDED FOUR
// MORE (the interface registry, in its own section further down, with its own permission
// argument), and T4 adds the downtime-kit routes to THIS FILE in a later wave of this plan — the
// sections are marked so each wave adds its own block and touches nothing else (§2.72: enumerated
// additions, not "change nothing else").
//
// THE PERMISSION SHAPE, and it is a decision rather than a default:
//
//   GET  /ops/mode                      AUTHENTICATED-ONLY — no permission
//   POST /ops/mode                      ops.mode.set (hospital)
//   POST /ops/config-validation         ops.mode.set (hospital)
//   GET  /ops/config-validation/latest  AUTHENTICATED-ONLY — no permission
//
// The two reads mint NO permission on purpose. Every screen in the product renders the mode banner,
// so an `ops.mode.read` would have to be granted to every seeded role to avoid a blank banner for
// half the hospital — which is precisely the trap `kernel/alerts/manifest.ts` records ("minting an
// `alerts.read` permission would oblige every seeded role to hold it… the exact trap that produced
// 'the cashier holds no tariff.read'"). A route that declares no requirement is gated by AuthGuard
// alone; `PermissionGuard` returns true the moment the reflector finds no requirement.
//
// The gate state is a READ for the same reason: the mode desk shows "you cannot leave commissioning
// yet, the last report was red" to whoever is looking at it, and hiding that behind a permission
// would leave the person who CAN act unable to see why they should.
//
// `POST /ops/config-validation` guards on `ops.mode.set` rather than a permission of its own,
// because running the aggregate is the act that AUTHORISES a mode change: the one who may declare
// the hospital open is the one who may produce the evidence for it. A separate `ops.config.validate`
// would be a permission with exactly one holder-set in every plausible role design.

/** Errors → HTTP, defined once (the patients/tariff `toHttp` convention). */
const BAD_REQUEST_CODES = new Set<ModeErrorCode>([
  "mode_note_required", // a caller who forgot an argument
  "mode_commissioning_is_initial_only", // a target no state of the world makes legal
]);

/**
 * THE BODY CARRIES THE CODE AS A FIELD, not folded into a message string.
 *
 * §3.14b's rule is that a bare status code proves nothing and the mechanism must be discriminable
 * from the response — the shipped modules satisfy it by prefixing the message with the code. This
 * controller goes one step further because T5's mode desk RENDERS the refusal to a duty manager at
 * 03:00: `golive_gate_unsatisfied` with `detail: "report_not_ok"` and `detail: "stale_report"` want
 * different sentences on screen, and parsing them back out of a message string would be a screen
 * depending on a server's punctuation.
 */
function toHttp(e: unknown): never {
  if (e instanceof ModeError) {
    const body = { code: e.code, detail: e.detail ?? null, message: e.message };
    if (BAD_REQUEST_CODES.has(e.code)) throw new BadRequestException(body);
    throw new ConflictException(body); // mode_unchanged · golive_gate_unsatisfied
  }
  throw e; // anything unrecognised is a genuine bug: 500, loudly
}

/**
 * T3's own mapper, kept SEPARATE from `toHttp` above rather than folded into it.
 *
 * `ModeError` is a refusal about STATE — a transition the matrix or the go-live gate will not
 * allow — and its whole vocabulary maps to 400/409. `InterfaceError` has exactly one code and it
 * means "no such row", which is a 404 and nothing else. Widening `toHttp` with a second error
 * class and a third status would make T2's four routes depend on a branch none of them can reach.
 */
function interfaceToHttp(e: unknown): never {
  if (e instanceof InterfaceError) {
    throw new NotFoundException({ code: e.code, message: e.message });
  }
  throw e; // anything unrecognised is a genuine bug: 500, loudly
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

const modeChangeBody = z.object({
  to: z.enum(OPERATING_MODES),
  note: z.string().max(2000).nullish(),
});

export type ModeView = {
  mode: OperatingMode;
  /** The instant the CURRENT mode began — null while the hospital has never left commissioning. */
  since: string | null;
  note: string | null;
  reportId: string | null;
};

@Controller("ops")
export class OpsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ───────────────────────────────── operating mode (T2 / D1-D3) ─────────────────────────────────

  /**
   * The banner's read, polled by every open screen. Authenticated-only — see the header.
   *
   * THE MODE WORD COMES FROM `getOperatingMode`, THE SEAM, and not from the row read below, even
   * though both would answer the same thing today. That function owns one rule the banner must
   * never restate: ZERO ROWS IS `commissioning` (Book V1). Recomputing it here would put a second
   * copy of the go-live default in a controller, where a later edit could silently disagree with
   * the guard that refuses to leave it. The second read is display-only — the note and the instant
   * — and it returns nulls on a virgin deployment because there is no change row to describe.
   */
  @Get("mode")
  async currentMode(): Promise<ModeView> {
    const mode = await getOperatingMode(this.db);
    const rows = await this.db
      .select({
        toMode: operatingModeChanges.toMode,
        note: operatingModeChanges.note,
        at: operatingModeChanges.at,
        reportId: operatingModeChanges.reportId,
      })
      .from(operatingModeChanges)
      .orderBy(desc(operatingModeChanges.seq)) // never `id`, never `at` — §3.26 / audit A1
      .limit(1);
    const latest = rows[0];
    if (latest === undefined) return { mode, since: null, note: null, reportId: null };
    return { mode, since: latest.at.toISOString(), note: latest.note, reportId: latest.reportId };
  }

  /**
   * Declare, degrade, recover. `ops.mode.set` at hospital scope is map 1's declare/recover
   * authority — duty-manager role data at go-live; the seeded `admin` holds every manifest
   * permission in dev.
   *
   * The transaction, the matrix, D3's gate and the event all live in `changeOperatingMode`; this
   * handler parses, delegates and maps. `now` is NOT accepted from the body: a caller who could
   * choose the instant could choose one at which a stale validation report is still fresh.
   */
  @RequirePermission(OPS_MODE_SET, "hospital")
  @Post("mode")
  async setMode(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ id: string; from: OperatingMode; to: OperatingMode; note: string | null; reportId: string | null }> {
    const b = parsed(modeChangeBody, body);
    try {
      const result = await withTx(this.db, (tx) =>
        changeOperatingMode(tx, actor, { to: b.to, note: b.note ?? null }),
      );
      return { id: result.id, from: result.from, to: result.to, note: result.note, reportId: result.reportId };
    } catch (e) {
      toHttp(e);
    }
  }

  // ──────────────────────────── the D-17 aggregate (T2 / D5) ────────────────────────────

  /**
   * Run every module validator, persist the verdict, append `ops.config_validated`. This is the
   * HTTP twin of `pnpm validate:config` and it calls exactly the same function — a runbook step and
   * a button that disagreed about what "validated" means would be worse than having only one.
   *
   * It returns 200 with `ok: false` when the configuration is bad. The RUN succeeded; the
   * CONFIGURATION did not, and the per-scope errors are the response. A 4xx here would make "the
   * validator could not be reached" indistinguishable from "the validator says no" — the
   * distinction the script draws with its exit code.
   */
  @RequirePermission(OPS_MODE_SET, "hospital")
  @Post("config-validation")
  async runValidation(): Promise<ConfigValidationReport> {
    return runConfigValidation(this.db);
  }

  /** The gate state the mode desk renders. Authenticated-only — see the header. */
  @Get("config-validation/latest")
  async latestValidation(): Promise<{ report: LatestValidationReport | null }> {
    return { report: await getLatestValidationReport(this.db) };
  }

  // ────────────────────── interfaces — the heartbeat registry (T3 / D6) ──────────────────────
  //
  // THE PERMISSION SHAPE HERE IS SPLIT, and the split is the decision:
  //
  //   GET  /ops/interfaces                 AUTHENTICATED-ONLY — no permission
  //   POST /ops/interfaces                 ops.interface.manage (hospital)
  //   POST /ops/interfaces/:id/deactivate  ops.interface.manage (hospital)
  //   POST /ops/interfaces/:id/heartbeat   AUTHENTICATED-ONLY — no permission
  //
  // MANAGING the registry is administration: who owns a printer and how long it may stay quiet
  // before somebody is woken up is a configuration act, and `ops.interface.manage` is the
  // manifest permission that guards it.
  //
  // A HEARTBEAT IS NOT. It is a liveness WRITE from a DEVICE IDENTITY — an agent actor saying "I
  // am still here", once a minute, forever. Minting a permission for it would oblige every device
  // agent to hold a grant before it could report at all, which turns a monitoring surface into a
  // provisioning problem and makes SILENCE the default failure mode of the thing whose entire job
  // is to notice silence. It is authenticated-only today, and PLAN 12a's AGENT GRANTS ARE ITS
  // FUTURE TIGHTENING: when an agent identity can hold scoped grants, this route takes one.
  //
  // The read mints no permission for the same reason `GET /ops/mode` does not (see the header):
  // the interface list is what the ops desk looks at to see whether the hospital's devices are
  // alive, and a read permission would have to be granted to every role that ever looks.

  /** The registry as the ops desk renders it, in `seq` order. Authenticated-only — see above. */
  @Get("interfaces")
  async interfaces(): Promise<{ interfaces: InterfaceView[] }> {
    return { interfaces: await listInterfaces(this.db) };
  }

  /**
   * Register a device. The body is parsed by the DOMAIN's own schema
   * (`interfaceRegistrationSchema`), not by one restated here, so the 30 s floor and the 180 000
   * default cannot drift between the HTTP edge and the sweep that reads the column.
   */
  @RequirePermission(OPS_INTERFACE_MANAGE, "hospital")
  @Post("interfaces")
  async createInterface(@Body() body: unknown): Promise<InterfaceView> {
    // `safeParse` inline rather than through `parsed()` above: this schema carries a `.default()`,
    // so its INPUT type is not its OUTPUT type and `z.ZodType<T>` (which equates the two) cannot
    // describe it. Same refusal shape — the issue list, as a 400.
    const r = interfaceRegistrationSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return registerInterface(this.db, r.data);
  }

  /** Retire a device: it leaves the SWEEP's population and its status column is left as it stands. */
  @RequirePermission(OPS_INTERFACE_MANAGE, "hospital")
  @Post("interfaces/:id/deactivate")
  async deactivate(@Param("id") id: string): Promise<InterfaceView> {
    try {
      return await deactivateInterface(this.db, id);
    } catch (e) {
      interfaceToHttp(e);
    }
  }

  /**
   * "I am alive." `now` is NOT accepted from the body — a device that could choose its own instant
   * could report a heartbeat from the future and never be swept again.
   */
  @Post("interfaces/:id/heartbeat")
  async heartbeat(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<HeartbeatResult> {
    try {
      return await recordHeartbeat(this.db, actor, id);
    } catch (e) {
      interfaceToHttp(e);
    }
  }

  // ─────────────────────────── T4 adds the downtime-kit routes here ───────────────────────────
}
