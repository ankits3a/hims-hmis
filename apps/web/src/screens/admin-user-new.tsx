import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { FormKit } from "../components/form-kit";
import { RolePicker } from "./admin-role-picker";
import { CloseIcon } from "./admin-user-drawer";
import { QUICK_ROLES, makePassword, shortTitle, suggestUsername } from "./admin-users-model";
import type { WireAdminUser, WireRole } from "../lib/admin-api";

const schema = z.object({
  fullName: z.string().trim().min(1),
  username: z.string().trim().min(1),
  mobile: z.string(),
  password: z.string(),
  pin: z.string(),
});
type Values = z.infer<typeof schema>;

export type NewUserInput = { fullName: string; username: string; password: string; pin: string; mobile: string; roleKeys: string[] };

/**
 * ═══ NEW USER (users board, drawing 2) ═══
 *
 * Full name first; the username is MADE from it ("Rekha Gupta" → `rekha.gupta`) until the person
 * types their own. It is a suggestion: the server decides `username_taken` and the username's shape.
 * The first password is made here with `crypto.getRandomValues` (word-word-four digits) so nobody
 * has to invent one at the counter; "Type my own" swaps it for a box. The server's floor still
 * judges whatever is sent, and the account must change it at first sign-in.
 *
 * Roles are picked BEFORE create — the quick six, "More roles…", or another person's — and assigned
 * one by one after the account exists (the parent's `create`). Alt+S submits (`FormKit`).
 */
export function NewUserDrawer({
  catalogue, users, error, onClose, onCreate,
}: {
  catalogue: readonly WireRole[] | undefined;
  users: readonly WireAdminUser[];
  error: string | null;
  onClose: () => void;
  onCreate: (v: NewUserInput) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { fullName: "", username: "", mobile: "", password: "", pin: "" } });
  const [made, setMade] = useState(() => makePassword());
  const [own, setOwn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const byKey = new Map((catalogue ?? []).map((r) => [r.key, r] as const));
  const quick = QUICK_ROLES.filter((k) => byKey.has(k));
  const extra = picked.filter((k) => !(quick as readonly string[]).includes(k));
  const toggle = (k: string): void => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const warns = picked.some((k) => byKey.get(k)?.grantsAccessAuthority === true);
  const username = form.watch("username");
  const taken = username.trim() !== "" && users.some((u) => u.username === username.trim().toLowerCase());

  const submit = form.handleSubmit(async (v) => {
    await onCreate({ fullName: v.fullName.trim(), username: v.username.trim(), password: own ? v.password : made, pin: v.pin.trim(), mobile: v.mobile.trim(), roleKeys: picked });
  });

  const nameField = form.register("fullName", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!usernameTouched) form.setValue("username", suggestUsername(e.target.value));
    },
  });
  const userField = form.register("username", { onChange: () => setUsernameTouched(true) });

  return (
    <aside className="au-drawer wide" data-testid="admin-new-user" aria-labelledby="au-new-title"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <FormProvider {...form}>
        <FormKit onSubmit={submit} className="au-new-form">
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="dh" style={{ alignItems: "center" }}>
              <h2 id="au-new-title" style={{ flex: 1, margin: 0, fontSize: 20, fontWeight: 700 }}>{t("adminUsers.newUser.title")}</h2>
              <button type="button" className="x" aria-label={t("adminUsers.drawer.close")} onClick={onClose}><CloseIcon /></button>
            </div>

            <div className="db" style={{ gap: 18 }}>
              <div className="field">
                <label className="lbl" htmlFor="au-fn">{t("adminUsers.fullName")}</label>
                <input id="au-fn" className="in" data-field autoFocus autoComplete="off" {...nameField} />
              </div>
              <div className="pair">
                <div className="field">
                  <label className="lbl" htmlFor="au-un">{t("adminUsers.username")}</label>
                  <input id="au-un" className="in mo" data-field autoComplete="off" spellCheck={false} style={{ fontSize: 13.5 }} {...userField} />
                  <span className="hint" data-testid="admin-new-username-hint" style={taken ? { color: "#7a4c08", fontWeight: 600 } : { color: "var(--green)", fontWeight: 600 }}>
                    {username.trim() === "" ? "" : taken ? t("adminUsers.newUser.usernameTaken") : usernameTouched ? "" : t("adminUsers.newUser.usernameMade")}
                  </span>
                </div>
                <div className="field">
                  <label className="lbl" htmlFor="au-mb">{t("adminUsers.drawer.mobile")}</label>
                  <input id="au-mb" className="in mo" data-field type="tel" inputMode="numeric" autoComplete="off" placeholder={t("adminUsers.newUser.mobilePlaceholder")} style={{ fontSize: 13.5 }} {...form.register("mobile")} />
                  <span className="hint">{t("adminUsers.newUser.mobileHint")}</span>
                </div>
              </div>

              {catalogue !== undefined && (
                <div className="field" style={{ gap: 9 }}>
                  <h3 className="sh">{t("adminUsers.roles")}</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {[...quick, ...extra].map((k) => (
                      <button key={k} type="button" className="qp" aria-pressed={picked.includes(k)} data-testid={`admin-new-role-${k}`} onClick={() => toggle(k)}>
                        {picked.includes(k) && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M2.5 7.5 5.5 10.5 11.5 4" /></svg>}
                        {(quick as readonly string[]).includes(k) ? t(`adminUsers.newUser.quick.${k}`) : shortTitle(byKey.get(k)?.title ?? k)}
                      </button>
                    ))}
                    <button type="button" className="qp" aria-expanded={more} data-testid="admin-new-more" onClick={() => setMore((m) => !m)}>{t("adminUsers.newUser.moreRoles")}</button>
                  </div>
                  {more && (
                    <RolePicker roles={(catalogue ?? []).filter((r) => !picked.includes(r.key))} testId="admin-new-role-search" warnTestId="admin-new-authority-armed"
                      actLabel={t("adminUsers.newUser.add")} onPick={async (r) => { setPicked((p) => [...p, r.key]); }} />
                  )}
                  {warns && <p role="status" data-testid="admin-new-authority-warning" className="hint" style={{ margin: 0, fontWeight: 600, color: "#7a4c08" }}>{t("adminUsers.grantsAccessAuthority")}</p>}
                  {!copyOpen ? (
                    <button type="button" className="link" data-testid="admin-new-copy-open" onClick={() => setCopyOpen(true)}>{t("adminUsers.newUser.copyRoles")}</button>
                  ) : (
                    <>
                      <label className="sr-only" htmlFor="au-new-copy">{t("adminUsers.newUser.copyRoles")}</label>
                      <select id="au-new-copy" data-testid="admin-new-copy" className="in" style={{ height: 36, fontSize: 13 }} value=""
                        onChange={(e) => {
                          const from = users.find((u) => u.id === e.target.value);
                          if (from === undefined) return;
                          const keys = from.roles.filter((r) => r.scopeType === "hospital" && byKey.has(r.roleKey)).map((r) => r.roleKey);
                          setPicked((p) => [...new Set([...p, ...keys])]);
                          setCopyOpen(false);
                        }}>
                        <option value="">{t("adminUsers.drawer.copyPick")}</option>
                        {[...users].filter((u) => u.roles.length > 0).sort((a, b) => a.fullName.localeCompare(b.fullName))
                          .map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.username}</option>)}
                      </select>
                    </>
                  )}
                </div>
              )}

              <div className="field" style={{ gap: 8 }}>
                <h3 className="sh">{t("adminUsers.newUser.firstPassword")}</h3>
                {own ? (
                  <>
                    <label className="sr-only" htmlFor="au-pw">{t("adminUsers.password")}</label>
                    <input id="au-pw" className="in mo" data-field type="password" autoComplete="new-password" {...form.register("password")} />
                    <span className="hint">{t("adminUsers.newUser.mustChange")} <button type="button" className="link" onClick={() => { setOwn(false); form.setValue("password", ""); }}>{t("adminUsers.newUser.useMade")}</button></span>
                  </>
                ) : (
                  <>
                    <div className="made">
                      <span className="pw" data-testid="admin-new-password">{made}</span>
                      <button type="button" className="sec sm" onClick={() => { void navigator.clipboard?.writeText(made).then(() => setCopied(true), () => setCopied(false)); }}>
                        {copied ? t("adminUsers.newUser.copied") : t("adminUsers.newUser.copy")}
                      </button>
                      <button type="button" className="sec sm" data-testid="admin-new-password-again" onClick={() => { setMade(makePassword()); setCopied(false); }}>{t("adminUsers.newUser.newOne")}</button>
                    </div>
                    <span className="hint">{t("adminUsers.newUser.mustChange")} <button type="button" className="link" data-testid="admin-new-own" onClick={() => setOwn(true)}>{t("adminUsers.newUser.typeOwn")}</button></span>
                  </>
                )}
              </div>

              <div className="field">
                <label className="lbl" htmlFor="au-pin">{t("adminUsers.pin")}</label>
                <input id="au-pin" className="in mo" data-field type="password" inputMode="numeric" autoComplete="new-password" placeholder={t("adminUsers.newUser.pinPlaceholder")} style={{ width: 160 }} {...form.register("pin")} />
              </div>

              {error !== null && <p role="alert" data-testid="admin-create-error" className="err">{error}</p>}
            </div>

            <div className="df">
              <button type="submit" className="pri" disabled={form.formState.isSubmitting}>{t("adminUsers.newUser.create")}</button>
              <button type="button" className="sec" onClick={onClose}>{t("adminUsers.cancel")}</button>
              <span className="mo" style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>Alt+S</span>
            </div>
          </div>
        </FormKit>
      </FormProvider>
    </aside>
  );
}
