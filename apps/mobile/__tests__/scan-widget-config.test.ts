import { execFileSync } from "child_process";
import { join } from "path";

/*
  HOME-SCREEN SCAN WIDGET (owner 2026-10-10, decision 0064 E1.1; spec Part A check 1). The plugins are
  RUN here (`expo config --type introspect` applies every config plugin the way a build does, offline),
  so this reads the AndroidManifest and strings the build would get. The native files the plugin writes
  are read from the plugin's own `widgetFiles` — the same text prebuild writes.
*/
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../plugins/with-scan-widget") as { widgetFiles: (pkg: string) => Record<string, string>; LINK: string };

type Node = { $: Record<string, string>; "intent-filter"?: { action: Node[] }[]; "meta-data"?: Node[] };
type Introspected = {
  android?: { package?: string };
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

describe.each([["production", "HMIS Scan"], ["preview", "HMIS Scan (staging)"]])("the %s build's scan widget", (env, label) => {
  let c: Introspected;
  beforeAll(() => { c = introspect(env); }, 120_000);

  it("registers ONE widget receiver, not exported, with the widget's metadata", () => {
    const receivers = (c._internal.modResults.android.manifest.manifest.application[0]?.receiver ?? []).filter((r) => r.$["android:name"] === ".ScanWidgetProvider");
    expect(receivers).toHaveLength(1);
    const r = receivers[0]!;
    expect(r.$["android:exported"]).toBe("false");
    expect(r.$["android:label"]).toBe("@string/scan_widget_label");
    expect(r["intent-filter"]?.[0]?.action.map((a) => a.$["android:name"])).toEqual(["android.appwidget.action.APPWIDGET_UPDATE"]);
    expect(r["meta-data"]?.map((m) => m.$)).toEqual([{ "android:name": "android.appwidget.provider", "android:resource": "@xml/scan_widget_info" }]);
  });

  it(`is named "${label}" in the widget picker`, () => {
    const strings = c._internal.modResults.android.strings.resources.string ?? [];
    expect(strings.find((s) => s.$.name === "scan_widget_label")?._).toBe(label);
    expect(strings.find((s) => s.$.name === "scan_widget_word")?._).toBe("Scan");
  });
});

describe("the widget's native files", () => {
  const files = plugin.widgetFiles("com.crkmch.hmis.staging");
  const kotlin = files[join("java", "com", "crkmch", "hmis", "staging", "ScanWidgetProvider.kt")] ?? "";

  it("opens hmis://scan in THIS app — never an 'open with' between staging and production", () => {
    expect(plugin.LINK).toBe("hmis://scan");
    expect(kotlin).toContain('Uri.parse("hmis://scan")');
    expect(kotlin).toContain("setPackage(context.packageName)");
    expect(kotlin).toContain("PendingIntent.FLAG_IMMUTABLE");
    expect(kotlin.startsWith("package com.crkmch.hmis.staging\n")).toBe(true);
  });

  it("1x1, resizable sideways to 2x1, never refreshed", () => {
    const info = files[join("res", "xml", "scan_widget_info.xml")] ?? "";
    expect(info).toContain('android:resizeMode="horizontal"');
    expect(info).toContain('android:targetCellWidth="1"');
    expect(info).toContain('android:maxResizeWidth="130dp"');
    expect(info).toContain('android:updatePeriodMillis="0"');
  });

  it("shows no patient, ever: a fixed layout, no network, no storage, nothing set but the tap", () => {
    expect(kotlin).not.toMatch(/setTextViewText|setImageViewBitmap|setImageViewUri|SharedPreferences|http|SecureStore|Keystore/);
    const layout = files[join("res", "layout", "scan_widget.xml")] ?? "";
    expect(layout.match(/android:text="[^"]*"/g)).toEqual(['android:text="@string/scan_widget_word"']);
  });
});
