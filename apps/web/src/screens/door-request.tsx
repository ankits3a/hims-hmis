import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cleanRefusal, raiseDoorRequestApi } from "../lib/housekeeping-api";
import type { HkDoorNeed } from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./housekeeping.css";

/*
 * HK-1 (#973) — THE DOOR PAGE at `/door#<token>` (design board "Anyone · Raise a request"). Opened by scanning the QR
 * on a room, toilet or hall door with any phone camera; no login. Pick one of four needs, then Send. Nothing about the person
 * is asked: no name, no phone, no free text (a note could carry a patient's details, spec #973 "no patient data"). The
 * token rides the URL's fragment, which never leaves the browser, so no server or edge log keeps it (the family page's
 * rule); the request carries it in the body. DECIDED: "Linen change" and "Pests" on the board belong to other modules
 * (linen, HK-2) and are not offered here yet.
 */
const NEEDS: readonly { need: HkDoorNeed; minutes: number }[] = [
  { need: "clean", minutes: 30 }, { need: "toilet", minutes: 30 }, { need: "spill", minutes: 15 }, { need: "bin", minutes: 30 },
];

function tokenFromLocation(): string {
  return typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

export function DoorRequest({ token: given }: { token?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const [token] = useState(() => given ?? tokenFromLocation());
  const [need, setNeed] = useState<HkDoorNeed | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  const send = (n: HkDoorNeed | null): void => {
    if (n === null) return;
    setState("sending");
    setProblem(null);
    raiseDoorRequestApi(token, n).then(() => setState("sent"), (e: unknown) => {
      const r = cleanRefusal(e);
      setProblem(r === null ? t("housekeeping.door.failed") : t(`housekeeping.door.refusal.${r.code}`, { defaultValue: `${r.message} ${r.fix}`.trim() }));
      setState("failed");
    });
  };

  return (
    <div className="pp hk-door" data-testid="door-request">
      <header>
        <h1>{t("housekeeping.door.title")}</h1>
        <div className="sub">{t("housekeeping.door.from")}</div>
      </header>
      <main>
        {token === "" ? (
          <p role="alert" className="hk-hint bad">{t("housekeeping.door.noCode")}</p>
        ) : state === "sent" ? (
          <p role="status" className="hk-hint ok" data-testid="door-sent">{t("housekeeping.door.sent")}</p>
        ) : (
          <>
            <span className="tag">{t("housekeeping.door.what")}</span>
            <div className="needs">
              {NEEDS.map((n) => (
                <button
                  key={n.need} type="button" className={`hk-need${n.need === "spill" ? " spill" : ""}${need === n.need ? " on" : ""}`}
                  aria-pressed={need === n.need} disabled={state === "sending"} onClick={() => setNeed(n.need)} data-testid={`door-${n.need}`}
                >
                  <b>{t(`housekeeping.door.need.${n.need}`)}</b>
                  <small>{t("housekeeping.door.within", { count: n.minutes })}</small>
                </button>
              ))}
            </div>
            {problem !== null && <p role="alert" className="hk-hint bad">{problem}</p>}
            <p className="hk-hint">{t("housekeeping.door.goes")}</p>
          </>
        )}
      </main>
      {token !== "" && state !== "sent" && (
        <div className="hk-foot">
          <button type="button" className="hk-primary" disabled={need === null || state === "sending"} onClick={() => send(need)} data-testid="door-send">
            {t("housekeeping.door.send")}
          </button>
        </div>
      )}
    </div>
  );
}
