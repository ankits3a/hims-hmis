import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { isPasswordChangeRequired } from "../lib/admin-api";
import i18next from "../lib/i18n";
import { switchLanguage } from "../lib/i18n";
import { istClock, istDateLabel } from "./desk-one/model";
import "../styles/paper-pine.css";
import "./login.css";

/**
 * PLAN 11e T6 — `password` IS `min(1)` NOW, AND IT WAS `min(8)`.
 *
 * The client-side floor was a copy of a rule the server does not apply at login and, since 11e D3,
 * deliberately never will: `loginSchema` in `auth.controller.ts` is `min(1)` because login VERIFIES
 * a credential that already exists, and a floor there locks out precisely the people the reset flow
 * exists to save. A floor HERE did the same thing one layer up — every live account whose password
 * predates `password-policy.ts` could have been shorter than eight characters and been refused by
 * the sign-in box without a request ever leaving the browser. The choosing rules live on the
 * server, at the paths where a human chooses.
 */
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
type LoginInput = z.infer<typeof loginSchema>;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-10 — THE SIGN-IN SCREEN, AND IT TEACHES THE GRAMMAR OF THE WHOLE SYSTEM BEFORE ANYBODY TYPES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: *"Build a beautiful login page for new age agentic AI Hospital OS assisting humans
 * with the help of AI agent which are co-pilot."*
 *
 * ═══ THE SPLIT IS THE ARGUMENT, NOT A LAYOUT ═══
 *
 * Desk One's legend (§3) sets one rule the entire system obeys: *"anything the AI says or does sits
 * on pine ink. No legend is needed to know what the machine touched."* This screen is where that
 * grammar is taught. The machine's half is pine and the human's half is paper, so by the time a
 * clerk meets a mint chip at the counter they already know, without ever being told, that a machine
 * put it there and a person did not. A login page is the only screen in a hospital system that
 * everybody sees and nobody is busy on — it is the one place that lesson is free.
 *
 * ═══ NOTHING ON THIS SCREEN IS LIVE, AND THAT IS A MEASURED CONSTRAINT ═══
 *
 * The obvious design for an "agentic OS" sign-in is a feed of what the copilot has been doing —
 * and it would have to be invented, because **there is no readable data here**. Every route is
 * guarded: `GET /ops/mode` answers 401 unauthenticated (measured against the running server, not
 * assumed), and so does everything else. A hospital screen that shows plausible numbers to a person
 * who cannot yet be identified is the worst version of this product, so this one shows none. What
 * it shows is either locally true (the clock, in IST, because a hospital clock in the browser's
 * zone is a wrong clock) or a plain claim about what the software does, in the same
 * argue-in-consequences voice the dock uses.
 *
 * ═══ WHAT THE OLD SCREEN DID, WHICH THIS ONE STILL DOES ═══
 *
 * Every behaviour is carried over unchanged and its tests are untouched: labelled fields, a
 * per-field alert on an empty submit, the sign-in failure alert, and 11e D6's forced-change fork.
 */
export function LoginScreen(): React.ReactElement {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [clock, setClock] = useState(() => istClock());
  const { register, handleSubmit, formState } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  useEffect(() => {
    const id = setInterval(() => setClock(istClock()), 20_000);
    return () => clearInterval(id);
  }, []);

  const onSubmit = handleSubmit(async (data) => {
    setFailed(false);
    try {
      await login(data.username, data.password);
      await navigate({ to: "/" });
    } catch (e) {
      /**
       * PLAN 11e T6 / D6 — THE FORCED-CHANGE FORK.
       *
       * `useAuth().login` stores the token and THEN calls `GET /auth/me`, which is a guarded route:
       * for somebody the admin has just provisioned or whose password was just reset, the guard
       * answers 403 `password_change_required` and that call throws. The token is already stored
       * (`api()` clears it only on a 401), so the change-password flow travels on this very
       * session — which is D1's whole point: completing the change needs no second login.
       *
       * Anything else here is an ordinary sign-in failure.
       */
      if (isPasswordChangeRequired(e)) {
        await navigate({ to: "/change-password" });
        return;
      }
      setFailed(true);
    }
  });

  /**
   * Caps Lock, read off the keystroke rather than guessed from the value. It is here because of who
   * uses this screen: a counter clerk signing in at 08:40 with a queue already at the door, on a
   * keyboard somebody else left. A wrong-case password is the most common sign-in failure there is
   * and the only one the browser can warn about before the request goes.
   */
  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    setCapsLock(e.getModifierState("CapsLock"));
  };

  const busy = formState.isSubmitting;
  const caps = [
    { key: "counter", title: t("login.cap.counterTitle"), body: t("login.cap.counter") },
    { key: "till", title: t("login.cap.tillTitle"), body: t("login.cap.till") },
    { key: "floor", title: t("login.cap.floorTitle"), body: t("login.cap.floor") },
    { key: "record", title: t("login.cap.recordTitle"), body: t("login.cap.record") },
  ];

  /*
    The language reaches the STYLESHEET, not just the strings. `.tag`'s uppercase and letter-spacing
    are Latin assumptions that damage Devanagari (see `login.css`), and a screen that translates its
    words while keeping type rules that fight the script is only half translated.
  */
  return (
    <div className="lg" data-lang={i18next.language.startsWith("hi") ? "hi" : "en"} data-testid="login-screen">
      {/*
        ══════════ the machine's half ══════════

        `<aside>` and NOT `aria-hidden`. The first draft hid this panel from assistive technology,
        which is the reflex for a marketing column and is wrong here: it holds four real statements
        about what the software will do at the reader's own seat, and a blind clerk is entitled to
        them. `<aside>` makes it a complementary landmark instead — announced, and skippable in one
        keystroke by anybody navigating landmarks, which is the actual need behind the reflex.
      */}
      <aside className="pine">
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span className="mark" />
          <span className="mo" style={{ fontSize: 14, fontWeight: 700, letterSpacing: ".1em", color: "#fff" }}>
            {t("app.title")}
          </span>
          <span className="tag" style={{ color: "var(--agent-dim)", marginTop: 2 }}>{t("login.product")}</span>
        </div>

        <div style={{ marginTop: 52 }}>
          <h2 className="lede rise">{t("login.lede")}</h2>
          <p className="sub" style={{ marginTop: 16 }}>{t("login.sub")}</p>
        </div>

        <div className="caps" style={{ marginTop: 38 }}>
          {caps.map((cap, i) => (
            <div
              key={cap.key}
              className="cap rise"
              style={{ animationDelay: `${String(80 + i * 70)}ms` }}
            >
              <span className="dot" />
              <span>
                <b className="tag" style={{ marginBottom: 4 }}>{cap.title}</b>
                {cap.body}
              </span>
            </div>
          ))}
        </div>

        <div style={{ flexGrow: 1, minHeight: 24 }} />

        {/*
          The footer is the only place on this screen with anything live in it, and it is the CLOCK —
          in IST, because the hospital's day is an IST calendar day and a lobby terminal showing the
          browser's zone is a clock nobody can act on. The creed below it is in Devanagari with its
          English gloss underneath, which is the Desk One voice rule: the sentence a person actually
          says, then what it means.
        */}
        <div style={{ borderTop: "1px solid rgba(217,239,228,.09)", paddingTop: 16, display: "flex", alignItems: "flex-end", gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div className="dev" style={{ fontSize: 15, color: "#fff" }}>{t("login.creed")}</div>
            <div style={{ fontSize: 11.5, color: "var(--agent-dim)", marginTop: 2 }}>{t("login.creedGloss")}</div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <span className="pulse"><i /><b /></span>
          <span className="mo" style={{ fontSize: 11, color: "var(--agent-dim)", whiteSpace: "nowrap" }}>
            {istDateLabel()} · {clock} IST
          </span>
        </div>
      </aside>

      {/* ══════════ the human's half ══════════ */}
      <main className="paper">
        <div className="sheet">
          <div className="tag" style={{ color: "var(--faint)" }}>{t("login.welcome")}</div>
          <h1 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.02em", margin: "8px 0 0" }}>
            {t("login.title")}
          </h1>
          <p style={{ fontSize: 13, color: "var(--dim)", margin: "6px 0 0", lineHeight: "19px" }}>
            {t("login.issued")}
          </p>

          <form onSubmit={(e) => void onSubmit(e)} style={{ marginTop: 26 }} noValidate>
            <div className="field">
              <label className="tag" htmlFor="username" style={{ color: "var(--dim)" }}>{t("login.username")}</label>
              <input
                id="username"
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={formState.errors.username ? "in mo bad" : "in mo"}
                aria-invalid={formState.errors.username !== undefined}
                {...register("username")}
              />
              {formState.errors.username && (
                <p role="alert" className="msg">{formState.errors.username.message}</p>
              )}
            </div>

            <div className="field">
              <label className="tag" htmlFor="password" style={{ color: "var(--dim)" }}>{t("login.password")}</label>
              <div className="pw">
                <input
                  id="password"
                  type={revealed ? "text" : "password"}
                  autoComplete="current-password"
                  className={formState.errors.password ? "in bad" : "in"}
                  aria-invalid={formState.errors.password !== undefined}
                  onKeyUp={readCaps}
                  onKeyDown={readCaps}
                  {...register("password")}
                />
                {/*
                  A reveal, because the alternative at a counter is worse: three failed attempts, a
                  lockout, and a clerk who now asks a colleague to type it for them. `tabIndex={-1}`
                  keeps it out of the tab path — Tab from the password field belongs on Sign in.
                */}
                <button type="button" tabIndex={-1} onClick={() => setRevealed((v) => !v)}>
                  {revealed ? t("login.hide") : t("login.reveal")}
                </button>
              </div>
              {formState.errors.password && (
                <p role="alert" className="msg">{formState.errors.password.message}</p>
              )}
            </div>

            {capsLock && !revealed ? (
              <div className="note warn" style={{ marginTop: 12 }}>
                <span aria-hidden="true">⇧</span>
                <span>{t("login.capsLock")}</span>
              </div>
            ) : null}

            {failed ? (
              <div role="alert" className="note bad" style={{ marginTop: 12 }}>
                <span aria-hidden="true">✕</span>
                <span>{t("login.failed")}</span>
              </div>
            ) : null}

            <button type="submit" className="go" disabled={busy}>
              {busy ? t("login.signingIn") : t("login.submit")}
              {busy ? null : <span aria-hidden="true">→</span>}
            </button>
          </form>

          <div style={{ marginTop: 26, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{t("login.helpTitle")}</div>
            <p style={{ fontSize: 12, color: "var(--dim)", margin: "4px 0 0", lineHeight: "18px" }}>
              {t("login.help")}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              {/*
                The language toggle belongs HERE more than anywhere else in the application: this is
                the screen a person meets before they have any other control, and the copy on the
                other half of it is the pitch. `switchLanguage` persists the choice, so the desk they
                land on opens in the language they chose at the door.
              */}
              <button type="button" className="lang" onClick={() => switchLanguage(i18next.language === "hi" ? "en" : "hi")}>
                {t("app.language")}
              </button>
              <span style={{ fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>{t("login.shared")}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
