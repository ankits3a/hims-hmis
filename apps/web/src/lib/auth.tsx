import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, getToken, setToken } from "./api";
import { isPasswordChangeRequired } from "./admin-api";

export type Actor = { type: "user" | "agent" | "system"; id: string };

/**
 * PLAN 11h T6 — what the signed-in person may do, as the server computes it.
 *
 * IT IS PRESENTATION, NEVER ENFORCEMENT. Every route keeps its server-side guard; this exists so
 * the shell stops offering controls the server will refuse — the "dark screens" the 2026-08-24
 * synthetic smoke test found, where sixteen navigation links were rendered to every role alike.
 */
export type EffectivePermissions = {
  hospital: string[];
  scoped: { department: Record<string, string[]>; floor: Record<string, string[]> };
};

const NO_PERMISSIONS: EffectivePermissions = { hospital: [], scoped: { department: {}, floor: {} } };

/**
 * FD-9 — THE NAME ON THE COUNTER, and it is the LOGIN NAME because that is the only one the client
 * is given. `GET /auth/me` returns `{ actor, permissions }` and `actor.id` is a ULID; no route on
 * the API hands a caller their own full name. Desk One's header reads
 * *"Registration · Counter 01 · <person>"*, and a counter whose header says `01M1HK…` is a counter
 * nobody believes. So the username typed at login is kept here, in the browser, alongside the
 * token it was exchanged for — and it is cleared with the token, because a stale name over a fresh
 * session would put the last person's name above this person's work.
 */
const USERNAME_KEY = "hmis.username";

type AuthState = {
  actor: Actor | null;
  permissions: EffectivePermissions;
  /** Hospital-scope check for a menu entry or a palette command. Presentation only. */
  can: (permission: string) => boolean;
  ready: boolean;
  /** The name typed at login, for a screen that must show WHO is at the counter. Null before login. */
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const queryClient = useQueryClient();
  const [actor, setActor] = useState<Actor | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermissions>(NO_PERMISSIONS);
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState<string | null>(() => localStorage.getItem(USERNAME_KEY));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (getToken() !== null) {
        try {
          const me = await api<{ actor: Actor; permissions?: EffectivePermissions }>("GET", "/auth/me");
          if (!cancelled) {
            setActor(me.actor);
            // `?? NO_PERMISSIONS` is not defensive clutter: a browser tab left open across a
            // deploy can hold a session older than this field, and an undefined list must read as
            // "nothing extra", never as a crash on the first render after login.
            setPermissions(me.permissions ?? NO_PERMISSIONS);
          }
        } catch (e) {
          /**
           * PLAN 11e CLOSE (M5) — A 403 `password_change_required` IS NOT A STALE TOKEN.
           *
           * `/auth/me` is a guarded route, so for anybody in the forced-change state it answers
           * 403 — and `api()` deliberately preserves the token on 403, because the change-password
           * call has to travel on that very session (11e D1). This `catch` used to discard it
           * anyway, which meant a RELOAD of `/change-password`, or a direct navigation to it,
           * signed the person out of the one route they were allowed to reach: `beforeLoad` then
           * bounced them to `/login`, or the submit went out with no Authorization header and came
           * back 401. The forced-change flow worked only on the unbroken path straight from the
           * login form. Found by the 11e independent reviewer.
           *
           * Every OTHER failure still clears the token — that is what this line is for.
           */
          if (!isPasswordChangeRequired(e)) setToken(null); // stale token — start signed out (the cache is cleared by logout, not here: screens boot before /auth/me answers)
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (name: string, password: string) => {
    const res = await api<{ token: string }>("POST", "/auth/login", { username: name, password });
    setToken(res.token);
    localStorage.setItem(USERNAME_KEY, name);
    setUsername(name);
    const me = await api<{ actor: Actor; permissions?: EffectivePermissions }>("GET", "/auth/me");
    setActor(me.actor);
    setPermissions(me.permissions ?? NO_PERMISSIONS);
  }, []);

  /**
   * FD-1 CLOSE pass 2 — A LOGOUT EMPTIES THE CACHE. The query client outlives the person: every
   * per-person key (the drawer, the desk, the brief, the doctor's identity, the alerts) stayed
   * cached across a logout and painted for the NEXT login on the same counter tab until its
   * refetch landed — up to five minutes for a key inside `staleTime`. Keying the front-desk
   * screens on the actor closed three consumers; this closes the class.
   */
  const logout = useCallback(async () => {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setToken(null);
      localStorage.removeItem(USERNAME_KEY);
      setUsername(null);
      setActor(null);
      setPermissions(NO_PERMISSIONS);
      queryClient.clear();
    }
  }, [queryClient]);

  const can = useCallback((permission: string) => permissions.hospital.includes(permission), [permissions]);

  return (
    <AuthContext.Provider value={{ actor, permissions, can, ready, username, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
