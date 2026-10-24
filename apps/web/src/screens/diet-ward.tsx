import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import { useAuth } from "../lib/auth";
import { istWallToIso } from "../lib/opd-api";
import {
  dietRefusal, fetchDietCatalogue, fetchDietWards, fetchWardSheet, istClock, liftNpoApi, orderDietApi, requestConsultApi, serveLineApi,
  startNpoApi,
} from "../lib/diet-api";
import type { DietCode, DietPreference, DietWardSheetRow, DietWardSheetView } from "@hmis/contracts";
import "./diet.css";

/**
 * ═══ E4.4 DIET (issue #736) — THE WARD DIET SHEET (390 px first, Hindi first) ═══
 *
 * Pick the ward once (remembered per user on this device, the same picker and labels as every IPD ward screen). One card per bed: the patient (the alias for a sealed patient), the
 * diet in force, NPO in red with its window, allergies in red, "no order" when the kitchen sends a normal tray by
 * default, and the next meal's tray. What a person may do follows their permissions: a doctor or dietician orders a
 * diet; a nurse sets or lifts NPO (and never sees "Order diet"); the ward taps a dispatched tray delivered or refused.
 */
const PREFS: readonly DietPreference[] = ["veg", "non_veg", "jain"];

function Two({ k, o }: { k: string; o?: Record<string, unknown> }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="dw-two">
      <span className="hi" lang="hi">{t(k, { ...o, lng: "hi" })}</span>
      <span className="en" lang="en">{t(k, { ...o, lng: "en" })}</span>
    </span>
  );
}

export function DietWard(): React.ReactElement {
  const { t } = useTranslation();
  const wardsQ = useQuery({ queryKey: ["diet", "wards"], queryFn: fetchDietWards });
  const pick = useWardChoice();
  const wards = wardsQ.data ?? [];
  // One ward: that one. Several: the one this person last picked, or ask — never the list's first ward.
  const ward = wards.length === 1 ? wards[0]!.id : pick.wardId !== null && wards.some((w) => w.id === pick.wardId) ? pick.wardId : "";
  const asking = wardsQ.data !== undefined && pick.needsPick(wards);
  const sheetQ = useQuery({ queryKey: ["diet", "sheet", ward], queryFn: () => fetchWardSheet(ward), enabled: ward !== "", refetchInterval: 30_000 });
  const sheet = sheetQ.data;
  return (
    <PaperScreen testId="diet-ward">
      <div className="dw-phone">
        <h1>{t("diet.ward.title")}</h1>
        {wards.length > 1 ? <WardPicker wards={wards} value={ward === "" ? null : ward} onChange={pick.choose} testId="dw-ward" /> : null}
        {asking ? <PickWardPrompt className="dk-empty" /> : null}
        {sheet !== undefined && (
          <p className="dw-next" data-testid="dw-next">
            {t("diet.ward.next", { meal: t(`diet.meal.${sheet.next.meal}`), state: t(`diet.listState.${sheet.next.state}`) })}
          </p>
        )}
        {sheetQ.isError && <p className="dw-notice">{t("diet.offline")}</p>}
        {sheet !== undefined && sheet.rows.length === 0 && <p className="dk-empty">{t("diet.ward.empty")}</p>}
        {(sheet?.rows ?? []).map((r) => <BedCard key={r.admissionId} r={r} sheet={sheet!} />)}
      </div>
    </PaperScreen>
  );
}

type Panel = "order" | "npo" | "consult" | null;

function BedCard({ r, sheet }: { r: DietWardSheetRow; sheet: DietWardSheetView }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const ok = (k: string): void => { setNotice({ ok: true, text: t(k) }); setPanel(null); void qc.invalidateQueries({ queryKey: ["diet"] }); };
  const fail = (e: unknown): void => setNotice({ ok: false, text: t(`diet.refusal.${dietRefusal(e) ?? "failed"}`, { defaultValue: t("diet.refusal.failed") }) });
  const lift = useMutation({ mutationFn: (npoId: string) => liftNpoApi(npoId, "Lifted at the ward"), onSuccess: () => ok("diet.ward.saved.lifted"), onError: fail });
  const serve = useMutation({ mutationFn: (o: "delivered" | "refused") => serveLineApi(r.nextLine!.id, o), onSuccess: () => ok("diet.ward.saved.served"), onError: fail });
  const line = r.nextLine;
  const canServe = can("diet.serve") && line !== null && line.state === "active" && line.served === null
    && (sheet.next.state === "dispatched" || sheet.next.state === "delivered");

  return (
    <section className={`box dw-card${r.npos.length > 0 ? " npo" : ""}`} data-testid={`dw-bed-${r.admissionId}`}>
      <div className="dw-top">
        <span className="dw-bed">{r.bedCode ?? "—"}</span>
        <span className="dw-name" data-testid="dw-name">{r.patient.name}</span>
        {r.patient.uhid !== "" && <span className="dw-uhid">{r.patient.uhid}</span>}
      </div>
      {/* Review item 15: every live NPO, now or ahead, each with its own Lift. */}
      {r.npos.map((n) => (
        <div key={n.id} className="dw-npo" data-testid="dw-npo">
          <b>{t("diet.ward.npo")}</b> · {n.endsAt === null
            ? t("diet.ward.npoSince", { at: istClock(n.startsAt) })
            : t("diet.ward.npoWindow", { from: istClock(n.startsAt), to: istClock(n.endsAt) })}
          <span className="dw-why"> · {n.reason}</span>
          {can("diet.npo") && (
            <button type="button" className="dw-btn ghost dw-lift" disabled={lift.isPending} onClick={() => lift.mutate(n.id)} data-testid="dw-lift-npo"><Two k="diet.ward.liftNpo" /></button>
          )}
        </div>
      ))}
      <div className="dw-diet" data-testid="dw-diet">
        {r.order === null
          ? <span className="dw-flag">{t("diet.ward.noOrder")}</span>
          : <>{t(`diet.code.${r.order.code}`)} · {t(`diet.pref.${r.order.preference}`)}
            {r.order.tubeVolumeMl !== null && ` · ${t("diet.ward.tube", { ml: r.order.tubeVolumeMl, h: r.order.tubeEveryHours ?? 0 })}`}</>}
        {r.consultOpen && <span className="dw-flag gd"> {t("diet.ward.consultOpen")}</span>}
      </div>
      {r.allergies.length > 0 && <div className="dw-alg" data-testid="dw-allergies">{r.allergies.join(", ")}</div>}
      {line !== null && (
        <div className="dw-tray" data-testid="dw-tray">
          {line.state === "withdrawn" ? t("diet.ward.trayOff", { why: t(`diet.withdrawn.${line.withdrawnReason ?? "npo"}`) })
            : line.served !== null ? t(`diet.ward.served.${line.served}`) : t("diet.ward.trayOn", { diet: t(`diet.code.${line.code}`) })}
        </div>
      )}
      {notice !== null && <p className={notice.ok ? "dw-notice ok" : "dw-notice"} data-testid="dw-notice">{notice.text}</p>}
      <div className="dw-acts">
        {canServe && (
          <>
            <button type="button" className="dw-btn" disabled={serve.isPending} onClick={() => serve.mutate("delivered")} data-testid="dw-delivered"><Two k="diet.ward.delivered" /></button>
            <button type="button" className="dw-btn ghost" disabled={serve.isPending} onClick={() => serve.mutate("refused")} data-testid="dw-refused"><Two k="diet.ward.refused" /></button>
          </>
        )}
        {can("diet.order") && <button type="button" className="dw-btn ghost" onClick={() => setPanel(panel === "order" ? null : "order")} data-testid="dw-order"><Two k="diet.ward.orderDiet" /></button>}
        {can("diet.npo") && <button type="button" className="dw-btn red" onClick={() => setPanel(panel === "npo" ? null : "npo")} data-testid="dw-set-npo"><Two k="diet.ward.setNpo" /></button>}
        {(can("diet.order") || can("diet.npo")) && !r.consultOpen && (
          <button type="button" className="dw-btn ghost" onClick={() => setPanel(panel === "consult" ? null : "consult")} data-testid="dw-ask"><Two k="diet.ward.askDietician" /></button>
        )}
      </div>
      {panel === "order" && <OrderPanel r={r} onOk={() => ok("diet.ward.saved.ordered")} onFail={fail} />}
      {panel === "npo" && <NpoPanel r={r} onOk={() => ok("diet.ward.saved.npo")} onFail={fail} />}
      {panel === "consult" && <ConsultPanel r={r} onOk={() => ok("diet.ward.saved.consult")} onFail={fail} />}
    </section>
  );
}

function OrderPanel({ r, onOk, onFail }: { r: DietWardSheetRow; onOk: () => void; onFail: (e: unknown) => void }): React.ReactElement {
  const { t } = useTranslation();
  const cat = useQuery({ queryKey: ["diet", "catalogue"], queryFn: fetchDietCatalogue });
  const [code, setCode] = useState<DietCode>(r.order?.code ?? "normal");
  const [pref, setPref] = useState<DietPreference>(r.order?.preference ?? "veg");
  const [ml, setMl] = useState(String(r.order?.tubeVolumeMl ?? 200));
  const [hours, setHours] = useState(String(r.order?.tubeEveryHours ?? 3));
  const tube = cat.data?.find((c) => c.code === code)?.tubeFeed === true;
  const save = useMutation({
    mutationFn: () => orderDietApi({ admissionId: r.admissionId, code, preference: pref, ...(tube ? { tubeVolumeMl: Number(ml), tubeEveryHours: Number(hours) } : {}) }),
    onSuccess: onOk, onError: onFail,
  });
  return (
    <div className="dw-panel" data-testid="dw-order-panel">
      <select aria-label={t("diet.ward.diet")} value={code} onChange={(e) => setCode(e.target.value as DietCode)} data-testid="dw-code">
        {(cat.data ?? []).map((c) => <option key={c.code} value={c.code}>{t(`diet.code.${c.code}`)}</option>)}
      </select>
      <div className="dw-prefs" role="group" aria-label={t("diet.ward.preference")}>
        {PREFS.map((p) => (
          <button key={p} type="button" className={pref === p ? "dw-pref on" : "dw-pref"} onClick={() => setPref(p)}>{t(`diet.pref.${p}`)}</button>
        ))}
      </div>
      {tube && (
        <div className="dw-pair">
          <label>{t("diet.ward.ml")}<input inputMode="numeric" value={ml} onChange={(e) => setMl(e.target.value)} data-testid="dw-ml" /></label>
          <label>{t("diet.ward.everyHours")}<input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} data-testid="dw-hours" /></label>
        </div>
      )}
      <button type="button" className="dw-btn big" disabled={save.isPending} onClick={() => save.mutate()} data-testid="dw-order-save"><Two k="diet.ward.save" /></button>
    </div>
  );
}

function NpoPanel({ r, onOk, onFail }: { r: DietWardSheetRow; onOk: () => void; onFail: (e: unknown) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const save = useMutation({
    mutationFn: () => startNpoApi({ admissionId: r.admissionId, reason: reason.trim(), ...(until === "" ? {} : { endsAt: istWallToIso(until) }) }),
    onSuccess: onOk, onError: onFail,
  });
  return (
    <div className="dw-panel" data-testid="dw-npo-panel">
      <input placeholder={t("diet.ward.npoReason")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dw-npo-reason" />
      <label className="dw-until">{t("diet.ward.npoUntil")}<input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      <button type="button" className="dw-btn big red" disabled={save.isPending || reason.trim() === ""} onClick={() => save.mutate()} data-testid="dw-npo-save"><Two k="diet.ward.setNpo" /></button>
    </div>
  );
}

function ConsultPanel({ r, onOk, onFail }: { r: DietWardSheetRow; onOk: () => void; onFail: (e: unknown) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const save = useMutation({ mutationFn: () => requestConsultApi(r.admissionId, reason.trim()), onSuccess: onOk, onError: onFail });
  return (
    <div className="dw-panel">
      <input placeholder={t("diet.ward.consultReason")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dw-consult-reason" />
      <button type="button" className="dw-btn big" disabled={save.isPending || reason.trim() === ""} onClick={() => save.mutate()}><Two k="diet.ward.askDietician" /></button>
    </div>
  );
}
