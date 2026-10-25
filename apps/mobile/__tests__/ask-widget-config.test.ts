import { execFileSync } from "child_process";
import { join } from "path";

/*
  #590 (plan E1.7) — THE "HMIS ASK" HOME-SCREEN WIDGET. As for the scan widget, the plugins are RUN here
  (`expo config --type introspect` applies every config plugin the way a build does, offline), so this
  reads the AndroidManifest, strings and `extra` the build would get. The native files are read from the
  plugin's own `widgetFiles` — the same text prebuild writes.
*/
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../plugins/with-ask-widget") as { widgetFiles: (pkg: string, o?: { mic?: boolean }) => Record<string, string>; LINK: string; MIC_LINK: string };

type Node = { $: Record<string, string>; "intent-filter"?: { action: Node[] }[]; "meta-data"?: Node[] };
type Introspected = {
  extra?: { voiceAsk?: boolean };
  _internal: { modResults: { android: {
    manifest: { manifest: { application: { receiver?: Node[] }[] } };
    strings: { resources: { string?: { $: { name: string }; _: string }[] } };
  } } };
};
const ROOT = join(__dirname, "..");

function introspect(appEnv: string): Introspected {
  const out = execFileSync(process.execPath, [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"], {
    cwd: ROOT, env: { ...process.env, APP_ENV: appEnv, EXPO_NO_TELEMETRY: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("{"))) as Introspected;
}

describe.each([["production", "HMIS Ask"], ["preview", "HMIS Ask (staging)"]])("the %s build's Ask widget", (env, label) => {
  let c: Introspected;
  beforeAll(() => { c = introspect(env); }, 120_000);

  it("registers ONE widget receiver, not exported, with the widget's metadata", () => {
    const receivers = (c._internal.modResults.android.manifest.manifest.application[0]?.receiver ?? []).filter((r) => r.$["android:name"] === ".AskWidgetProvider");
    expect(receivers).toHaveLength(1);
    const r = receivers[0]!;
    expect(r.$["android:exported"]).toBe("false");
    expect(r.$["android:label"]).toBe("@string/ask_widget_label");
    expect(r["intent-filter"]?.[0]?.action.map((a) => a.$["android:name"])).toEqual(["android.appwidget.action.APPWIDGET_UPDATE"]);
    expect(r["meta-data"]?.map((m) => m.$)).toEqual([{ "android:name": "android.appwidget.provider", "android:resource": "@xml/ask_widget_info" }]);
  });

  it(`is named "${label}" in the widget picker and says "Ask"`, () => {
    const strings = c._internal.modResults.android.strings.resources.string ?? [];
    expect(strings.find((s) => s.$.name === "ask_widget_label")?._).toBe(label);
    expect(strings.find((s) => s.$.name === "ask_widget_word")?._).toBe("Ask");
  });

  it("draws no microphone and the app carries none: ruling R-2 is not given", () => {
    const strings = c._internal.modResults.android.strings.resources.string ?? [];
    expect(strings.find((s) => s.$.name === "ask_widget_mic")).toBeUndefined();
    expect(c.extra?.voiceAsk).toBe(false);
  });
});

describe("the Ask widget's native files", () => {
  const PKG = "com.crkmch.hmis.staging";
  const kotlinOf = (files: Record<string, string>) => files[join("java", "com", "crkmch", "hmis", "staging", "AskWidgetProvider.kt")] ?? "";
  const off = plugin.widgetFiles(PKG);
  const on = plugin.widgetFiles(PKG, { mic: true });

  it("opens the copilot with the keyboard up, in THIS app — never an 'open with' between staging and production", () => {
    expect(plugin.LINK).toBe("hmis://copilot?keyboard=1");
    const kotlin = kotlinOf(off);
    expect(kotlin).toContain('Uri.parse("hmis://copilot?keyboard=1")');
    expect(kotlin).toContain("setPackage(context.packageName)");
    expect(kotlin).toContain("PendingIntent.FLAG_IMMUTABLE");
    expect(kotlin).toContain("setOnClickPendingIntent(R.id.ask_widget_ask, ask)");
    expect(kotlin.startsWith("package com.crkmch.hmis.staging\n")).toBe(true);
  });

  it("without the mic option: no mic in the layout, the Kotlin or the drawables", () => {
    expect(kotlinOf(off)).not.toMatch(/mic/i);
    const layout = off[join("res", "layout", "ask_widget.xml")] ?? "";
    expect(layout).not.toMatch(/mic/i);
    expect(Object.keys(off).filter((p) => /mic/.test(p))).toEqual([]);
  });

  it("with the mic option (after R-2): a second button opens hmis://copilot?mic=1 in this app", () => {
    expect(plugin.MIC_LINK).toBe("hmis://copilot?mic=1");
    const kotlin = kotlinOf(on);
    expect(kotlin).toContain('Uri.parse("hmis://copilot?mic=1")');
    expect(kotlin).toContain("setOnClickPendingIntent(R.id.ask_widget_mic, mic)");
    // Two taps, two request codes: Android would otherwise hand both buttons the same PendingIntent.
    expect(kotlin).toContain("PendingIntent.getActivity(context, 0,");
    expect(kotlin).toContain("PendingIntent.getActivity(context, 1,");
    expect(on[join("res", "layout", "ask_widget.xml")]).toContain('android:id="@+id/ask_widget_mic"');
    expect(on[join("res", "drawable", "ask_widget_mic_icon.xml")]).toBeDefined();
  });

  it("2x1, resizable sideways, never refreshed", () => {
    const info = off[join("res", "xml", "ask_widget_info.xml")] ?? "";
    expect(info).toContain('android:resizeMode="horizontal"');
    expect(info).toContain('android:targetCellWidth="2"');
    expect(info).toContain('android:updatePeriodMillis="0"');
  });

  it("shows no patient and no answer, ever: a fixed layout, no network, no storage, nothing set but the taps", () => {
    for (const files of [off, on]) {
      expect(kotlinOf(files)).not.toMatch(/setTextViewText|setImageViewBitmap|setImageViewUri|SharedPreferences|http|SecureStore|Keystore/);
      const layout = files[join("res", "layout", "ask_widget.xml")] ?? "";
      expect(layout.match(/android:text="[^"]*"/g)).toEqual(['android:text="@string/ask_widget_word"']);
    }
  });
});
