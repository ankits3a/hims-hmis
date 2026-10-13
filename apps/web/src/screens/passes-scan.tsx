import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { PassScanAnswer, PassWard } from "@hmis/contracts";
import { listPassWards, passRefusalOf, scanPass } from "../lib/passes-api";
import "../styles/paper-pine.css";
import "./passes.css";

/**
 * E1.3 (#720) — THE GUARD'S PHONE AT THE WARD DOOR (SPEC-ipd-companions §8, §10: 390 px, Hindi first, thumb zone).
 * Pick the door once (remembered on this phone). A handheld scanner types the token and Enter into the box; without
 * one, the guard types or pastes it. One answer fills the screen: a colour AND a word ("Valid · Ward 5B", "Wrong ward",
 * "Outside visiting hours", "Expired") — colour never carries the meaning alone — with the holder's name to check
 * against a face. The patient is never named here.
 *
 * DECIDED: no camera reader in this lane (a camera needs a decoder library and the permission flow; the hospital's
 * guards carry USB/Bluetooth scanners that type). The box keeps focus so the next scan needs no tap.
 */

const DOOR_KEY = "hmis.passes.door";
const TONE: Record<PassScanAnswer["result"], "ok" | "warn" | "bad"> = {
  valid: "ok", wrong_ward: "warn", outside_hours: "warn", paused: "warn", expired: "bad", revoked: "bad", unknown: "bad",
};

function readDoor(): string {
  try { return window.localStorage.getItem(DOOR_KEY) ?? ""; } catch { return ""; }
}
function saveDoor(id: string): void {
  try { window.localStorage.setItem(DOOR_KEY, id); } catch { /* private window: the guard picks again */ }
}

export function PassesScan(): React.ReactElement {
  const { t } = useTranslation();
  const [wards, setWards] = useState<PassWard[]>([]);
  const [door, setDoor] = useState<string>(readDoor);
  const [token, setToken] = useState("");
  const [answer, setAnswer] = useState<PassScanAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<PassScanAnswer[]>([]);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => { listPassWards().then(setWards).catch(() => setWards([])); }, []);
  useEffect(() => { box.current?.focus(); }, [answer]);

  const scan = async (): Promise<void> => {
    const tk = token.trim();
    if (tk === "") return;
    setError(null);
    try {
      const a = await scanPass(tk, door === "" ? undefined : door);
      setAnswer(a);
      setRecent((r) => [a, ...r].slice(0, 5));
    } catch (e) {
      const r = passRefusalOf(e);
      setError(r?.rule ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setToken("");
    }
  };

  const word = (a: PassScanAnswer): string =>
    a.result === "valid" && a.wardName ? `${t("passes.scan.result.valid")} · ${a.wardName}` : t(`passes.scan.result.${a.result}`);

  return (
    <div className="pss">
      <header className="pss-head">
        <h1>{t("passes.scan.title")}</h1>
        <label className="pss-door">
          <span>{t("passes.scan.door")}</span>
          <select value={door} onChange={(e) => { setDoor(e.target.value); saveDoor(e.target.value); }}>
            <option value="">{t("passes.scan.mainGate")}</option>
            {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </header>

      <section className={`pss-answer ${answer === null ? "idle" : TONE[answer.result]}`} aria-live="assertive" data-testid="scan-answer">
        {answer === null ? <span className="pss-word">{t("passes.scan.ready")}</span> : (
          <>
            <span className="pss-icon" aria-hidden="true">{TONE[answer.result] === "ok" ? "✓" : TONE[answer.result] === "warn" ? "!" : "✕"}</span>
            <span className="pss-word">{word(answer)}</span>
            {answer.holderName ? <span className="pss-holder">{answer.holderName}</span> : null}
            {answer.kind ? <span className="pss-kind">{t(`passes.kind.${answer.kind}`)}{answer.bedCode ? ` · ${answer.bedCode}` : ""}</span> : null}
          </>
        )}
      </section>
      {error ? <div className="pss-error" role="alert">{error}</div> : null}

      <form className="pss-form" onSubmit={(e) => { e.preventDefault(); void scan(); }}>
        <label htmlFor="pss-token" className="sr">{t("passes.scan.token")}</label>
        <input id="pss-token" ref={box} value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("passes.scan.token")}
          autoComplete="off" autoCapitalize="off" spellCheck={false} />
        <button type="submit" className="pss-go" disabled={token.trim() === ""}>{t("passes.scan.check")}</button>
      </form>

      {recent.length > 1 ? (
        <ol className="pss-recent" aria-label={t("passes.scan.recent")}>
          {recent.slice(1).map((r) => (
            <li key={r.at} className={TONE[r.result]}><span>{word(r)}</span><span>{r.holderName ?? ""}</span></li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
