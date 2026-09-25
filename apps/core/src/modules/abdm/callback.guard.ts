import {
  CanActivate, ExecutionContext, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException,
} from "@nestjs/common";
import { AbdmCallbackAuthError } from "./callback-auth";
import { AbdmRuntime } from "./runtime";
import type { AbdmJwtClaims } from "./callback-auth";
import type { Request } from "express";

export type AbdmCallbackRequest = Request & { abdmClaims?: AbdmJwtClaims };

/**
 * ABDM S0 — the guard on every callback route, and the ONLY authentication those routes have.
 *
 * The routes are `@Public()` to the app's own AuthGuard (ABDM holds no HMIS session), so this guard
 * is the whole gate, and it runs in this order:
 *
 *   1. NOT CONFIGURED → 503 "ABDM not configured". Nothing is verified, logged or dispatched: without
 *      a gateway there is no key to verify against, and a deployment that is off must say so rather
 *      than 401 a caller who may be entirely genuine.
 *   2. The RS256 JWT (`callback-auth.ts`) → 401 on any failure, the reason in the message and in the
 *      server log, never the token. A JWKS the gateway would not serve is OUR failure, not the
 *      caller's: 503, so ABDM retries rather than concluding it was refused.
 */
@Injectable()
export class AbdmCallbackGuard implements CanActivate {
  private readonly log = new Logger("abdm");

  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const verifier = this.runtime.verifier;
    if (verifier === null) throw new ServiceUnavailableException("ABDM not configured");
    const req = ctx.switchToHttp().getRequest<AbdmCallbackRequest>();
    try {
      req.abdmClaims = await verifier.verify(req.headers.authorization);
      return true;
    } catch (e) {
      if (e instanceof AbdmCallbackAuthError) {
        this.log.warn(`callback ${req.method} ${req.path} rejected: ${e.reason}`);
        if (e.reason === "jwks_unavailable") throw new ServiceUnavailableException("ABDM signing keys unavailable");
        throw new UnauthorizedException(`abdm_callback_unauthenticated: ${e.reason}`);
      }
      throw e;
    }
  }
}
