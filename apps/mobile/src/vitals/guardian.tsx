import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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
export { guardianMayStandIn } from "../../../../packages/contracts/src/patient-absent";

export function GuardianAbsentAction({ api, encounterId, onDone }: {
  api: VitalsApi; encounterId: string; onDone: (absent: WirePatientAbsent) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState<GuardianRelation | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => { setOpen(false); setRelation(null); setName(""); setError(null); };
  const confirm = async (): Promise<void> => {
    if (relation === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.markPatientAbsent(encounterId, { relation, name: name.trim() === "" ? null : name.trim() });
      close();
      onDone(out.patientAbsent);
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

  if (!open) {
    return (
      <Pressable testID="patient-absent-open" accessibilityRole="button" onPress={() => setOpen(true)} style={s.openBtn}>
        <Text style={s.openText}>{t("patientAbsent.action")}</Text>
      </Pressable>
    );
  }
  return (
    <View testID="patient-absent-dialog" accessibilityLabel={t("patientAbsent.title")} style={s.card}>
      <Text style={s.title}>{t("patientAbsent.title")}</Text>
      <Text style={s.hint}>{t("patientAbsent.hint")}</Text>
      <Text style={s.label}>{t("patientAbsent.relationLabel")}</Text>
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
      <Button testID="patient-absent-cancel" kind="secondary" label={t("patientAbsent.cancel")} disabled={busy} onPress={close} />
    </View>
  );
}

const s = StyleSheet.create({
  openBtn: { minHeight: TOUCH, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: space.md, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card },
  openText: { fontSize: 14, fontWeight: "600", color: color.green },
  card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card },
  title: { fontSize: 15, fontWeight: "700", color: color.ink },
  hint: { fontSize: 13, color: color.dim },
  label: { fontSize: 12, color: color.dim, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 40, justifyContent: "center", paddingHorizontal: space.md, borderWidth: 1, borderColor: color.line, borderRadius: 999, backgroundColor: color.card },
  chipOn: { backgroundColor: color.green, borderColor: color.green },
  chipText: { fontSize: 14, fontWeight: "600", color: color.ink },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: color.ink, backgroundColor: color.card },
});
