import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE SERVICE WORKER, DRIVEN THROUGH A `self` STUB
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `public/sw.js` is a static file at the scope root — a service worker may only control pages
 * at or below its own path, so it cannot be a bundled module and cannot be imported. It is
 * therefore evaluated here against a hand-built `self`, which is the only way to reach it at
 * all, and it is worth reaching: it is the last piece of code between a push payload and a
 * lock screen in a shared house.
 */
const SW_SOURCE = readFileSync(join(__dirname, "../../public/sw.js"), "utf8");

type Listener = (event: unknown) => void;

function loadWorker(): {
  fire: (type: string, event: Record<string, unknown>) => void;
  shown: { title: string; options: Record<string, unknown> }[];
  opened: string[];
  navigated: string[];
  focused: number;
  setClients: (clients: unknown[]) => void;
} {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const state = { focused: 0, clients: [] as unknown[] };

  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(state.clients),
      openWindow: (url: string) => { opened.push(url); return Promise.resolve(null); },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("self", SW_SOURCE)(self);

  return {
    fire: (type, event) => { listeners.get(type)?.(event); },
    shown,
    opened,
    navigated,
    get focused() { return state.focused; },
    setClients: (clients) => {
      state.clients = clients.map((c) => ({
        ...(c as object),
        focus: () => { state.focused += 1; return Promise.resolve(); },
        navigate: (url: string) => { navigated.push(url); return Promise.resolve(); },
      }));
    },
  };
}

const waited: Promise<unknown>[] = [];
const waitUntil = (p: Promise<unknown>): void => { waited.push(p); };
const settle = async (): Promise<void> => { await Promise.all(waited.splice(0)); };

describe("public/sw.js", () => {
  it("renders the title, body and link a push carries, and nothing it does not", async () => {
    const sw = loadWorker();
    sw.fire("push", {
      waitUntil,
      data: { json: () => ({ title: "escalation · now · 12 min left", body: "Open it", link: "/approvals?focus=ap-9", tag: "ob-9" }) },
    });
    await settle();

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe("escalation · now · 12 min left");
    expect(sw.shown[0]!.options.body).toBe("Open it");
    expect(sw.shown[0]!.options.data).toEqual({ link: "/approvals?focus=ap-9" });
    // The tag collapses repeats of ONE obligation into one lock-screen row instead of a stack.
    expect(sw.shown[0]!.options.tag).toBe("ob-9");
  });

  it("a wake-up with no data renders NOTHING — `undefined` on a lock screen is worse than silence", async () => {
    const sw = loadWorker();
    sw.fire("push", { waitUntil, data: null });
    await settle();
    expect(sw.shown).toHaveLength(0);
  });

  it("falls back to plain text and a default title rather than throwing on a non-JSON payload", async () => {
    const sw = loadWorker();
    sw.fire("push", { waitUntil, data: { json: () => { throw new Error("not json"); }, text: () => "plain words" } });
    await settle();
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe("plain words");
    expect(sw.shown[0]!.options.data).toEqual({ link: "/" });
  });

  it("a click FOCUSES an open tab and navigates it — a nurse tapping four ends with one window", async () => {
    const sw = loadWorker();
    sw.setClients([{ url: "https://hmis.test/" }]);
    let closed = 0;
    sw.fire("notificationclick", {
      waitUntil,
      notification: { close: () => { closed += 1; }, data: { link: "/approvals?focus=ap-9" } },
    });
    await settle();

    expect(closed).toBe(1);
    expect(sw.focused).toBe(1);
    expect(sw.navigated).toEqual(["/approvals?focus=ap-9"]);
    expect(sw.opened).toEqual([]); // and NOT a fifth window
  });

  it("with no tab open it opens one, at the link", async () => {
    const sw = loadWorker();
    sw.setClients([]);
    sw.fire("notificationclick", {
      waitUntil,
      notification: { close: () => undefined, data: { link: "/approvals?focus=ap-9" } },
    });
    await settle();
    expect(sw.opened).toEqual(["/approvals?focus=ap-9"]);
  });

  it("caches nothing and intercepts no fetch — an offline worklist is a stale one", () => {
    // Asserted against the SOURCE because the absence of a listener cannot be fired. A cache
    // here would be a second copy of a worklist somebody is making decisions from.
    expect(SW_SOURCE).not.toContain('addEventListener("fetch"');
    expect(SW_SOURCE).not.toContain("caches.");
  });
});
