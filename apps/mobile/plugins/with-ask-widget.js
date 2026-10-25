/**
 * HOME-SCREEN ASK WIDGET (owner 2026-10-10: "talk or chat to the agent"; decision 0064, plan E1.7,
 * spec Part B2, #590).
 *
 * An Android home-screen widget, "HMIS Ask": a tap on "Ask" opens `hmis://copilot?keyboard=1`, the
 * app's copilot chat with the box focused and the keyboard up. Like the scan widget it is native and
 * tiny — it draws fixed words and an icon and hands the tap to the app. NO JavaScript runs in it, it
 * reads nothing, stores nothing and is never refreshed, so it can never show a patient or an answer.
 *
 * THE MICROPHONE IS NOT DRAWN until ruling R-2 (staff voice to the cloud speech service) is given:
 * `mic: false` leaves the mic out of the layout, the strings and the Kotlin altogether. `mic: true`
 * adds a second button that opens `hmis://copilot?mic=1`, where the app listens and puts what it
 * heard in the box to be read and edited — never asked by itself (src/copilot/voice.tsx).
 *
 * Android only, as the scan widget. Native: a new APK, not an OTA update.
 */
const fs = require("fs");
const path = require("path");
const { AndroidConfig, withAndroidManifest, withDangerousMod, withStringsXml } = require("expo/config-plugins");

const RECEIVER = ".AskWidgetProvider";
const LINK = "hmis://copilot?keyboard=1";
const MIC_LINK = "hmis://copilot?mic=1";
const PINE = "#0E6B4E";

/** The receiver the widget picker lists; label and preview come from the resources below. */
function addReceiver(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.receiver = (app.receiver ?? []).filter((r) => r.$["android:name"] !== RECEIVER);
  app.receiver.push({
    $: { "android:name": RECEIVER, "android:exported": "false", "android:label": "@string/ask_widget_label" },
    "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
    "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/ask_widget_info" } }],
  });
  return manifest;
}

/** Every native file the widget needs, keyed by its path under android/app/src/main. */
function widgetFiles(pkg, { mic = false } = {}) {
  const intent = (name, link, code) => `    val ${name} = PendingIntent.getActivity(context, ${code}, Intent(Intent.ACTION_VIEW, Uri.parse("${link}")).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
`;
  const kotlin = `package ${pkg}

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/** HMIS Ask (decision 0064): fixed words; a tap opens ${LINK} in THIS app. Shows no patient, ever. */
class AskWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
${intent("ask", LINK, 0)}${mic ? intent("mic", MIC_LINK, 1) : ""}    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.ask_widget)
      views.setOnClickPendingIntent(R.id.ask_widget_ask, ask)
${mic ? "      views.setOnClickPendingIntent(R.id.ask_widget_mic, mic)\n" : ""}      manager.updateAppWidget(id, views)
    }
  }
}
`;
  // 2x1 (73n - 16 dp per cell), resizable sideways to 3x1. Never refreshed: nothing on it changes.
  const info = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="110dp" android:minHeight="40dp"
  android:minResizeWidth="110dp" android:minResizeHeight="40dp"
  android:maxResizeWidth="203dp" android:maxResizeHeight="57dp"
  android:targetCellWidth="2" android:targetCellHeight="1"
  android:resizeMode="horizontal" android:widgetCategory="home_screen"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/ask_widget" android:previewLayout="@layout/ask_widget"
  android:description="@string/ask_widget_description" />
`;
  const micButton = `
  <LinearLayout android:id="@+id/ask_widget_mic"
    android:layout_width="52dp" android:layout_height="match_parent"
    android:layout_marginStart="4dp" android:gravity="center"
    android:background="@drawable/ask_widget_bg"
    android:contentDescription="@string/ask_widget_mic">
    <ImageView android:layout_width="24dp" android:layout_height="24dp"
      android:src="@drawable/ask_widget_mic_icon" android:importantForAccessibility="no" />
  </LinearLayout>`;
  const layout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:id="@+id/ask_widget_root"
  android:layout_width="match_parent" android:layout_height="match_parent"
  android:orientation="horizontal" android:padding="4dp">
  <LinearLayout android:id="@+id/ask_widget_ask"
    android:layout_width="0dp" android:layout_height="match_parent" android:layout_weight="1"
    android:orientation="horizontal" android:gravity="center" android:paddingStart="10dp" android:paddingEnd="10dp"
    android:background="@drawable/ask_widget_bg"
    android:contentDescription="@string/ask_widget_label">
    <ImageView android:layout_width="22dp" android:layout_height="22dp"
      android:src="@drawable/ask_widget_icon" android:importantForAccessibility="no" />
    <TextView android:layout_width="wrap_content" android:layout_height="wrap_content"
      android:layout_marginStart="6dp" android:text="@string/ask_widget_word"
      android:textColor="#FFFFFF" android:textSize="14sp" android:textStyle="bold"
      android:maxLines="1" android:importantForAccessibility="no" />
  </LinearLayout>${mic ? micButton : ""}
</LinearLayout>
`;
  const bg = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="${PINE}" />
  <corners android:radius="16dp" />
</shape>
`;
  // A speech bubble with three dots, white on pine.
  const icon = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFF" android:strokeWidth="2" android:strokeLineJoin="round"
    android:pathData="M5,4h14a2,2 0,0 1,2,2v9a2,2 0,0 1,-2,2h-8l-5,4v-4h-1a2,2 0,0 1,-2,-2v-9a2,2 0,0 1,2,-2z" />
  <path android:fillColor="#FFFFFF" android:pathData="M8,10.5m-1.25,0a1.25,1.25 0,1 1,2.5,0a1.25,1.25 0,1 1,-2.5,0" />
  <path android:fillColor="#FFFFFF" android:pathData="M12,10.5m-1.25,0a1.25,1.25 0,1 1,2.5,0a1.25,1.25 0,1 1,-2.5,0" />
  <path android:fillColor="#FFFFFF" android:pathData="M16,10.5m-1.25,0a1.25,1.25 0,1 1,2.5,0a1.25,1.25 0,1 1,-2.5,0" />
</vector>
`;
  const micIcon = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFF" android:pathData="M12,3a3,3 0,0 1,3,3v6a3,3 0,0 1,-6,0v-6a3,3 0,0 1,3,-3z" />
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFF" android:strokeWidth="2" android:strokeLineCap="round"
    android:pathData="M6,11a6,6 0,0 0,12,0M12,17v4M9,21h6" />
</vector>
`;
  return {
    [path.join("java", ...pkg.split("."), "AskWidgetProvider.kt")]: kotlin,
    [path.join("res", "xml", "ask_widget_info.xml")]: info,
    [path.join("res", "layout", "ask_widget.xml")]: layout,
    [path.join("res", "drawable", "ask_widget_bg.xml")]: bg,
    [path.join("res", "drawable", "ask_widget_icon.xml")]: icon,
    ...(mic ? { [path.join("res", "drawable", "ask_widget_mic_icon.xml")]: micIcon } : {}),
  };
}

function setString(strings, name, value) {
  return AndroidConfig.Strings.setStringItem([AndroidConfig.Resources.buildResourceItem({ name, value })], strings);
}

/**
 * `label` — the name in the widget picker: "HMIS Ask", or "HMIS Ask (staging)" for the staging app.
 * `mic` — draw the microphone; false until ruling R-2 (app.config.ts `VOICE_ASK`).
 */
const withAskWidget = (config, { label = "HMIS Ask", mic = false } = {}) => {
  config = withAndroidManifest(config, (c) => {
    addReceiver(c.modResults);
    return c;
  });
  config = withStringsXml(config, (c) => {
    c.modResults = setString(c.modResults, "ask_widget_label", label);
    c.modResults = setString(c.modResults, "ask_widget_word", "Ask");
    c.modResults = setString(c.modResults, "ask_widget_description", "Opens the copilot with the keyboard up.");
    if (mic) c.modResults = setString(c.modResults, "ask_widget_mic", "Speak a question");
    return c;
  });
  config = withDangerousMod(config, ["android", async (c) => {
    const pkg = c.android?.package;
    if (!pkg) throw new Error("with-ask-widget: android.package is required");
    const main = path.join(c.modRequest.platformProjectRoot, "app", "src", "main");
    for (const [rel, body] of Object.entries(widgetFiles(pkg, { mic }))) {
      const file = path.join(main, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return c;
  }]);
  return config;
};

module.exports = withAskWidget;
module.exports.addReceiver = addReceiver;
module.exports.widgetFiles = widgetFiles;
module.exports.LINK = LINK;
module.exports.MIC_LINK = MIC_LINK;
