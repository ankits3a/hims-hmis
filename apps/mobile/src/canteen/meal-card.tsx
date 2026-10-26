import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, NetworkError } from "../api";
import { QrRows } from "../counter/qr-rows";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, Note } from "../ui";
import type { Call } from "../doctor/api";

/**
 * ═══ CN-1 CANTEEN (#977) — THE STAFF MEAL CARD ═══
 *
 * A line on the home, beside attendance, for a person finance has given a meal card; the page behind it shows the
 * card's QR (signed by the server, alive one minute) with the staff code, and fetches a fresh one before it lapses.
 * The till scans it and shows the person's photo. The app draws the QR from the server's rows (`QrRows`): no QR library.
 * A person with no card sees nothing; a dark canteen module answers 404 and the line stays hidden.
 */
export type MealCardQr = { token: string; expiresAt: string; staffCode: string; category: string; qr: string[] };
const PATH = "/canteen/my-card";
/** Fetch a fresh QR this long before the old one lapses. */
const REFRESH_EARLY_MS = 10_000;

/** One read per home refresh: whether this person has a meal card. */
export function useMealCardHome(call: Call, on: boolean): { has: boolean; reload: () => Promise<void> } {
  const [has, setHas] = useState(false);
  const reload = useCallback(async () => {
    if (!on) return;
    try { await call<MealCardQr>("GET", PATH); setHas(true); } catch (e) { if (e instanceof ApiError) setHas(false); }
  }, [call, on]);
  useEffect(() => { void reload(); }, [reload]);
  return { has, reload };
}

type T = (key: string, vars?: Record<string, string | number>) => string;

export function MealCardLine({ t, has, onOpen }: { t: T; has: boolean; onOpen: () => void }) {
  if (!has) return null;
  return (
    <Pressable testID="home-meal-card" accessibilityRole="button" onPress={onOpen}
      style={({ pressed }) => ({ marginTop: space.md, flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, minHeight: 52,
        backgroundColor: pressed ? color.wash : color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg })}>
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: "700", color: color.ink }}>{t("canteen.mealCard")}</Text>
      <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
    </Pressable>
  );
}

export function MealCardScreen({ nowMs = Date.now }: { nowMs?: () => number } = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const [card, setCard] = useState<MealCardQr | null>(null);
  const [failed, setFailed] = useState<"offline" | "none" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    try {
      const c = await call<MealCardQr>("GET", PATH);
      setCard(c); setFailed(null);
      const wait = Math.max(5_000, Date.parse(c.expiresAt) - nowMs() - REFRESH_EARLY_MS);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => { void load(); }, wait);
    } catch (e) {
      setFailed(e instanceof NetworkError ? "offline" : "none");
    }
  }, [call, nowMs]);
  useEffect(() => { void load(); return () => { if (timer.current !== null) clearTimeout(timer.current); }; }, [load]);
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("canteen.back")} onPress={() => router.back()} testID="meal-card-back" />} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, alignItems: "center" }}>
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("canteen.mealCard")}</Text>
        {failed === "offline" && <Note tone="bad">{t("canteen.offline")}</Note>}
        {failed === "none" && <Note tone="info">{t("canteen.noCard")}</Note>}
        {card !== null && (
          <>
            <QrRows testID="meal-card-qr" rows={card.qr} size={260} label={t("canteen.qrLabel")} />
            <Text testID="meal-card-code" style={{ fontSize: 22, fontWeight: "800", color: color.ink }}>{card.staffCode}</Text>
            <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{card.category}</Text>
            <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("canteen.showAtTill")}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
