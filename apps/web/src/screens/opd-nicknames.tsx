import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { opdErrorMessage } from "../lib/opd-api";

/**
 * ═══ MEDICINE NICKNAMES — WHAT THE HOSPITAL LEARNED, AND THE ONE-TAP UNDO (decisions 0051, 0055) ═══
 *
 * Owner, 2026-10-07: "currently no one adds and no one approves … I am looking this to be automated."
 * So nobody approves a nickname. What the owner has instead is this list — the "Nicknames" tab of
 * OPD masters, beside "Phone consult", behind the same `opd.masters.manage` — and one button a row.
 *
 * Every word here is the hospital's own: the nickname is what a doctor typed, the medicine is the
 * catalogue's full name with its strength and form. NOTHING A MODEL WROTE IS SHOWN — a model only
 * ever picked one of our rows. The screen says "nickname" throughout; "alias" is the code's word.
 *
 *   Suggested — offered to doctors as a suggestion, with a "nickname" tag.
 *   Trusted   — doctors have used it enough that it is offered first.
 *   Removed   — by the owner here (Undo), or by doctors crossing it off. Never offered, never learned again
 *               unless it is put back.
 *
 * It opens with nicknames switched OFF on the server too: the list is then what was learned before,
 * and it can still be undone. The switch itself is a server setting, not a button on this page.
 */
type NicknameRow = {
  id: string; nickname: string; medicine: string | null; detail: string | null;
  state: "suggested" | "trusted" | "removed"; removedBy: "owner" | "doctors" | null;
  doctors: number; taps: number; changedAt: string;
};
type NicknameList = { on: boolean; counts: { suggested: number; trusted: number; removed: number }; items: NicknameRow[] };

const KEY = ["opd", "nicknames"] as const;
const TONE: Record<NicknameRow["state"], { fg: string; bg: string }> = {
  suggested: { fg: "#8a5a10", bg: "#fdf3dc" },
  trusted: { fg: "var(--green)", bg: "var(--green-soft)" },
  removed: { fg: "var(--mut, #55635e)", bg: "var(--line2)" },
};

export function NicknamesAdmin(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: [...KEY, all], queryFn: () => api<NicknameList>("GET", `/opd/consult/nicknames${all ? "?all=1" : ""}`), retry: false });

  const act = async (row: NicknameRow, what: "undo" | "restore"): Promise<void> => {
    setBusy(row.id); setError(null);
    try {
      await api("POST", `/opd/consult/nicknames/${encodeURIComponent(row.id)}/${what}`);
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const day = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  const data = list.data;
  return (
    <section data-testid="nicknames-admin" style={{ display: "grid", gap: 14, maxWidth: 860 }}>
      <header style={{ display: "grid", gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{t("nicknames.title")}</h2>
        <p style={{ margin: 0, fontSize: 13, color: "var(--mut, #55635e)" }}>{t("nicknames.what")}</p>
        {data !== undefined && (
          <p
            role="status" data-testid="nicknames-switch"
            style={{
              margin: 0, padding: "8px 11px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              color: data.on ? "var(--green)" : "#8a5a10", background: data.on ? "var(--green-soft)" : "#fdf3dc",
            }}
          >
            {data.on ? t("nicknames.on") : t("nicknames.off")}
          </p>
        )}
        {data !== undefined && (
          <p data-testid="nicknames-counts" style={{ margin: 0, fontSize: 13 }}>
            {t("nicknames.counts", { suggested: data.counts.suggested, trusted: data.counts.trusted, removed: data.counts.removed })}
          </p>
        )}
      </header>

      <div role="group" aria-label={t("nicknames.rangeLabel")} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className={all ? "sec" : "pri"} aria-pressed={!all} data-testid="nicknames-week" onClick={() => { setAll(false); }}>{t("nicknames.week")}</button>
        <button type="button" className={all ? "pri" : "sec"} aria-pressed={all} data-testid="nicknames-all" onClick={() => { setAll(true); }}>{t("nicknames.all")}</button>
      </div>

      {error !== null && <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
      {list.isError && <p role="alert" data-testid="nicknames-error" style={{ margin: 0, fontSize: 13, color: "var(--red)" }}>{opdErrorMessage(list.error)}</p>}
      {data !== undefined && data.items.length === 0 && (
        <p data-testid="nicknames-empty" style={{ margin: 0, fontSize: 13, color: "var(--faint)" }}>{all ? t("nicknames.emptyAll") : t("nicknames.emptyWeek")}</p>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {(data?.items ?? []).map((r) => (
          <li
            key={r.id} data-testid={`nickname-${r.id}`}
            style={{
              display: "flex", flexWrap: "wrap", gap: "8px 14px", alignItems: "center", padding: "11px 13px",
              border: "1px solid var(--line)", borderRadius: 10, background: "var(--card)", opacity: r.state === "removed" ? 0.88 : 1,
            }}
          >
            <div style={{ flex: "1 1 260px", minWidth: 0, display: "grid", gap: 3 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, overflowWrap: "anywhere" }}>
                <span data-testid={`nickname-term-${r.id}`}>“{r.nickname}”</span>
                <span aria-hidden="true" style={{ margin: "0 7px", color: "var(--faint)", fontWeight: 400 }}>→</span>
                <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{t("nicknames.means")}</span>
                <span data-testid={`nickname-medicine-${r.id}`} style={{ fontWeight: 600 }}>{r.medicine ?? t("nicknames.medicineGone")}</span>
              </div>
              {r.detail !== null && r.detail !== "" && <div className="mo" style={{ fontSize: 11.5, color: "var(--faint)" }}>{r.detail}</div>}
              <div style={{ fontSize: 12, color: "var(--mut, #55635e)" }}>
                {r.taps === 0 && r.doctors === 0 ? t("nicknames.unused") : `${t("nicknames.doctors", { count: r.doctors })} · ${t("nicknames.uses", { count: r.taps })}`} · {day(r.changedAt)}
              </div>
            </div>
            <span
              data-testid={`nickname-state-${r.id}`}
              style={{ flexShrink: 0, padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700, color: TONE[r.state].fg, background: TONE[r.state].bg }}
            >
              {r.state === "removed" ? t(r.removedBy === "doctors" ? "nicknames.state.removedByDoctors" : "nicknames.state.removed") : t(`nicknames.state.${r.state}`)}
            </span>
            {r.state === "removed"
              ? (<button type="button" className="sec" disabled={busy === r.id} data-testid={`nickname-restore-${r.id}`} onClick={() => { void act(r, "restore"); }}>{t("nicknames.restore")}</button>)
              : (<button type="button" className="sec" disabled={busy === r.id} data-testid={`nickname-undo-${r.id}`} onClick={() => { void act(r, "undo"); }}>{t("nicknames.undo")}</button>)}
          </li>
        ))}
      </ul>
    </section>
  );
}
