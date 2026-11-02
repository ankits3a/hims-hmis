/**
 * What makes two builds "the same native app" (app.config.ts, `runtimeVersion`).
 *
 * An over-the-air bundle reaches a phone only when the phone's fingerprint equals the bundle's. So
 * the fingerprint must move when the NATIVE side moves and stand still otherwise:
 *  - the version name and versionCode go up on every build — they are not native code;
 *  - `extra` is read by JavaScript only (API address, feed address, version shown on screen), and
 *    the bundle carries its own copy.
 * Everything else stays in: native modules, config plugins, permissions, the Firebase client file.
 *
 * A Gradle build leaves its own output inside node_modules (`expo-updates-gradle-plugin/build`,
 * `.gradle`, `.kotlin`). The first APK built with this file was fingerprinted HALF-WAY through that —
 * a value no later checkout could ever compute again, so nothing could be published to it
 * (2026-10-06, versionCode 10). Build output is not the native side; it is ignored.
 */
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ["ExpoConfigVersions", "ExpoConfigExtraSection"],
  ignorePaths: ["node_modules/**/*gradle-plugin*/**/build/**", "node_modules/**/.gradle/**", "node_modules/**/.kotlin/**"],
};
