#!/usr/bin/env bash
# Phone notifications (plan M6b): check the two Firebase files the owner supplies, WITHOUT printing
# what is in them. See BUILDING.md, "Notifications".
#
#   apps/mobile/scripts/enable-push.sh --check      # are both files there and the right shape?
#   apps/mobile/scripts/enable-push.sh --validate   # --check, then ask Firebase itself (dry run: nothing is sent to any phone)
#
# The files (owner-supplied, dir 0700, files 0600, never committed):
#   /root/.config/hmis/firebase/google-services.json   Firebase's CLIENT config — goes into the APK at build time
#   /root/.config/hmis/firebase/service-account.json   the SERVER's key (SECRET) — deploy.sh copies it for the api and worker
#
# This script changes nothing. What turns notifications on is: (1) build both APKs
# (scripts/build-apk.sh — it picks google-services.json up by itself), and (2) a deploy, whose step 2
# copies the key beside the api and the worker; they notice it within a minute, no restart.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in --check|--validate) ;; *) echo "usage: $0 [--check|--validate]" >&2; exit 2 ;; esac
DIR="${HMIS_FIREBASE_DIR:-/root/.config/hmis/firebase}"

MODE="$MODE" DIR="$DIR" node - <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const dir = process.env.DIR;
const WANT = ["com.crkmch.hmis", "com.crkmch.hmis.staging"];
const problems = [];
const ok = (line) => console.log(`  ok   ${line}`);
const bad = (line) => { problems.push(line); console.log(`  FAIL ${line}`); };

function read(name) {
  const path = `${dir}/${name}`;
  let st;
  try { st = fs.statSync(path); } catch { bad(`${path} is not there`); return null; }
  if ((st.mode & 0o077) !== 0) bad(`${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}) — chmod 600`);
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { bad(`${path} is not JSON`); return null; }
}

console.log(`Firebase files in ${dir}`);
const gs = read("google-services.json");
let gsProject = null;
if (gs !== null) {
  gsProject = gs.project_info && gs.project_info.project_id;
  if (typeof gsProject !== "string") bad("google-services.json has no project id — is it the right file?");
  else ok(`google-services.json — project ${gsProject}`);
  const ids = (gs.client || []).map((c) => c && c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name).filter(Boolean);
  for (const id of WANT) {
    if (ids.includes(id)) ok(`google-services.json names the app ${id}`);
    else bad(`google-services.json does not name ${id} — add that Android app in the Firebase console, then download the file again`);
  }
}

const sa = read("service-account.json");
let account = null;
if (sa !== null) {
  if (sa.type !== "service_account") bad("service-account.json is not a service-account key (did google-services.json get saved under this name?)");
  else if (typeof sa.project_id !== "string" || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") bad("service-account.json is missing its project, e-mail or key");
  else {
    try {
      crypto.createPrivateKey(sa.private_key);
      ok(`service-account.json — a service-account key for project ${sa.project_id} (the key parses)`);
      account = sa;
    } catch { bad("service-account.json's private key does not parse — download a new key"); }
    if (gsProject !== null && typeof gsProject === "string" && sa.project_id !== gsProject) bad(`the two files are from DIFFERENT projects (${gsProject} and ${sa.project_id})`);
    else if (account !== null && gsProject !== null) ok("both files are from the same project");
  }
}

async function validate() {
  // Firebase's own answer, with `validate_only`: the credentials, the project and the Cloud
  // Messaging API are checked and NOTHING is delivered — the message names a topic no phone is on.
  const b64 = (v) => Buffer.from(v).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 600 }))}`;
  const assertion = `${unsigned}.${b64(crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key))}`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
  });
  if (tokenRes.status !== 200) { bad(`Google refused the key (token endpoint answered ${tokenRes.status}) — is the key deleted or disabled?`); return; }
  ok("Google accepted the key (an access token was issued)");
  const access = (await tokenRes.json()).access_token;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ validate_only: true, message: { topic: "hmis-selftest", notification: { title: "HMIS", body: "Test — this phone can receive HMIS notifications." }, data: { category: "alert", link: "home" }, android: { priority: "HIGH", notification: { channel_id: "alert" } } } }),
  });
  if (res.status === 200) { ok("Firebase Cloud Messaging accepted a dry-run message (validate_only — nothing was sent)"); return; }
  let code = "UNKNOWN";
  try { const j = await res.json(); code = (j.error && (j.error.status || j.error.message)) || code; } catch { /* keep UNKNOWN */ }
  bad(`Firebase Cloud Messaging refused the dry run: ${res.status} ${code}${res.status === 403 ? " — enable the 'Firebase Cloud Messaging API' for this project in the Google Cloud console" : ""}`);
}

(async () => {
  if (process.env.MODE === "--validate") {
    if (account === null) bad("cannot ask Firebase: there is no usable service-account key");
    else { try { await validate(); } catch (e) { bad(`could not reach Google: ${e && e.code ? e.code : "network error"}`); } }
  }
  if (problems.length > 0) { console.log(`\n${problems.length} problem(s). Nothing was changed.`); process.exit(1); }
  console.log(process.env.MODE === "--validate"
    ? "\nAll good. Build the APKs (scripts/build-apk.sh staging, then production); the next deploy gives the key to the api and the worker."
    : "\nBoth files are the right shape. Run with --validate to ask Firebase itself (a dry run; nothing is sent).");
})();
NODE
