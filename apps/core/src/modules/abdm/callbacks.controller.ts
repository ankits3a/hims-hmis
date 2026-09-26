import {
  BadRequestException, Body, Controller, HttpCode, Inject, NotFoundException, Post, Req, UseGuards,
} from "@nestjs/common";
import { Public } from "../../kernel/auth/decorators";
import { AbdmCallbackGuard } from "./callback.guard";
import { ABDM_CALLBACKS, abdmCallbackHandler, callbackKind } from "./callbacks";
import { insertInbound, markDispatch } from "./messages";
import { INBOUND_SECRET_KEYS, loggableHeaders, redactKeys } from "./redact";
import { AbdmRuntime } from "./runtime";
import type { AbdmCallbackRequest } from "./callback.guard";

const BASE = "abdm/callbacks";
/** The inbound headers worth keeping. The JWT is ABDM's credential, and is recorded as redacted. */
const KEPT_HEADERS = ["request-id", "timestamp", "x-cm-id", "x-hip-id", "x-hiu-id", "content-type", "authorization"];

function header(req: AbdmCallbackRequest, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

/**
 * ═══ ABDM S0 — THE CALLBACK ROUTES ═══
 *
 * `POST /abdm/callbacks/<one of ABDM_CALLBACKS>` — public to the app's user authentication
 * (`@Public()`, the `/health` and `/auth/login` mechanism: the global AuthGuard returns before it
 * reads a session), and guarded instead by ABDM's RS256 JWT (`AbdmCallbackGuard`). Per callback:
 *
 *   1. REQUEST-ID is required — it is the de-duplication key; without it a retry is indistinguishable
 *      from a new message. 400.
 *   2. The message is written to `abdm_messages` (`direction = 'in'`). A REQUEST-ID seen before
 *      inserts nothing, and the route answers 202 WITHOUT dispatching — ABDM retries callbacks, and a
 *      retry must not run a handler twice (two consent notifications, two data pushes).
 *   3. The handler registered for the kind runs; its outcome is recorded on the row (`handled`,
 *      `unhandled`, `failed`). ABDM gets 202 in every case: the message is stored, and a handler's
 *      failure is ours to reprocess from the log, not a reason for ABDM to send it again.
 */
@Controller(BASE)
export class AbdmCallbacksController {
  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  @Public()
  @UseGuards(AbdmCallbackGuard)
  @Post([...ABDM_CALLBACKS])
  @HttpCode(202)
  async receive(@Req() req: AbdmCallbackRequest, @Body() body: unknown): Promise<void> {
    const path = ABDM_CALLBACKS.find((p) => req.path.endsWith(`/${BASE}${p}`));
    if (path === undefined) throw new NotFoundException();
    const requestId = header(req, "request-id");
    if (requestId === null) throw new BadRequestException("REQUEST-ID header is required");
    const kind = callbackKind(path);
    const b = body ?? null;
    const response = typeof b === "object" && b !== null ? (b as { response?: { requestId?: unknown } }).response : undefined;
    const correlationRequestId = typeof response?.requestId === "string" ? response.requestId : null;

    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = header(req, name);
      if (v !== null) kept[name] = v;
    }
    // S2 — the OTP of a link confirm and the link token of on-generate-token never reach the row
    // (`redact.ts` INBOUND_SECRET_KEYS); the handler below still receives the body as ABDM sent it.
    const messageId = await insertInbound(this.runtime.db, {
      kind, path, requestId, correlationRequestId, headers: loggableHeaders(kept),
      body: redactKeys(b, INBOUND_SECRET_KEYS), httpStatus: 202,
    });
    if (messageId === null) return; // a retry of a message we already hold

    const handler = abdmCallbackHandler(kind);
    if (handler === undefined) {
      await markDispatch(this.runtime.db, messageId, "unhandled");
      return;
    }
    try {
      await handler({
        messageId, kind, path, requestId, correlationRequestId,
        hipId: header(req, "x-hip-id"), hiuId: header(req, "x-hiu-id"),
        body: b, claims: req.abdmClaims!,
      });
      await markDispatch(this.runtime.db, messageId, "handled");
    } catch (e) {
      await markDispatch(this.runtime.db, messageId, "failed", (e instanceof Error ? e.message : String(e)).slice(0, 2000));
    }
  }
}
