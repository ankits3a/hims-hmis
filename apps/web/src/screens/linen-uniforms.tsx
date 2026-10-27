import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import { fetchUniforms, linenRefusal, rupees, uniformApi } from "../lib/linen-api";
import { LinenTabs } from "./linen-store";
import "./linen.css";

/**
 * ═══ LD-2 (#979, decisions 0087 and 0092) — UNIFORMS (the laundry counter, 16:9) ═══
 *
 * The counter types the staff member's sign-in name: Exchange takes one dirty set for each clean one (never otherwise),
 * Issue gives up to three sets, Return takes sets back. Right: the no-dues list — leavers still holding sets, with the
 * deduction decision 0092 allows (replacement cost less 1/12 per month of use), for HR to approve.
 */
type Verb = "exchange" | "issue" | "return";

export function LinenUniforms(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ["linen", "uniforms"], queryFn: fetchUniforms, refetchInterval: 60_000 });
  const [verb, setVerb] = useState<Verb>("exchange");
  const [username, setUsername] = useState("");
  const [sets, setSets] = useState(1);
  const [size, setSize] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () => uniformApi(verb, {
      username: username.trim(),
      ...(verb === "exchange" ? { dirty: sets, clean: sets } : { sets }),
      ...(verb === "issue" && size.trim() !== "" ? { size: size.trim() } : {}),
    }),
    onSuccess: (r) => { setNotice({ ok: true, text: t("linen.uniforms.saved", { count: r.holding }) }); void qc.invalidateQueries({ queryKey: ["linen", "uniforms"] }); },
    onError: (e) => setNotice({ ok: false, text: t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") }) }),
  });
  const v = view.data;
  const mayAct = can("linen.uniform");

  return (
    <PaperScreen testId="linen-uniforms" style={{ height: "var(--pp-h)" }}>
      <div className="lp-desk">
        <LinenTabs on="uniforms" />
        <div className="lp-grid store vendor">
          <section className="lp-centre">
            <div className="lp-title">
              <div><h1>{t("linen.uniforms.title")}</h1><p>{t("linen.uniforms.sub")}</p></div>
              {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="uniform-notice">{notice.text}</p>}
            </div>
            {mayAct && (
              <section className="box" data-testid="uniform-counter">
                <div className="lp-form" style={{ padding: "10px 12px" }}>
                  <span className="lp-acts" role="group" aria-label={t("linen.uniforms.title")}>
                    {(["exchange", "issue", "return"] as const).map((k) => (
                      <button key={k} type="button" className={verb === k ? "ln-mini ok" : "ln-mini"} aria-pressed={verb === k} onClick={() => setVerb(k)} data-testid={`verb-${k}`}>{t(`linen.uniforms.verb.${k}`)}</button>
                    ))}
                  </span>
                  <label>{t("linen.uniforms.who")}<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="uniform-who" /></label>
                  <label>{verb === "exchange" ? t("linen.uniforms.dirtyForClean") : t("linen.uniforms.sets")}
                    <select value={sets} onChange={(e) => setSets(Number(e.target.value))} data-testid="uniform-sets">{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                  </label>
                  {verb === "issue" && <label>{t("linen.uniforms.size")}<input value={size} onChange={(e) => setSize(e.target.value)} data-testid="uniform-size" /></label>}
                  <button type="button" className="ln-mini ok" disabled={username.trim().length < 2 || save.isPending} onClick={() => { setNotice(null); save.mutate(); }} data-testid="uniform-save">
                    {t(`linen.uniforms.go.${verb}`, { count: sets })}
                  </button>
                </div>
              </section>
            )}
            <div className="box lp-table-box">
              <table className="lp-table" data-testid="uniform-holdings">
                <thead><tr><th>{t("linen.uniforms.col.staff")}</th><th>{t("linen.uniforms.col.code")}</th><th>{t("linen.uniforms.col.sets")}</th><th>{t("linen.uniforms.col.size")}</th></tr></thead>
                <tbody>
                  {(v?.holdings ?? []).map((h) => (
                    <tr key={h.userId}><td>{h.name}</td><td className="mono">{h.staffCode}</td><td className="mono">{h.sets}</td><td>{h.size ?? "—"}</td></tr>
                  ))}
                  {v !== undefined && v.holdings.length === 0 && <tr><td colSpan={4} className="ln-empty">{t("linen.uniforms.none")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <aside className="lp-side">
            <section className="box" data-testid="uniform-dues">
              <header className="lp-h"><b>{t("linen.uniforms.dues")}</b><span className="mono">{v?.dues.length ?? 0}</span></header>
              {(v?.dues ?? []).map((d) => (
                <div key={d.userId} className="lp-crow col" data-testid={`due-${d.userId}`}>
                  <div>
                    <b>{d.name} <span className="ln-tag inf">{t("linen.uniforms.blocks")}</span></b>
                    <small>{t("linen.uniforms.dueLine", { sets: d.sets, months: d.monthsUsed })}</small>
                    <small>{t("linen.uniforms.deduct", { amount: rupees(d.deductionPaise), of: rupees(d.replacementPaise) })}</small>
                  </div>
                </div>
              ))}
              {v !== undefined && v.dues.length === 0 && <div className="ln-empty">{t("linen.uniforms.noDues")}</div>}
            </section>
            <section className="box">
              <header className="lp-h"><b>{t("linen.uniforms.roles")}</b></header>
              <div className="lp-crow"><small>{(v?.roles ?? []).join(", ")}</small></div>
            </section>
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}
