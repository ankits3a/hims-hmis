import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";

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
        } catch {
          setToken(null); // stale token — start signed out
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
