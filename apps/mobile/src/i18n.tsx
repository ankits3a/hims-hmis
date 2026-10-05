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

export function translate(lang: Lang, key: string, vars?: Record<string, string>): string {
  let node: unknown = DICTS[lang];
  for (const part of key.split(".")) {
    node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== "string") return key;
  return vars === undefined ? node : node.replace(/\{\{(\w+)\}\}/g, (_, v: string) => vars[v] ?? "");
}

type I18n = { lang: Lang; t: (key: string, vars?: Record<string, string>) => string; toggle: () => void };
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const t = useCallback((key: string, vars?: Record<string, string>) => translate(lang, key, vars), [lang]);
  const toggle = useCallback(() => setLang((l) => (l === "en" ? "hi" : "en")), []);
  const value = useMemo(() => ({ lang, t, toggle }), [lang, t, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useI18n outside I18nProvider");
  return v;
}
