import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../i18n";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Tag } from "../ui";
import type { VitalsApi, WireAllergenHit, WireAllergy } from "./api";

/**
 * THE ALLERGY STEP, at the one desk every OPD patient passes (owner 2026-09-12) — the web bay's
 * step, same routes. Deliberately NO "no known allergies" button: an empty register prints a blank
 * strip on the prescription so that "nobody asked" is never rendered as "none".
 *
 * A suggestion that is picked carries the allergen's code so the prescription guard can match it;
 * the code is dropped the moment the words change. Free text still saves, and the line under the
 * box says when the guard knows no rule for it.
 */
type Severity = "mild" | "moderate" | "severe";

export function AllergyStep({ api, patientId }: { api: VitalsApi; patientId: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<WireAllergy[] | null>(null);
  const [open, setOpen] = useState(false);
  const [substance, setSubstance] = useState("");
  const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState<Severity>("mild");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pick, setPick] = useState<WireAllergenHit | null>(null);
  const [hits, setHits] = useState<WireAllergenHit[]>([]);
  const [known, setKnown] = useState(true);

  const load = useCallback(() => {
    api.allergies(patientId).then((r) => setItems(r.items)).catch(() => setItems((prev) => prev ?? []));
  }, [api, patientId]);
  useEffect(load, [load]);

  // 120 ms debounce, three-character floor; a slow answer to an old prefix loses.
  const asked = useRef("");
  useEffect(() => {
    const q = substance.trim();
    asked.current = q;
    if (!open || q.length < 3 || pick !== null) { setHits([]); setKnown(true); return; }
    let live = true;
    const timer = setTimeout(() => {
      api.completeAllergen(q)
        .then((r) => { if (live && asked.current === q) { setHits(r.items); setKnown(r.known); } })
        .catch(() => { if (live) { setHits([]); setKnown(true); } });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [substance, open, pick, api]);

  const reset = (): void => { setSubstance(""); setReaction(""); setSeverity("mild"); setFailed(false); setPick(null); setHits([]); setKnown(true); };

  const save = async (): Promise<void> => {
    const sub = substance.trim();
    if (sub === "" || busy) return;
    setBusy(true); setFailed(false);
    try {
      await api.addAllergy(patientId, {
        substance: sub,
        ...(reaction.trim() === "" ? {} : { reaction: reaction.trim() }),
        severity, source: "vitals",
        ...(pick !== null && pick.term.toLowerCase() === sub.toLowerCase() ? { saltId: pick.saltId, allergenClass: pick.allergenClass } : {}),
      });
      reset(); setOpen(false); load();
    } catch {
      setFailed(true); // stated, never swallowed: the form stays open with what was typed
    } finally {
      setBusy(false);
    }
  };

  const active = (items ?? []).filter((a) => a.status === "active");
  return (
    <View testID="allergy-step" style={{ gap: space.sm }}>
      <Tag>{t("vitalsBay.allergy.title")}</Tag>
      {active.length === 0 ? (
        <Text testID="allergy-none" style={s.faint}>{t("vitalsBay.allergy.none")}</Text>
      ) : (
        <View style={s.chips}>
          {active.map((a) => (
            <View key={a.id} testID={`allergy-chip-${a.id}`} style={s.chip}>
              <Text style={s.chipText}>{a.substance}{a.severity === null ? "" : ` · ${t(`vitalsBay.allergy.${a.severity}`)}`}</Text>
            </View>
          ))}
        </View>
      )}
      {open ? (
        <View style={{ gap: space.sm }}>
          <Text style={s.label}>{t("vitalsBay.allergy.substance")}</Text>
          <TextInput
            testID="allergy-substance" accessibilityLabel={t("vitalsBay.allergy.substance")} autoFocus autoCorrect={false} autoCapitalize="none"
            value={substance} onChangeText={(v) => { setSubstance(v); setPick(null); }} style={s.input}
          />
          {hits.map((h) => (
            <Pressable key={`${h.kind}-${h.term}`} testID={`allergy-hit-${h.term}`} accessibilityRole="button" style={s.hit}
              onPress={() => { setSubstance(h.term); setPick(h); setHits([]); setKnown(true); }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{h.term}</Text>
              {h.blocks.length > 0 && <Text style={s.faint}>{t("opdConsult.allergyBlocks", { list: h.blocks.slice(0, 4).join(", ") })}</Text>}
            </Pressable>
          ))}
          {!known && pick === null && substance.trim().length >= 3 && (
            <Text testID="allergy-unknown" style={{ fontSize: 13, color: "#8a5a10" }}>{t("opdConsult.allergyUnknown")}</Text>
          )}
          <Text style={s.label}>{t("vitalsBay.allergy.reaction")}</Text>
          <TextInput testID="allergy-reaction" accessibilityLabel={t("vitalsBay.allergy.reaction")} value={reaction} onChangeText={setReaction} style={s.input} />
          <Text style={s.label}>{t("vitalsBay.allergy.severity")}</Text>
          <View style={s.seg}>
            {(["mild", "moderate", "severe"] as const).map((v) => (
              <Pressable key={v} testID={`allergy-severity-${v}`} accessibilityRole="button" accessibilityState={{ selected: severity === v }}
                onPress={() => setSeverity(v)} style={[s.segItem, severity === v && s.segOn]}>
                <Text style={[s.segText, severity === v && { color: "#f2faf6" }]}>{t(`vitalsBay.allergy.${v}`)}</Text>
              </Pressable>
            ))}
          </View>
          {failed && <Text accessibilityRole="alert" testID="allergy-failed" style={{ fontSize: 13.5, fontWeight: "700", color: color.red }}>{t("vitalsBay.allergy.failed")}</Text>}
          <Button testID="allergy-save" label={t("vitalsBay.allergy.save")} busy={busy} disabled={substance.trim() === ""} onPress={() => { void save(); }} />
          <Button testID="allergy-cancel" kind="secondary" label={t("vitalsBay.allergy.cancel")} onPress={() => { reset(); setOpen(false); }} />
        </View>
      ) : (
        <Button testID="allergy-open" kind="secondary" label={t("vitalsBay.allergy.add")} onPress={() => setOpen(true)} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  faint: { fontSize: 13, lineHeight: 18, color: color.faint },
  label: { fontSize: 12.5, color: color.dim },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: color.redLine, backgroundColor: color.redSoft },
  chipText: { fontSize: 13.5, fontWeight: "700", color: color.red },
  input: { minHeight: TOUCH, paddingHorizontal: 12, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, fontSize: 16, color: color.ink },
  hit: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card },
  seg: { flexDirection: "row", gap: 6 },
  segItem: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  segOn: { backgroundColor: color.green, borderColor: color.green },
  segText: { fontSize: 14, fontWeight: "700", color: color.green },
});
