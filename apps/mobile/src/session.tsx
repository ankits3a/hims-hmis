import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import { api, ApiError, NetworkError, xhrPost } from "./api";
import { deviceClaim } from "./device";
import { tokenStore } from "./storage";
import type { EffectivePermissions } from "./seats";

/**
 * Sign-in for the phone, on the server's EXISTING bearer sessions (`POST /auth/login`,
 * `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`). Nothing about who may do
 * what lives here: the server decides every call, and a session expires on the phone exactly
 * when it expires on the web (SESSION_TTL_MINUTES).
 *
 * Fingerprint unlock is a lock on the PHONE, not a second login: with a stored session and an
 * enrolled fingerprint the app opens on "Unlock", and only after the phone confirms the person
 * does it use the token. It never replaces the password and never extends a session.
 */
/** `profile` — the person's own name and role keys, for a header (server since app home round 2; absent from an older one). */
export type MeProfile = { username: string; fullName: string | null; roles: string[] };
export type Me = { actor: { type: string; id: string }; permissions: EffectivePermissions; profile?: MeProfile | null };

export type SessionState =
  | { status: "loading" }
  | { status: "signedOut"; note?: "expired" }
  | { status: "locked" }
  | { status: "mustChange" }
  | { status: "signedIn"; me: Me; username: string; since: string | null };

type Session = {
  state: SessionState;
  login: (username: string, password: string) => Promise<void>;
  unlock: () => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  forgetAndSignIn: () => Promise<void>;
  token: string | null;
  /**
   * A signed call for a screen: the session's token and transport, and ONE place where a session
   * the server has ended (401) returns the phone to sign-in instead of failing screen by screen.
   * `idempotencyKey` rides as the web's `Idempotency-Key` header — for the two writes that must
   * never happen twice (a visit, a bill): a retry with the SAME key is answered, not repeated.
   */
  call: <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string) => Promise<T>;
  /**
   * A signed POST that reports how much of the body has left the phone (0–1) — for a photograph on
   * a slow connection. Same errors as `call` (`ApiError`, `NetworkError`), same 401 handling.
   */
  upload: <T>(path: string, body: unknown, onProgress: (fraction: number) => void) => Promise<T>;
  /** The transport itself, for the one read that is not the API: the update feed (src/update.ts). */
  fetcher: typeof fetch;
};

const Ctx = createContext<Session | null>(null);

export async function biometricReady(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

export function SessionProvider({ children, fetcher }: { children: ReactNode; fetcher?: typeof fetch }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [since, setSince] = useState<string | null>(null);

  /** Ask the server who this token is. Every outcome lands in exactly one state. */
  const resolve = useCallback(
    async (tok: string, username: string, since: string | null): Promise<void> => {
      try {
        const me = await api<Me>("GET", "/auth/me", { token: tok, fetcher });
        setState({ status: "signedIn", me, username, since });
      } catch (e) {
        if (e instanceof ApiError && e.status === 403 && e.code === "password_change_required") {
          setState({ status: "mustChange" });
          return;
        }
        if (e instanceof ApiError && e.status === 401) {
          await tokenStore.clear();
          setToken(null);
          setState({ status: "signedOut", note: "expired" });
          return;
        }
        throw e;
      }
    },
    [fetcher],
  );

  useEffect(() => {
    void (async () => {
      const stored = await tokenStore.get();
      if (stored === null) {
        setState({ status: "signedOut" });
        return;
      }
      setToken(stored.token);
      setUsername(stored.username);
      setSince(stored.since ?? null);
      if (await biometricReady()) {
        setState({ status: "locked" });
        return;
      }
      try {
        await resolve(stored.token, stored.username, stored.since ?? null);
      } catch {
        setState({ status: "locked" });
      }
    })();
  }, [resolve]);

  const login = useCallback(
    async (username: string, password: string) => {
      // M6a — the sign-in names this phone, so an administrator can see it and sign it out (src/device.ts).
      const device = await deviceClaim();
      const { token: tok } = await api<{ token: string }>("POST", "/auth/login", {
        body: { username: username.trim(), password, ...(device === null ? {} : { device }) },
        fetcher,
      });
      const now = new Date().toISOString();
      await tokenStore.set({ token: tok, username: username.trim(), since: now });
      setToken(tok);
      setUsername(username.trim());
      setSince(now);
      await resolve(tok, username.trim(), now);
    },
    [fetcher, resolve],
  );

  const unlock = useCallback(async (): Promise<boolean> => {
    if (token === null) return false;
    if (await biometricReady()) {
      const r = await LocalAuthentication.authenticateAsync({ disableDeviceFallback: false });
      if (!r.success) return false;
    }
    await resolve(token, username, since);
    return true;
  }, [token, username, since, resolve]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (token === null) throw new ApiError(401, "no_session", null);
      await api<void>("POST", "/auth/change-password", { token, body: { currentPassword, newPassword }, fetcher });
      await resolve(token, username, since);
    },
    [token, username, since, fetcher, resolve],
  );

  const forgetAndSignIn = useCallback(async () => {
    await tokenStore.clear();
    setToken(null);
    setState({ status: "signedOut" });
  }, []);

  const logout = useCallback(async () => {
    if (token !== null) {
      try {
        await api<void>("POST", "/auth/logout", { token, fetcher });
      } catch (e) {
        // A phone with no signal still signs out locally; the server session then dies at its TTL.
        if (!(e instanceof NetworkError) && !(e instanceof ApiError)) throw e;
      }
    }
    await forgetAndSignIn();
  }, [token, fetcher, forgetAndSignIn]);

  const call = useCallback(
    async <T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string): Promise<T> => {
      try {
        return await api<T>(method, path, { token, body, fetcher, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await tokenStore.clear();
          setToken(null);
          setState({ status: "signedOut", note: "expired" });
        }
        throw e;
      }
    },
    [token, fetcher],
  );

  const upload = useCallback(
    async <T,>(path: string, body: unknown, onProgress: (fraction: number) => void): Promise<T> => {
      // An injected transport (tests) and a platform with no XHR take the plain road: no progress, same result.
      if (fetcher !== undefined || typeof XMLHttpRequest === "undefined") return call<T>("POST", path, body);
      try {
        return await xhrPost<T>(path, token, body, onProgress);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await tokenStore.clear();
          setToken(null);
          setState({ status: "signedOut", note: "expired" });
        }
        throw e;
      }
    },
    [call, fetcher, token],
  );

  const value = useMemo(
    () => ({ state, login, unlock, changePassword, logout, forgetAndSignIn, token, call, upload, fetcher: fetcher ?? fetch }),
    [state, login, unlock, changePassword, logout, forgetAndSignIn, token, call, upload, fetcher],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useSession outside SessionProvider");
  return v;
}
