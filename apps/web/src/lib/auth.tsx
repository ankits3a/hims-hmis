import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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

/**
 * A browser left untouched on a shared terminal signs itself out after this long (the server also refuses a browser
 * session idle this long, `SESSION_IDLE_MS`). Screens that poll keep the server session warm, so the browser counts the
 * person's own input. The wall displays — queue boards nobody types at — stay signed in.
 */
export const IDLE_SIGN_OUT_MS = 30 * 60_000;
const DISPLAY_PATHS = ["/opd/display", "/radiology/display"];
export function idleSignOutDue(lastInputAt: number, now: number, path: string): boolean {
  if (DISPLAY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  return now - lastInputAt > IDLE_SIGN_OUT_MS;
}
const INPUT_EVENTS = ["keydown", "pointerdown", "mousemove", "touchstart", "wheel"] as const;
/**
 * Every tab of a browser shares one token, so one tab's sign-out signs them all out. The last input is therefore kept
 * where every tab reads it: a tab nobody looks at must not sign out the person typing in the next one.
 */
export const IDLE_INPUT_KEY = "hmis.lastInputAt";
/** The shared stamp is written at most this often (mousemove fires constantly). */
const SHARE_INPUT_EVERY_MS = 5_000;
function sharedLastInput(): number {
  try {
    const v = Number(localStorage.getItem(IDLE_INPUT_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function shareLastInput(at: number): void {
  try { localStorage.setItem(IDLE_INPUT_KEY, String(at)); } catch { /* storage unavailable: this tab's own clock still counts */ }
}

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

  /* The idle sign-out: only while someone is signed in; any input resets the clock; checked every 15 s. */
  const lastInput = useRef(Date.now());
  useEffect(() => {
    if (actor === null) return;
    lastInput.current = Date.now();
    let sharedAt = lastInput.current;
    shareLastInput(sharedAt);
    const touch = (): void => {
      const now = Date.now();
      lastInput.current = now;
      if (now - sharedAt >= SHARE_INPUT_EVERY_MS) { sharedAt = now; shareLastInput(now); }
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, touch, { passive: true });
    const timer = setInterval(() => {
      const last = Math.max(lastInput.current, sharedLastInput());
      if (idleSignOutDue(last, Date.now(), window.location.pathname)) void logout();
    }, 15_000);
    return () => {
      clearInterval(timer);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, touch);
    };
  }, [actor, logout]);

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
