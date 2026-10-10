/**
 * HOME-SCREEN SCAN WIDGET (owner 2026-10-10: "quick camera, to quickly capture the barcode/QR to start
 * working on that patient"; decision 0064, plan E1.1, spec Part A).
 *
 * An Android home-screen widget, "HMIS Scan": one tap opens `hmis://scan`, the app's existing scan
 * screen with the camera on. It is native and tiny — an AppWidgetProvider that draws a fixed icon and
 * the word "Scan" and hands the tap to the app. NO JavaScript runs in the widget, it reads nothing,
 * stores nothing and is never refreshed, so it can never show a patient. Sign-in, the fingerprint and
 * everything after the tap belong to the app (app/scan.tsx, src/return-to.ts).
 *
 * The tap's intent names this app's own package: the staging and the production app both answer the
 * `hmis` scheme, and a widget must open ITS app, never ask "open with…".
 *
 * Android only: an iPhone widget is out of scope (spec Part A). Native: a new APK, not an OTA update.
 */
const fs = require("fs");
const path = require("path");
const { AndroidConfig, withAndroidManifest, withDangerousMod, withStringsXml } = require("expo/config-plugins");

const RECEIVER = ".ScanWidgetProvider";
const LINK = "hmis://scan";
const PINE = "#0E6B4E";

/** The receiver the widget picker lists; label and preview come from the resources below. */
function addReceiver(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.receiver = (app.receiver ?? []).filter((r) => r.$["android:name"] !== RECEIVER);
  app.receiver.push({
    $: { "android:name": RECEIVER, "android:exported": "false", "android:label": "@string/scan_widget_label" },
    "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
    "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/scan_widget_info" } }],
  });
  return manifest;
}

/** Every native file the widget needs, keyed by its path under android/app/src/main. */
function widgetFiles(pkg) {
  const kotlin = `package ${pkg}

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/** HMIS Scan (decision 0064): a fixed icon; a tap opens ${LINK} in THIS app. Shows no patient, ever. */
class ScanWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("${LINK}")).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.scan_widget)
      views.setOnClickPendingIntent(R.id.scan_widget_root, tap)
      manager.updateAppWidget(id, views)
    }
  }
}
`;
  // 1x1, resizable sideways to 2x1 (73n - 16 dp per cell). Never refreshed: nothing on it changes.
  const info = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="40dp" android:minHeight="40dp"
  android:minResizeWidth="40dp" android:minResizeHeight="40dp"
  android:maxResizeWidth="130dp" android:maxResizeHeight="57dp"
  android:targetCellWidth="1" android:targetCellHeight="1"
  android:resizeMode="horizontal" android:widgetCategory="home_screen"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/scan_widget" android:previewLayout="@layout/scan_widget"
  android:description="@string/scan_widget_description" />
`;
  const layout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:id="@+id/scan_widget_root"
  android:layout_width="match_parent" android:layout_height="match_parent"
  android:orientation="vertical" android:gravity="center" android:padding="4dp"
  android:background="@drawable/scan_widget_bg"
  android:contentDescription="@string/scan_widget_label">
  <ImageView android:layout_width="26dp" android:layout_height="26dp"
    android:src="@drawable/scan_widget_icon" android:importantForAccessibility="no" />
  <TextView android:layout_width="wrap_content" android:layout_height="wrap_content"
    android:layout_marginTop="2dp" android:text="@string/scan_widget_word"
    android:textColor="#FFFFFF" android:textSize="12sp" android:textStyle="bold"
    android:maxLines="1" android:importantForAccessibility="no" />
</LinearLayout>
`;
  const bg = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="${PINE}" />
  <corners android:radius="16dp" />
</shape>
`;
  // A camera in a scan frame (four corners), white on pine — the header's scan button, larger.
  const icon = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFF" android:strokeWidth="2" android:strokeLineCap="round"
    android:pathData="M3,8V5a2,2 0,0 1,2,-2h3M16,3h3a2,2 0,0 1,2,2v3M21,16v3a2,2 0,0 1,-2,2h-3M8,21H5a2,2 0,0 1,-2,-2v-3" />
  <path android:fillColor="#00000000" android:strokeColor="#FFFFFF" android:strokeWidth="1.8" android:strokeLineJoin="round"
    android:pathData="M7,9.5h2l1,-1.5h4l1,1.5h2v6.5h-10z" />
  <path android:fillColor="#FFFFFF" android:pathData="M12,12.75m-1.75,0a1.75,1.75 0,1 1,3.5,0a1.75,1.75 0,1 1,-3.5,0" />
</vector>
`;
  return {
    [path.join("java", ...pkg.split("."), "ScanWidgetProvider.kt")]: kotlin,
    [path.join("res", "xml", "scan_widget_info.xml")]: info,
    [path.join("res", "layout", "scan_widget.xml")]: layout,
    [path.join("res", "drawable", "scan_widget_bg.xml")]: bg,
    [path.join("res", "drawable", "scan_widget_icon.xml")]: icon,
  };
}

function setString(strings, name, value) {
  return AndroidConfig.Strings.setStringItem([AndroidConfig.Resources.buildResourceItem({ name, value })], strings);
}

/** `label` — the name in the widget picker: "HMIS Scan", or "HMIS Scan (staging)" for the staging app. */
const withScanWidget = (config, { label = "HMIS Scan" } = {}) => {
  config = withAndroidManifest(config, (c) => {
    addReceiver(c.modResults);
    return c;
  });
  config = withStringsXml(config, (c) => {
    c.modResults = setString(c.modResults, "scan_widget_label", label);
    c.modResults = setString(c.modResults, "scan_widget_word", "Scan");
    c.modResults = setString(c.modResults, "scan_widget_description", "Opens the scan screen with the camera on.");
    return c;
  });
  config = withDangerousMod(config, ["android", async (c) => {
    const pkg = c.android?.package;
    if (!pkg) throw new Error("with-scan-widget: android.package is required");
    const main = path.join(c.modRequest.platformProjectRoot, "app", "src", "main");
    for (const [rel, body] of Object.entries(widgetFiles(pkg))) {
      const file = path.join(main, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return c;
  }]);
  return config;
};

module.exports = withScanWidget;
module.exports.addReceiver = addReceiver;
module.exports.widgetFiles = widgetFiles;
module.exports.LINK = LINK;
