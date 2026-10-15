import type { NeedKind } from "./rules";

/**
 * A NOTIFICATION'S TAP LANDS ON ITS CARD (app home round 2). The tap arrives in the notifications
 * provider, above the router; the home screen may not be mounted yet. So the wish is left here and
 * the home takes it when it next draws: it scrolls nowhere clever — the card is outlined, and an
 * approval that is the only one waiting opens straight into its sheet.
 */
let wanted: NeedKind | null = null;
const listeners = new Set<() => void>();

export function focusHome(kind: NeedKind): void { wanted = kind; for (const l of listeners) l(); }
export function takeHomeFocus(): NeedKind | null { const k = wanted; wanted = null; return k; }
export function onHomeFocus(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
