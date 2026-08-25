import type { ModuleManifest } from "../modules/manifest";

export const authManifest: ModuleManifest = {
  key: "auth",
  title: "Users & Access",
  menu: [],
  permissions: [
    "auth.users.manage",
    "auth.roles.manage",
    "auth.agents.manage",
    "auth.break_glass.use",
    "auth.break_glass.review",
    "auth.temp_role.grant",
    /**
     * THE SEVENTH, AND IT IS DELIBERATELY NOT `auth.break_glass.review`.
     *
     * Reviewing a break-glass and reviewing an emergency ELEVATION are the same governance shape
     * but they must not be the same permission, for one structural reason: `temp-roles.ts`'s
     * `ELEVATABLE_AUTH_PERMISSIONS` decides what a person may hand themselves, and this string is
     * NOT on that list. So nobody can self-elevate into the ability to clear their own elevation.
     * One permission covering both acts would have made that loop reachable the day
     * `auth.break_glass.review` became elevatable — which it is, because opening a record at 2 a.m.
     * is the legitimate emergency this mechanism exists for.
     *
     * `seed-admin` grants every string in this array to `admin`, so it has a holder from the first
     * deploy and the reachability census (`seed-roles.test.ts`) closes at 74 = 51 + 23.
     */
    "auth.elevation.review",
  ],
  subscriptions: [],
};
