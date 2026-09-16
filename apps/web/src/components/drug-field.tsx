import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchMedicines } from "../lib/formulary-api";
import type { WireMedicineHit } from "../lib/formulary-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DRUG FIELD — TYPE THREE LETTERS, SEE THE CATALOGUE, TAP ONE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: *"even though the doctor doesn't enable AI suggestion in the prescription tab,
 * auto complete will work if doctor starts to type drug name … 'par' → 'Paracetamol Tablets IP
 * 500mg[500 mg | Tablet | D0230]' … our format could be lot better than what I just gave you."*
 *
 * ═══ THE ROW, AND WHY IT IS TWO LINES ═══
 *
 *   Paracetamol 500 mg oral capsule                             Oral capsule
 *   paracetamol · 500 mg · D7611
 *
 * The NAME carries the typed prefix in bold, because a doctor scanning ten rows is looking for the
 * letters they just typed. Underneath, in mono, the things that decide WHICH paracetamol: the
 * moiety (what it actually is — and the reason `clav` finds Augmentin), the strength, and the
 * hospital's own code, which is what a storekeeper reads off a shelf. The form sits right, where
 * the eye lands last, because "tablet or syrup" is usually already known from the patient.
 *
 * ═══ WHAT IT REPLACED, AND WHY IT HAD TO ═══
 *
 * A `<select>` holding every medicine. Against a curated handful that was fine; against the owner's
 * catalogue it is 103,383 options on every consult screen load. This comment used to say "a 15 MB
 * payload — measured", and no field subset reproduces that. The measured figures are 57.3 MiB full
 * and 37.0 MiB trimmed, with the method in `lib/formulary-api.ts`. A typeahead is not a nicety at
 * this size, it is the only workable instrument.
 *
 * ═══ "NOT YET REVIEWED BY PHARMACY" (formulary phase 2) ═══
 *
 * A row whose `reviewed` is false has a component that is still the national release's entry, with
 * no pharmacist's attestation behind it. That component carries no drug class and no interaction
 * pairs, so the checks that run on the line cannot see what they would see for a reviewed one. The
 * pick is still allowed: free prescribing is never taken away. But the row says so, in words,
 * before the tap rather than after.
 *
 * FREE TYPING IS NEVER TAKEN AWAY (16a design law 1): the input is the value, a doctor may write
 * anything, and picking a row simply fills the name AND the id — which is what turns a line into
 * one the interaction and duplicate checks can reason about.
 */
export function DrugField({
  value, onPick, onText, placeholder, inputId,
}: {
  value: string;
  /** A row was chosen: the caller sets both the name and the medicine id. */
  onPick: (hit: WireMedicineHit) => void;
  /** Free text, exactly as typed. */
  onText: (text: string) => void;
  placeholder?: string;
  inputId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [hits, setHits] = useState<WireMedicineHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const asked = useRef("");
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = value.trim();
    asked.current = q;
    if (q.length < 3) { setHits([]); setBusy(false); return; }
    let live = true;
    setBusy(true);
    /* 180 ms: the search answers in about 220, so a faster cadence would queue requests behind a
       doctor who types at speed and show them answers to prefixes they have already left. */
    const timer = setTimeout(() => {
      void searchMedicines(q)
        .then((items) => {
          if (!live || asked.current !== q) return;
          setHits(items);
          setOpen(items.length > 0);
        })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setBusy(false); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [value]);

  /* A click outside closes the list; the value stays whatever the doctor typed. */
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mousedown", onDown); };
  }, []);

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input
        id={inputId} value={value} className="in" autoComplete="off"
        style={{ width: "100%", height: 34, fontSize: 13 }}
        placeholder={placeholder}
        onChange={(e) => { onText(e.target.value); }}
        onFocus={() => { if (hits.length > 0) setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}
      />
      {busy && (
        <span className="mo" data-testid={`${inputId}-busy`} style={{ position: "absolute", right: 9, top: 10, fontSize: 10, color: "var(--faint)" }}>…</span>
      )}
      {open && hits.length > 0 && (
        <ul
          data-testid={`${inputId}-hits`}
          style={{
            position: "absolute", zIndex: 20, top: 37, left: 0, right: 0, margin: 0, padding: 0,
            listStyle: "none", background: "var(--card)", border: "1px solid var(--line)",
            borderRadius: 7, boxShadow: "0 6px 18px rgba(19,36,32,.10)", maxHeight: 292, overflowY: "auto",
          }}
        >
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button" data-testid={`${inputId}-hit-${h.id}`}
                onClick={() => { onPick(h); setOpen(false); }}
                style={{
                  display: "flex", width: "100%", gap: 10, alignItems: "baseline", padding: "7px 10px",
                  border: 0, borderTop: "1px solid var(--line2)", background: "none", cursor: "pointer",
                  textAlign: "left", font: "inherit", color: "inherit",
                }}
              >
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, display: "block" }}>
                    {/* the typed prefix, in bold — what the eye is scanning for */}
                    {h.prefix
                      ? (<><strong>{h.name.slice(0, value.trim().length)}</strong>{h.name.slice(value.trim().length)}</>)
                      : h.name}
                  </span>
                  <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                    {[h.salts.join(" + ") || null, h.strength, h.code].filter((x) => x !== null && x !== "").join(" · ")}
                  </span>
                  {/* `=== false`, not `!`: an absent field is an older server saying nothing, not a warning. */}
                  {h.reviewed === false && (
                    <span
                      data-testid={`${inputId}-unreviewed-${h.id}`}
                      title={t("drugField.unreviewedTitle")}
                      style={{ display: "block", fontSize: 10.5, color: "#92400e" }}
                    >
                      {t("drugField.unreviewed")}
                    </span>
                  )}
                </span>
                <span className="pill" style={{ flexShrink: 0 }}>{h.form}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
