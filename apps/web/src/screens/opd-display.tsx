import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearch } from "@tanstack/react-router";
import { api } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import type { WireBoardItem } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { Button } from "@/components/ui/button";

/**
 * The waiting-room token display board (D6 / Task 16, the Plan 07 capstone) — a full-screen, dark,
 * TV-facing layout. It shows TOKENS, ROOMS and DOCTORS and NOTHING that identifies a patient (§14):
 * the wire shape it reads, `WireBoardItem`, carries no patient field at all, and this file makes no
 * `/patients` call — the confidentiality guarantee is structural, not merely a rendering choice.
 *
 * THE START GATE IS A REAL REQUIREMENT, not a nicety: browsers refuse speech synthesis (and may
 * refuse socket-driven audio) without a prior user gesture. `OpdDisplay` therefore renders ONLY the
 * gate — no query, no realtime hook — until Start is clicked. `DisplayBoard`, which alone owns the
 * board query and the realtime subscription, does not exist in the tree before that (never merely
 * "disabled"), so no `WebSocket` can open early — K52's mutant collapses exactly this split.
 *
 * Bilingual by design (§15 Hindi/English day one) — and this applies to BOTH channels the board
 * uses, not just the one: every `queue.called` frame is SPOKEN twice, Hindi first (`hi-IN`), then
 * English (`en-IN`) — K51. Independently, every on-screen LABEL (the header title, the NOW SERVING
 * caption, the Next caption, and the Start button) is WRITTEN in both languages at once, via
 * `i18n.getFixedT("hi")` / `getFixedT("en")` rather than the ambient `t()` — a waiting-room TV has
 * no per-viewer language setting, so it cannot render "whichever language i18next happens to be
 * in" the way a staff screen can. Data fields (room code, doctor name, department name, token
 * numbers) are NOT translated — they come straight off the wire, not out of a locale file.
 */
const POLL_MS = 15_000;

function roomsFromSearch(raw: string | undefined): string[] {
  return raw === undefined ? [] : raw.split(",").filter((r) => r !== "");
}

/**
 * jsdom (and some browsers under policy) ship neither `speechSynthesis` nor
 * `SpeechSynthesisUtterance` — ABSENT properties, not prototype methods, so the guard is a plain
 * `in` check, never a method probe (verify-by-execution flag ⑮). Cancels any pending utterance
 * first so a fast second call never overlaps the first, then queues Hindi before English.
 */
function speak(token: number, room: string, t: (key: string, opts?: Record<string, unknown>) => string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const hi = new SpeechSynthesisUtterance(t("opdDisplay.announceHi", { token, room }));
  hi.lang = "hi-IN";
  const en = new SpeechSynthesisUtterance(t("opdDisplay.announceEn", { token, room }));
  en.lang = "en-IN";
  window.speechSynthesis.speak(hi);
  window.speechSynthesis.speak(en);
}

function BoardCard({ item }: { item: WireBoardItem }): React.ReactElement {
  const { t, i18n } = useTranslation();
  // Fixed-language lookups (see the file docstring) — the caption strings are shown in BOTH
  // languages regardless of the app's current locale; `item.status` below stays on the ambient
  // `t()` because a session-status word is not one of the four labels this screen must pair.
  const tHi = i18n.getFixedT("hi");
  const tEn = i18n.getFixedT("en");
  return (
    <div
      data-testid={`board-card-${item.sessionId}`}
      className="flex flex-col gap-3 rounded-2xl border border-neutral-700 bg-neutral-900 p-8"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-3xl font-bold">{item.roomCode ?? "—"}</span>
        <span className="text-base text-neutral-400">{t(`opd.sessionStatus.${item.status}`)}</span>
      </div>
      <div className="text-2xl">{item.doctorName}</div>
      <div className="text-lg text-neutral-400">{item.departmentName}</div>
      <div className="mt-6 text-center">
        <div className="text-lg tracking-widest text-neutral-400 uppercase">
          {tHi("opdDisplay.nowServing")} / {tEn("opdDisplay.nowServing")}
        </div>
        <div data-testid={`now-serving-${item.sessionId}`} className="text-8xl leading-none font-black">
          {item.nowServing ?? "—"}
        </div>
      </div>
      <div className="text-center text-xl text-neutral-400">
        {tHi("opdDisplay.next")} / {tEn("opdDisplay.next")}: {item.next.length > 0 ? item.next.join(", ") : "—"}
      </div>
    </div>
  );
}

/**
 * Mounted ONLY after Start (the gate above). Owns the board read (poll + realtime hint, D6) and the
 * speech side-effect. `queue.called`/`queue.skipped` patch the affected room's `nowServing` in the
 * query cache directly — BEFORE any refetch — so the board never waits on the 15 s poll to reflect a
 * call it was just told about; the poll exists so a missed frame costs seconds, never correctness.
 */
function DisplayBoard({ rooms }: { rooms: string[] }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const today = todayIst();
  const queryKey = ["opd", "board", today, rooms.join("|")];

  const board = useQuery({
    queryKey,
    queryFn: () =>
      api<{ items: WireBoardItem[] }>(
        "GET",
        `/opd/queues/board?serviceDate=${today}${rooms.length > 0 ? `&roomIds=${rooms.join(",")}` : ""}`,
      ),
    refetchInterval: POLL_MS,
  });

  const topics = rooms.map((r) => `display:${r}`);
  useRealtime(topics, (frame) => {
    if (frame.name !== "queue.called" && frame.name !== "queue.skipped") return;
    const payload = frame.payload as { roomId: string | null; tokenNo: number };
    queryClient.setQueryData<{ items: WireBoardItem[] } | undefined>(queryKey, (prev) => {
      if (prev === undefined) return prev;
      return {
        items: prev.items.map((it) =>
          it.roomId === payload.roomId
            ? { ...it, nowServing: frame.name === "queue.called" ? payload.tokenNo : null }
            : it,
        ),
      };
    });
    if (frame.name === "queue.called") {
      const item = board.data?.items.find((it) => it.roomId === payload.roomId);
      speak(payload.tokenNo, item?.roomCode ?? "", t);
    }
  });

  const items = board.data?.items ?? [];
  return (
    <div className="grid flex-1 grid-cols-1 gap-6 p-10 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <BoardCard key={item.sessionId} item={item} />
      ))}
    </div>
  );
}

export function OpdDisplay(): React.ReactElement {
  const { i18n } = useTranslation();
  const tHi = i18n.getFixedT("hi");
  const tEn = i18n.getFixedT("en");
  // `strict: false` reads the search of whatever route is active without a compile-time circular
  // import back to router.tsx (which itself imports this component) — cast to the shape this
  // screen's own `validateSearch` produces, mirroring the cast already used by opd-api.ts.
  const search = useSearch({ strict: false }) as { rooms?: string };
  const rooms = roomsFromSearch(search.rooms);
  const [started, setStarted] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-white">
      <div className="no-print flex items-center justify-between border-b border-neutral-800 px-6 py-3 text-lg">
        <span className="font-semibold">
          {tHi("opdDisplay.title")} / {tEn("opdDisplay.title")}
        </span>
      </div>
      {started ? (
        <DisplayBoard rooms={rooms} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-8">
          <Button type="button" size="lg" className="px-12 py-8 text-3xl" onClick={() => setStarted(true)}>
            {tHi("opdDisplay.start")} / {tEn("opdDisplay.start")}
          </Button>
        </div>
      )}
    </div>
  );
}
