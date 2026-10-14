import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../lib/auth";
import "./ward-picker.css";

/**
 * IPD walk 2026-10-14 (#733 #735 #736) — ONE WARD PICKER FOR EVERY WARD SCREEN.
 *
 * The staging walk found /ipd/ward, /ipd/my-shift, /ipd/mar and /ipd/narcotics drawing one chip per ward: 60 chips,
 * a full phone screen of buttons before the first bed. Two wards share the name "Twin-sharing rooms", so a chip that
 * says only the name cannot be told from its twin, and a chip that says only the code ("F03-SPVT") cannot be read.
 *
 * So every ward screen (and /diet/ward) uses this: a native select (the phone's own picker on a phone), grouped by
 * floor, each ward labelled "name · code". The last ward a person picked is remembered per user on this device; a
 * person with nothing remembered and more than one ward is ASKED rather than dropped on the server's first ward
 * (DECIDED: no staff-to-ward assignment exists anywhere in the data, so the server's first ward is arbitrary).
 */
export type WardRef = { id: string; code: string; name: string };

export const wardLabel = (w: WardRef): string => `${w.name} · ${w.code}`;

/** The floor a ward stands on, read off its code ("F03-MED-F" → 3). Null when the code carries no floor. */
export function floorOf(code: string): number | null {
  const m = /^F(\d{1,2})-/i.exec(code);
  return m === null ? null : Number(m[1]);
}

export function groupByFloor(wards: readonly WardRef[]): { floor: number | null; wards: WardRef[] }[] {
  const groups = new Map<number | null, WardRef[]>();
  for (const w of wards) {
    const f = floorOf(w.code);
    groups.set(f, [...(groups.get(f) ?? []), w]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([floor, ws]) => ({ floor, wards: ws }));
}

const KEY_PREFIX = "hmis.ward.last";
const keyFor = (user: string | null): string => (user === null || user === "" ? KEY_PREFIX : `${KEY_PREFIX}.${user}`);

export function readLastWard(user: string | null): string | null {
  try { return globalThis.localStorage?.getItem(keyFor(user)) ?? null; } catch { return null; }
}
export function keepLastWard(user: string | null, wardId: string): void {
  try { globalThis.localStorage?.setItem(keyFor(user), wardId); } catch { /* private window: remembered for this page only */ }
}

/**
 * The ward this person is looking at. `explicit` (a ward in the URL) wins, then the last ward they picked. The screen
 * fetches with `wardId`; once it has the list, `needsPick(wards)` says whether to ask instead of showing a ward the
 * person never chose.
 */
export function useWardChoice(explicit?: string | null): {
  wardId: string | null;
  choose: (id: string) => void;
  needsPick: (wards: readonly WardRef[]) => boolean;
} {
  const { username } = useAuth();
  const [chosen, setChosen] = useState<string | null>(() => explicit ?? readLastWard(username));
  const wardId = explicit ?? chosen;
  const choose = useCallback((id: string) => { setChosen(id); keepLastWard(username, id); }, [username]);
  const needsPick = useCallback((wards: readonly WardRef[]) => {
    if (wards.length <= 1) return false;
    return wardId === null || !wards.some((w) => w.id === wardId);
  }, [wardId]);
  return { wardId, choose, needsPick };
}

export function WardPicker({ wards, value, onChange, className, testId = "ward-picker" }: {
  wards: readonly WardRef[];
  value: string | null;
  onChange: (id: string) => void;
  className?: string;
  testId?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const known = value !== null && wards.some((w) => w.id === value);
  const floorName = (f: number | null): string =>
    f === null ? t("ipdNursing.wardPicker.otherFloor") : f === 0 ? t("ipdNursing.wardPicker.ground") : t("ipdNursing.wardPicker.floor", { n: f });
  return (
    <label className={`ward-picker${className ? ` ${className}` : ""}`}>
      <span className="ward-picker__label">{t("ipdNursing.wardPicker.label")}</span>
      <select value={known ? value : ""} onChange={(e) => { if (e.target.value !== "") onChange(e.target.value); }} data-testid={testId}>
        {known ? null : <option value="" disabled>{t("ipdNursing.wardPicker.choose")}</option>}
        {groupByFloor(wards).map((g) => (
          <optgroup key={g.floor ?? "other"} label={floorName(g.floor)}>
            {g.wards.map((w) => <option key={w.id} value={w.id}>{wardLabel(w)}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** What a ward screen shows in place of its body while the person has not picked a ward. */
export function PickWardPrompt({ className }: { className?: string }): React.ReactElement {
  const { t } = useTranslation();
  return <div className={className} role="status" data-testid="ward-pick-prompt">{t("ipdNursing.wardPicker.pickFirst")}</div>;
}
