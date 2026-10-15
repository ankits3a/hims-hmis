import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SessionProvider, useSession } from "../src/session";

/** Wednesday 14 Oct 2026, 11:00 IST — every attendance suite's "now". */
export const NOW = Date.parse("2026-10-14T05:30:00.000Z");
export const TODAY = "2026-10-14";
export const nowMs = (): number => NOW;

export type Reply = { status: number; body?: unknown } | "offline";
export type Route = Reply | ((body: unknown, url: string) => Reply);

/** A scripted server: `METHOD /path` → reply. Anything else is 404. Every call is kept, with its query string. */
export function server(perms: string[], routes: Record<string, Route>, userId = "u-me") {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.split("?")[0] ?? path}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, url: path });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: userId }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(body, path) : hit;
    if (r === "offline") throw new TypeError("Network request failed");
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, sent: (key: string) => calls.filter((c) => c.key === key), keys: () => calls.map((c) => c.key) };
}

function Gate({ children }: { children: ReactElement }) {
  const { state } = useSession();
  return state.status === "signedIn" ? children : null;
}
export async function mount(fetcher: typeof fetch, screen: ReactElement, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate>{screen}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const PERSON = { pin: "304", name: "Dr A Kumar", dept: "Medicine", post: "Asst Prof" };
type Day = { date: string; status: string; reason?: string; firstIn?: string | null; lastOut?: string | null; hoursWorked?: number | null };
/** `/attendance/me` for a linked person — WORDS ONLY unless a test adds the time keys itself. */
export function me(over: { state?: string; status?: string | null; days?: Day[]; needsConfirm?: string[]; showsTimes?: boolean; leadsTeam?: boolean; configured?: boolean; today?: Record<string, unknown> } = {}) {
  return {
    linked: true, configured: over.configured ?? true, leadsTeam: over.leadsTeam ?? false, showsTimes: over.showsTimes ?? false, person: PERSON, from: "2026-09-13", to: TODAY,
    today: { date: TODAY, state: over.state ?? "checked_in", status: over.status ?? null, ...(over.today ?? {}) },
    days: over.days ?? WEEK, needsConfirm: over.needsConfirm ?? [], leaves: [], roster: [], holidays: [],
  };
}
/** Mon 12 – Wed 14 Oct, and the week before it. Fri 9 is the forgotten evening punch. */
export const WEEK: Day[] = [
  { date: "2026-10-05", status: "present" }, { date: "2026-10-06", status: "partial" }, { date: "2026-10-07", status: "leave" }, { date: "2026-10-08", status: "absent" },
  { date: "2026-10-09", status: "confirm", reason: "one_punch_only" }, { date: "2026-10-10", status: "present" }, { date: "2026-10-11", status: "off" },
  { date: "2026-10-12", status: "present" }, { date: "2026-10-13", status: "present" }, { date: "2026-10-14", status: "partial" },
];
/** The same server, answering only the days the request asked for — as the real one does. */
export const meRoute = (over: Parameters<typeof me>[0] = {}): Route => (_b, url) => {
  const from = /from=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "0000-00-00";
  const to = /to=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "9999-99-99";
  const m = me(over);
  return { status: 200, body: { ...m, from, to, days: m.days.filter((d) => d.date >= from && d.date <= to) } };
};
