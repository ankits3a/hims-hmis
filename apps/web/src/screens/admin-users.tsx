import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useCopilot } from "../lib/use-copilot";
import { CopilotReport } from "../components/copilot-report";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import { UserPhones } from "./admin-user-phones";
import { UserIdentity } from "./admin-user-identity";
import { PrintComputers } from "./admin-print-computers";
import { UserDrawer } from "./admin-user-drawer";
import { NewUserDrawer } from "./admin-user-new";
import { RolePicker } from "./admin-role-picker";
import { CHIPS, avatarColour, inChip, initials, matchesQuery, roleTitle, shortTitle } from "./admin-users-model";
import type { Chip } from "./admin-users-model";
import type { NewUserInput } from "./admin-user-new";
import {
  adminErrorCode, adminErrorMessage, assignRole, createUser, deactivateUser, listRoles, listUserIdentity, listUsers,
  reactivateUser, resetPassword, resetPin, revokeRole, setUserIdentity,
} from "../lib/admin-api";
import type { WireAdminUser, WireRole, WireUserIdentity, WireUserRole } from "../lib/admin-api";
import "./admin-users.css";

/**
 * PLAN 11e T6 / D6 — THE USER-ADMINISTRATION DESK, REWORKED (owner 2026-10-09: "With growing number
 * of users, it has been difficult to manage and act smoothly in this screen… rework to make it
 * highly user friendly"; the users board, five drawings, approved: "user screen looks good").
 *
 * A search box and filter chips over a compact list; a person opens in a drawer; ticking rows acts
 * on many. 300 people filter IN MEMORY (`useMemo`, `admin-users-model.ts`) and only the matching rows
 * are drawn.
 *
 * ═══ THE SERVER STAYS AUTHORITATIVE FOR EVERY RULE ═══
 *
 * This screen mints NO client-side permission check, NO password policy, and NO lockout arithmetic.
 * A caller without `auth.users.manage` gets a 403 and it renders inline like every other refusal.
 * The refusals worth their own sentence are `admin_lockout` and `username_taken`. A username made
 * from a name and a first password made in the browser are SUGGESTIONS, sent as typed and judged
 * there.
 *
 * ═══ EVERY WRITE IS A `SubmitButton` (§3.45) ═══ — the ref latch, so a double click is one request.
 *
 * ═══ A REFUSAL RENDERS IN EXACTLY ONE PLACE, WHERE THE EYE IS ═══
 *
 * The open dialog if there is one (reset, the deactivate check, the bulk role picker), else the open
 * drawer, else the rail at the foot of the screen. Two live regions carrying one sentence would be
 * read twice by a screen reader. (The rail exists because a paragraph at the top of a tall page was
 * once measured 1,401 px above the viewport — the box "opened somewhere the operator was not looking".)
 *
 * ═══ THE PICKER REFUSES TO GUESS ═══ — which scopes it may offer (`assignableScopes`), what a role
 * hands over (`permissions`) and whether it confers authority over access (`grantsAccessAuthority`)
 * all come from `GET /admin/roles`. A 403 on that catalogue is not an error: `auth.users.manage`
 * opens this screen, `auth.roles.manage` opens the picker, and a delegate holding only the first
 * sees the roster with no assign control.
 *
 * No role CREATION here: the vocabulary is code-owned (`seed:roles`).
 */
type PendingReset = { user: WireAdminUser; kind: "password" | "pin" };
type Confirm = { users: WireAdminUser[] };

const SearchIcon = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--dim)" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2 16 16" /></svg>
);

export function AdminUsers(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rowError, setRowError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReset | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [phonesOf, setPhonesOf] = useState<WireAdminUser | null>(null);
  const [printComputers, setPrintComputers] = useState(false);
  const [identityOf, setIdentityOf] = useState<WireAdminUser | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [bulkRole, setBulkRole] = useState(false);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const users = useQuery({ queryKey: ["admin", "users"], queryFn: listUsers });
  /** `retry: false`: the expected failure is a 403 (a delegate without `auth.roles.manage`). */
  const catalogue = useQuery({ queryKey: ["admin", "roles"], queryFn: listRoles, retry: false });
  /** Mobile, masked Aadhaar and the attendance link per person. The roster does not wait for it. */
  const identity = useQuery({ queryKey: ["admin", "users", "identity"], queryFn: listUserIdentity, retry: false });

  const roles = catalogue.data?.roles;
  const scope = catalogue.data?.assignableScopes[0] ?? "hospital";
  const all = users.data?.users;
  const rows = useMemo(() => [...(all ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName) || a.username.localeCompare(b.username)), [all]);
  const identityById = useMemo(() => new Map((identity.data?.users ?? []).map((x) => [x.userId, x] as const)), [identity.data]);
  /** `undefined` when the identity list is not readable — then nobody is "not linked", nobody is anything. */
  const identityFor = useCallback((id: string): WireUserIdentity | null | undefined => (identity.data === undefined ? undefined : identityById.get(id) ?? null), [identity.data, identityById]);
  /** `undefined` while the list is in flight: an unloaded screen must not accuse a deployment. */
  const fullAdmins = users.data?.fullAdministrators;

  /** Search and role first; the chips count WITHIN that, so a chip's number is the rows a click on it shows. */
  const narrowed = useMemo(() => rows.filter((u) => matchesQuery(u, query, identityById.get(u.id)?.mobile ?? null)
    && (roleFilter === "" || u.roles.some((r) => r.roleKey === roleFilter))), [rows, query, roleFilter, identityById]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(CHIPS.map((k) => [k, 0])) as Record<Chip, number>;
    for (const u of narrowed) for (const k of CHIPS) if (inChip(k, u, identityFor(u.id))) c[k] += 1;
    return c;
  }, [narrowed, identityFor]);
  const shown = useMemo(() => narrowed.filter((u) => inChip(chip, u, identityFor(u.id))), [narrowed, chip, identityFor]);
  const chips = CHIPS.filter((k) => k !== "notLinked" || identity.data !== undefined);
  const openUser = openId === null ? null : rows.find((u) => u.id === openId) ?? null;
  const picked = rows.filter((u) => selected.has(u.id));
  const roleOptions = useMemo(() => {
    if (roles !== undefined) return [...roles].sort((a, b) => shortTitle(a.title).localeCompare(shortTitle(b.title))).map((r) => ({ key: r.key, title: shortTitle(r.title) }));
    return [...new Set(rows.flatMap((u) => u.roles.map((r) => r.roleKey)))].sort().map((k) => ({ key: k, title: k }));
  }, [roles, rows]);

  /*
    "/" puts the cursor in the search box — but never while somebody is typing in a field, and never
    behind an open dialog. Mounted with the screen and gone with it, so it is this screen's key only.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el !== null && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, []);

  /** BOTH lists: `holders` on the catalogue moves on every assign, revoke, deactivate and reactivate. */
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    await qc.invalidateQueries({ queryKey: ["admin", "roles"] });
  };

  /** A named refusal gets its own sentence; anything else falls back to the server's message. */
  const refusal = (e: unknown): string => {
    const code = adminErrorCode(e);
    if (code === "admin_lockout") return t("adminUsers.error.admin_lockout");
    if (code === "username_taken") return t("adminUsers.error.username_taken");
    if (code === "user_not_found") return t("adminUsers.error.user_not_found");
    if (code === "role_not_found") return t("adminUsers.error.role_not_found");
    return adminErrorMessage(e);
  };

  /** Answers whether the write LANDED, because a refused dialog must stay open. */
  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setRowError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await refresh();
      return true;
    } catch (e) {
      setRowError(refusal(e));
      return false;
    }
  };

  const clearOutcome = (): void => { setRowError(null); setNotice(null); };
  const openReset = (user: WireAdminUser, kind: PendingReset["kind"]): void => { clearOutcome(); setResetValue(""); setPending({ user, kind }); };
  const closeReset = (): void => { setRowError(null); setPending(null); setResetValue(""); };
  const submitReset = async (): Promise<void> => {
    if (pending === null) return;
    const { user, kind } = pending;
    const landed = await run(
      () => (kind === "password" ? resetPassword(user.id, resetValue) : resetPin(user.id, resetValue)),
      t(kind === "password" ? "adminUsers.passwordReset" : "adminUsers.pinReset", { username: user.username }),
    );
    if (!landed) return;
    setPending(null);
    setResetValue("");
  };

  const openPerson = (u: WireAdminUser): void => { clearOutcome(); setCreating(false); setOpenId(u.id); };
  const closePerson = (): void => { setRowError(null); setOpenId(null); };
  const toggle = (id: string): void => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownTicked = shown.length > 0 && shown.every((u) => selected.has(u.id));

  /** Many people, one at a time: the count that landed, and each refusal by NAME. */
  const each = async <T,>(items: readonly T[], name: (x: T) => string, act: (x: T) => Promise<unknown>, done: (n: number) => string): Promise<void> => {
    clearOutcome();
    let n = 0;
    const refused: string[] = [];
    for (const x of items) {
      try { await act(x); n += 1; } catch (e) { refused.push(t("adminUsers.bulk.refusedBy", { name: name(x), why: refusal(e) })); }
    }
    if (n > 0) setNotice(done(n));
    if (refused.length > 0) setRowError(refused.join(" · "));
    await refresh();
  };

  const deactivateConfirmed = async (): Promise<void> => {
    if (confirm === null) return;
    const people = confirm.users.filter((u) => u.active);
    if (people.length === 1) {
      const u = people[0]!;
      const landed = await run(() => deactivateUser(u.id), t("adminUsers.deactivated", { username: u.username }));
      if (landed) { setConfirm(null); setSelected((s) => { const n = new Set(s); n.delete(u.id); return n; }); }
      return;
    }
    setConfirm(null);
    await each(people, (u) => u.username, (u) => deactivateUser(u.id), (n) => t("adminUsers.bulk.deactivatedN", { n }));
    setSelected(new Set());
  };

  const bulkAssign = async (role: WireRole): Promise<void> => {
    const people = picked.filter((u) => !u.roles.some((r) => r.roleKey === role.key));
    setBulkRole(false);
    await each(people, (u) => u.username, (u) => assignRole(u.id, { roleKey: role.key, scopeType: scope as "hospital" }),
      (n) => t("adminUsers.bulk.addedTo", { role: shortTitle(role.title), n }));
  };

  const create = async (v: NewUserInput): Promise<void> => {
    setCreateError(null);
    clearOutcome();
    let id: string;
    try {
      ({ id } = await createUser({ username: v.username, fullName: v.fullName, password: v.password, ...(v.pin === "" ? {} : { pin: v.pin }) }));
    } catch (e) {
      setCreateError(refusal(e));
      return;
    }
    // The account exists now. What follows can be refused one by one without undoing it.
    const refused: string[] = [];
    if (v.mobile !== "") {
      try { await setUserIdentity(id, { mobile: v.mobile }); } catch (e) { refused.push(t("adminUsers.newUser.notSaved", { what: t("adminUsers.drawer.mobile"), why: adminErrorMessage(e) })); }
    }
    for (const key of v.roleKeys) {
      try { await assignRole(id, { roleKey: key, scopeType: scope as "hospital" }); } catch (e) { refused.push(t("adminUsers.newUser.notSaved", { what: roleTitle(key, roles), why: refusal(e) })); }
    }
    setCreating(false);
    setNotice(t("adminUsers.created", { username: v.username }));
    if (refused.length > 0) setRowError(refused.join(" · "));
    setOpenId(id);
    await refresh();
    void qc.invalidateQueries({ queryKey: ["admin", "users", "identity"] });
  };

  // Where a refusal belongs right now (see the header): exactly one of these.
  const errorAt = pending !== null ? "reset" : confirm !== null ? "confirm" : bulkRole ? "bulk" : openUser !== null ? "drawer" : "rail";

  /*
    THE CO-PILOT ON AN ACCESS-CONTROL SCREEN READS AND NEVER ACTS — arithmetic nobody wants to do by
    eye across three hundred rows. No model behind it: an agent that could invent a role holding
    would be inventing a permission.
  */
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const agentState = useRef({ rows, fullAdmins });
  agentState.current = { rows, fullAdmins };
  const localAnswer = useCallback((question: string): string | null => {
    const q = question.toLowerCase();
    const { rows: list, fullAdmins: admins } = agentState.current;
    if (/admin|owner|full/.test(q)) return t("adminUsers.agent.admins", { count: admins ?? 0 });
    if (/inert|scope/.test(q)) {
      const n = list.reduce((acc, u) => acc + u.roles.filter((r) => r.scopeType !== "hospital").length, 0);
      return n === 0 ? t("adminUsers.agent.noInert") : t("adminUsers.agent.inert", { count: n });
    }
    if (/role|permission|access|can do/.test(q)) {
      const none = list.filter((u) => u.roles.length === 0).map((u) => u.username);
      return none.length === 0 ? t("adminUsers.agent.allHaveRoles") : t("adminUsers.agent.noRoles", { list: none.join(", ") });
    }
    if (/how many|count|user|account|active|inactive|list/.test(q)) {
      const active = list.filter((u) => u.active).length;
      return t("adminUsers.agent.counts", { count: list.length, active, inactive: list.length - active });
    }
    return null;
  }, [t]);
  const copilot = useCopilot({ fallback: localAnswer, onNote: (text) => { setAgentLog((l) => logged(l, text)); } });

  const errorLine = (where: typeof errorAt): React.ReactElement | null => (rowError !== null && errorAt === where
    ? <p role="alert" data-testid="admin-row-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{rowError}</p>
    : null);

  // No bottom padding: the Desk Agent bar is the screen's foot, flush on the shell's shortcut line, never 18px above it.
  return (
    <PaperScreen testId="admin-users" style={{ padding: "18px 22px 0", gap: 16 }}>
      <div className="au" style={{ display: "contents" }}>
        <div className="au-head">
          <h1>{t("adminUsers.heading")}</h1>
          <span className="au-count" data-testid="admin-count">{t("adminUsers.list.count", { n: rows.length })}</span>
          <span className="au-grow" />
          {/* Decision 0047 — the counters' print computers are added, watched and removed here. */}
          <button type="button" className="sec" data-testid="open-print-computers" onClick={() => setPrintComputers(true)}>{t("printComputers.open")}</button>
          <button type="button" className="pri au-new" data-testid="admin-new-open" onClick={() => { clearOutcome(); setCreateError(null); setOpenId(null); setCreating(true); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
            {t("adminUsers.list.newUser")}
          </button>
        </div>

        {/*
          PLAN 11f D2 — the takeover rule's mitigation, unmet, said out loud. The COUNT is the server's;
          `status`, not `alert`: a standing condition, not an event.
        */}
        {fullAdmins !== undefined && fullAdmins < 2 && (
          <p role="status" data-testid="admin-two-admin-warning" className="box"
            style={{ margin: 0, padding: "10px 14px", fontSize: 12.5, fontWeight: 600, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
            {/* `n`, not `count`: i18next reads `count` as a plural selector. */}
            {t("adminUsers.twoAdminWarning", { n: fullAdmins })}
          </p>
        )}

        <div className="au-find">
          <label className="sr-only" htmlFor="au-q">{t("adminUsers.list.searchLabel")}</label>
          <div className="au-search">
            <SearchIcon />
            <input ref={searchRef} id="au-q" className="au-bare" data-testid="admin-search" type="search" autoFocus autoComplete="off"
              placeholder={t("adminUsers.list.search")} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query !== "") { e.stopPropagation(); setQuery(""); } }} />
            <span className="kb" aria-hidden="true">/</span>
          </div>
          <label className="sr-only" htmlFor="au-rf">{t("adminUsers.list.roleFilter")}</label>
          <select id="au-rf" data-testid="admin-role-filter" className="au-role-filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">{t("adminUsers.list.anyRole")}</option>
            {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
          </select>
        </div>

        <div className="au-chips" role="group" aria-label={t("adminUsers.list.filters")}>
          {chips.map((k) => (
            <button key={k} type="button" className={k === "noRole" && counts.noRole > 0 ? "au-chip warn" : "au-chip"} aria-pressed={chip === k}
              data-testid={`admin-chip-${k}`} onClick={() => setChip(k)}>
              {t(`adminUsers.chip.${k}`)} <b>{counts[k]}</b>
            </button>
          ))}
        </div>

        {picked.length > 0 && (
          <div className="au-bulk" data-testid="admin-bulk">
            <span className="n">{t("adminUsers.bulk.selected", { n: picked.length })}</span>
            {roles !== undefined && <button type="button" data-testid="admin-bulk-role" onClick={() => { clearOutcome(); setBulkRole(true); }}>{t("adminUsers.bulk.addRole")}</button>}
            <button type="button" data-testid="admin-bulk-deactivate" disabled={!picked.some((u) => u.active)} onClick={() => { clearOutcome(); setConfirm({ users: picked }); }}>{t("adminUsers.bulk.deactivate")}</button>
            <button type="button" className="clear" onClick={() => setSelected(new Set())}>{t("adminUsers.bulk.clear")}</button>
          </div>
        )}

        <div className="au-list box">
          {users.data === undefined ? (
            <p style={{ margin: 0, padding: 16, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>
          ) : rows.length === 0 ? (
            <p style={{ margin: 0, padding: 16, fontSize: 12.5, color: "var(--dim)" }}>{t("adminUsers.empty")}</p>
          ) : (
            <>
              <div className="au-grid au-colhead">
                <input type="checkbox" aria-label={t("adminUsers.list.selectAll")} checked={allShownTicked}
                  onChange={() => setSelected((s) => { const n = new Set(s); for (const u of shown) { if (allShownTicked) n.delete(u.id); else n.add(u.id); } return n; })} />
                <span>{t("adminUsers.list.colName")}</span>
                <span>{t("adminUsers.roles")}</span>
                <span>{t("adminUsers.status")}</span>
                <span>{t("adminUsers.list.colSignIn")}</span>
              </div>
              <div className="au-rows" data-testid="admin-rows">
                {shown.length === 0 && <p style={{ margin: 0, padding: 16, fontSize: 12.5, color: "var(--dim)" }}>{t("adminUsers.list.noMatch")}</p>}
                {shown.map((u) => <UserRow key={u.id} u={u} roles={roles} identity={identityFor(u.id)} ticked={selected.has(u.id)} open={u.id === openId} onOpen={() => openPerson(u)} onTick={() => toggle(u.id)} />)}
              </div>
              <div className="au-foot" data-testid="admin-shown">{t("adminUsers.list.shown", { n: shown.length, total: rows.length })}</div>
            </>
          )}
        </div>
      </div>

      {openUser !== null && !creating && (
        <UserDrawer
          user={openUser} catalogue={roles} assignableScope={scope} identity={identityFor(openUser.id)} users={rows}
          error={errorAt === "drawer" ? rowError : null}
          onClose={closePerson}
          onRevoke={async (r: WireUserRole) => { await run(() => revokeRole(openUser.id, r.assignmentId), t("adminUsers.roleRevoked", { roleKey: r.roleKey, username: openUser.username })); }}
          onAssign={async (r: WireRole) => { await run(() => assignRole(openUser.id, { roleKey: r.key, scopeType: scope as "hospital" }), t("adminUsers.roleAssigned", { roleKey: r.key, username: openUser.username })); }}
          onCopy={async (from, keys) => {
            await each(keys, (k) => roleTitle(k, roles), (k) => assignRole(openUser.id, { roleKey: k, scopeType: scope as "hospital" }),
              (n) => t("adminUsers.drawer.copied", { n, username: openUser.username, from: from.username }));
          }}
          onReset={(kind) => openReset(openUser, kind)}
          onPhones={() => { clearOutcome(); setPhonesOf(openUser); }}
          onIdentity={() => { clearOutcome(); setIdentityOf(openUser); }}
          onDeactivate={() => { clearOutcome(); setConfirm({ users: [openUser] }); }}
          onReactivate={async () => { await run(() => reactivateUser(openUser.id), t("adminUsers.reactivated", { username: openUser.username })); }}
        />
      )}
      {creating && <NewUserDrawer catalogue={roles} users={rows} error={createError} onClose={() => setCreating(false)} onCreate={create} />}

      {/* The rail: an outcome follows the eye to wherever the roster has been scrolled. */}
      {(notice !== null || (rowError !== null && errorAt === "rail")) && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 60, zIndex: 55, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "0 16px", pointerEvents: "none" }}>
          {notice !== null && (
            <p role="status" data-testid="admin-notice" className="box"
              style={{ margin: 0, padding: "9px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--green)", borderColor: "var(--green)", background: "var(--paper)", pointerEvents: "auto", boxShadow: "0 10px 30px rgba(19,36,32,.18)" }}>
              {notice}
            </p>
          )}
          {rowError !== null && errorAt === "rail" && (
            <p role="alert" data-testid="admin-row-error" className="box"
              style={{ margin: 0, padding: "9px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--red)", borderColor: "var(--red)", background: "var(--paper)", pointerEvents: "auto", boxShadow: "0 10px 30px rgba(19,36,32,.18)" }}>
              {rowError}
            </p>
          )}
        </div>
      )}

      <DeskModal open={pending !== null} onClose={closeReset} titleId="admin-reset-title" testId="admin-reset-panel" width={480}
        title={pending === null ? "" : t(pending.kind === "password" ? "adminUsers.resetPasswordFor" : "adminUsers.resetPinFor", { username: pending.user.username })}>
        {pending !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t(pending.kind === "password" ? "adminUsers.resetPasswordWhy" : "adminUsers.resetPinWhy")}</p>
            <label className="tag" style={{ display: "block" }} htmlFor="reset-value">{t(pending.kind === "password" ? "adminUsers.password" : "adminUsers.pin")}</label>
            <input id="reset-value" type="password"
              /* A fresh secret, never the operator's own: without this a browser offers the ADMINISTRATOR's saved password. */
              autoComplete="new-password" className="in mo" style={{ width: "100%", height: 34, fontSize: 13 }}
              value={resetValue} onChange={(e) => setResetValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitReset(); } }} />
            {errorLine("reset")}
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <SubmitButton plain type="button" className="pri" onClick={submitReset}>{t("adminUsers.confirmReset")}</SubmitButton>
              <button type="button" className="sec" onClick={closeReset}>{t("adminUsers.cancel")}</button>
            </div>
          </div>
        )}
      </DeskModal>

      {/* Drawing 3 — Deactivate ALWAYS asks first. One person or many, one question. */}
      <DeskModal open={confirm !== null} onClose={() => { setRowError(null); setConfirm(null); }} titleId="admin-deactivate-title" testId="admin-deactivate-ask" width={440} centred
        title={confirm === null ? "" : confirm.users.length === 1 ? t("adminUsers.ask.title", { name: confirm.users[0]!.fullName }) : t("adminUsers.ask.titleMany", { n: confirm.users.filter((u) => u.active).length })}>
        {confirm !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <ul style={{ margin: 0, padding: "0 0 0 18px", listStyle: "disc", display: "flex", flexDirection: "column", gap: 6, fontSize: 14, color: "#33463f" }}>
              <li>{t("adminUsers.ask.signedOut")}</li>
              <li>{t("adminUsers.ask.rolesKept")}</li>
              <li>{t("adminUsers.ask.turnOn")}</li>
            </ul>
            {errorLine("confirm")}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <SubmitButton plain type="button" className="pri" data-testid="admin-deactivate-confirm" style={{ background: "var(--red)", borderColor: "var(--red)" }} onClick={deactivateConfirmed}>
                {t("adminUsers.ask.confirm")}
              </SubmitButton>
              <button type="button" className="sec" style={{ height: 40 }} onClick={() => { setRowError(null); setConfirm(null); }}>{t("adminUsers.ask.keep")}</button>
            </div>
          </div>
        )}
      </DeskModal>

      <DeskModal open={bulkRole} onClose={() => setBulkRole(false)} titleId="admin-bulk-role-title" testId="admin-bulk-role-panel" width={460}
        title={t("adminUsers.bulk.addRoleTitle", { n: picked.length })}>
        {bulkRole && roles !== undefined && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <RolePicker roles={roles} onPick={bulkAssign} testId="admin-bulk-role-search" warnTestId="admin-bulk-authority-warning" actLabel={t("adminUsers.assignRole")} />
            {errorLine("bulk")}
          </div>
        )}
      </DeskModal>

      <UserPhones user={phonesOf} onClose={() => setPhonesOf(null)} />
      <UserIdentity
        user={identityOf} identity={identityOf === null ? null : identityById.get(identityOf.id) ?? null}
        aadhaarConfigured={identity.data?.aadhaarConfigured === true}
        onClose={() => setIdentityOf(null)}
        onChanged={(_next, said) => { setNotice(said); void qc.invalidateQueries({ queryKey: ["admin", "users", "identity"] }); }}
      />
      <PrintComputers open={printComputers} onClose={() => setPrintComputers(false)} />

      <AgentDock
        answer={copilot.answer} log={agentLog} onAsk={copilot.ask}
        panel={copilot.report === null ? undefined : <CopilotReport report={copilot.report} onDismiss={copilot.dismissReport} />}
        placeholder={t("adminUsers.askPlaceholder")} idle={t("adminUsers.agentIdle")}
      />
    </PaperScreen>
  );
}

/** One person, one line. The whole row opens the drawer; the name is the keyboard's way in. */
function UserRow({ u, roles, identity, ticked, open, onOpen, onTick }: {
  u: WireAdminUser; roles: readonly WireRole[] | undefined; identity: WireUserIdentity | null | undefined;
  ticked: boolean; open: boolean; onOpen: () => void; onTick: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const titles = [...new Set(u.roles.map((r) => roleTitle(r.roleKey, roles)))];
  const linked = identity?.attendance === "linked";
  return (
    <div className={`au-grid au-row${ticked ? " sel" : ""}${open ? " open" : ""}`} data-testid={`admin-user-${u.username}`} onClick={onOpen}>
      <input type="checkbox" aria-label={t("adminUsers.list.selectUser", { name: u.fullName })} checked={ticked}
        onClick={(e) => e.stopPropagation()} onChange={onTick} />
      <button type="button" className="au-who" data-testid={`admin-open-${u.username}`} aria-label={t("adminUsers.list.openUser", { name: u.fullName })}
        onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        <span className="au-av" style={{ background: avatarColour(u.id, u.active) }} aria-hidden="true">{initials(u.fullName)}</span>
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <span className="au-name" style={{ color: u.active ? "var(--ink)" : "var(--dim)" }}>{u.fullName}</span>
          <span className="au-sub" data-testid={`admin-staff-code-${u.username}`}>{u.username} · {u.staffCode}</span>
        </span>
      </button>
      <div className="au-roles">
        {titles.length === 0 && <span className="au-pill norole">{t("adminUsers.list.noRole")}</span>}
        {titles.slice(0, 3).map((title) => <span key={title} className="au-role">{title}</span>)}
        {titles.length > 3 && <span className="au-more">+{titles.length - 3}</span>}
      </div>
      <div className="au-status" data-testid={`admin-status-${u.username}`}>
        <span className={u.active ? "au-pill on" : "au-pill off"}>{u.active ? t("adminUsers.active") : t("adminUsers.inactive")}</span>
        {u.mustChangePassword && <span className="au-note">{t("adminUsers.chip.passwordDue")}</span>}
      </div>
      <div className="au-icons">
        <span className={u.hasPin ? undefined : "dim"} title={t(u.hasPin ? "adminUsers.list.pinSet" : "adminUsers.list.noPin")} data-testid={`admin-pin-${u.username}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          <span className="sr-only">{t(u.hasPin ? "adminUsers.list.pinSet" : "adminUsers.list.noPin")}</span>
        </span>
        {identity !== undefined && (
          /* The state is a WORD for the screen reader and the tooltip; the clock icon only repeats it. */
          <span className={linked ? undefined : "dim"} title={t(`adminUsers.identity.state.${identity?.attendance ?? "not_linked"}`)} data-testid={`admin-attendance-${u.username}`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={identity?.attendance === "two_matches" ? "var(--gold)" : "currentColor"} strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>
            <span className="sr-only">{t(`adminUsers.identity.state.${identity?.attendance ?? "not_linked"}`)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
