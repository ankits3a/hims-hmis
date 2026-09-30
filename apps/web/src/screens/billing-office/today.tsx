import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hand } from "./hand";
import { SRC_KEY, clockText, needSub, needTitle, pillCls } from "./needs-text";
import type { OfficeView } from "./pages";
import type { WireBillingNeeds, WireNeedRow } from "../../lib/billing-office-api";

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — TODAY: ONE RANKED "NEEDS YOU TODAY" ═══
 *
 * Artboard 1 of the approved billing back office board: the item in hand on the left, its numbered steps
 * and pinned act in the centre, and on the right everything that needs the office today, most urgent
 * first, in ONE list with a chip naming where each row comes from — no filter tabs. What nobody here can
 * act on (a dispute with the bank, a question with the owner) runs on the Clocks, collapsed.
 *
 * Widths (the board's caption): at 1281 and above three columns; up to 1280 the list moves into the
 * centre while nothing is in hand, and behind the header's count while something is; up to 900 the
 * phone layout (artboard 4) — the list is the page and an opened row fills the screen.
 *
 * Keys: ↑↓ move · ⏎ open · A the act · Esc put it back.
 */
type Props = {
  data: WireBillingNeeds | undefined;
  error: string | null;
  phone: boolean;
  /** 1100–1280: the list is a drawer while something is in hand. */
  drawerMode: boolean;
  drawerOpen: boolean;
  onDrawer: (open: boolean) => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onGo: (go: { view: OfficeView; page?: string }) => void;
  onDone: (message: string) => void;
  /** Phone: a row opened full screen; the frame hides its header while it is. */
  onFullScreen: (full: boolean) => void;
};

export function TodayDesk(p: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const rows = useMemo(() => p.data?.rows ?? [], [p.data]);
  const open = rows.filter((r) => r.state === "open");
  const clocks = rows.filter((r) => r.state === "waiting");
  const inHand = rows.find((r) => r.id === p.openId) ?? null;
  const [clocksOpen, setClocksOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // A row that left the feed (acted on) leaves the hand too.
  const { openId, onOpen } = p;
  useEffect(() => { if (openId !== null && p.data !== undefined && inHand === null) onOpen(null); }, [openId, inHand, p.data, onOpen]);
  const { onFullScreen } = p;
  const full = p.phone && inHand !== null;
  useEffect(() => { onFullScreen(full); }, [onFullScreen, full]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const typing = el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing) { if (e.key === "Escape") el.blur(); return; }
      if (e.key === "Escape" && inHand !== null) { e.preventDefault(); onOpen(null); return; }
      if ((e.key === "a" || e.key === "A") && inHand !== null) {
        const act = document.querySelector<HTMLElement>('[data-testid="hand-act"]');
        if (act !== null && !(act as HTMLButtonElement).disabled) { e.preventDefault(); act.click(); }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-need-row]") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? Math.min(buttons.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      buttons[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const chip = (r: WireNeedRow): React.ReactElement => (
    <span className={r.source === "RECON" && r.kind !== "recon_missing" ? "src rd" : "src"}>{t(`billingOffice.board.src.${SRC_KEY[r.source]}`)}</span>
  );

  const clocksBox = (
    <section className="box" style={{ padding: 0, flexShrink: 0 }} data-testid="office-clocks">
      <button type="button" onClick={() => setClocksOpen((o) => !o)} aria-expanded={clocksOpen} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", minHeight: 44 }}>
        <span className="tag" style={{ flexGrow: 1, whiteSpace: "nowrap" }}>{t("billingOffice.board.today.clocks", { count: clocks.length })}</span>
        {clocks[0] !== undefined && (
          <span style={{ fontSize: 11.5, color: "var(--gold-ink, #9a6208)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {t("billingOffice.board.today.oldest", { clock: clockText(clocks[0], t) })}
          </span>
        )}
        <span aria-hidden="true" style={{ color: "var(--dim)" }}>{clocksOpen ? "▴" : "▾"}</span>
      </button>
      {clocksOpen && (
        <div style={{ padding: "0 6px 6px" }}>
          {clocks.length === 0 && <p style={{ margin: "0 8px 8px", fontSize: 12, color: "var(--dim)" }}>{t("billingOffice.board.today.noClocks")}</p>}
          {clocks.map((c) => (
            <button key={c.id} type="button" className={c.id === p.openId ? "bof-row sel" : "bof-row"} data-testid={`clock-${c.id}`} onClick={() => onOpen(c.id)}>
              {chip(c)}
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span className="t">{needTitle(c, t, i18n.language)}</span>
                <span className="s">{needSub(c, t)}</span>
              </span>
              <span className={pillCls(c)}>{clockText(c, t)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const list = (compact: boolean): React.ReactElement => (
    <div className="box" style={{ overflow: "hidden", flexShrink: 0 }} ref={listRef} data-testid="needs-list">
      {open.map((r, i) => (
        <button key={r.id} type="button" className={r.id === p.openId ? "bof-row sel" : "bof-row"} data-need-row data-testid={`need-${r.id}`}
          aria-pressed={r.id === p.openId} onClick={() => { onOpen(r.id); p.onDrawer(false); }}>
          {!compact && <span className="n mo">{i + 1}</span>}
          {chip(r)}
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <span className="t">{needTitle(r, t, i18n.language)}</span>
            <span className="s">{needSub(r, t)}</span>
          </span>
          <span className={pillCls(r)}>{clockText(r, t)}</span>
        </button>
      ))}
      {p.data !== undefined && open.length === 0 && <p style={{ margin: 0, padding: "12px 14px", fontSize: 12.5, color: "var(--dim)" }} data-testid="needs-empty">{t("billingOffice.board.today.empty")}</p>}
    </div>
  );

  const heading = (big: boolean): React.ReactElement => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
      <h1 style={{ margin: 0, fontSize: big ? 17 : 15, fontWeight: 600 }}>{t("billingOffice.board.today.title")}</h1>
      <span className="dev" style={{ fontSize: 12, color: "var(--dim)" }}>{t("billingOffice.board.today.titleOther")}</span>
      <span style={{ flexGrow: 1 }} />
      <span style={{ fontSize: 11, color: "var(--dim)" }} data-testid="needs-sub">{p.data === undefined ? "" : t("billingOffice.board.today.sub", { count: open.length })}</span>
    </div>
  );

  const errorLine = p.error === null ? null : <p role="alert" data-testid="load-error" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{p.error}</p>;

  if (p.phone) {
    if (inHand !== null) {
      return <Hand key={inHand.id} row={inHand} limits={p.data?.limits ?? null} phone onBack={() => onOpen(null)} onGo={p.onGo} onDone={(m) => { onOpen(null); p.onDone(m); }} />;
    }
    return (
      <div className="pof-pscroll" data-testid="office-today">
        <div style={{ padding: "14px 16px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
          {heading(true)}
          {errorLine}
          {list(true)}
          {clocksBox}
          <div style={{ fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>{t("billingOffice.board.today.noTabs")}</div>
        </div>
      </div>
    );
  }

  const listColumn = (
    <aside className="bof-list" aria-label={t("billingOffice.board.today.title")}>
      {heading(false)}
      {errorLine}
      {list(false)}
      {clocksBox}
      <div style={{ fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>{t("billingOffice.board.today.noTabs")}</div>
    </aside>
  );

  return (
    <div className="pof-body bof-body" data-testid="office-today">
      {inHand === null ? (
        <>
          <aside className="pof-lane" aria-label={t("billingOffice.board.today.inHandAria")} data-testid="in-hand-empty">
            <div style={{ padding: "20px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
              <div className="tag">{t("billingOffice.board.today.nothing.tag")}</div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: "19px", color: "var(--dim)" }}>{t("billingOffice.board.today.nothing.body")}</p>
              <div>
                <div className="tag" style={{ marginBottom: 6 }}>{t("billingOffice.board.today.nothing.keys")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12 }}>
                  {([["↑↓", "move"], ["⏎", "open"], ["A", "act"], ["Esc", "clear"]] as const).map(([k, w]) => (
                    <div key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="kb">{k}</span>{t(`billingOffice.board.today.nothing.${w}`)}</div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
          {p.drawerMode ? <main className="bof-centre bof-centre-list">{listColumn}</main> : (
            <main className="bof-centre bof-idle">
              <p style={{ margin: "auto", maxWidth: 360, textAlign: "center", fontSize: 13, color: "var(--dim)", lineHeight: "19px" }}>{t("billingOffice.board.today.idle")}</p>
            </main>
          )}
          {!p.drawerMode && listColumn}
        </>
      ) : (
        <>
          <Hand key={inHand.id} row={inHand} limits={p.data?.limits ?? null} phone={false} onBack={() => onOpen(null)} onGo={p.onGo} onDone={(m) => { onOpen(null); p.onDone(m); }} />
          {!p.drawerMode && listColumn}
          {p.drawerMode && p.drawerOpen && (
            <div className="bof-drawer" role="dialog" aria-label={t("billingOffice.board.today.title")} data-testid="needs-drawer">
              <button type="button" className="sec" style={{ alignSelf: "flex-end" }} onClick={() => p.onDrawer(false)}>{t("billingOffice.board.today.close")}</button>
              {listColumn}
            </div>
          )}
        </>
      )}
    </div>
  );
}
