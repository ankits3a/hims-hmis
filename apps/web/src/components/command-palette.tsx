import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { useDebounced } from "../lib/format";
import { api } from "../lib/api";
import { recordOpened, runSearch } from "../lib/search-api";
import type { PaletteResponse } from "../lib/search-api";
import { VoiceButton } from "./voice-button";
import type { SearchEntity, SearchHit } from "@hmis/contracts";

type PaletteState = { isOpen: boolean; open: (seed?: string) => void; close: () => void };
const PaletteContext = createContext<PaletteState | null>(null);

export function usePalette(): PaletteState {
  const ctx = useContext(PaletteContext);
  if (ctx === null) throw new Error("usePalette outside PaletteProvider");
  return ctx;
}

/**
 * PLAN 11h T8 — THE COMMAND PALETTE.
 *
 * `/` opened a per-screen input on six of sixteen screens and did nothing on the other ten. This
 * replaces that with one surface over every entity the signed-in person may see, plus the screens
 * they may reach — which is why T6's effective-permissions projection had to land first.
 *
 * WHAT IS DELIBERATELY NOT PERSISTED: recent searches. They are patient names, these are shared
 * counter machines, and `localStorage` survives the shift change. Recents live in component state
 * and die with the tab (plan DD8).
 */
export function PaletteProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [seed, setSeed] = useState("");
  const open = useCallback((s = "") => { setSeed(s); setIsOpen(true); }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return (
    <PaletteContext.Provider value={value}>
      {children}
      {isOpen ? <CommandPalette seed={seed} onClose={close} /> : null}
    </PaletteContext.Provider>
  );
}

/** A command is a navigation the signed-in person is allowed to make (T6). */
type Command = { to: string; label: string; permission: string };

const COMMANDS: readonly Command[] = [
  { to: "/registration", label: "nav.registration", permission: "patients.register" },
  { to: "/merge", label: "nav.merge", permission: "patients.merge" },
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read" },
  { to: "/opd/appointments", label: "nav.opdAppointments", permission: "opd.appointments.read" },
  { to: "/opd/desk", label: "nav.opdDesk", permission: "opd.visits.open" },
  { to: "/opd/vitals", label: "nav.opdVitals", permission: "opd.vitals.record" },
  { to: "/opd/consult", label: "nav.opdConsult", permission: "opd.consult" },
  { to: "/opd/display", label: "nav.opdDisplay", permission: "opd.display.read" },
  { to: "/billing", label: "nav.billing", permission: "billing.invoice.issue" },
  { to: "/billing/dues", label: "nav.billingDues", permission: "billing.invoice.read" },
  { to: "/billing/session", label: "nav.billingSession", permission: "billing.session.own" },
  { to: "/billing/office", label: "nav.billingOffice", permission: "billing.reports.read" },
  { to: "/ops/mode", label: "nav.opsMode", permission: "ops.mode.set" },
  { to: "/ops/downtime-kit", label: "nav.opsDowntimeKit", permission: "ops.downtime.generate" },
  { to: "/admin/users", label: "nav.adminUsers", permission: "auth.users.manage" },
];

/**
 * How fast a human cannot type. A barcode wedge delivers a whole payload in well under this;
 * fingers do not. `patient-picker.tsx` proved the same discipline for the scan box — this is the
 * palette inheriting it so a card scanned on ANY screen opens the patient (plan DD6).
 */
const WEDGE_MAX_MS = 120;
const WEDGE_MIN_CHARS = 12;

/**
 * Is this input a SCAN rather than typing? Extracted so the decision can be asserted and mutated
 * on its own. Both halves matter: a short burst is somebody typing fast, and a long payload
 * entered slowly is somebody reading a UHID off a card aloud. Only long AND fast is a wedge, and
 * routing anything else to `qr/verify` would fire a lookup on every long query a desk ever types.
 */
export function isWedgeInput(length: number, elapsedMs: number): boolean {
  return length >= WEDGE_MIN_CHARS && elapsedMs <= WEDGE_MAX_MS;
}

type Row = { kind: "hit"; hit: SearchHit; entity: SearchEntity } | { kind: "command"; command: Command };

function CommandPalette({ seed, onClose }: { seed: string; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [raw, setRaw] = useState(seed);
  const [result, setResult] = useState<PaletteResponse | null>(null);
  const [cursor, setCursor] = useState(0);
  const [scanning, setScanning] = useState(false);
  const debounced = useDebounced(raw, 200);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const firstKeyAt = useRef<number | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let cancelled = false;
    if (debounced.trim().length < 2) { setResult(null); return () => { cancelled = true; }; }
    void runSearch(debounced).then((r) => { if (!cancelled) { setResult(r); setCursor(0); } }).catch(() => {
      if (!cancelled) setResult(null);
    });
    return () => { cancelled = true; };
  }, [debounced]);

  const commands = useMemo(
    () => (raw.trim().length < 2 ? [] : COMMANDS.filter((c) => can(c.permission) && t(c.label).toLowerCase().includes(raw.trim().toLowerCase()))),
    [raw, can, t],
  );

  const rows: Row[] = useMemo(() => [
    ...commands.map((command): Row => ({ kind: "command", command })),
    ...(result?.groups ?? []).flatMap((g) => g.hits.map((hit): Row => ({ kind: "hit", hit, entity: g.entity }))),
  ], [commands, result]);

  const take = useCallback((row: Row) => {
    if (row.kind === "command") { void navigate({ to: row.command.to as never }); onClose(); return; }
    if (result !== null) recordOpened(result.auditId, row.entity, row.hit.id);
    if (row.hit.href !== undefined) void navigate({ to: row.hit.href as never });
    onClose();
  }, [navigate, onClose, result]);

  /**
   * A WEDGE SCAN IS NOT TYPING (plan DD6). A card scanned anywhere in the app should open its
   * patient, and the only thing separating a scan from a person typing a long UHID is SPEED.
   */
  const onChange = (next: string): void => {
    const at = Date.now();
    if (raw.length === 0) firstKeyAt.current = at;
    setRaw(next);
    const elapsed = at - (firstKeyAt.current ?? at);
    if (isWedgeInput(next.length, elapsed)) {
      setScanning(true);
      void api<{ ok: boolean; patient?: { id: string } }>("POST", "/patients/qr/verify", { payload: next })
        .then((res) => {
          if (res.ok && res.patient !== undefined) { void navigate({ to: `/patients/${res.patient.id}` as never }); onClose(); }
        })
        .catch(() => { /* a failed scan falls back to being ordinary text */ })
        .finally(() => setScanning(false));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0))); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row !== undefined) take(row);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/40 pt-24 backdrop-blur-sm motion-reduce:backdrop-blur-none motion-reduce:bg-neutral-900/70"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={t("palette.title")} className="w-full max-w-2xl rounded-lg border bg-white shadow-xl">
        <input
          ref={inputRef}
          data-palette-input
          className="w-full rounded-t-lg border-b px-4 py-3 text-lg outline-none"
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.title")}
          value={raw}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <VoiceButton />
        <div aria-live="polite" className="px-4 py-1 text-xs text-neutral-500">
          {scanning ? t("palette.scanning") : t("palette.count", { count: rows.length })}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {rows.map((row, i) => (
            <li key={row.kind === "command" ? row.command.to : `${row.entity}:${row.hit.id}`}>
              <button
                type="button"
                aria-current={i === cursor ? "true" : undefined}
                className={`flex w-full flex-col items-start px-4 py-2 text-left ${i === cursor ? "bg-neutral-100" : ""}`}
                onClick={() => take(row)}
              >
                {row.kind === "command" ? (
                  <span>{t(row.command.label)}</span>
                ) : (
                  <>
                    <span>
                      {row.hit.title}
                      {row.hit.meta?.match === "approximate" ? (
                        <span className="ml-2 text-xs text-amber-700">{t("palette.approximate")}</span>
                      ) : null}
                      {row.hit.restricted !== undefined ? (
                        <span className="ml-2 text-xs text-red-700">{t("palette.restricted")}</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-neutral-500">{row.hit.subtitle}</span>
                  </>
                )}
              </button>
            </li>
          ))}
          {rows.length === 0 && debounced.trim().length >= 2 ? (
            <li className="px-4 py-3 text-sm text-neutral-500">{t("palette.none")}</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
