import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  fetchLinenFloor, fetchLinenHandler, linenRefusal, openRoundApi, placeHoldApi, sealBagApi, signDeliveryApi, signPickupApi,
} from "../lib/linen-api";
import type { LinenLine, LinenRoundSign } from "../lib/linen-api";
import type { LinenHoldKind, LinenItem } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ LD-1 (#978, decision 0087) — THE WARD HAND-OVER ON THE RUNNER'S PHONE (390 px, Hindi first) ═══
 *
 * Pick the ward → "Soiled out" (a pickup) or "Clean in" (a delivery) → counts with big − / + steppers; sealed bags by
 * tag only, never by piece; a held bag cannot be ticked. The ward nurse signs on this phone with the name she signs in
 * with and her PIN — or the runner records "runner only" with a reason. "Bag / hold" seals a bag at a bed and places a
 * hold. Notices are a few words on one line (owner rule).
 */
const WARD_KEY = "hmis.linen.ward";
const readWard = (): string => { try { return localStorage.getItem(WARD_KEY) ?? ""; } catch { return ""; } };
const keepWard = (id: string): void => { try { localStorage.setItem(WARD_KEY, id); } catch { /* private window: forget it */ } };
const TABS = ["pickup", "delivery", "bag"] as const;
type Tab = (typeof TABS)[number];
const HOLD_KINDS: readonly LinenHoldKind[] = ["mlc", "chemo", "radioactive"];

function Two({ k, o }: { k: string; o?: Record<string, unknown> }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="ln-two">
      <span className="hi" lang="hi">{t(k, { ...o, lng: "hi" })}</span>
      <span className="en" lang="en">{t(k, { ...o, lng: "en" })}</span>
    </span>
  );
}

export function LinenRounds(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const floor = useQuery({ queryKey: ["linen", "floor"], queryFn: fetchLinenFloor });
  const handler = useQuery({ queryKey: ["linen", "handler"], queryFn: fetchLinenHandler });
  const [wardId, setWardId] = useState<string>(readWard);
  const [tab, setTab] = useState<Tab>("pickup");
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [bags, setBags] = useState<string[]>([]);
  const [runnerOnly, setRunnerOnly] = useState(false);
  const [reason, setReason] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [tag, setTag] = useState("");
  const [bedId, setBedId] = useState("");
  const [infected, setInfected] = useState(true);
  const [holdKind, setHoldKind] = useState<LinenHoldKind>("mlc");
  const [doseAt, setDoseAt] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const view = handler.data;
  const items: readonly LinenItem[] = view?.items ?? [];
  const ward = view?.wards.find((w) => w.wardId === wardId);
  const setItems = items.filter((i) => i.unitsPerSet > 0 || (ward?.items.find((x) => x.itemCode === i.code)?.par ?? 0) > 0);
  const start: Record<string, number> = {};
  for (const i of setItems) start[i.code] = tab === "delivery" ? ward?.items.find((x) => x.itemCode === i.code)?.short ?? 0 : 0;
  const qty = (code: string): number => edits[code] ?? start[code] ?? 0;
  const setQty = (code: string, n: number): void => setEdits((e) => ({ ...e, [code]: Math.max(0, n) }));
  const lines: LinenLine[] = setItems.map((i) => ({ itemCode: i.code, qty: qty(i.code) })).filter((l) => l.qty > 0);
  const total = lines.reduce((n, l) => n + l.qty, 0);
  const holdOn = new Map((floor.data?.holds ?? []).map((h) => [h.bedId, h.kind]));
  const wardBags = (floor.data?.sealedBags ?? []).filter((b) => b.wardId === wardId);
  const wardBeds = (floor.data?.beds ?? []).filter((b) => b.wardId === wardId);
  const mlc = new Set(floor.data?.mlcBeds ?? []);
  const name = (code: string, lng: string): string => t(`linen.item.${code}`, { defaultValue: items.find((i) => i.code === code)?.name ?? code, lng });

  const signed = runnerOnly ? reason.trim().length >= 3 : username.trim().length >= 2 && pin.length >= 4;
  const sign = (): LinenRoundSign => (runnerOnly ? { runnerOnlyReason: reason.trim() } : { wardSign: { username: username.trim(), pin } });
  const reset = (): void => { setEdits({}); setBags([]); setPin(""); setReason(""); setTag(""); };
  const pick = (x: Tab): void => { setTab(x); reset(); setNotice(null); };

  const save = useMutation({
    mutationFn: async (what: "round" | "bag" | "hold"): Promise<string> => {
      if (what === "bag") {
        await sealBagApi({ wardId, ...(bedId === "" ? {} : { bedId }), tag: tag.trim(), infected, lines });
        return "linen.rounds.saved.bag";
      }
      if (what === "hold") {
        await placeHoldApi({ kind: holdKind, bedId, ...(holdKind === "chemo" ? { doseAt: new Date(doseAt).toISOString() } : {}) });
        return "linen.rounds.saved.hold";
      }
      const r = await openRoundApi(wardId, tab === "delivery" ? "delivery" : "pickup");
      const done = tab === "delivery" ? await signDeliveryApi(r.id, lines, sign()) : await signPickupApi(r.id, lines, bags, sign());
      return done.state === "skipped" ? "linen.rounds.saved.skipped" : `linen.rounds.saved.${tab}`;
    },
    onSuccess: (k) => { setNotice({ ok: true, text: t(k) }); reset(); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => setNotice({ ok: false, text: t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") }) }),
  });

  const roundReady = wardId !== "" && signed && (tab === "delivery" || total > 0 || bags.length > 0);

  return (
    <PaperScreen testId="linen-rounds">
      <div className="ln-phone">
        <h1><Two k="linen.rounds.title" /></h1>
        {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="rounds-notice">{notice.text}</p>}
        <select value={wardId} onChange={(e) => { setWardId(e.target.value); keepWard(e.target.value); reset(); }} aria-label={t("linen.handle.ward")} data-testid="rounds-ward">
          <option value="">{t("linen.handle.pickWard")}</option>
          {(view?.wards ?? []).map((w) => <option key={w.wardId} value={w.wardId}>{w.floorName === null ? w.wardName : `${w.wardName} · ${w.floorName}`}</option>)}
        </select>
        <div className="lr-seg" role="tablist">
          {TABS.map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => pick(x)} data-testid={`rounds-tab-${x}`}>
              <Two k={`linen.rounds.tab.${x}`} />
            </button>
          ))}
        </div>

        {wardId !== "" && tab !== "bag" && (
          <section className="box ln-card" data-testid="rounds-sheet">
            <h2><Two k={tab === "pickup" ? "linen.rounds.ordinary" : "linen.rounds.clean"} /></h2>
            {setItems.map((i) => (
              <div key={i.code} className="ln-step" data-testid={`rstep-${i.code}`}>
                <span className="nm"><span className="hi" lang="hi">{name(i.code, "hi")}</span><span className="en">{name(i.code, "en")}</span></span>
                <button type="button" className="ln-pm" aria-label={t("linen.handle.less")} onClick={() => setQty(i.code, qty(i.code) - 1)}>−</button>
                <input className="ln-qty" inputMode="numeric" value={String(qty(i.code))} aria-label={name(i.code, "en")} onChange={(e) => setQty(i.code, Number(e.target.value.replace(/\D/g, "")) || 0)} data-testid={`rqty-${i.code}`} />
                <button type="button" className="ln-pm" aria-label={t("linen.handle.more")} onClick={() => setQty(i.code, qty(i.code) + 1)} data-testid={`rplus-${i.code}`}>+</button>
              </div>
            ))}
            {tab === "pickup" && (
              <div className="lr-bags" data-testid="rounds-bags">
                <h2><Two k="linen.rounds.bags" /></h2>
                {wardBags.length === 0 && <div className="ln-empty">{t("linen.rounds.noBags")}</div>}
                {wardBags.map((b) => {
                  const kind = b.bedId === null ? undefined : holdOn.get(b.bedId);
                  const held = b.held || kind !== undefined;
                  return (
                    <label key={b.tag} className={`ln-check${held ? " held" : ""}`} data-testid={`bag-${b.tag}`}>
                      <input type="checkbox" disabled={held} checked={bags.includes(b.tag)} onChange={(e) => setBags((x) => (e.target.checked ? [...x, b.tag] : x.filter((y) => y !== b.tag)))} />
                      <span className="mono">{b.tag}</span>
                      {b.infected && <span className="ln-tag inf">{t("linen.board.infectedBatch")}</span>}
                      {b.bedName !== null && <span className="ln-dim">{b.bedName}</span>}
                      {held && <span className="ln-err">{t("linen.rounds.held", { kind: kind === undefined ? "" : t(`linen.hold.${kind}`) })}</span>}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="lr-sign" data-testid="rounds-sign">
              <label className="ln-check plain"><input type="checkbox" checked={runnerOnly} onChange={(e) => setRunnerOnly(e.target.checked)} data-testid="rounds-runner-only" /> <Two k="linen.rounds.runnerOnly" /></label>
              {runnerOnly ? (
                <input className="ln-qty lr-in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("linen.rounds.reason")} aria-label={t("linen.rounds.reason")} data-testid="rounds-reason" />
              ) : (
                <>
                  <input className="ln-qty lr-in" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={t("linen.sign.name")} aria-label={t("linen.sign.name")} data-testid="rounds-signer" />
                  <input className="ln-qty lr-in" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder={t("linen.sign.pin")} aria-label={t("linen.sign.pin")} data-testid="rounds-pin" />
                </>
              )}
            </div>
            <button type="button" className="ln-btn big ln-save lr-save" disabled={!roundReady || save.isPending} onClick={() => save.mutate("round")} data-testid="rounds-save">
              <Two k="linen.rounds.sign" o={{ count: total }} />
            </button>
          </section>
        )}

        {wardId !== "" && tab === "bag" && (
          <>
            <section className="box ln-card" data-testid="rounds-seal">
              <h2><Two k="linen.rounds.sealBag" /></h2>
              <input className="ln-qty lr-in" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t("linen.rounds.tag")} aria-label={t("linen.rounds.tag")} data-testid="seal-tag" />
              <BedPick beds={wardBeds} mlc={mlc} value={bedId} onChange={setBedId} t={t} />
              <label className="ln-check"><input type="checkbox" checked={infected} onChange={(e) => setInfected(e.target.checked)} data-testid="seal-infected" /> <Two k="linen.handle.infectedBatch" /></label>
              {setItems.map((i) => (
                <div key={i.code} className="ln-step">
                  <span className="nm"><span className="hi" lang="hi">{name(i.code, "hi")}</span><span className="en">{name(i.code, "en")}</span></span>
                  <button type="button" className="ln-pm" aria-label={t("linen.handle.less")} onClick={() => setQty(i.code, qty(i.code) - 1)}>−</button>
                  <input className="ln-qty" inputMode="numeric" value={String(qty(i.code))} aria-label={name(i.code, "en")} onChange={(e) => setQty(i.code, Number(e.target.value.replace(/\D/g, "")) || 0)} />
                  <button type="button" className="ln-pm" aria-label={t("linen.handle.more")} onClick={() => setQty(i.code, qty(i.code) + 1)} data-testid={`splus-${i.code}`}>+</button>
                </div>
              ))}
              <button type="button" className="ln-btn big" disabled={tag.trim().length < 2 || total === 0 || save.isPending} onClick={() => save.mutate("bag")} data-testid="seal-save">
                <Two k="linen.rounds.seal" />
              </button>
            </section>
            <section className="box ln-card" data-testid="rounds-hold">
              <h2><Two k="linen.rounds.placeHold" /></h2>
              <select value={holdKind} onChange={(e) => setHoldKind(e.target.value as LinenHoldKind)} aria-label={t("linen.rounds.holdKind")} data-testid="hold-kind">
                {HOLD_KINDS.map((k) => <option key={k} value={k}>{t(`linen.hold.${k}`)}</option>)}
              </select>
              <BedPick beds={wardBeds} mlc={mlc} value={bedId} onChange={setBedId} t={t} />
              {holdKind === "chemo" && (
                <input className="ln-qty lr-in" type="datetime-local" value={doseAt} onChange={(e) => setDoseAt(e.target.value)} aria-label={t("linen.rounds.doseAt")} data-testid="hold-dose" />
              )}
              <button type="button" className="ln-btn big" disabled={bedId === "" || (holdKind === "chemo" && doseAt === "") || save.isPending} onClick={() => save.mutate("hold")} data-testid="hold-save">
                <Two k="linen.rounds.hold" />
              </button>
            </section>
          </>
        )}
      </div>
    </PaperScreen>
  );
}

function BedPick({ beds, mlc, value, onChange, t }: {
  beds: { bedId: string; bedName: string }[]; mlc: ReadonlySet<string>; value: string; onChange: (v: string) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}): React.ReactElement {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("linen.rounds.bed")} data-testid="pick-bed">
      <option value="">{t("linen.rounds.pickBed")}</option>
      {beds.map((b) => <option key={b.bedId} value={b.bedId}>{mlc.has(b.bedId) ? `${b.bedName} · ${t("linen.rounds.mlcSuggest")}` : b.bedName}</option>)}
    </select>
  );
}
