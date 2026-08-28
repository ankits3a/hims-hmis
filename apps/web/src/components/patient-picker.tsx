import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { PatientPhoto } from "../screens/registration-desk";

/**
 * The smallest shape both lanes of the picker can produce: the free-text search route returns
 * more (phone, hasPhoto, isConfidential — Plan 05's SearchHit), the QR-verify route returns less.
 * `onPick` is deliberately pinned to their intersection so it stays a stable, reusable contract for
 * T13's walk-in open as well as this task's booking flow.
 */
export type PatientPickerHit = { id: string; uhid: string; name: string | null; sex: string; dob: string | null };

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; sex: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
};
type QrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; sex: string; dob: string | null } }
  | { ok: false; reason: string };

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * How long a keystroke buffer may sit idle before it is DISCARDED (Plan 08 owner ruling 5). This is
 * NOT a trigger and NOT a speed heuristic: nothing is ever verified because the clock ran out. It
 * exists so an interrupted half-scan cannot prefix the next scan.
 */
const WEDGE_IDLE_MS = 500;

/**
 * Search-first patient picker (§11.1 entry lane), reused by T12's booking flow and T13's walk-in
 * open. Wraps `GET /patients/search` (typed digits, phone-first) and a QR-scan text box that posts
 * `POST /patients/qr/verify` — the same signed-QR verification Plan 05's card uses.
 */
/**
 * PLAN 07b T2 — `autoFocus` is OPT-IN, not the default.
 *
 * On a counter screen the first keystroke of every patient should land in this box without a mouse
 * ever being touched, and it did not: the picker took no focus on mount, so a clerk clicked into it
 * a few thousand times a day. But a page may mount more than one picker (a tab beside a dialog),
 * and two inputs both claiming focus on mount is a worse defect than the one being fixed — so the
 * screens that want it ask for it.
 */
export function PatientPicker(
  { onPick, autoFocus = false }: { onPick: (hit: PatientPickerHit) => void; autoFocus?: boolean },
): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState(false);
  const debounced = useDebounced(q, 250);
  // The wedge buffer and its idle timer (see the scan box below). Refs, not state: a keystroke of a
  // 24-character payload must not cost a render, and the buffer is never read during one.
  const wedgeRef = useRef("");
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (idleRef.current !== null) clearTimeout(idleRef.current);
  }, []);

  const search = useQuery({
    queryKey: ["picker-search", debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const verify = async (payload: string): Promise<void> => {
    setScanError(false);
    try {
      const res = await api<QrVerifyResult>("POST", "/patients/qr/verify", { payload });
      if (res.ok) {
        onPick({ id: res.patient.id, uhid: res.patient.uhid, name: res.patient.name, sex: res.patient.sex, dob: res.patient.dob });
        setScan("");
      } else {
        setScanError(true);
      }
    } catch {
      setScanError(true);
    }
  };

  return (
    <div className="space-y-3">
      {/*
        `data-search-input` is the `/` hotkey's target (keyboard.tsx). It lives HERE, on the
        picker's own input, rather than being stamped on from a screen's wrapper effect — which is
        what opd-desk.tsx did while this component was outside that task's Files list (Plan 08 T13
        absorbs that debt, and the wrapper's setAttribute line is deleted with it).
      */}
      <input
        data-search-input
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("picker.searchPlaceholder")}
        aria-label={t("picker.searchLabel")}
        className="w-full rounded border px-3 py-2"
      />
      <div className="space-y-1">
        {(search.data?.items ?? []).map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => onPick({ id: hit.id, uhid: hit.uhid, name: hit.name, sex: hit.sex, dob: hit.dob })}
            className="flex w-full items-center gap-2 rounded border p-1 text-left hover:bg-neutral-50"
          >
            {hit.hasPhoto ? (
              <PatientPhoto patientId={hit.id} className="h-8 w-7 rounded" />
            ) : (
              <div className="h-8 w-7 rounded bg-neutral-100" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{hit.name}</span>
              <span className="block font-mono text-xs text-neutral-600">{hit.uhid}</span>
            </span>
          </button>
        ))}
      </div>
      <div>
        {/*
          THE WEDGE LANE (owner ruling 5): the counters' USB/Bluetooth scanners are KEYBOARDS. They
          type the payload one keystroke at a time and finish with Enter, so there is no paste event
          to hook — which is why the shipped `onPaste` lane alone left the scanners unsupported.

          ENTER IS THE TRIGGER, and it is the only one. The buffer is an ACCUMULATOR, not a timer
          gate: a scan delivered in 8 ms and a UHID typed by hand take the identical path and fire
          the identical `verify` call the paste lane fires. The 500 ms idle window only DISCARDS a
          stale buffer, so an interrupted half-scan cannot prefix the next one; nothing is ever
          verified because the window elapsed. The box is cleared with the buffer — leaving the
          stale text visible would let the next scan append to it, which is the bug this guards.
          (A stated cost: hand-typing SLOWER than one character per 500 ms into the SCAN box loses
          it. The free-text box above is the lane for typing, and it has no such window.)
        */}
        <input
          value={scan}
          onChange={(e) => {
            setScan(e.target.value);
            wedgeRef.current = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (idleRef.current !== null) {
                clearTimeout(idleRef.current);
                idleRef.current = null;
              }
              const text = wedgeRef.current.trim();
              wedgeRef.current = "";
              if (text !== "") void verify(text);
              return;
            }
            if (e.key.length !== 1) return; // Shift, Tab, arrows… are not payload
            // The buffer only ACCUMULATES here; the visible box is updated by the browser's own
            // text insertion, whose `onChange` above re-syncs the buffer to the truth. Writing the
            // box from this handler would fight that insertion and double every character.
            wedgeRef.current += e.key;
            if (idleRef.current !== null) clearTimeout(idleRef.current);
            idleRef.current = setTimeout(() => {
              idleRef.current = null;
              wedgeRef.current = "";
              setScan("");
            }, WEDGE_IDLE_MS);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").trim();
            if (text !== "") void verify(text);
          }}
          placeholder={t("picker.scanPlaceholder")}
          aria-label={t("picker.scanLabel")}
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
        {scanError && <p role="alert" className="text-sm text-red-600">{t("picker.badScan")}</p>}
      </div>
    </div>
  );
}
