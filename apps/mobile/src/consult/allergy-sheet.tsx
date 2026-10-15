import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO } from "../ui";
import { refusalText } from "../vitals/api";
import type { WireAllergenHit } from "../vitals/api";
import type { Call, WireAllergyRow } from "../doctor/api";
import { Drawer } from "./sheets";

/**
 * #608 — "+ ALLERGY" IN THE PHONE CONSULT (spec approved by the owner 2026-10-10).
 *
 * The routes are the ones the web consult and the vitals bay already use, under their own grants:
 * `GET /opd/cds/complete/allergen` and `POST /patients/:id/allergies` (both `patients.update`).
 * Nothing new on the server, and the phone widens no permission.
 *
 * A PICKED suggestion carries its code (`allergenClass` / `saltId`) so the prescription check fires by
 * identity, not spelling; the code is dropped the moment the words change. A substance not in the list
 * still saves, as typed (allergy is safety data — never block recording it), and the sheet says in a
 * few words that no check rule knows it. Severity is required; reaction is optional.
 *
 * The search starts at three letters: that is the server's own floor (`ALLERGEN_MIN_CHARS`), below
 * which it answers nothing. DECIDED — the spec's "2 letters" would only add an empty request.
 */
export type Severity = "mild" | "moderate" | "severe";
export const ALLERGY_MIN_CHARS = 3;

export function allergyApi(call: Call) {
  return {
    complete: (q: string) => call<{ items: WireAllergenHit[]; known: boolean }>("GET", `/opd/cds/complete/allergen?q=${encodeURIComponent(q)}`),
    add: (patientId: string, body: {
      substance: string; severity: Severity; reaction?: string; source: "consult"; saltId?: string | null; allergenClass?: string | null;
    }) => call<{ allergyId: string }>("POST", `/patients/${encodeURIComponent(patientId)}/allergies`, body),
  };
}

export function AllergySheet({ call, patientId, onClose, onSaved }: {
  call: Call; patientId: string; onClose: () => void; onSaved: (row: WireAllergyRow) => void;
}) {
  const { t } = useI18n();
  const api = useRef(allergyApi(call)).current;
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<WireAllergenHit | null>(null);
  const [hits, setHits] = useState<WireAllergenHit[]>([]);
  const [known, setKnown] = useState(true);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [reaction, setReaction] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // A slow answer to an old prefix loses; a picked suggestion asks nothing more.
  const asked = useRef("");
  useEffect(() => {
    const text = q.trim();
    asked.current = text;
    if (text.length < ALLERGY_MIN_CHARS || pick !== null) { setHits([]); setKnown(true); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      api.complete(text)
        .then((r) => { if (live && asked.current === text) { setHits(r.items); setKnown(r.known); } })
        .catch(() => { if (live) { setHits([]); setKnown(true); } });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [q, pick, api]);

  const substance = q.trim();
  const ready = substance !== "" && severity !== null && !busy;

  const save = async (): Promise<void> => {
    if (!ready || severity === null) return;
    setBusy(true); setFailed(null);
    const coded = pick !== null && pick.term.toLowerCase() === substance.toLowerCase();
    const why = reaction.trim();
    try {
      const r = await api.add(patientId, {
        substance, severity,
        ...(why === "" ? {} : { reaction: why }),
        source: "consult",
        ...(coded ? { saltId: pick.saltId, allergenClass: pick.allergenClass } : {}),
      });
      onSaved({ id: r.allergyId, substance, severity, reaction: why === "" ? null : why, status: "active" });
    } catch (e) {
      // Stated, never swallowed: the sheet stays open with what was typed.
      setFailed(e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : t("vitalsBay.allergy.failed"));
    } finally {
      setBusy(false);
    }
  };

  const foot = (
    <>
      {failed !== null && (
        <Text accessibilityRole="alert" testID="allergy-add-failed" numberOfLines={2} style={st.failed}>{t("mobile.consult.allergyAdd.failed", { why: failed })}</Text>
      )}
      <Button testID="allergy-add-save" label={t("vitalsBay.allergy.save")} busy={busy} disabled={!ready} onPress={() => { void save(); }} />
    </>
  );

  return (
    <Drawer testID="allergy-add-sheet" title={t("mobile.consult.allergyAdd.title")} onClose={onClose} foot={foot}>
      <Text style={st.lab}>{t("vitalsBay.allergy.substance")}</Text>
      <TextInput testID="allergy-add-q" accessibilityLabel={t("vitalsBay.allergy.substance")} autoFocus autoCorrect={false} autoCapitalize="none"
        placeholder={t("mobile.consult.allergyAdd.placeholder")} placeholderTextColor={color.faint}
        value={q} onChangeText={(v) => { setQ(v); setPick(null); setFailed(null); }} style={st.box} />
      {hits.length > 0 && (
        <View>
          {hits.map((h) => (
            <Pressable key={`${h.kind}-${h.term}`} testID={`allergy-add-hit-${h.term}`} accessibilityRole="button" style={st.hit}
              onPress={() => { setQ(h.term); setPick(h); setHits([]); setKnown(true); }}>
              <Text style={st.hitName} numberOfLines={1}>{h.term}</Text>
              {h.blocks.length > 0 && <Text style={st.hitSub} numberOfLines={1}>{t("opdConsult.allergyBlocks", { list: h.blocks.slice(0, 4).join(", ") })}</Text>}
            </Pressable>
          ))}
        </View>
      )}
      {!known && pick === null && substance.length >= ALLERGY_MIN_CHARS && (
        <Text testID="allergy-add-norule" numberOfLines={1} style={st.norule}>{t("mobile.consult.allergyAdd.noRule")}</Text>
      )}

      <Text style={st.lab}>{t("vitalsBay.allergy.severity")}</Text>
      <View style={st.seg}>
        {(["mild", "moderate", "severe"] as const).map((v) => (
          <Pressable key={v} testID={`allergy-add-sev-${v}`} accessibilityRole="button" accessibilityState={{ selected: severity === v }}
            onPress={() => setSeverity(v)} style={[st.segItem, severity === v && (v === "severe" ? st.segSevere : st.segOn)]}>
            <Text style={[st.segText, severity === v && { color: "#f2faf6" }]}>{t(`vitalsBay.allergy.${v}`)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={st.lab}>{t("vitalsBay.allergy.reaction")}</Text>
      <TextInput testID="allergy-add-reaction" accessibilityLabel={t("vitalsBay.allergy.reaction")} value={reaction} onChangeText={setReaction}
        placeholder={t("mobile.consult.allergyAdd.reactionHint")} placeholderTextColor={color.faint} style={st.box} />
    </Drawer>
  );
}

const st = StyleSheet.create({
  lab: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.faint, textTransform: "uppercase", marginTop: 2 },
  box: { minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.paper, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: color.ink },
  hit: { minHeight: TOUCH, justifyContent: "center", paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line2 },
  hitName: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: color.ink },
  hitSub: { fontSize: 12.5, lineHeight: 18, color: color.dim },
  norule: { fontSize: 13, fontWeight: "700", color: "#8a5a10" },
  seg: { flexDirection: "row", gap: 6 },
  segItem: { flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, paddingHorizontal: 4 },
  segOn: { backgroundColor: color.green, borderColor: color.green },
  segSevere: { backgroundColor: color.red, borderColor: color.red },
  segText: { fontSize: 14, fontWeight: "700", color: color.ink },
  failed: { fontSize: 13.5, fontWeight: "700", color: color.red },
});
