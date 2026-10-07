import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import { adminErrorCode, adminErrorMessage } from "../lib/admin-api";
import { PRINT_PROGRAM_DOWNLOAD, issuePrintComputerCode, listPrintComputers, revokePrintComputer, testPrintComputer } from "../lib/print-api";
import type { WirePrintComputer } from "../lib/print-api";
import { dayMonthIst, fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";

const when = (iso: string): string => `${dayMonthIst(todayIst(new Date(iso)))}, ${fmtIst(iso)}`;

/**
 * ═══ PRINT COMPUTERS (decision 0047, owner 2026-10-07) ═══
 *
 * Each counter PC with its own printer runs HMIS Print and is added here with a one-time code. The
 * server decides everything on this panel — which computers exist, whether one is asking for work,
 * what it reported as its printer — so what is tested is what the SCREEN decides: that the code is
 * shown once with what to do with it, that "Remove" takes two taps, and that a refusal is a sentence.
 */
export function PrintComputers({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ name: string; code: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "print-computers"], queryFn: listPrintComputers, enabled: open, refetchInterval: open ? 10_000 : false });
  const close = (): void => { setNotice(null); setError(null); setCode(null); setName(""); setAsking(null); onClose(); };
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ["admin", "print-computers"] });

  const makeCode = async (): Promise<void> => {
    const n = name.trim();
    if (n === "") return;
    setNotice(null); setError(null);
    try {
      const r = await issuePrintComputerCode(n);
      setCode({ name: n, code: r.code });
      setName("");
    } catch (e) { setError(`${t("printComputers.codeFailed")} ${adminErrorMessage(e)}`); }
  };
  const test = async (c: WirePrintComputer): Promise<void> => {
    setNotice(null); setError(null);
    try {
      await testPrintComputer(c.id);
      setNotice(t("printComputers.testSent", { name: c.name }));
    } catch (e) {
      setError(adminErrorCode(e) === "print_computer_offline" ? t("printComputers.testOffline", { name: c.name }) : adminErrorMessage(e));
    }
    await refresh();
  };
  const remove = async (c: WirePrintComputer): Promise<void> => {
    if (asking !== c.id) { setAsking(c.id); return; }
    setAsking(null); setNotice(null); setError(null);
    try {
      await revokePrintComputer(c.id);
      setNotice(t("printComputers.removed", { name: c.name }));
    } catch (e) { setError(adminErrorMessage(e)); }
    await refresh();
  };

  const computers = (q.data?.computers ?? []).filter((c) => !c.revoked);
  return (
    <DeskModal open={open} onClose={close} titleId="print-computers-title" testId="print-computers-panel" width={600} title={t("printComputers.title")}>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("printComputers.why")}</p>
          {q.isPending && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>}
          {q.isError && <p role="alert" data-testid="print-computers-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{adminErrorMessage(q.error)}</p>}
          {q.data !== undefined && computers.length === 0 && (
            <p data-testid="print-computers-none" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("printComputers.none")}</p>
          )}
          {computers.map((c) => (
            <div key={c.id} className="box" data-testid={`print-computer-${c.id}`} style={{ padding: "10px 12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{c.name}</span>
                {/* The state is a WORD first; the colour only repeats it. */}
                <span data-testid={`print-computer-state-${c.id}`} style={{ fontSize: 12, fontWeight: 600, color: c.alive ? "var(--green)" : "var(--gold)" }}>
                  {t(c.alive ? "printComputers.connected" : "printComputers.offline")}
                </span>
                <span style={{ fontSize: 12, color: "var(--dim)", overflowWrap: "anywhere" }}>
                  {c.printer === null ? t("printComputers.noPrinter") : t("printComputers.printer", { printer: c.printer })}
                </span>
                <span className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>
                  {c.lastSeenAt === null ? t("printComputers.never") : t("printComputers.lastSeen", { when: when(c.lastSeenAt) })}
                  {c.appVersion === null ? "" : ` · ${t("printComputers.version", { version: c.appVersion })}`}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <SubmitButton plain type="button" className="sec" data-testid={`print-computer-test-${c.id}`} disabled={!c.alive} onClick={() => test(c)}>
                  {t("printComputers.test")}
                </SubmitButton>
                <SubmitButton plain type="button" className="sec" data-testid={`print-computer-remove-${c.id}`} onClick={() => remove(c)}>
                  {t(asking === c.id ? "printComputers.removeAsk" : "printComputers.remove")}
                </SubmitButton>
              </div>
            </div>
          ))}

          {notice !== null && <p role="status" data-testid="print-computers-notice" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>{notice}</p>}
          {error !== null && <p role="alert" data-testid="print-computers-refusal" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}

          <div className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <b style={{ fontSize: 13.5 }}>{t("printComputers.add")}</b>
            {code === null ? (
              <form style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 220px", fontSize: 12 }}>
                  {t("printComputers.nameLabel")}
                  <input className="inp" data-testid="print-computer-name" value={name} maxLength={80} placeholder={t("printComputers.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
                </label>
                <SubmitButton plain type="button" className="pri" data-testid="print-computer-make-code" disabled={name.trim() === ""} onClick={makeCode}>{t("printComputers.makeCode")}</SubmitButton>
              </form>
            ) : (
              <div data-testid="print-computer-code" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12.5 }}>{t("printComputers.codeTitle", { name: code.name })}</span>
                <span className="mo" data-testid="print-computer-code-value" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "0.12em", userSelect: "all" }}>{code.code}</span>
                <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("printComputers.codeExpires")}</span>
                <ol style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4, listStyle: "decimal" }}>
                  <li>{t("printComputers.step1")}</li>
                  <li>{t("printComputers.step2")}</li>
                  <li>{t("printComputers.step3")}</li>
                  <li>{t("printComputers.step4")}</li>
                </ol>
              </div>
            )}
            <a href={PRINT_PROGRAM_DOWNLOAD} data-testid="print-computer-download" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>{t("printComputers.download")}</a>
          </div>
        </div>
      )}
    </DeskModal>
  );
}
