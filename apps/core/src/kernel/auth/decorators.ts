import { SetMetadata, createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Actor } from "@hmis/contracts";
import type { Request } from "express";
import type { LiveSession } from "./sessions";

export type AuthedRequest = Request & { hmisActor?: Actor; hmisSession?: LiveSession };

export const IS_PUBLIC = "hmis:isPublic";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export type PermissionScope = "department" | "floor" | "hospital";
export type PermissionRequirement = {
  permission: string;
  scope: PermissionScope;
  secondFactor?: boolean;
  breakGlassBypass?: boolean;
  /**
   * OWNER RULING 2026-09-30 — ANY-OF, ADDITIVE. A route may name further permissions that ALSO
   * admit, at the same scope. `permission` stays the primary: it is what every route census reads
   * and what the refusal names, so a holder of NEITHER is refused exactly as before. Use it only for
   * a narrow string that opens a strict subset of what the primary opens (the front desk's one
   * patient's dues, not the invoice list) — never to widen a route.
   */
  alsoAdmits?: readonly string[];
};
export const PERMISSION_KEY = "hmis:permission";
export const RequirePermission = (
  permission: string,
  scope: PermissionScope,
  opts: { secondFactor?: boolean; breakGlassBypass?: boolean; alsoAdmits?: readonly string[] } = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { permission, scope, ...opts } satisfies PermissionRequirement);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.hmisActor) throw new Error("CurrentActor used on a route the AuthGuard did not authenticate");
  return req.hmisActor;
});
