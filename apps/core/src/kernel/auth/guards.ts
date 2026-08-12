import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DB } from "../tokens";
import { findLiveSession } from "./sessions";
import { findAgentByKey } from "./agents";
import { IS_PUBLIC, AuthedRequest } from "./decorators";
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
