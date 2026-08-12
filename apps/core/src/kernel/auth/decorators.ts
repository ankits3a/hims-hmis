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
};
export const PERMISSION_KEY = "hmis:permission";
export const RequirePermission = (
  permission: string,
  scope: PermissionScope,
  opts: { secondFactor?: boolean; breakGlassBypass?: boolean } = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { permission, scope, ...opts } satisfies PermissionRequirement);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.hmisActor) throw new Error("CurrentActor used on a route the AuthGuard did not authenticate");
  return req.hmisActor;
});
