import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO, Note } from "../ui";
import { refusalText } from "../vitals/api";
import { REVIEW_CHOICES, applySet, emptyDraft, lineText, setBodyOf } from "./rules";
import { Chip, Drawer, MedicinesDrawer, TestsDrawer, type Patch } from "./sheets";
import type { ConsultApi, WireRxSet } from "./api";
import type { ConsultDraft } from "./rules";

/**
 * #610 — EDIT A SAVED SET (spec approved by the owner 2026-10-10).
 *
 * The set opens in the consult's OWN editors — the medicine drawer and the tests drawer — run over a
 * draft that belongs to this sheet alone: it is never the visit's draft, never kept in the phone's
 * draft store and never sent as the visit's note. "Save set" writes over the set (`PUT /opd/rx-sets/:id`);
 * "Cancel" leaves it as it was. A visit already prescribed from the set keeps its own lines.
 *
 * A starter set is the unit head's; an edit clears its signature on the server (what the head signed
 * is what doctors see). The head is the one editing it here, so the button says "Save and sign" and
 * signs the edited set in the same tap. DECIDED — otherwise a head's edit on the phone would hide the
 * set from every doctor until someone signed it on the computer.
 */
const SUGGEST_OFF = { on: false, hidden: [] } as const;

export function SetEditor({ api, set, encounterId, onDone }: {
  api: ConsultApi; set: WireRxSet; encounterId: string; onDone: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ConsultDraft>(() => applySet(emptyDraft(encounterId, Date.now()), set.name, set.body, () => 0, Date.now(), "adult"));
  const [name, setName] = useState(set.name);
  const [sub, setSub] = useState<null | "meds" | "tests">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch: Patch = useCallback((next) => { setDraft((d) => ({ ...next(d), updatedAt: Date.now() })); setError(null); }, []);
  const days = useCallback((n: number): string => t("mobile.consult.days", { count: n }), [t]);
  const food = useMemo(() => ({ before: t("mobile.consult.foodBefore"), after: t("mobile.consult.foodAfter") }), [t]);
  const starter = set.scope === "department";

  const body = setBodyOf(draft, food);
  const empty = body.lines.length === 0 && body.tests.length === 0 && (body.advice ?? "").trim() === "";
  const ready = name.trim() !== "" && !empty && !busy;

  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await api.updateSet(set.id, name.trim(), body);
      if (starter) await api.signSet(set.id);
      onDone();
    } catch (e) {
      setError(e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sub === "meds") return <MedicinesDrawer api={api} draft={draft} patch={patch} warnings={[]} checking={false} onClose={() => setSub(null)} startWith={null} />;
  if (sub === "tests") return <TestsDrawer api={api} draft={draft} patch={patch} onClose={() => setSub(null)} suggest={SUGGEST_OFF} />;

  const foot = (
    <View style={st.two}>
      <View style={{ flex: 1 }}><Button testID="set-edit-cancel" kind="secondary" label={t("mobile.consult.sets.cancel")} onPress={onDone} /></View>
      <View style={{ flex: 1.4 }}>
        <Button testID="set-edit-save" label={t(starter ? "mobile.consult.sets.saveSign" : "mobile.consult.sets.saveOver")} busy={busy} disabled={!ready} onPress={() => { void save(); }} />
      </View>
    </View>
  );
  return (
    <Drawer testID="set-edit" title={t("mobile.consult.sets.editTitle")} onClose={onDone} closeLabel={t("mobile.consult.sets.cancel")} foot={foot}>
      <Text style={st.lab}>{t("mobile.consult.sets.name")}</Text>
      <TextInput testID="set-edit-name" accessibilityLabel={t("mobile.consult.sets.name")} value={name} maxLength={60}
        onChangeText={(v) => { setName(v); setError(null); }} style={st.box} placeholderTextColor={color.faint} />

      <Pressable testID="set-edit-meds" accessibilityRole="button" onPress={() => setSub("meds")} style={[st.row, { borderTopWidth: 1 }]}>
        <Text style={st.rowKey}>{t("mobile.consult.five.meds")}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          {draft.lines.length === 0
            ? <Text style={st.none}>{t("mobile.consult.sets.none")}</Text>
            : draft.lines.map((l, i) => <Text key={`${String(i)}-${l.drug}`} style={st.rowText}>{lineText(l, days)}</Text>)}
        </View>
        <Text style={st.chev}>›</Text>
      </Pressable>
      <Pressable testID="set-edit-tests" accessibilityRole="button" onPress={() => setSub("tests")} style={st.row}>
        <Text style={st.rowKey}>{t("mobile.consult.five.tests")}</Text>
        <Text style={[st.rowText, { flex: 1 }, draft.tests.length === 0 && st.none]}>
          {draft.tests.length === 0 ? t("mobile.consult.sets.none") : draft.tests.map((x) => x.name).join(" · ")}
        </Text>
        <Text style={st.chev}>›</Text>
      </Pressable>

      <Text style={st.lab}>{t("mobile.consult.five.advice")}</Text>
      <TextInput testID="set-edit-advice" accessibilityLabel={t("mobile.consult.five.advice")} multiline value={draft.adviceText} maxLength={2000}
        onChangeText={(v) => patch((d) => ({ ...d, adviceText: v, adviceChips: [] }))} style={[st.box, { minHeight: 88, textAlignVertical: "top" }]} />
      <Text style={st.lab}>{t("mobile.consult.reviewAfter")}</Text>
      <View style={st.chips}>
        {REVIEW_CHOICES.map((n) => <Chip key={n} testID={`set-review-${String(n)}`} label={days(n)} on={draft.reviewDays === n} onPress={() => patch((d) => ({ ...d, reviewDays: d.reviewDays === n ? null : n }))} />)}
        <Chip testID="set-review-none" dashed label={t("mobile.consult.reviewNone")} on={draft.reviewDays === null} onPress={() => patch((d) => ({ ...d, reviewDays: null }))} />
      </View>
      {error !== null && <Note tone="bad" testID="set-edit-error">{error}</Note>}
    </Drawer>
  );
}

const st = StyleSheet.create({
  lab: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.faint, textTransform: "uppercase", marginTop: 2 },
  box: { minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.paper, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: color.ink },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: TOUCH, paddingVertical: 10, borderBottomWidth: 1, borderColor: color.line2 },
  rowKey: { width: 82, fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.faint, textTransform: "uppercase", paddingTop: 3 },
  rowText: { fontSize: 15, lineHeight: 21, color: color.ink },
  none: { fontSize: 14, color: color.faint },
  chev: { fontSize: 20, color: color.faint, paddingTop: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  two: { flexDirection: "row", gap: space.sm },
});
