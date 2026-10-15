import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { completeAllergen } from "../../lib/opd-api";
import type { WireAllergenHit } from "../../lib/opd-api";
import type { AllergyDraft } from "./session";

/**
 * ═══ ALLERGIES AT REGISTRATION (owner, 2026-10-01) ═══
 *
 * *"Add allergy input and selection in registration screen as well."* The same typeahead the bay,
 * the doctor and the profile have (`GET /opd/cds/complete/allergen`): the prescription guard matches
 * free text on word tokens, so a misspelt allergen never fires its block, and a PICK carries the
 * coded class or salt. Free text is still legal — the line under the box says when the guard knows
 * no rule for it.
 *
 * Nothing is posted from here. A patient does not exist until the UHID does, so the list rides on
 * the form and `enrol` posts each row to `/patients/:id/allergies` once the registration answers.
 * `pending` is on the form too, so an allergen typed but not yet added is not lost at Register.
 */
export function RegAllergies(
  { list, pending, onChange }: {
    list: AllergyDraft[]; pending: AllergyDraft;
    /* ONE patch for both: the form's `set` spreads over the value it rendered with, so two calls in
       one handler would have the second undo the first. */
    onChange: (next: { allergies?: AllergyDraft[]; allergyPending?: AllergyDraft }) => void;
  },
): React.ReactElement {
  const { t } = useTranslation();
  const [hits, setHits] = useState<WireAllergenHit[]>([]);
  const [known, setKnown] = useState(true);
  const q = pending.substance.trim();
  const picked = pending.saltId !== null || pending.allergenClass !== null;

  /* 120 ms debounce, three-character floor, and `asked` so a slow answer to an old prefix loses. */
  const asked = useRef("");
  useEffect(() => {
    asked.current = q;
    if (q.length < 3 || picked) { setHits([]); setKnown(true); return; }
    let live = true;
    const timer = setTimeout(() => {
      completeAllergen(q)
        .then((r) => {
          if (!live || asked.current !== q) return;
          setHits(r.items);
          setKnown(r.known);
        })
        /* A suggester that is down leaves a plain text box that still saves, and no false warning. */
        .catch(() => { if (live) { setHits([]); setKnown(true); } });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [q, picked]);

  const add = (): void => {
    if (q === "") return;
    /* The same allergen twice is one fact; the later severity wins. */
    onChange({
      allergies: [...list.filter((a) => a.substance.toLowerCase() !== q.toLowerCase()), { ...pending, substance: q }],
      allergyPending: { substance: "", severity: "mild", saltId: null, allergenClass: null },
    });
    setHits([]); setKnown(true);
  };

  return (
    <div className="box" data-testid="reg-allergies" style={{ marginTop: 12, padding: "10px 13px 12px" }}>
      <div className="tag">{t("registrationCounter.register.allergy.title")}</div>
      {list.length > 0 && (
        <div data-testid="reg-allergy-list" style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "6px 0 8px" }}>
          {list.map((a) => (
            <span key={a.substance} className="pill rd" style={{ fontWeight: 600 }}>
              {a.substance} · {t(`patient.${a.severity}`)}
              <button
                type="button" data-testid={`reg-allergy-remove-${a.substance}`}
                aria-label={t("registrationCounter.register.allergy.remove", { name: a.substance })}
                onClick={() => { onChange({ allergies: list.filter((x) => x !== a) }); }}
                style={{ marginLeft: 6, border: "none", background: "none", cursor: "pointer", color: "inherit", padding: 0 }}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1.9fr 1fr auto", gap: 10, alignItems: "end" }}>
        <div style={{ position: "relative" }}>
          <div className="tag" style={{ marginBottom: 5 }}>{t("registrationCounter.register.allergy.substance")}</div>
          <input
            className="in" data-testid="reg-allergy-substance" autoComplete="off" value={pending.substance}
            placeholder={t("registrationCounter.register.allergy.placeholder")}
            /* The code belonged to the OLD words — a keystroke clears it. */
            onChange={(e) => { onChange({ allergyPending: { ...pending, substance: e.target.value, saltId: null, allergenClass: null } }); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          {hits.length > 0 && (
            <ul
              data-testid="reg-allergy-hits"
              style={{
                position: "absolute", zIndex: 5, top: "100%", left: 0, right: 0, margin: "2px 0 0", padding: 0,
                listStyle: "none", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 5,
                maxHeight: 200, overflowY: "auto",
              }}
            >
              {hits.map((h) => (
                <li key={`${h.kind}-${h.term}`}>
                  <button
                    type="button" data-testid={`reg-allergy-hit-${h.term}`}
                    onMouseDown={(e) => { e.preventDefault(); }}
                    onClick={() => {
                      onChange({ allergyPending: { ...pending, substance: h.term, saltId: h.saltId, allergenClass: h.allergenClass } });
                      setHits([]); setKnown(true);
                    }}
                    style={{
                      display: "block", width: "100%", textAlign: "left", padding: "6px 9px",
                      border: "none", background: "none", cursor: "pointer", fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{h.term}</span>
                    {h.blocks.length > 0 && (
                      <span className="mo" style={{ display: "block", fontSize: 11, color: "var(--faint)" }}>
                        {t("opdConsult.allergyBlocks", { list: h.blocks.slice(0, 4).join(", ") })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>{t("patient.severity")}</div>
          <select
            className="in" data-testid="reg-allergy-severity" value={pending.severity} style={{ height: 40 }}
            onChange={(e) => { onChange({ allergyPending: { ...pending, severity: e.target.value as AllergyDraft["severity"] } }); }}
          >
            <option value="mild">{t("patient.mild")}</option>
            <option value="moderate">{t("patient.moderate")}</option>
            <option value="severe">{t("patient.severe")}</option>
          </select>
        </div>
        <button type="button" className="sec" data-testid="reg-allergy-add" disabled={q === ""} onClick={add} style={{ height: 40 }}>
          {t("registrationCounter.register.allergy.add")}
        </button>
      </div>
      {!known && !picked && q.length >= 3 && (
        <div data-testid="reg-allergy-unknown" style={{ fontSize: 11, color: "var(--gold)", marginTop: 4 }}>
          {t("opdConsult.allergyUnknown")}
        </div>
      )}
    </div>
  );
}
