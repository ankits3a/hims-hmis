import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { SubmitButton } from "../components/submit-button";
import {
  pushSupport, readReachSettings, saveReachSettings, subscribeToPush, unsubscribeFromPush,
} from "../lib/push";
import type { ReachSettingsWire } from "../lib/push";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — `/me/reach`: HOW THIS PERSON IS FOUND
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Linked from the alerts bell's footer, not from the nav: it is a settings page somebody visits
 * twice a year, and a nav row for it would cost every seat a line of chrome for ever.
 *
 * ═══ WHAT IT SHOWS THAT A TOGGLE WOULD NOT ═══
 *
 * A push switch that is simply "on" or "off" hides the three states that actually occur, and
 * they need different words and different buttons: the browser cannot do push at all (an iPhone
 * before the app is installed); the person has never been asked; the person has said no, and
 * the browser will not ask again so the only cure is the site settings panel. A page that says
 * "off" to all three sends somebody to tap a button that cannot work.
 *
 * ═══ AND IT NAMES THE OTHER BROWSERS ═══
 *
 * A person is a set of browsers. The list is what tells a doctor that the desktop at the
 * station she left last month is still subscribed — which is why a push reached nobody when she
 * was on the ward.
 */
const CHANNEL_ORDER = ["web_push", "whatsapp", "sms"] as const;

export function MyReach(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ["me", "reach"], queryFn: readReachSettings });
  const save = useMutation({
    mutationFn: (input: { language?: "en" | "hi"; ladder?: ("web_push" | "whatsapp" | "sms")[] }) =>
      saveReachSettings(input, `reach-${String(Date.now())}`),
    onSuccess: (next) => { qc.setQueryData(["me", "reach"], next); },
  });

  const data: ReachSettingsWire | undefined = settings.data;
  const support = pushSupport();
  const subscribedHere = data !== undefined && data.pushSubscriptions.length > 0;

  const togglePush = async (key: string): Promise<void> => {
    setError(null);
    try {
      if (support === "granted" && subscribedHere) await unsubscribeFromPush(key);
      else if (data?.vapidPublicKey != null) await subscribeToPush(data.vapidPublicKey, key);
      await qc.invalidateQueries({ queryKey: ["me", "reach"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PaperScreen testId="my-reach">
      <div style={{ width: "100%", maxWidth: 640, margin: "0 auto", padding: "22px 16px 48px", display: "flex", flexDirection: "column", gap: 18 }}>
        <ScreenTitle title={t("reach.title")} subtitle={t("reach.lead")} />

        {settings.isPending ? <p>{t("reach.loading")}</p> : null}
        {settings.isError ? <p role="alert">{t("reach.failed")}</p> : null}

        {data === undefined ? null : (
          <>
            <section className="box" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{t("reach.language.title")}</h2>
              <div style={{ display: "flex", gap: 8 }}>
                {(["en", "hi"] as const).map((lang) => (
                  <SubmitButton
                    key={lang}
                    data-testid={`reach-language-${lang}`}
                    variant={data.language === lang ? "default" : "ghost"}
                    size="sm"
                    onClick={async () => { await save.mutateAsync({ language: lang }); }}
                  >
                    {t(`reach.language.${lang}`)}
                  </SubmitButton>
                ))}
              </div>
            </section>

            <section className="box" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{t("reach.ladder.title")}</h2>
              <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("reach.ladder.lead")}</p>
              <ol data-testid="reach-ladder" style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
                {data.ladder.map((c) => <li key={c}>{t(`reach.channel.${c}`)}</li>)}
              </ol>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {CHANNEL_ORDER.map((c) => {
                  const on = data.ladder.includes(c);
                  return (
                    <SubmitButton
                      key={c}
                      data-testid={`reach-channel-${c}`}
                      variant={on ? "default" : "ghost"}
                      size="sm"
                      onClick={async () => {
                        // The last channel cannot be removed: a person nothing can reach is a
                        // configuration mistake that looks exactly like "quiet".
                        const next = on ? data.ladder.filter((x) => x !== c) : [...data.ladder, c];
                        if (next.length === 0) { setError(t("reach.ladder.atLeastOne")); return; }
                        await save.mutateAsync({ ladder: next });
                      }}
                    >
                      {t(`reach.channel.${c}`)}
                    </SubmitButton>
                  );
                })}
              </div>
            </section>

            <section className="box" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{t("reach.push.title")}</h2>
              <p data-testid="reach-push-state" style={{ margin: 0, fontSize: 14 }}>
                {data.vapidPublicKey === null
                  ? t("reach.push.notConfigured")
                  : support === "unsupported"
                    ? t("reach.push.unsupported")
                    : support === "denied"
                      ? t("reach.push.denied")
                      : subscribedHere
                        ? t("reach.push.on", { count: data.pushSubscriptions.length })
                        : t("reach.push.off")}
              </p>
              {data.vapidPublicKey !== null && support !== "unsupported" && support !== "denied" ? (
                <SubmitButton
                  data-testid="reach-push-toggle"
                  variant={subscribedHere ? "ghost" : "default"}
                  size="sm"
                  onClick={togglePush}
                >
                  {subscribedHere ? t("reach.push.turnOff") : t("reach.push.turnOn")}
                </SubmitButton>
              ) : null}
              {data.pushSubscriptions.length > 0 ? (
                <ul data-testid="reach-push-browsers" style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--dim)" }}>
                  {data.pushSubscriptions.map((s) => (
                    <li key={s.id}>{s.userAgent ?? t("reach.push.unknownBrowser")}</li>
                  ))}
                </ul>
              ) : null}
            </section>

            <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>
              {data.consentAt === null ? t("reach.consent.none") : t("reach.consent.given")}
            </p>
          </>
        )}

        {error === null ? null : <p role="alert" data-testid="reach-error">{error}</p>}
      </div>
    </PaperScreen>
  );
}
