import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchHallBoard, radiologyErrorText } from "../lib/radiology-api";
import type { WireHallRoom } from "../lib/radiology-api";
import { useIstClock } from "../components/station/station-shell";

/**
 * PLAN 18-S RS3 — **THE IMAGING WAITING-HALL DISPLAY.** What the TV in the hall shows: per room,
 * who is on the table NOW and the NEXT three who are here, by TOKEN (the accession on the slip)
 * with a first name and initial (DPDP; a confidential patient is a token alone — the server
 * decides, `display.ts`). A room that is down or unlicensed says so in Hindi and English.
 *
 * **It changes nothing and nobody types into it.** The desk and the rooms drive it. It follows the
 * OPD board's rules: a full-screen TV page behind its own permission (`radiology.display.read`, held
 * by the kiosk `display` account), every caption written in BOTH languages at once (a hall TV has no
 * per-viewer language), and the data fields straight off the wire. The OPD board's voice announcer
 * rides `queue.called` frames; imaging has no call act yet (the room console's bell is RS6), so this
 * board polls and does not speak — named, not implied.
 */
const POLL_MS = 15_000;

function Tile({ room }: { room: WireHallRoom }): React.ReactElement {
  const { i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const tHi = i18n.getFixedT("hi");
  const both = (k: string): string => `${tEn(k)} · ${tHi(k)}`;
  return (
    <div
      className={`flex min-w-0 flex-col gap-3 rounded-2xl border p-5 ${room.closed === null ? "border-emerald-200 bg-white" : "border-neutral-300 bg-neutral-100 text-neutral-500"}`}
      data-testid={`hall-room-${room.code}`}
      {...(room.closed === "down" ? { "data-down": room.code } : {})}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-3xl font-bold">{room.code}</span>
        <span className="text-base text-neutral-500">{room.room ?? room.name}</span>
      </div>
      <div>
        <div className="text-sm uppercase tracking-widest text-neutral-500">{both("radiology.hall.now")}</div>
        {room.closed !== null
          ? <div className="text-5xl font-black">—</div>
          : room.now === null
            ? <div className="text-2xl text-neutral-400">{both("radiology.hall.free")}</div>
            : (
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="mo text-4xl font-black sm:text-5xl" data-testid={`hall-now-${room.code}`}>{room.now.token}</span>
                {room.now.name !== null && <span className="text-2xl">{room.now.name}</span>}
              </div>
            )}
      </div>
      <div>
        <div className="text-sm uppercase tracking-widest text-neutral-500">{both("radiology.hall.next")}</div>
        {room.closed !== null
          ? <div className="text-xl">{room.closed === "down" ? both("radiology.hall.closedDown") : both("radiology.hall.closedToday")}</div>
          : room.next.length === 0
            ? <div className="text-xl text-neutral-400">{both("radiology.hall.nobody")}</div>
            : (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {room.next.map((n) => (
                  <li key={n.token} className="rounded-lg bg-emerald-50 px-3 py-1 text-xl">
                    <span className="mo font-bold">{n.token}</span>{n.name !== null && <span className="ml-2">{n.name}</span>}
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}

export function RadiologyDisplay(): React.ReactElement {
  const { i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const tHi = i18n.getFixedT("hi");
  const clock = useIstClock();
  const q = useQuery({ queryKey: ["radiology", "display"], queryFn: fetchHallBoard, refetchInterval: POLL_MS });
  const rooms = q.data?.rooms ?? [];
  const closed = rooms.filter((r) => r.closed !== null);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f4f7f5] p-4 text-neutral-900 sm:p-8" data-testid="radiology-display">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="m-0 text-3xl font-bold sm:text-4xl">{tEn("radiology.hall.title")} · <span lang="hi">{tHi("radiology.hall.title")}</span></h1>
        <time className="mo text-3xl" data-testid="hall-clock">{clock}</time>
      </header>
      {q.isError && <p role="alert" className="text-xl text-red-700">{radiologyErrorText(q.error)}</p>}
      {closed.length > 0 && (
        <div className="mb-6 space-y-2" data-testid="hall-notices">
          {closed.map((r) => (
            <div key={r.deviceResourceId} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xl" {...(r.closed === "down" ? { "data-down": r.code } : {})}>
              <b>{tEn(r.closed === "down" ? "radiology.hall.noticeDown" : "radiology.hall.noticeUnlicensed", { room: r.code })}</b>
              <div lang="hi">{tHi(r.closed === "down" ? "radiology.hall.noticeDown" : "radiology.hall.noticeUnlicensed", { room: r.code })}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
        {rooms.map((r) => <Tile key={r.deviceResourceId} room={r} />)}
      </div>
      <footer className="mt-8 flex flex-wrap justify-between gap-3 text-lg text-neutral-600">
        <span>{tEn("radiology.hall.footReports")} · <span lang="hi">{tHi("radiology.hall.footReports")}</span></span>
        <span>{tEn("radiology.hall.footEmergency")} · <span lang="hi">{tHi("radiology.hall.footEmergency")}</span></span>
      </footer>
    </div>
  );
}
