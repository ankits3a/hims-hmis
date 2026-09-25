import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WireIcd11 } from "../lib/cds-api";

/**
 * ═══ ICD-11 BESIDE ICD-10 — A MUTED PILL, AND WHO'S CITATION ONCE PER SCREEN ═══
 *
 * The server attaches `icd11` to a diagnosis suggestion and to a saved diagnosis: WHO's answer for
 * that ICD-10 code in the latest loaded release of WHO's ICD-10 → ICD-11 one-to-one table, or null.
 * It is null everywhere until someone loads WHO's table by hand, and then this renders nothing —
 * the screen is exactly what it was.
 *
 * ICD-10 stays the code the doctor picks and the note saves. Nothing here is ever sent back.
 *
 * ═══ WHAT THE LICENCE ASKS OF A SCREEN (WHO ICD-11 Terms of Use, 2025-10-07) ═══
 *
 *   · §1.2.3 — the code, the title AND the URI travel together: the pill shows the code, carries
 *     WHO's title as its tooltip, and keeps the URI on the element.
 *   · §1.2.5 — what is ours is marked as ours: the "ICD-11" label and the lead-in are this
 *     hospital's words (translated); WHO's title and the citation stay verbatim English.
 *   · §1.3 — the citation, WORD FOR WORD, wherever ICD-11 appears. Once per screen rather than once
 *     per pill: `Icd11Scope` counts the pills on screen and `Icd11Citation` renders while any is.
 */

/** WHO's §1.3 citation. Verbatim, not translated, and not to be edited. */
export const ICD11_CITATION =
  "International Classification of Diseases, Eleventh Revision (ICD-11), World Health Organization (WHO) 2019 https://icd.who.int/browse11. "
  + "Licensed under the Creative Commons Attribution-NoDerivatives 3.0 IGO licence (CC BY-ND 3.0 IGO).";

/*
  TWO CONTEXTS, SO A PILL NEVER RE-RENDERS BECAUSE ANOTHER ONE MOUNTED. The register function is
  stable for the life of the scope; only the citation reads the changing count.
*/
const RegisterCtx = createContext<((release: string) => () => void) | null>(null);
const ShownCtx = createContext<ReadonlyMap<string, number>>(new Map());

export function Icd11Scope({ children }: { children: React.ReactNode }): React.ReactElement {
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const register = useCallback((release: string) => {
    const bump = (by: number) => {
      setShown((m) => {
        const next = new Map(m);
        const n = (next.get(release) ?? 0) + by;
        if (n <= 0) next.delete(release); else next.set(release, n);
        return next;
      });
    };
    bump(1);
    return () => { bump(-1); };
  }, []);
  return (
    <RegisterCtx.Provider value={register}>
      <ShownCtx.Provider value={shown}>{children}</ShownCtx.Provider>
    </RegisterCtx.Provider>
  );
}

/** "ICD-11 <code>", muted, WHO's title as the tooltip. Null renders nothing at all. */
export function Icd11Pill({ icd11, testId }: { icd11: WireIcd11 | null | undefined; testId?: string }): React.ReactElement | null {
  if (icd11 == null) return null;
  return <Pill icd11={icd11} testId={testId} />;
}

function Pill({ icd11, testId }: { icd11: WireIcd11; testId?: string | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const register = useContext(RegisterCtx);
  useEffect(() => register?.(icd11.release), [register, icd11.release]);
  return (
    <span
      className="mo" data-testid={testId} title={icd11.title} data-uri={icd11.uri}
      style={{
        marginLeft: 6, padding: "0 5px", borderRadius: 7, border: "1px solid var(--line)",
        fontSize: 10, fontWeight: 500, lineHeight: "15px", color: "var(--faint)", whiteSpace: "nowrap",
      }}
    >
      {`${t("cds.icd11.label")} ${icd11.code}`}
    </span>
  );
}

/** WHO's citation, while any pill in the enclosing scope is on screen. Place ONE per screen. */
export function Icd11Citation(): React.ReactElement | null {
  const { t } = useTranslation();
  const shown = useContext(ShownCtx);
  if (shown.size === 0) return null;
  const releases = [...shown.keys()].sort().join(", ");
  return (
    <p data-testid="icd11-citation" style={{ margin: "10px 0 0", fontSize: 10.5, lineHeight: 1.4, color: "var(--faint)" }}>
      {t("cds.icd11.citationLead", { release: releases })}{" "}
      <span lang="en">{ICD11_CITATION}</span>
    </p>
  );
}
