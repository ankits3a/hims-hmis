#!/usr/bin/env node
/**
 * WHAT GOOGLE PLAY REFUSES, REFUSED HERE FIRST (spec #1058 D4, decision 0095).
 *
 * `scripts/build-apk.sh production --play` runs this on every bundle before it is kept, so a bundle that
 * Play's automatic checks would reject never reaches the owner's upload:
 *  - a permission Play bans or makes the owner justify: installing other apps (our APK prompt is off on
 *    Play phones, src/update.ts), background location (attendance reads it once, in the foreground),
 *    photo-library and shared-storage reads (the slip picker is the system picker, #934), all files,
 *    every installed app;
 *  - a target SDK below Play's floor for new apps and updates;
 *  - a 64-bit native library whose LOAD segments are not 16 KB-aligned (Play requires 16 KB page support
 *    for apps that target Android 15+). 32-bit libraries are exempt.
 *
 *   node scripts/play-checks.js <merged AndroidManifest.xml> <folder of the bundle's lib/ files>
 *
 * No dependency: the app's CI installs only the app's own packages.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const TARGET_SDK_FLOOR = 35;
const PAGE = 16384;
const BANNED = [
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.QUERY_ALL_PACKAGES",
];

/** Every permission the manifest asks for (uses-permission and uses-permission-sdk-23). */
function permissionsOf(manifest) {
  const out = new Set();
  for (const m of manifest.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*?android:name\s*=\s*"([^"]+)"/g)) out.add(m[1]);
  return out;
}

function targetSdkOf(manifest) {
  const m = /<uses-sdk\b[^>]*?android:targetSdkVersion\s*=\s*"(\d+)"/.exec(manifest);
  return m ? Number(m[1]) : null;
}

/**
 * The smallest alignment of an ELF file's PT_LOAD segments: a number for a 64-bit library, "32-bit" for a
 * 32-bit one (exempt), null when the bytes are not an ELF file.
 */
function loadAlignment(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 0x40 || b.readUInt32BE(0) !== 0x7f454c46) return null;
  if (b[4] === 1) return "32-bit";
  if (b[4] !== 2 || b[5] !== 1) return null; // only little-endian 64-bit is an Android library
  const phoff = Number(b.readBigUInt64LE(0x20)), size = b.readUInt16LE(0x36), count = b.readUInt16LE(0x38);
  let smallest = Infinity;
  for (let i = 0; i < count; i++) {
    const at = phoff + i * size;
    if (at + 56 > b.length) return null;
    if (b.readUInt32LE(at) !== 1) continue; // PT_LOAD
    smallest = Math.min(smallest, Number(b.readBigUInt64LE(at + 48)));
  }
  return smallest === Infinity ? null : smallest;
}

/** Every reason Play would refuse this bundle; an empty list passes. */
function checkPlayBundle({ manifest, libs }) {
  const refused = [];
  const perms = permissionsOf(manifest);
  for (const p of BANNED) if (perms.has(p)) refused.push(`the manifest asks for ${p}`);
  const target = targetSdkOf(manifest);
  if (target === null) refused.push("the manifest names no targetSdkVersion");
  else if (target < TARGET_SDK_FLOOR) refused.push(`targetSdkVersion ${target} is below Google Play's floor of ${TARGET_SDK_FLOOR}`);
  if (libs.length === 0) refused.push("the bundle carries no native libraries (the lib/ folder was not read)");
  for (const lib of libs) {
    const align = loadAlignment(lib.bytes);
    if (align === null) refused.push(`${lib.path} is not a native library Android can load`);
    else if (align !== "32-bit" && align < PAGE) refused.push(`${lib.path} is aligned to ${align} bytes, not 16 KB`);
  }
  return refused;
}

function libsUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".so")) out.push({ path: path.relative(dir, p), bytes: fs.readFileSync(p) });
    }
  };
  walk(dir);
  return out;
}

if (require.main === module) {
  const [manifestPath, libDir] = process.argv.slice(2);
  if (!manifestPath || !libDir) {
    console.error("usage: play-checks.js <merged AndroidManifest.xml> <lib folder>");
    process.exit(2);
  }
  const refused = checkPlayBundle({ manifest: fs.readFileSync(manifestPath, "utf8"), libs: libsUnder(libDir) });
  for (const r of refused) console.error(`REFUSED: ${r}`);
  if (refused.length > 0) process.exit(1);
  console.log("play checks: permissions, target SDK and 16 KB alignment are what Google Play accepts");
}

module.exports = { checkPlayBundle, loadAlignment, permissionsOf, targetSdkOf, BANNED, TARGET_SDK_FLOOR };
