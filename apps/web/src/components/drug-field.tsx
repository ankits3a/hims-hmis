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
/**
 * ═══ A SUGGESTION SAYS EACH THING ONCE ═══
 *
 * The row used to read, for one real catalogue entry:
 *
 *     Paracetamol 500 mg oral tablet
 *     Paracetamol · 500 mg · D0230                          [Tablet]
 *
 * — the molecule, the strength and the form all repeated from the title the doctor is already
 * reading. The owner's note of 2026-09-17 names it: remove the duplicacy while autosuggesting.
 *
 * The second line exists to say what the NAME does not. So a moiety already in the name is
 * dropped, a strength already in the name is dropped, and the form pill is dropped when the name
 * says the form — leaving the code, which is never in the name, and the moieties of a combination
 * whose brand name hides them, which is the case the line was written for:
 *
 *     Augmentin 625                                         [Tablet]
 *     Amoxicillin + Clavulanic acid · 625 mg · D1680
 *
 * Compared with the punctuation and spacing squashed out, because "500mg" in a name and "500 mg"
 * in a column are the same fact written two ways, and only one of them should reach the doctor.
 */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export function saysAlready(name: string, part: string | null): boolean {
  if (part === null || part === "") return false;
  const needle = squash(part);
  return needle !== "" && squash(name).includes(needle);
}

export function detailOf(h: { name: string; salts: string[]; strength: string | null; code: string | null }): string {
  const moieties = h.salts.filter((salt) => !saysAlready(h.name, salt)).join(" + ");
  const strength = saysAlready(h.name, h.strength) ? null : h.strength;
  return [moieties || null, strength, h.code].filter((x) => x !== null && x !== "").join(" · ");
}

export function DrugField({
  value, onPick, onText, placeholder, inputId, onEnter,
}: {
  /**
   * Owner ruling 2026-10-06 — the desk scribe types all day and never reaches for a mouse. Enter with
   * NO suggestion highlighted is the caller's (the scribe's table adds a line); with one highlighted
   * (↓ / ↑) it picks that suggestion, here. Absent, Enter does nothing new and the doctor's screen
   * behaves as it always has.
   */
  onEnter?: () => void;
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
  /**
   * THE NAME THAT WAS JUST PICKED, so the list does not reopen on top of the doctor.
   *
   * A pick writes `hit.name` into the field, which changes `value`, which re-runs the search below
   * — and 180 ms later the answers arrive and reopen the list the pick had just closed. In jsdom
   * the assertion runs before that timer, so the shipped test saw a closed list and passed; a
   * browser walk at 1280 px saw the list hanging over the sig drawer, swallowing the taps meant
   * for it. Editing the name clears this, and the field behaves as it always did.
   */
  const picked = useRef<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  /** The suggestion the arrow keys are on; -1 is "none", which is every list as it opens. */
  const [at, setAt] = useState(-1);

  useEffect(() => {
    const q = value.trim();
    asked.current = q;
    if (picked.current === q) { setHits([]); setBusy(false); return; }
    picked.current = null;
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
          setAt(-1);
          /*
            ONLY UNDER THE CURSOR (browser walk, 2026-10-06). A table that arrives PRE-FILLED — the
            doctor correcting what the desk typed — mounts three fields with three names, and each
            one searched and dropped its list open over the rows beneath it, with nobody typing in
            any of them. The answers are kept; the list opens when the field is the one in hand.
          */
          setOpen(items.length > 0 && box.current !== null && box.current.contains(document.activeElement));
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
        /* The input keeps its plain `textbox` role — every consult suite finds it by that — and names the
           highlighted suggestion for a screen reader without changing what the field is. */
        aria-activedescendant={open && at >= 0 && hits[at] !== undefined ? `${inputId}-opt-${hits[at].id}` : undefined}
        onKeyDown={(e) => {
          const listed = open && hits.length > 0;
          if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); return; }
          if (e.key === "ArrowDown" && listed) { e.preventDefault(); setAt((i) => Math.min(hits.length - 1, i + 1)); return; }
          if (e.key === "ArrowUp" && listed) { e.preventDefault(); setAt((i) => Math.max(-1, i - 1)); return; }
          if (e.key !== "Enter") return;
          const hit = listed && at >= 0 ? hits[at] : undefined;
          if (hit !== undefined) {
            e.preventDefault();
            picked.current = hit.name; onPick(hit); setOpen(false); setAt(-1);
          } else if (onEnter !== undefined) {
            e.preventDefault();
            setOpen(false);
            onEnter();
          }
        }}
      />
      {busy && (
        <span className="mo" data-testid={`${inputId}-busy`} style={{ position: "absolute", right: 9, top: 10, fontSize: 10, color: "var(--faint)" }}>…</span>
      )}
      {open && hits.length > 0 && (
        <ul
          id={`${inputId}-list`}
          data-testid={`${inputId}-hits`}
          style={{
            position: "absolute", zIndex: 20, top: 37, left: 0, right: 0, margin: 0, padding: 0,
            /*
              A FLOOR, BECAUSE THE COLUMN IS NOT THE LIST'S BUSINESS. Pinned left-to-right, this
              list inherits the width of the Drug column — about 170 px at phone width, where a
              browser walk showed "Amoxicillin + Clavulanic acid · 625 mg · D1680" wrapping onto
              FOUR lines and the third suggestion cut off below the fold. The input may be narrow;
              what it is offering must still be readable. Capped at 88vw so it cannot leave the
              screen it just grew past.
            */
            minWidth: "min(300px, 88vw)",
            listStyle: "none", background: "var(--card)", border: "1px solid var(--line)",
            borderRadius: 7, boxShadow: "0 6px 18px rgba(19,36,32,.10)", maxHeight: 292, overflowY: "auto",
          }}
        >
          {hits.map((h, i) => (
            <li key={h.id} id={`${inputId}-opt-${h.id}`} data-on={i === at ? "true" : undefined}>
              <button
                type="button" data-testid={`${inputId}-hit-${h.id}`} tabIndex={-1}
                onClick={() => { picked.current = h.name; onPick(h); setOpen(false); }}
                style={{
                  display: "flex", width: "100%", gap: 10, alignItems: "baseline", padding: "7px 10px",
                  border: 0, borderTop: "1px solid var(--line2)", background: i === at ? "var(--green-soft)" : "none", cursor: "pointer",
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
                    {detailOf(h)}
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
                {/* The pill is dropped when the NAME already says the form — see `detailOf`. */}
                {!saysAlready(h.name, h.form) && (
                  <span className="pill" style={{ flexShrink: 0 }}>{h.form}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
