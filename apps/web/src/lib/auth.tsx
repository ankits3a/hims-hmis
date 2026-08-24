import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import { isPasswordChangeRequired } from "./admin-api";

export type Actor = { type: "user" | "agent" | "system"; id: string };

type AuthState = {
  actor: Actor | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [actor, setActor] = useState<Actor | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (getToken() !== null) {
        try {
          const me = await api<{ actor: Actor }>("GET", "/auth/me");
          if (!cancelled) setActor(me.actor);
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
          if (!isPasswordChangeRequired(e)) setToken(null); // stale token — start signed out
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<{ token: string }>("POST", "/auth/login", { username, password });
    setToken(res.token);
    const me = await api<{ actor: Actor }>("GET", "/auth/me");
    setActor(me.actor);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setToken(null);
      setActor(null);
    }
  }, []);

  return <AuthContext.Provider value={{ actor, ready, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
