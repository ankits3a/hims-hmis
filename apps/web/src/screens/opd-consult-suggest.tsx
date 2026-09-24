import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { StockTag, useDoctorStock } from "./opd-consult-v2";
import type { WireAdvisedTest } from "../lib/opd-api";
import type { WireRegimen, WireSyndromeHit } from "../lib/cds-api";

/*
 * ═══ CONSULT V2 PR 3 (owner, 2026-09-23, round 4) ═══
 *
 * Two things the second PR left out:
 *   1. "Autocomplete chips should appear when typing characters everywhere" — `TermInput`.
 *   2. "If the right panel is minimised, the inline suggestion in the same column is enabled
 *      automatically" — `CopilotSuggestions`, mounted in the copilot column when it is open and at
 *      the head of the active tab when it is folded. Never both.
 *
 * Every suggestion is a dashed chip that one tap accepts. Nothing is entered silently, and nothing on
 * the tap path asks a model: diagnoses come from the syndrome matcher, tests from what this hospital
 * advised before for the same diagnosis, medicines from the regimen book.
 */

export type TermOption = { term: string; hint?: string | null };

/**
 * THE AUTOCOMPLETE INPUT. Typing lists matches (the doctor's own words first, then the hospital's
 * list). ↑/↓ move, Enter takes the highlighted row, or the typed words when nothing is highlighted, and
 * Esc closes the list. A doctor's own phrase is always allowed; it becomes their private entry (D4).
 */
export function TermInput({ id, label, placeholder, local, remote, exclude = [], onAdd, testId }: {
  id: string; label: string; placeholder: string;
  /** The hospital's own list for this field, filtered on the screen. */
  local: string[];
  /** The doctor's own earlier words, from the server. */
  remote?: (q: string) => Promise<TermOption[]>;
  exclude?: string[];
  onAdd: (term: string) => void;
  testId?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const listId = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [mine, setMine] = useState<TermOption[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const needle = q.trim();
    if (remote === undefined || needle === "") { setMine([]); return; }
    const n = ++seq.current;
    const timer = setTimeout(() => {
      remote(needle).then((r) => { if (n === seq.current) setMine(r); }).catch(() => { if (n === seq.current) setMine([]); });
    }, 180);
    return () => { clearTimeout(timer); };
  }, [q, remote]);

  const needle = q.trim().toLowerCase();
  const taken = new Set(exclude.map((x) => x.toLowerCase()));
  const seen = new Set<string>();
  const options: TermOption[] = [];
  for (const o of [...mine, ...local.filter((l) => l.toLowerCase().includes(needle)).map((term) => ({ term }))]) {
    const k = o.term.toLowerCase();
    if (needle === "" || seen.has(k) || taken.has(k)) continue;
    seen.add(k);
    options.push(o);
    if (options.length >= 8) break;
  }
  const shown = open && needle !== "";

  const commit = (term: string): void => {
    const x = term.trim();
    if (x === "" || taken.has(x.toLowerCase())) return;
    onAdd(x);
    setQ(""); setHi(-1); setOpen(false);
  };

  return (
    <div style={{ position: "relative", flexGrow: 1 }}>
      <label htmlFor={id} style={{ position: "absolute", left: -9999 }}>{label}</label>
      <input
        id={id} data-testid={testId} className="in" value={q} placeholder={placeholder} autoComplete="off"
        role="combobox" aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown && hi >= 0 ? `${listId}-${String(hi)}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(-1); }}
        onBlur={() => { setTimeout(() => { setOpen(false); }, 120); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
          else if (e.key === "Escape") { if (shown) { e.preventDefault(); e.stopPropagation(); setOpen(false); setHi(-1); } }
          else if (e.key === "Enter") { e.preventDefault(); commit(hi >= 0 && options[hi] !== undefined ? options[hi].term : q); }
        }}
        style={{ width: "100%", boxSizing: "border-box", height: 32, fontSize: 12.5 }}
      />
      {shown && (
        <ul id={listId} role="listbox" aria-label={label}
          style={{ position: "absolute", top: 35, left: 0, right: 0, zIndex: 20, margin: 0, padding: 4, listStyle: "none", background: "var(--card, #fff)", border: "1px solid var(--line)", borderRadius: 8, boxShadow: "0 6px 18px rgba(19,36,32,.12)" }}>
          {options.map((o, i) => (
            <li key={o.term} id={`${listId}-${String(i)}`} role="option" aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); commit(o.term); }}
              style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer", background: i === hi ? "rgba(14,107,78,.08)" : "transparent" }}>
              <span>{o.term}</span>
              {o.hint != null && o.hint !== "" && <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>{o.hint}</span>}
            </li>
          ))}
          <li id={`${listId}-own`} role="option" aria-selected={false}
            onMouseDown={(e) => { e.preventDefault(); commit(q); }}
            style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, color: "var(--dim)", cursor: "pointer" }}>
            {t("opdConsultV3.addOwn", { term: q.trim() })}
          </li>
        </ul>
      )}
    </div>
  );
}

type TermFieldKey = "exam_general" | "exam_systemic" | "exam_local" | "treatment";
const remotes = new Map<TermFieldKey, (q: string) => Promise<TermOption[]>>();

/**
 * The doctor's own earlier words for a Consult v2 field (D4: never another doctor's). One function per
 * field for the life of the page, so `TermInput`'s effect sees a stable reference and does not refetch
 * on every render.
 */
export function ownTerms(field: TermFieldKey): (q: string) => Promise<TermOption[]> {
  let f = remotes.get(field);
  if (f === undefined) {
    f = async (q: string): Promise<TermOption[]> => {
      const r = await api<{ items: { term: string; uses: number }[] }>(
        "GET", `/opd/cds/complete/term?field=${field}&q=${encodeURIComponent(q)}`);
      return r.items.map((i) => ({ term: i.term, hint: `×${String(i.uses)}` }));
    };
    remotes.set(field, f);
  }
  return f;
}

type TestHit = WireAdvisedTest & { mine: number; hospital: number };

/**
 * THE COPILOT'S SUGGESTIONS, IN ONE PLACE — mounted in the copilot column when it is open, at the head
 * of the active tab when it is folded (owner, round 4). Complaints → diagnoses; complaints + diagnosis →
 * tests and medicines, with the pharmacy's stock beside each medicine.
 */
export function CopilotSuggestions({ variant, hits, diagnoses, onAddDx, advised, onAddTest, regimen, onOpenRegimen, onFillRx }: {
  variant: "pane" | "inline";
  hits: WireSyndromeHit[];
  /** The diagnoses on screen now, with their code when one was picked. */
  diagnoses: { text: string; icd10: string | null }[];
  onAddDx: (name: string, icd10: string | null) => void;
  advised: WireAdvisedTest[];
  onAddTest: (test: WireAdvisedTest) => void;
  regimen: WireRegimen | null;
  onOpenRegimen: (key: string) => void;
  onFillRx: () => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const dxKey = JSON.stringify(diagnoses);
  const tests = useQuery({
    queryKey: ["opd", "suggest-tests", dxKey], enabled: diagnoses.length > 0, staleTime: 60_000,
    queryFn: () => api<{ items: TestHit[] }>("GET", `/opd/cds/suggest/tests?dx=${encodeURIComponent(dxKey)}`),
  });
  const stock = useDoctorStock((regimen?.regimen.lines ?? []).map((l) => l.rx.medicineId ?? ""));

  const have = new Set(diagnoses.map((d) => d.text.toLowerCase()));
  const dxChips = hits.filter((h) => !have.has(h.name.toLowerCase())).slice(0, 4);
  const advisedIds = new Set(advised.map((a) => a.serviceId));
  const testChips = (tests.data?.items ?? []).filter((x) => !advisedIds.has(x.serviceId)).slice(0, 6);
  const rxFor = hits.find((h) => have.has(h.name.toLowerCase())) ?? null;

  if (dxChips.length === 0 && testChips.length === 0 && regimen === null && rxFor === null) return null;

  const pane = variant === "pane";
  /* The copilot column is WHITE now (the Consult Engine boards): the pane's chips read on paper, like the inline ones. */
  const chip: React.CSSProperties = {
    padding: "3px 11px", fontSize: 12.5, borderRadius: 15, border: "1.5px dashed var(--green)",
    background: "rgba(14,107,78,.05)", color: "var(--green)",
  };
  const head: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", color: "var(--green)" };

  return (
    <section data-testid={`copilot-suggestions-${variant}`} aria-label={t("opdConsultV3.suggestions")}
      style={pane
        ? { display: "flex", flexDirection: "column", gap: 10 }
        : { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 8, border: "1px dashed var(--green)", background: "rgba(14,107,78,.03)" }}>
      {!pane && <span className="mo" style={head}>{t("opdConsultV3.folded")}</span>}

      {dxChips.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="mo" style={head}>{t("opdConsultV3.dxHead")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {dxChips.map((h) => (
              <button key={h.key} type="button" data-testid={`sug-dx-${h.key}`} style={chip}
                onClick={() => { onAddDx(h.name, h.icd10); onOpenRegimen(h.key); }}>
                + {h.name}{h.icd10 === null ? "" : ` · ${h.icd10}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {testChips.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="mo" style={head}>{t("opdConsultV3.testsHead")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {testChips.map((x) => (
              <button key={x.serviceId} type="button" data-testid={`sug-test-${x.serviceId}`} style={chip}
                title={t("opdConsultV3.testsWhy", { mine: x.mine, hospital: x.hospital })}
                onClick={() => { onAddTest({ serviceId: x.serviceId, code: x.code, name: x.name, pricePaise: x.pricePaise }); }}>
                + {x.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {regimen === null && rxFor !== null && (
        <button type="button" data-testid={`sug-rx-open-${rxFor.key}`} style={{ ...chip, alignSelf: "flex-start" }}
          onClick={() => { onOpenRegimen(rxFor.key); }}>
          {t("opdConsultV3.rxFor", { name: rxFor.name })}
        </button>
      )}
      {regimen !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="mo" style={head}>{t("opdConsultV3.rxHead", { name: regimen.regimen.syndrome.name })}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, paddingTop: 6 }}>
            {regimen.regimen.lines.map((l) => (
              <span key={`${l.band}-${String(l.seq)}`} data-testid={`sug-rx-line-${String(l.seq)}`}
                style={{ position: "relative", padding: "5px 10px", fontSize: 12, borderRadius: 8, border: "1px solid var(--line)", background: pane ? "transparent" : "var(--card, #fff)" }}>
                <StockTag stock={l.rx.medicineId == null ? undefined : stock.get(l.rx.medicineId)} testId={`sug-rx-stock-${String(l.seq)}`} />
                {l.drugLabel}
              </span>
            ))}
          </div>
          <button type="button" data-testid="sug-rx-fill" style={{ ...chip, alignSelf: "flex-start" }} onClick={onFillRx}>
            {t("opdConsultV3.rxFill", { n: regimen.regimen.lines.length })}
          </button>
        </div>
      )}
    </section>
  );
}
