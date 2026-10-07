import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  HANDOVER_PAPERS, printDocumentHere, printSettingSnapshot, subscribePrintSetting, testPrintDocument, writePrintSetting,
} from "../lib/browser-print";
import type { PrintMode, PrintSetting } from "../lib/browser-print";
import { listComputersHere } from "../lib/print-api";
import type { WireHereComputer } from "../lib/print-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * "THIS COMPUTER PRINTS" — the one panel where a counter says how its paper comes out
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-10-07: *"Right now I have printer attached with each computer at front desk."* The
 * choice is this BROWSER's (a printer is attached to a machine), so it is kept in `localStorage`
 * and nothing here reads or writes the server. It opens from the shell's Menu, from Desk One's dock
 * and from the hand-over line, and is the same panel in all three.
 */
export function usePrintSetting(): PrintSetting {
  return useSyncExternalStore(subscribePrintSetting, printSettingSnapshot, printSettingSnapshot);
}

let open = false;
const openListeners = new Set<() => void>();
function setOpen(next: boolean): void { open = next; for (const l of openListeners) l(); }
export function openPrintingPanel(): void { setOpen(true); }

const MODES: readonly PrintMode[] = ["auto", "browser", "relay"];

/* Its own button styles: the panel mounts above every screen, outside Desk One's `.d1` and the shell's scopes. */
const BTN: React.CSSProperties = { font: "inherit", fontSize: 13, fontWeight: 600, minHeight: 36, padding: "0 14px", borderRadius: 9, border: "1px solid var(--line, #dfe7e1)", background: "var(--card, #fff)", color: "var(--ink, #132420)", cursor: "pointer" };
const BTN_PRI: React.CSSProperties = { ...BTN, background: "var(--green, #0e6b4e)", borderColor: "var(--green, #0e6b4e)", color: "#fff" };

export function PrintingPanelHost(): React.ReactElement | null {
  const isOpen = useSyncExternalStore((l) => { openListeners.add(l); return () => { openListeners.delete(l); }; }, () => open, () => open);
  const setting = usePrintSetting();
  const { t } = useTranslation();
  const [test, setTest] = useState<"idle" | "sending" | "printed" | "no_dialog" | "refused">("idle");
  const [help, setHelp] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  /*
    THE PRINT PROGRAM ON THIS COMPUTER (decision 0047). Read when the panel opens and every ten
    seconds while it is open, so "running / not running" is the program's own last word. `null` =
    not read yet; `"failed"` = the read was refused (an older server, or a seat without the grant),
    in which case the section says so and the rest of the panel works as before.
  */
  const [computers, setComputers] = useState<WireHereComputer[] | "failed" | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    const read = (): void => { void listComputersHere().then((r) => { if (live) setComputers(r.computers); }, () => { if (live) setComputers((c) => c ?? "failed"); }); };
    read();
    const id = window.setInterval(read, 10_000);
    return () => { live = false; window.clearInterval(id); };
  }, [isOpen]);

  if (!isOpen) return null;
  const linked = Array.isArray(computers) ? computers.find((c) => c.id === setting.computerId) ?? null : null;
  const set = (patch: Partial<PrintSetting>): void => writePrintSetting({ ...setting, ...patch });
  const browserish = setting.mode !== "relay";
  const both = setting.papers.opd_prescription === true && setting.papers.opd_token_slip === true;

  return (
    <div
      data-testid="printing-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t("printHere.panel.title")}
      style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(12,22,19,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 12px 12px", overflowY: "auto" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div style={{ background: "var(--card, #fff)", color: "var(--ink, #132420)", border: "1px solid var(--line, #dfe7e1)", borderRadius: 12, width: "min(560px, 100%)", padding: "18px 20px 16px", fontSize: 13.5, lineHeight: 1.45 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, flex: 1 }}>{t("printHere.panel.title")}</h2>
          <button type="button" style={BTN} data-testid="printing-close" onClick={() => setOpen(false)}>{t("printHere.panel.close")}</button>
        </div>
        <p style={{ margin: "6px 0 14px", color: "var(--dim, #5c6f66)" }}>{t("printHere.panel.sub")}</p>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, padding: 0, marginBottom: 6 }}>{t("printHere.panel.how")}</legend>
          {MODES.map((m) => (
            <label key={m} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", border: "1px solid var(--line, #dfe7e1)", borderRadius: 9, marginBottom: 6, cursor: "pointer", background: setting.mode === m ? "var(--green-soft, rgba(14,107,78,.09))" : "transparent" }}>
              <input type="radio" name="print-mode" data-testid={`print-mode-${m}`} checked={setting.mode === m} onChange={() => set({ mode: m })} style={{ marginTop: 3 }} />
              <span>
                <b style={{ display: "block" }}>{t(`printHere.mode.${m}.name`)}</b>
                <span style={{ color: "var(--dim, #5c6f66)", fontSize: 12.5 }}>{t(`printHere.mode.${m}.sub`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {/* A seat that may not read the list (or an older server) is shown nothing here: the rest of the panel is theirs. */}
        {computers === "failed" ? null : (
        <div data-testid="print-program" style={{ margin: "12px 0 0", padding: "10px 12px", border: "1px solid var(--line, #dfe7e1)", borderRadius: 9 }}>
          <b style={{ display: "block" }}>{t("printHere.program.title")}</b>
          <span style={{ display: "block", color: "var(--dim, #5c6f66)", fontSize: 12.5, margin: "2px 0 8px" }}>{t("printHere.program.sub")}</span>
          {computers === null ? <span style={{ fontSize: 12.5, color: "var(--dim, #5c6f66)" }}>{t("printHere.program.loading")}</span> : null}
          {Array.isArray(computers) && computers.length === 0 && setting.computerId === null ? (
            <span data-testid="print-program-none" style={{ fontSize: 12.5, color: "var(--dim, #5c6f66)" }}>{t("printHere.program.none")}</span>
          ) : null}
          {Array.isArray(computers) && (computers.length > 0 || setting.computerId !== null) ? (
            <>
              <select
                data-testid="print-program-select"
                aria-label={t("printHere.program.title")}
                value={linked === null ? "" : linked.id}
                onChange={(e) => set({ computerId: e.target.value === "" ? null : e.target.value })}
                style={{ font: "inherit", fontSize: 13, minHeight: 36, padding: "0 8px", borderRadius: 9, border: "1px solid var(--line, #dfe7e1)", background: "var(--card, #fff)", color: "var(--ink, #132420)", maxWidth: "100%" }}
              >
                <option value="">{t("printHere.program.notLinked")}</option>
                {computers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.name} · ${c.printer ?? t("printHere.program.noPrinter")} · ${t(c.alive ? "printHere.program.connected" : "printHere.program.offline")}`}
                  </option>
                ))}
              </select>
              {setting.computerId !== null ? (
                <p role="status" data-testid="print-program-state" style={{ margin: "6px 0 0", fontSize: 12.5, fontWeight: 600, color: linked !== null && linked.alive ? "var(--green, #0e6b4e)" : "var(--gold, #a8650a)" }}>
                  {linked === null ? t("printHere.program.linkedGone")
                    : linked.alive ? t("printHere.program.linkedOk", { name: linked.name, printer: linked.printer ?? t("printHere.program.noPrinter") })
                    : t("printHere.program.linkedOff", { name: linked.name })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        )}

        <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0", opacity: browserish ? 1 : 0.5 }} disabled={!browserish}>
          <legend style={{ fontWeight: 600, padding: 0, marginBottom: 4 }}>{t("printHere.panel.papers")}</legend>
          {HANDOVER_PAPERS.map((doc) => (
            <label key={doc} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 34, cursor: "pointer" }}>
              <input
                type="checkbox"
                data-testid={`print-paper-${doc}`}
                checked={setting.papers[doc] === true}
                onChange={(e) => set({ papers: { ...setting.papers, [doc]: e.target.checked } })}
              />
              <span>{t(`printHere.paper.${doc}`)}</span>
            </label>
          ))}
          {both ? <p data-testid="print-two-dialogs" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--gold, #a8650a)" }}>{t("printHere.panel.twoDialogs")}</p> : null}
        </fieldset>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 14 }}>
          <button
            type="button"
            style={BTN_PRI}
            data-testid="print-test"
            disabled={test === "sending"}
            onClick={() => {
              setTest("sending");
              void printDocumentHere(testPrintDocument(t("printHere.test.title"), [t("printHere.test.line1"), t("printHere.test.line2"), "जाँच पृष्ठ — यह कंप्यूटर इसी प्रिंटर पर छापता है।"]), 60_000).then(setTest);
            }}
          >
            {t("printHere.panel.test")}
          </button>
          <button type="button" style={BTN} data-testid="print-help-toggle" aria-expanded={help} onClick={() => setHelp((h) => !h)}>{t("printHere.panel.autoHow")}</button>
          {test === "idle" || test === "sending" ? null : (
            <span role="status" data-testid="print-test-result" style={{ fontSize: 12.5, color: test === "printed" ? "var(--green, #0e6b4e)" : "var(--red, #b23a30)" }}>{t(`printHere.test.${test}`)}</span>
          )}
        </div>

        {help ? (
          <div data-testid="print-help" style={{ marginTop: 12, padding: "12px 14px", background: "var(--wash, #eef3ef)", borderRadius: 9, fontSize: 12.5 }}>
            <b>{t("printHere.help.title")}</b>
            <ol style={{ margin: "6px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 5, listStyle: "decimal" }}>
              <li>{t("printHere.help.s1")}</li>
              <li>{t("printHere.help.s2")}</li>
              <li>
                {t("printHere.help.s3")}
                <code style={{ display: "block", margin: "4px 0", padding: "6px 8px", background: "var(--card, #fff)", border: "1px solid var(--line, #dfe7e1)", borderRadius: 6, overflowWrap: "anywhere", userSelect: "all" }}>
                  {'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing https://hmis.crkmch.com/counter'}
                </code>
                {t("printHere.help.edge")}
                <code style={{ display: "block", margin: "4px 0", padding: "6px 8px", background: "var(--card, #fff)", border: "1px solid var(--line, #dfe7e1)", borderRadius: 6, overflowWrap: "anywhere", userSelect: "all" }}>
                  {'"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --kiosk-printing https://hmis.crkmch.com/counter'}
                </code>
              </li>
              <li>{t("printHere.help.s4")}</li>
              <li>{t("printHere.help.s5")}</li>
            </ol>
            <p style={{ margin: "8px 0 0", color: "var(--dim, #5c6f66)" }}>{t("printHere.help.undo")}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
