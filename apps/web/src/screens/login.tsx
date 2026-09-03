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
import { GITA, PROVERB_LABEL, pickLine } from "./login-verses";
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
 * who cannot yet be identified is the worst version of this product, so this one shows none. The
 * only live thing on it is the clock, in IST, because a hospital clock in the browser's zone is a
 * wrong clock.
 *
 * ═══ THE PANEL CARRIES A VERSE, NOT A PITCH — THE OWNER'S RULING ═══
 *
 * The first version of this panel argued for the product: a lede, a sub, and four capability rows
 * about what the agent does at the reader's seat. The owner threw it out. Nobody signing in at 08:40
 * with a queue at the door is reading a pitch for software they have already been given, and a
 * sign-in screen is the wrong place to sell anything to the people who already work here.
 *
 * What stands there now is one line from the Gita and its meaning in Hinglish, a different one on
 * every page load. The whole risk in that is accuracy, and it is handled one file over in
 * `login-verses.ts`: the Sanskrit and the chapter:verse live in a single frozen table so they cannot
 * drift between `en.json` and `hi.json`, every line was transcribed from source rather than
 * recalled, and the one entry that is a PROVERB rather than scripture — `सेवा ही परम धर्म है` —
 * carries `cite: null` and is labelled a saying, because attributing a proverb to the Gita on the
 * screen an entire hospital sees each morning is the one mistake this panel must not make.
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
  /**
   * ONE PICK PER PAGE LOAD, HELD FOR THE LIFE OF THE MOUNT — and the lazy initialiser is the whole
   * point, not a style choice. `pickLine()` called in the render body would reroll the verse on
   * every re-render of this component, and this component re-renders on the 20-second clock tick,
   * on every keystroke, on Caps Lock, on the reveal button and on the language toggle. A clerk would
   * watch the line change three times a minute while reading it. `useState` runs this once.
   */
  const [line] = useState(() => pickLine());
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
  const hindi = i18next.language.startsWith("hi");
  /*
    The citation, and the reason it is assembled here rather than stored as a finished string: a
    verse prints `गीता 18.46` and anything that is NOT scripture prints the saying label instead.
    `cite` is `null` for exactly those, so there is no path on which a proverb acquires a chapter and
    verse — the type makes the mistake unrepresentable rather than merely unlikely.
  */
  const attribution = line.cite === null ? PROVERB_LABEL : `${GITA} ${line.cite}`;

  /*
    The language reaches the STYLESHEET, not just the strings. `.tag`'s uppercase and letter-spacing
    are Latin assumptions that damage Devanagari (see `login.css`), and a screen that translates its
    words while keeping type rules that fight the script is only half translated.
  */
  return (
    <div className="lg" data-lang={hindi ? "hi" : "en"} data-testid="login-screen">
      {/*
        ══════════ the machine's half ══════════

        `<aside>` and NOT `aria-hidden`. The first draft hid this panel from assistive technology,
        which is the reflex for a marketing column and is wrong here. It was wrong then because the
        panel held four real claims about the software, and it is MORE wrong now that it holds a
        verse: hiding it would hand every sighted colleague a line of scripture each morning and
        give a blind one a blank. `<aside>` makes it a complementary landmark instead — announced,
        and skippable in one keystroke by anybody navigating landmarks, which is the actual need
        behind the reflex. It is deliberately NOT a live region: the line is fixed for the life of
        the page, so there is nothing for a screen reader to announce as a change.
      */}
      <aside className="pine">
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span className="mark" />
          <span className="mo" style={{ fontSize: 14, fontWeight: 700, letterSpacing: ".1em", color: "#fff" }}>
            {t("app.title")}
          </span>
          <span className="tag" style={{ color: "var(--agent-dim)", marginTop: 2 }}>{t("login.product")}</span>
        </div>

        {/*
          Two spacers of different weight rather than one, so the verse sits a little ABOVE the
          optical centre of the panel. Dead centre would put it level with the sign-in button on the
          other half and the two would read as a pair of competing headlines.

          `lang` is set on each line and it is not decoration. All three are Devanagari in EVERY UI
          language, so without it a screen reader pronounces a shloka and its meaning with an English
          voice. `sa` for the verse and `hi` for the two lines under it: they are different languages
          in the same script, and a reader that knows the difference should be told.
        */}
        <div style={{ flexGrow: 1, minHeight: 28 }} />

        <div className="verse rise">
          <div className="cite">{attribution}</div>
          <p className="shloka" lang="sa">{line.shloka}</p>
          <p className="mean" lang="hi">{line.anuvad}</p>
          <p className="gloss" lang="hi">{line.arth}</p>
        </div>

        <div style={{ flexGrow: 1.25, minHeight: 28 }} />

        {/*
          The footer is the only place on this screen with anything live in it, and it is the CLOCK —
          in IST, because the hospital's day is an IST calendar day and a lobby terminal showing the
          browser's zone is a clock nobody can act on.

          The creed `मरीज़ पहले। मशीन बाद में।` used to sit here and the owner dropped it with the
          pitch: the panel now carries one Devanagari line, and a second one underneath it competed
          with the verse for the same job in the same script.
        */}
        <div style={{ borderTop: "1px solid rgba(217,239,228,.09)", paddingTop: 16, display: "flex", alignItems: "center", gap: 10 }}>
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
