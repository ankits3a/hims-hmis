#!/usr/bin/env bash
#
# Owner 2026-09-30: "I want changes deployed fast" — and the owner does not deploy by hand.
# Cron runs this every 10 minutes (/etc/cron.d/hmis-auto-deploy). It deploys origin/main to
# production and then to UAT (the staging site), but ONLY a commit whose required CI checks
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
# in FAILED and UAT is not deployed from it.
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

git -C "$REPO" fetch -q origin main
target="$(git -C "$REPO" rev-parse origin/main)"
last="$(cat "$STATE" 2>/dev/null || true)"
if [ "$target" = "$last" ]; then
  [ "$DRY" = 1 ] && say "origin/main ${target:0:8} is already deployed"
  exit 0
fi
if [ "$target" = "$(cat "$FAILED" 2>/dev/null || true)" ]; then
  [ "$DRY" = 1 ] && say "${target:0:8} failed its prod deploy before; not retried (delete $FAILED to retry)"
  exit 0
fi

# Every required check must have a run on this SHA that concluded `success`. A pending,
# failed or missing check means "not yet": exit quietly and look again next run.
conclusions="$(gh api "repos/$GH_REPO/commits/$target/check-runs?per_page=100" \
  --jq '.check_runs[] | "\(.name)=\(.conclusion)"')"
for check in $REQUIRED; do
  if ! grep -qx "$check=success" <<<"$conclusions"; then
    [ "$DRY" = 1 ] && say "${target:0:8}: check '$check' is not green yet; waiting"
    exit 0
  fi
done

if [ "$DRY" = 1 ]; then
  say "${target:0:8}: all of '$REQUIRED' green; WOULD fast-forward $REPO and deploy prod then uat"
  exit 0
fi

say "deploying ${target:0:8} (last green deploy: ${last:0:8})"
git -C "$REPO" merge -q --ff-only "$target"

if ! bash "$REPO/docker/prod/deploy.sh"; then
  echo "$target" >"$FAILED"
  say "PROD deploy of ${target:0:8} FAILED; recorded in $FAILED, not retried; UAT not touched"
  exit 1
fi
echo "$target" >"$STATE"
say "prod is ${target:0:8}"

if [ -d "$UAT_DIR" ]; then
  if HMIS_TARGET=uat bash "$REPO/docker/prod/deploy.sh"; then
    say "uat is ${target:0:8}"
  else
    say "UAT deploy of ${target:0:8} FAILED (production is fine and stays deployed)"
  fi
fi
