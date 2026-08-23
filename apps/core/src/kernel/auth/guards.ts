import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CONFIG, DB } from "../tokens";
import { findLiveSession } from "./sessions";
import { findAgentByKey } from "./agents";
import { IS_PUBLIC, PERMISSION_KEY, AuthedRequest, PermissionRequirement } from "./decorators";
import { hasPermission, requestParam, scopeCtxFromRequest } from "./permissions";
import { recordSecondFactor, secondFactorFresh, verifyTotpCode } from "./totp";
import { hasActiveBreakGlass } from "./break-glass";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

/**
 * PLAN 11e D1 — THE ONLY TWO ROUTES A MUST-CHANGE SESSION MAY REACH, in one place.
 *
 * A person mid-forced-reset has exactly two things left to do: change the password, or leave. The
 * list is a CONSTANT beside the refusal that reads it, rather than a decorator scattered over the
 * handlers, because the question an auditor asks is "what can a locked-out user reach?" — and that
 * question is answered by reading these two lines, not by grepping the tree for a marker.
 *
 * `POST /auth/logout` is here deliberately: refusing it would mean a person handed a temporary
 * password could not put the terminal down without closing the browser.
 */
const PASSWORD_CHANGE_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  "POST /auth/change-password",
  "POST /auth/logout",
]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    const agentKey = req.headers["x-agent-key"];
    if (typeof agentKey === "string" && agentKey !== "") {
      const agent = await findAgentByKey(this.db, agentKey);
      if (!agent) throw new UnauthorizedException();
      if (agent.killSwitch) throw new ForbiddenException("agent kill switch is active");
      req.hmisActor = { type: "agent", id: agent.id };
      return true;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) throw new UnauthorizedException();
    const session = await findLiveSession(this.db, token);
    // 401, and it now covers a DEACTIVATED user too: `findLiveSession` joins `users` and refuses
    // an inactive one at the choke point (11e D1, sessions.ts), so this line needs no new branch
    // and no future route can forget the check.
    if (!session) throw new UnauthorizedException();

    // 403 `password_change_required` — the forced-reset gate (11e D1). It sits AFTER the session
    // resolves and BEFORE the actor is published, so no handler on a guarded route can run while
    // the flag is set. The session itself stays valid: the change-password call travels on this
    // same token, so completing the change needs no second login.
    if (session.mustChangePassword && !PASSWORD_CHANGE_EXEMPT_ROUTES.has(`${req.method} ${req.path}`)) {
      throw new ForbiddenException("password_change_required");
    }

    req.hmisActor = { type: "user", id: session.userId };
    req.hmisSession = session;
    return true;
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!requirement) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const actor = req.hmisActor;
    if (!actor) throw new UnauthorizedException();

    if (actor.type !== "user") {
      // Deliberate Plan-02 seam: agent permission grants arrive with the agent runtime
      // (Plan 12, additive agent_permissions table). Until then agents hold no permissions.
      throw new ForbiddenException("agents hold no permissions yet");
    }

    const allowed = await hasPermission(
      this.db, actor.id, requirement.permission, requirement.scope, scopeCtxFromRequest(req),
    );
    if (!allowed) {
      const bypass =
        requirement.breakGlassBypass === true &&
        (await hasActiveBreakGlass(this.db, actor.id, requestParam(req, "patientId")));
      if (!bypass) throw new ForbiddenException(`missing permission ${requirement.permission}`);
    }

    if (requirement.secondFactor) {
      const session = req.hmisSession;
      if (!session) throw new ForbiddenException("second factor requires a user session");
      if (!secondFactorFresh(session, this.cfg.secondFactorWindowMinutes)) {
        const code = req.headers["x-totp-code"];
        const ok = typeof code === "string" && (await verifyTotpCode(this.db, this.cfg, actor.id, code));
        if (!ok) throw new ForbiddenException("second_factor_required");
        await recordSecondFactor(this.db, session.sessionId);
      }
    }
    return true;
  }
}
