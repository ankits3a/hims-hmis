#!/usr/bin/env bash
#
# Owner 2026-09-30: "I want changes deployed fast" — and the owner does not deploy by hand.
# Cron runs this every 10 minutes (/etc/cron.d/hmis-auto-deploy). It deploys origin/main to
# production, but ONLY a commit whose required CI checks
# (`static`, `core`, `web` — the branch-protection set) all concluded `success`. CI is the gate;
# this script adds none of its own judgement.
#
#   KILL SWITCH   touch /opt/hmis-prod/AUTO_DEPLOY_OFF   — every run exits before touching anything
#   ONE AT A TIME flock on /run/lock/hmis-auto-deploy.lock — a slow deploy is never overlapped
#   STATE         /opt/hmis-prod/log/auto-deploy.last    — the last SHA production took green
#   FAILED        /opt/hmis-prod/log/auto-deploy.failed  — a SHA whose prod deploy failed; it is
#                 NOT retried (a deterministic failure must not churn production every 10 minutes).
#                 The next merge to main is tried; delete the file to retry the same SHA.
#   LOG           /opt/hmis-prod/log/auto-deploy.log
#
# It fast-forwards /opt/hmis (the integration checkout, which stays on `main`) and runs deploy.sh
# from there, exactly as a person would. deploy.sh keeps every one of its own refusals: a dirty
# tree outside docs/, HEAD != origin/main, a failed gate. A failed production deploy is recorded
# in FAILED and staging is not touched.
#
# STAGING (https://stagehmis.crkmch.com) then follows production through `tools/stage.sh
# --follow-main` — unless a lane is staged there for the owner to review (`tools/stage.sh <lane>`),
# in which case it stays on that lane until the lane's PR merges or closes, or `tools/stage.sh main`.
#
# TWO HOSTS (owner 2026-10-07: production moved to its own server). When /etc/hmis/auto-deploy.env
# sets PROD_SSH (e.g. root@2.28.235.10), THIS host is the controller and staging: it still decides
# what is green, but production is deployed ON PROD_SSH — over SSH, that host fetches the same SHA
# from GitHub with its own read-only deploy key, fast-forwards its /opt/hmis and runs its own
# deploy.sh. No GitHub token lives on the production host. Without PROD_SSH, production is local,
# exactly as before. Phone-app files (/opt/hmis-context/mobile-apk-prod, written here by
# build-apk.sh and publish-ota.sh) are synced to PROD_SSH on every run, deploy or not.
#
# `--dry-run` prints what it would do and changes nothing.

set -euo pipefail

REPO=/opt/hmis
PROD_DIR=/opt/hmis-prod
UAT_DIR=/opt/hmis-uat
STATE="$PROD_DIR/log/auto-deploy.last"
FAILED="$PROD_DIR/log/auto-deploy.failed"
LOG="$PROD_DIR/log/auto-deploy.log"
LOCK=/run/lock/hmis-auto-deploy.lock
GH_REPO=ankits3a/hims-hmis
REQUIRED="static core web"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
PROD_SSH=""
PROD_SSH_KEY=/root/.ssh/hmis_deploy
APK_DIR=/opt/hmis-context/mobile-apk-prod
# shellcheck disable=SC1091
[ -f /etc/hmis/auto-deploy.env ] && . /etc/hmis/auto-deploy.env
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -i "$PROD_SSH_KEY")

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [ "$DRY" = 0 ]; then
  exec >>"$LOG" 2>&1
  exec 9>"$LOCK"
  flock -n 9 || { say "another run holds the lock; skipping"; exit 0; }
fi

if [ -e "$PROD_DIR/AUTO_DEPLOY_OFF" ]; then
  [ "$DRY" = 1 ] && say "kill switch $PROD_DIR/AUTO_DEPLOY_OFF is present; nothing runs"
  exit 0
fi

# ── phone-app files follow production's host (no-op when nothing changed) ──────────────────────────
if [ -n "$PROD_SSH" ] && [ -d "$APK_DIR" ]; then
  if [ "$DRY" = 1 ]; then
    say "WOULD sync $APK_DIR to $PROD_SSH"
  else
    rsync -a -e "ssh ${SSH_OPTS[*]}" "$APK_DIR/" "$PROD_SSH:$APK_DIR/" \
      || say "phone-app files did not sync to $PROD_SSH (production is unaffected); see above"
  fi
fi

# ── production: origin/main, once every required check is green ─────────────────────────────────
deploy_prod() {
  git -C "$REPO" fetch -q origin main
  target="$(git -C "$REPO" rev-parse origin/main)"
  last="$(cat "$STATE" 2>/dev/null || true)"
  if [ "$target" = "$last" ]; then
    [ "$DRY" = 1 ] && say "origin/main ${target:0:8} is already deployed"
    return 0
  fi
  if [ "$target" = "$(cat "$FAILED" 2>/dev/null || true)" ]; then
    [ "$DRY" = 1 ] && say "${target:0:8} failed its prod deploy before; not retried (delete $FAILED to retry)"
    return 0
  fi

  # Every required check must have a run on this SHA that concluded `success`. A pending,
  # failed or missing check means "not yet": look again next run.
  conclusions="$(gh api "repos/$GH_REPO/commits/$target/check-runs?per_page=100" \
    --jq '.check_runs[] | "\(.name)=\(.conclusion)"')"
  for check in $REQUIRED; do
    if ! grep -qx "$check=success" <<<"$conclusions"; then
      [ "$DRY" = 1 ] && say "${target:0:8}: check '$check' is not green yet; waiting"
      return 0
    fi
  done

  if [ "$DRY" = 1 ]; then
    say "${target:0:8}: all of '$REQUIRED' green; WOULD fast-forward $REPO and deploy prod${PROD_SSH:+ on $PROD_SSH}"
    return 0
  fi

  say "deploying ${target:0:8} (last green deploy: ${last:0:8})${PROD_SSH:+ on $PROD_SSH}"
  # The local checkout follows too: staging (below) deploys from it.
  git -C "$REPO" merge -q --ff-only "$target"
  if [ -n "$PROD_SSH" ]; then
    run_prod_deploy() {
      # shellcheck disable=SC2029  # $target is expanded here on purpose: the remote deploys THIS SHA
      ssh "${SSH_OPTS[@]}" "$PROD_SSH" "set -e; cd /opt/hmis; git fetch -q origin main; git merge -q --ff-only $target; bash docker/prod/deploy.sh"
    }
  else
    run_prod_deploy() { bash "$REPO/docker/prod/deploy.sh"; }
  fi
  if ! run_prod_deploy; then
    echo "$target" >"$FAILED"
    say "PROD deploy of ${target:0:8} FAILED; recorded in $FAILED, not retried"
    return 1
  fi
  echo "$target" >"$STATE"
  say "prod is ${target:0:8}"
}

prod_ok=1
deploy_prod || prod_ok=0

# ── staging: follows what production runs, unless a lane holds it (tools/stage.sh) ──────────────
# Runs every time, not only after a prod deploy, so a hold ends within 10 minutes of that lane's
# PR merging or closing. Skipped after a failed prod deploy: /opt/hmis is then ahead of production.
if [ "$prod_ok" = 1 ] && [ -d "$UAT_DIR" ]; then
  if [ "$DRY" = 1 ]; then
    say "staging: $(tr '\n' ' ' <"$UAT_DIR/STAGED" 2>/dev/null || echo 'no record'); WOULD run stage.sh --follow-main"
  else
    HMIS_STAGE_LOCK_HELD=1 bash "$REPO/tools/stage.sh" --follow-main \
      || say "staging did not follow main (production is fine); see the lines above"
  fi
fi
[ "$prod_ok" = 1 ]
