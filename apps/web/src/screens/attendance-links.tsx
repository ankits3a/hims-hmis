import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { SubmitButton } from "../components/submit-button";
import { useAuth } from "../lib/auth";
import { adminErrorCode, adminErrorMessage, setUserIdentity } from "../lib/admin-api";
import { linkCandidates, linkPerson, listSuggestions, listUnlinked, searchMachinePeople } from "../lib/attendance-links-api";
import type { WireLinkCounts, WireLoginRow, WireMachinePerson, WireSuggestion } from "../lib/attendance-links-api";

const WATCH = "attendance.all.read";
const MANAGE = "auth.users.manage";
type Tab = "unlinked" | "suggestions" | "byHand";
const KEY = ["attendance", "links"] as const;

/**
 * ═══ ATTENDANCE LINKS (#634) — WHO ON THE MACHINE'S LIST IS WHICH LOGIN ═══
 *
 * Three tabs, by permission:
 *   Not linked    — the count to watch and the people still unlinked, with why (owner, committee);
 *   Suggestions   — exact mobile matches, each linked by its own click (the Users administrator);
 *   Link by hand  — find a machine person, see which logins match by mobile or Aadhaar, confirm.
 *
 * The SERVER decides every link: it refuses a pair that matches by neither key, so this screen
 * offers "Link" only on a matching login and offers a login with no match its mobile and Aadhaar
 * boxes instead (the Users screen's own route). The Aadhaar lives only in its box while typed.
 */
export function AttendanceLinks(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const watch = can(WATCH);
  const manage = can(MANAGE);
  const tabs: Tab[] = [...(watch ? (["unlinked"] as const) : []), ...(manage ? (["suggestions", "byHand"] as const) : [])];
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab = chosen !== null && tabs.includes(chosen) ? chosen : tabs[0] ?? null;
  const [notice, setNotice] = useState<string | null>(null);

  // The count: the committee's route when the viewer holds it, else the administrator's search (q empty answers counts only).
  const counts = useQuery({
    queryKey: [...KEY, "counts", watch],
    queryFn: async () => (watch ? (await listUnlinked("")).counts : (await searchMachinePeople("")).counts),
    enabled: watch || manage,
  });

  if (tab === null) {
    return (
      <PaperScreen testId="attendance-links" style={{ padding: "18px 16px" }}>
        <p data-testid="attendance-links-denied" style={{ margin: 0 }}>{t("attendanceLinks.denied")}</p>
      </PaperScreen>
    );
  }

  return (
    <PaperScreen testId="attendance-links" style={{ padding: "16px clamp(16px, 3vw, 22px) 24px", gap: 14, overflowY: "auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t("attendanceLinks.heading")}</h1>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("attendanceLinks.sub")}</span>
      </div>
      {counts.data !== undefined && <CountStrip counts={counts.data} />}

      <div role="tablist" aria-label={t("attendanceLinks.heading")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabs.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === tab} data-testid={`links-tab-${k}`}
            className={k === tab ? "pri" : "sec"} style={{ height: 34, padding: "0 14px", fontSize: 12.5 }}
            onClick={() => { setChosen(k); setNotice(null); }}>
            {t(`attendanceLinks.tab.${k}`)}
          </button>
        ))}
      </div>
      {notice !== null && (
        <p role="status" data-testid="links-notice" className="box" style={{ margin: 0, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, color: "var(--green)", background: "var(--green-soft)", borderColor: "var(--green-line)" }}>{notice}</p>
      )}
      {tab === "unlinked" && <UnlinkedTab />}
      {tab === "suggestions" && <SuggestionsTab onLinked={setNotice} />}
      {tab === "byHand" && <ByHandTab onLinked={setNotice} />}
    </PaperScreen>
  );
}

function CountStrip({ counts }: { counts: WireLinkCounts }): React.ReactElement {
  const { t } = useTranslation();
  const pct = counts.active === 0 ? 0 : Math.round((counts.linked / counts.active) * 100);
  const n = (v: number): string => v.toLocaleString("en-IN");
  return (
    <div className="box" data-testid="links-counts" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
        <span data-testid="links-linked" style={{ fontSize: 22, fontWeight: 700 }}>{t("attendanceLinks.count.linked", { linked: n(counts.linked), active: n(counts.active) })}</span>
        <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("attendanceLinks.count.pct", { pct })}</span>
      </div>
      <div aria-hidden="true" style={{ height: 8, borderRadius: 4, background: "var(--line, #e5e2da)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--green)" }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 12.5 }}>
        <span data-testid="links-unlinked">{t("attendanceLinks.count.unlinked", { n: n(counts.unlinked) })}</span>
        <span data-testid="links-attention" style={{ color: counts.needsAttention > 0 ? "var(--gold)" : undefined, fontWeight: counts.needsAttention > 0 ? 600 : 400 }}>
          {t("attendanceLinks.count.attention", { n: n(counts.needsAttention) })}
        </span>
        <span data-testid="links-logins">{t("attendanceLinks.count.logins", { linked: n(counts.loginsLinked), active: n(counts.loginsActive) })}</span>
      </div>
    </div>
  );
}

function PersonLine({ name, dept, post, pin }: { name: string; dept: string | null; post: string | null; pin: string }): React.ReactElement {
  return (
    <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      <span style={{ fontSize: 11.5, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {[dept, post, `#${pin}`].filter((x) => x !== null && x !== "").join(" · ")}
      </span>
    </span>
  );
}

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid var(--line, #e5e2da)", minWidth: 0 };
const small: React.CSSProperties = { height: 30, padding: "0 12px", fontSize: 12, flexShrink: 0 };

function UnlinkedTab(): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [pages, setPages] = useState(1);
  const list = useQuery({
    queryKey: [...KEY, "unlinked", q, pages],
    queryFn: async () => {
      const first = await listUnlinked(q);
      const people = [...first.people];
      for (let p = 1; p < pages && people.length < first.total; p++) people.push(...(await listUnlinked(q, people.length)).people);
      return { total: first.total, people };
    },
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input className="in" data-testid="unlinked-search" aria-label={t("attendanceLinks.unlinked.search")} placeholder={t("attendanceLinks.unlinked.search")}
        style={{ height: 36, fontSize: 13, maxWidth: 420 }} value={q} onChange={(e) => { setQ(e.target.value); setPages(1); }} />
      {list.data !== undefined && (
        <>
          <span data-testid="unlinked-total" style={{ fontSize: 12, color: "var(--dim)" }}>{t("attendanceLinks.unlinked.total", { n: list.data.total })}</span>
          <div className="box" data-testid="unlinked-rows" style={{ padding: 0 }}>
            {list.data.people.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 12.5 }}>{t("attendanceLinks.unlinked.none")}</p>}
            {list.data.people.map((p) => (
              <div key={p.pin} data-testid={`unlinked-${p.pin}`} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0 }}><PersonLine {...p} /></span>
                <span data-testid={`unlinked-reason-${p.pin}`} style={{ fontSize: 11.5, fontWeight: 600, textAlign: "right", color: p.reason === "no_match" ? "var(--dim)" : "var(--gold)", flexShrink: 0, maxWidth: "45%" }}>
                  {t(`attendanceLinks.reason.${p.reason}`)}
                </span>
              </div>
            ))}
          </div>
          {list.data.people.length < list.data.total && (
            <button type="button" className="sec" data-testid="unlinked-more" style={{ alignSelf: "flex-start" }} onClick={() => setPages((n) => n + 1)}>{t("attendanceLinks.unlinked.more")}</button>
          )}
        </>
      )}
    </div>
  );
}

function linkRefusal(t: (k: string) => string, e: unknown): string {
  const code = adminErrorCode(e);
  const known = ["no_match", "person_linked", "login_linked", "login_inactive", "unknown_person", "user_not_found", "mobile_invalid", "aadhaar_invalid", "aadhaar_key_not_configured"];
  return code !== null && known.includes(code) ? t(`attendanceLinks.error.${code}`) : adminErrorMessage(e);
}

function SuggestionsTab({ onLinked }: { onLinked: (s: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: [...KEY, "suggestions"], queryFn: listSuggestions });
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const keyOf = (s: WireSuggestion): string => `${s.person.pin}:${s.login.userId}`;
  const link = async (s: WireSuggestion): Promise<void> => {
    setError(null);
    try {
      await linkPerson(s.person.pin, s.login.userId);
      onLinked(t("attendanceLinks.linkedNotice", { name: s.person.name, username: s.login.username }));
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) { setError({ key: keyOf(s), text: linkRefusal(t, e) }); }
  };
  if (list.data === undefined) return <span />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("attendanceLinks.suggestions.why")}</p>
      <div className="box" data-testid="suggestion-rows" style={{ padding: 0 }}>
        {list.data.suggestions.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 12.5 }}>{t("attendanceLinks.suggestions.none")}</p>}
        {list.data.suggestions.map((s) => (
          <div key={keyOf(s)} data-testid={`suggestion-${s.person.pin}-${s.login.username}`} style={{ ...rowStyle, flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 180px", minWidth: 0 }}><PersonLine {...s.person} /></span>
            <span style={{ flex: "1 1 160px", minWidth: 0, display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.login.fullName}</span>
              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>
                {s.login.username} · {t("attendanceLinks.suggestions.mobile", { last4: s.last4 })}
                {s.shared && <b data-testid={`suggestion-shared-${s.person.pin}`} style={{ color: "var(--gold)", marginLeft: 6 }}>{t("attendanceLinks.suggestions.shared")}</b>}
              </span>
            </span>
            <SubmitButton plain type="button" className="pri" style={small} data-testid={`suggestion-link-${s.person.pin}-${s.login.username}`} onClick={() => link(s)}>
              {t("attendanceLinks.link")}
            </SubmitButton>
            {error?.key === keyOf(s) && <p role="alert" style={{ flexBasis: "100%", margin: 0, fontSize: 12, color: "var(--red)", fontWeight: 600 }}>{error.text}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ByHandTab({ onLinked }: { onLinked: (s: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const found = useQuery({ queryKey: [...KEY, "search", q], queryFn: () => searchMachinePeople(q), enabled: q.trim().length >= 2, placeholderData: keepPreviousData });
  if (pin !== null) return <PersonPanel pin={pin} onBack={() => setPin(null)} onLinked={onLinked} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input className="in" data-testid="byhand-search" aria-label={t("attendanceLinks.byHand.search")} placeholder={t("attendanceLinks.byHand.search")}
        style={{ height: 36, fontSize: 13, maxWidth: 420 }} value={q} onChange={(e) => setQ(e.target.value)} />
      {found.data !== undefined && q.trim().length >= 2 && (
        <div className="box" data-testid="byhand-rows" style={{ padding: 0 }}>
          {found.data.people.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 12.5 }}>{t("attendanceLinks.byHand.none")}</p>}
          {found.data.people.map((p) => (
            <button key={p.pin} type="button" data-testid={`byhand-person-${p.pin}`} onClick={() => setPin(p.pin)}
              style={{ ...rowStyle, width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--line, #e5e2da)", textAlign: "left", cursor: "pointer" }}>
              <span style={{ flex: 1, minWidth: 0 }}><PersonLine {...p} /></span>
              <PersonState p={p} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonState({ p }: { p: WireMachinePerson }): React.ReactElement {
  const { t } = useTranslation();
  const [word, colour] = p.login !== null ? [t("attendanceLinks.state.linked", { username: p.login.username }), "var(--green)"]
    : p.status !== "active" ? [t("attendanceLinks.state.left"), "var(--dim)"]
      : [t(`attendanceLinks.reason.${p.needsAttention ?? "no_match"}`), p.needsAttention === null ? "var(--dim)" : "var(--gold)"];
  return <span style={{ fontSize: 11.5, fontWeight: 600, color: colour, flexShrink: 0, maxWidth: "45%", textAlign: "right" }}>{word}</span>;
}

function PersonPanel({ pin, onBack, onLinked }: { pin: string; onBack: () => void; onLinked: (s: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<WireLoginRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = useQuery({ queryKey: [...KEY, "candidates", pin, q], queryFn: () => linkCandidates(pin, q), placeholderData: keepPreviousData });
  // keepPreviousData: without it every keystroke in the login search unmounts the panel and its own box.
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: KEY });
  // The confirm sits below both lists: bring it into view, or a "Link" tapped on a phone seems to do nothing.
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (confirm !== null) confirmRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [confirm]);

  const link = async (login: WireLoginRow): Promise<void> => {
    setError(null);
    try {
      await linkPerson(pin, login.userId);
      setConfirm(null);
      onLinked(t("attendanceLinks.linkedNotice", { name: data.data?.person.name ?? pin, username: login.username }));
      await refresh();
    } catch (e) { setError(linkRefusal(t, e)); }
  };

  const person = data.data?.person;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button type="button" className="sec" data-testid="byhand-back" style={{ alignSelf: "flex-start", height: 30, fontSize: 12 }} onClick={onBack}>{t("attendanceLinks.byHand.back")}</button>
      {person !== undefined && (
        <div className="box" data-testid="byhand-person" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1, minWidth: 0 }}><PersonLine {...person} /></span>
          <PersonState p={person} />
        </div>
      )}
      {person !== undefined && person.login === null && (
        <>
          <h2 style={{ margin: 0, fontSize: 13.5 }}>{t("attendanceLinks.byHand.matches")}</h2>
          <div className="box" data-testid="byhand-matches" style={{ padding: 0 }}>
            {data.data!.matches.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 12.5 }}>{t("attendanceLinks.byHand.noMatches")}</p>}
            {data.data!.matches.map((l) => <LoginLine key={l.userId} l={l} onLink={() => { setError(null); setConfirm(l); }} onChanged={refresh} />)}
          </div>
          <h2 style={{ margin: "4px 0 0", fontSize: 13.5 }}>{t("attendanceLinks.byHand.findLogin")}</h2>
          <input className="in" data-testid="byhand-login-search" aria-label={t("attendanceLinks.byHand.findLogin")} placeholder={t("attendanceLinks.byHand.loginSearch")}
            style={{ height: 36, fontSize: 13, maxWidth: 420 }} value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim() !== "" && data.data !== undefined && (
            <div className="box" data-testid="byhand-found" style={{ padding: 0 }}>
              {data.data.found.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 12.5 }}>{t("attendanceLinks.byHand.noLogins")}</p>}
              {data.data.found.map((l) => <LoginLine key={l.userId} l={l} onLink={() => { setError(null); setConfirm(l); }} onChanged={refresh} />)}
            </div>
          )}
        </>
      )}
      {confirm !== null && person !== undefined && (
        <div ref={confirmRef} role="dialog" aria-labelledby="links-confirm-title" className="box" data-testid="byhand-confirm"
          style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
          <span id="links-confirm-title" style={{ fontWeight: 700, fontSize: 13.5 }}>
            {t("attendanceLinks.confirm.title", { name: person.name, pin: person.pin, username: confirm.username })}
          </span>
          <span style={{ fontSize: 12 }}>{t(`attendanceLinks.confirm.by.${confirm.match ?? "mobile"}`)}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <SubmitButton plain type="button" className="pri" data-testid="byhand-confirm-yes" style={small} onClick={() => link(confirm)}>{t("attendanceLinks.confirm.yes")}</SubmitButton>
            <button type="button" className="sec" style={small} onClick={() => setConfirm(null)}>{t("attendanceLinks.confirm.no")}</button>
          </div>
        </div>
      )}
      {error !== null && <p role="alert" data-testid="byhand-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
    </div>
  );
}

/**
 * One login. A MATCHING free login offers "Link"; a free login with no match offers its mobile and
 * Aadhaar boxes (the Users screen's own write), after which the server may already have linked it.
 */
function LoginLine({ l, onLink, onChanged }: { l: WireLoginRow; onLink: () => void; onChanged: () => Promise<void> }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async (body: { mobile?: string; aadhaar?: string }): Promise<void> => {
    setError(null);
    try {
      await setUserIdentity(l.userId, body);
      setMobile(""); setAadhaar(""); setOpen(false);
      await onChanged();
    } catch (e) { setAadhaar(""); setError(linkRefusal(t, e)); }
  };
  return (
    <div data-testid={`login-${l.username}`} style={{ ...rowStyle, flexWrap: "wrap" }}>
      <span style={{ flex: "1 1 180px", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.fullName}</span>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{[l.username, l.staffCode, l.aadhaar].filter((x) => x !== null).join(" · ")}</span>
      </span>
      {l.linkedPin !== null ? (
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--dim)" }}>{t("attendanceLinks.login.taken", { pin: l.linkedPin })}</span>
      ) : l.match !== null ? (
        <>
          <span data-testid={`login-match-${l.username}`} style={{ fontSize: 11.5, fontWeight: 600, color: "var(--green)" }}>{t(`attendanceLinks.login.match.${l.match}`)}</span>
          <button type="button" className="pri" style={small} data-testid={`login-link-${l.username}`} onClick={onLink}>{t("attendanceLinks.link")}</button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("attendanceLinks.login.noMatch")}</span>
          <button type="button" className="sec" style={small} data-testid={`login-give-${l.username}`} onClick={() => setOpen((v) => !v)}>{t("attendanceLinks.login.give")}</button>
        </>
      )}
      {open && (
        <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input className="in mo" inputMode="numeric" autoComplete="off" maxLength={16} data-testid={`login-mobile-${l.username}`} aria-label={t("attendanceLinks.login.mobile")}
            placeholder={t("attendanceLinks.login.mobile")} style={{ flex: "1 1 140px", minWidth: 0, height: 32, fontSize: 13 }} value={mobile} onChange={(e) => setMobile(e.target.value)} />
          <SubmitButton plain type="button" className="sec" style={small} disabled={mobile.trim() === ""} onClick={() => send({ mobile: mobile.trim() })}>{t("attendanceLinks.login.save")}</SubmitButton>
          <input className="in mo" inputMode="numeric" autoComplete="off" maxLength={14} data-testid={`login-aadhaar-${l.username}`} aria-label={t("attendanceLinks.login.aadhaar")}
            placeholder="0000 0000 0000" style={{ flex: "1 1 140px", minWidth: 0, height: 32, fontSize: 13 }} value={aadhaar} onChange={(e) => setAadhaar(e.target.value.replace(/[^\d\s-]/g, ""))} />
          <SubmitButton plain type="button" className="sec" style={small} disabled={aadhaar.trim() === ""} onClick={() => send({ aadhaar: aadhaar.trim() })}>{t("attendanceLinks.login.save")}</SubmitButton>
        </div>
      )}
      {error !== null && <p role="alert" style={{ flexBasis: "100%", margin: 0, fontSize: 12, color: "var(--red)", fontWeight: 600 }}>{error}</p>}
    </div>
  );
}
