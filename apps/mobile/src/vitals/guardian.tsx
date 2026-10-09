import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text, TextInput } from "../text";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Note } from "../ui";
import { refusalText, type VitalsApi } from "./api";

/**
 * The fixed list and the name bound of `packages/contracts/src/patient-absent.ts`. That file imports
 * zod, which this standalone project cannot resolve from outside its own folder (the mobile CI job
 * installs nothing at the repo root), so the two values are restated here and
 * `__tests__/vitals-rules.test.ts` fails the day they differ from the contract's.
 */
export const GUARDIAN_RELATIONS = [
  "father", "mother", "spouse", "son", "daughter", "brother", "sister", "other_relative", "attendant",
] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];
export const GUARDIAN_NAME_MAX = 80;
export type WirePatientAbsent = { relation: GuardianRelation; name: string | null; by: string; at: string };

/**
 * THE GUARDIAN CAME WITH THE REPORTS (owner 2026-10-07) — the phone's twin of the web bay's
 * `components/patient-absent.tsx`: the same question, the same fixed list, the same route. A REVISIT
 * with no chart yet may skip the bay; the server decides who may and which visit can, and a refusal
 * is shown in the reader's language where the code is known, else in the server's own sentence.
 * Nothing is queued: a send that does not reach the server stays on screen and says so.
 */
type T = (key: string, vars?: Record<string, string | number>) => string;

/** "Father: Ramesh", or "Father" when no name was given. */
export function guardianWho(t: T, absent: { relation: string; name: string | null }): string {
  const relation = t(`patientAbsent.relation.${absent.relation}`);
  return absent.name === null || absent.name === "" ? relation : t("patientAbsent.who", { relation, name: absent.name });
}

/**
 * Which visits may be marked "patient not present — guardian with reports": the SAME rule the server
 * and the web screens use (packages/contracts/src/patient-absent.ts; metro.config.js watches it).
 * Owner 2026-10-07: revisits and renewals, never a new visit.
 */
export { guardianMayStandIn } from "../../../../packages/contracts/src/patient-absent-rule";

/**
 * "WHO CAME?" — the one sheet (owner 2026-10-09). It is reached from four places and never sits on
 * the vitals form's main view: the action card (a held row, a scan), "Details" inside the form, and a
 * left swipe on a bench row. Whichever opened it, NOTHING is written until "Send to doctor".
 *
 * `confirmHere`: the vitals bay says what happened in its own banner and clears its desk; any other
 * screen has no such banner, so the sheet stays up with the one confirmation line and a Close.
 */
export function GuardianSheet({ api, encounterId, onDone, onClose, confirmHere = false }: {
  api: Pick<VitalsApi, "markPatientAbsent">; encounterId: string; onDone: (absent: WirePatientAbsent) => void; onClose: () => void; confirmHere?: boolean;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [relation, setRelation] = useState<GuardianRelation | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const confirm = async (): Promise<void> => {
    if (relation === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.markPatientAbsent(encounterId, { relation, name: name.trim() === "" ? null : name.trim() });
      onDone(out.patientAbsent);
      if (confirmHere) setSent(true); else onClose();
    } catch (e) {
      if (e instanceof NetworkError) setError(t("home.cover.failed"));
      else if (e instanceof ApiError) {
        const known = t(`patientAbsent.errors.${e.code}`);
        setError(known === `patientAbsent.errors.${e.code}` ? refusalText(e.body, e.code) : known);
      } else setError(t("home.cover.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={busy ? undefined : onClose} accessibilityLabel={t("patientAbsent.cancel")} testID="patient-absent-scrim" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        {sent ? (
          <View testID="patient-absent-sent" style={{ gap: space.md }}>
            <Text style={s.sent}>✓ {t("patientAbsent.done")}</Text>
            <Button testID="patient-absent-close" kind="secondary" label={t("mobile.scan.close")} onPress={onClose} />
          </View>
        ) : (
          <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
            <View testID="patient-absent-dialog" accessibilityLabel={t("patientAbsent.title")} style={{ gap: space.sm }}>
              <Text style={s.title} numberOfLines={1}>{t("patientAbsent.title")}</Text>
              <Text style={s.hint} numberOfLines={1}>{t("patientAbsent.hint")}</Text>
              <View style={s.chips}>
                {GUARDIAN_RELATIONS.map((r) => (
                  <Pressable
                    key={r} testID={`patient-absent-relation-${r}`} accessibilityRole="button" accessibilityState={{ selected: relation === r }}
                    onPress={() => setRelation(r)} style={[s.chip, relation === r && s.chipOn]}
                  >
                    <Text style={[s.chipText, relation === r && { color: "#ffffff" }]}>{t(`patientAbsent.relation.${r}`)}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.label}>{t("patientAbsent.nameLabel")}</Text>
              <TextInput
                testID="patient-absent-name" value={name} onChangeText={setName} maxLength={GUARDIAN_NAME_MAX}
                autoCorrect={false} autoComplete="off" accessibilityLabel={t("patientAbsent.nameLabel")} style={s.input}
              />
              {error !== null && <Note tone="bad" testID="patient-absent-error">{error}</Note>}
              <Button testID="patient-absent-confirm" label={busy ? t("patientAbsent.sending") : t("patientAbsent.confirm")} busy={busy} disabled={relation === null} onPress={() => { void confirm(); }} />
              <Button testID="patient-absent-cancel" kind="secondary" label={t("patientAbsent.cancel")} disabled={busy} onPress={onClose} />
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

/** The visible, non-gesture way in: a text link under "Details" in the vitals form. */
export function GuardianLink({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable testID="patient-absent-open" accessibilityRole="button" hitSlop={6} onPress={onPress} style={s.linkBtn}>
      <Text style={s.linkText} numberOfLines={1}>{t("patientAbsent.short")} ›</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(19,36,32,.45)" },
  sheet: { maxHeight: "88%", backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: space.lg, paddingTop: space.lg },
  sent: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: color.green },
  linkBtn: { minHeight: 36, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { fontSize: 14.5, fontWeight: "700", color: "#8a5a10" },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700", color: color.ink },
  hint: { fontSize: 13.5, lineHeight: 19, color: color.dim, marginBottom: space.xs },
  label: { fontSize: 12, color: color.dim, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 40, justifyContent: "center", paddingHorizontal: space.md, borderWidth: 1, borderColor: color.line, borderRadius: 999, backgroundColor: color.card },
  chipOn: { backgroundColor: color.green, borderColor: color.green },
  chipText: { fontSize: 14, fontWeight: "600", color: color.ink },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: color.ink, backgroundColor: color.card },
});
