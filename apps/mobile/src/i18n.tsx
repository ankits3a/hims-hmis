import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import en from "./locales/en.json";
import hi from "./locales/hi.json";

/**
 * English and Hindi. The keys shared with the web app (`app.*`, `login.*`, `changePassword.*`)
 * are copied from apps/web/src/locales and `i18n.test.ts` fails if their wording drifts, so a
 * clerk sees the same sentence on the counter PC and on the phone.
 */
export type Lang = "en" | "hi";
const DICTS: Record<Lang, unknown> = { en, hi };

export type Vars = Record<string, string | number>;

function lookup(lang: Lang, key: string): string | undefined {
  let node: unknown = DICTS[lang];
  for (const part of key.split(".")) {
    node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * `{{vars}}` are filled; a key the web writes as `x_one` / `x_other` (i18next plurals) is chosen
 * by `count`, so the phone can carry the web's sentences verbatim.
 */
export function translate(lang: Lang, key: string, vars?: Vars): string {
  let text = lookup(lang, key);
  if (text === undefined && typeof vars?.count === "number") {
    text = lookup(lang, `${key}_${vars.count === 1 ? "one" : "other"}`);
  }
  if (text === undefined) return key;
  return vars === undefined ? text : text.replace(/\{\{(\w+)\}\}/g, (_, v: string) => String(vars[v] ?? ""));
}

type I18n = { lang: Lang; t: (key: string, vars?: Vars) => string; toggle: () => void };
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const t = useCallback((key: string, vars?: Vars) => translate(lang, key, vars), [lang]);
  const toggle = useCallback(() => setLang((l) => (l === "en" ? "hi" : "en")), []);
  const value = useMemo(() => ({ lang, t, toggle }), [lang, t, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useI18n outside I18nProvider");
  return v;
}
