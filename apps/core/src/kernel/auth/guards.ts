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
    if (!session) throw new UnauthorizedException();
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
