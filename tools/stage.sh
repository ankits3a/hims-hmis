#!/usr/bin/env bash
#
# Owner 2026-09-30: "so that I can start working on staging and see changes fast".
#
# Puts a lane's work on the STAGING site (https://stagehmis.crkmch.com, the UAT stack) BEFORE it
# merges, so the owner reviews the real screen, not a description of it.
#
#   tools/stage.sh <lane>          stage the lane's committed HEAD; staging then HOLDS it
#   tools/stage.sh main            put main back on staging and release the hold
#   tools/stage.sh --status        what staging is running now
#   tools/stage.sh --follow-main   cron (via auto-deploy.sh): bring staging to main unless a lane
#                                  holds it; a hold ends by itself when that lane's PR is merged
#                                  or closed
#
# WHAT IS STAGED IS THE LANE'S COMMITTED HEAD, never its working tree: commit first, then stage.
#
# ═══ WHY THIS CANNOT REACH PRODUCTION ═══
#
# deploy.sh derives its checkout from its own location, and a lane's copy of deploy.sh may be
# older than the `uat` target itself — on 2026-09-06 exactly that deployed production from a lane
# tree (see the long comment at the top of deploy.sh). So a lane is never deployed with ITS OWN
# deploy tooling. The lane's commit is checked out into a scratch worktree
# (/opt/hmis-lanes/.stage/hmis) and `docker/prod/` there is replaced with MAIN's copy before
# anything runs. On top of that this script pins HMIS_TARGET=uat and HMIS_DEPLOY_DIR=/opt/hmis-uat
# itself and refuses if the deploy.sh it is about to run does not know the uat target. A lane that
# changes docker/prod/ is refused: its deploy change cannot be staged, only merged.
#
# ═══ MIGRATIONS ═══
#
# A lane that adds a migration applies it to UAT's database. When staging later goes back to main,
# that migration may be renumbered or absent, and the deploy can fail on it. UAT holds synthetic
# data only, so the answer is to throw the database away: going back to main after such a lane
# runs uat-reset.sh (drop, migrate, re-seed), and a deploy that fails on top of such a lane is
# retried once after the same reset. Production is never involved.
#
# The same lock as auto-deploy.sh, so a staging deploy and a production deploy never overlap.

set -euo pipefail

MAIN=/opt/hmis
LANES=/opt/hmis-lanes
STAGE_TREE="$LANES/.stage/hmis"
UAT_DIR=/opt/hmis-uat
MARKER="$UAT_DIR/STAGED"
LOCK=/run/lock/hmis-auto-deploy.lock
GH_REPO=ankits3a/hims-hmis

say() { printf '%s stage: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { say "REFUSED: $*" >&2; exit 1; }
field() { sed -n "s/^$1=//p" "$MARKER" 2>/dev/null | head -n 1; }

[ -f "$UAT_DIR/.env" ] || die "$UAT_DIR/.env is missing — UAT has never been set up on this box"

if [ "${1:-}" = "--status" ]; then
  if [ -f "$MARKER" ]; then cat "$MARKER"; else echo "no staging record yet"; fi
  exit 0
fi
[ $# -eq 1 ] || die "usage: tools/stage.sh <lane> | main | --status | --follow-main"
ARG="$1"

if [ "${HMIS_STAGE_LOCK_HELD:-0}" != "1" ]; then
  exec 9>"$LOCK"
  say "waiting for the deploy lock (a production or staging deploy may be running)"
  flock -w 2400 9 || die "the deploy lock was held for 40 minutes; try again"
fi

# ── which commit, and from which tree ────────────────────────────────────────────────────────────
if [ "$ARG" = "--follow-main" ]; then
  held="$(field ref)"
  if [ -n "$held" ] && [ "$held" != "main" ]; then
    state="$(gh pr list --repo "$GH_REPO" --head "lane/$held" --state all --json state --jq '.[0].state' 2>/dev/null || true)"
    case "$state" in
      MERGED|CLOSED) say "lane '$held' PR is $state; staging goes back to main" ;;
      *) exit 0 ;;  # the owner is still looking at that lane
    esac
  fi
  # A newer main still waiting on CI: deploy.sh would refuse HEAD != origin/main. Production
  # catches up first; staging follows on the run after.
  [ "$(git -C "$MAIN" rev-parse HEAD)" = "$(git -C "$MAIN" rev-parse origin/main)" ] || exit 0
  [ "$(field sha)" = "$(git -C "$MAIN" rev-parse HEAD)" ] && [ "$(field ref)" = "main" ] && exit 0
  ARG=main
fi

if [ "$ARG" = "main" ]; then
  REF=main
  TREE="$MAIN"
  SHA="$(git -C "$TREE" rev-parse HEAD)"
  DIRTY_OK=0            # main deploys as main does: clean tree, HEAD == origin/main
  DIVERGED=0
else
  case "$ARG" in *[!A-Za-z0-9._-]*|"") die "lane name '$ARG' is not a lane name" ;; esac
  REF="$ARG"
  LANE_TREE="$LANES/$REF/hmis"
  [ -d "$LANE_TREE" ] || die "no lane at $LANE_TREE"
  SHA="$(git -C "$LANE_TREE" rev-parse HEAD)"
  if [ -n "$(git -C "$LANE_TREE" status --porcelain --untracked-files=no)" ]; then
    say "NOTE: lane '$REF' has uncommitted changes; they are NOT staged — only commit ${SHA:0:8}"
  fi
  base="$(git -C "$MAIN" merge-base "$SHA" HEAD)"
  if [ -n "$(git -C "$MAIN" diff --name-only "$base" "$SHA" -- docker/prod)" ]; then
    die "lane '$REF' changes docker/prod/; deploy tooling cannot be staged, only merged"
  fi
  # Migrations this lane carries that main does not.
  lane_sql="$(git -C "$MAIN" ls-tree --name-only "$SHA" apps/core/drizzle/ | grep '\.sql$' || true)"
  main_sql="$(git -C "$MAIN" ls-tree --name-only HEAD apps/core/drizzle/ | grep '\.sql$' || true)"
  extra="$(comm -23 <(sort <<<"$lane_sql") <(sort <<<"$main_sql"))"
  DIVERGED=0
  if [ -n "$extra" ]; then
    DIVERGED=1
    say "lane carries migrations main does not: $(tr '\n' ' ' <<<"$extra")— UAT's database takes them"
  fi

  # The scratch worktree: the lane's commit, with MAIN's deploy tooling laid over it.
  if [ ! -d "$STAGE_TREE" ]; then
    mkdir -p "$(dirname "$STAGE_TREE")"
    git -C "$MAIN" worktree add -q --detach "$STAGE_TREE" "$SHA"
  fi
  git -C "$STAGE_TREE" checkout -q -f --detach "$SHA"
  git -C "$STAGE_TREE" clean -q -fd
  git -C "$STAGE_TREE" checkout -q "$(git -C "$MAIN" rev-parse HEAD)" -- docker/prod
  TREE="$STAGE_TREE"
  DIRTY_OK=1            # the overlay above IS the dirt; deploy.sh allows it on uat only
fi

DEPLOY="$TREE/docker/prod/deploy.sh"
grep -q 'DEPLOY_DIR="${HMIS_DEPLOY_DIR:-/opt/hmis-uat}"' "$DEPLOY" \
  || die "$DEPLOY does not know the uat target; refusing to run it"

# The banner every screen wears names what is on staging (config caps it at 24 characters).
label="UAT ${REF:0:20}"
sed -i "s/^HMIS_ENVIRONMENT_LABEL=.*/HMIS_ENVIRONMENT_LABEL=$label/" "$UAT_DIR/.env"

run_deploy() {
  HMIS_TARGET=uat HMIS_DEPLOY_DIR="$UAT_DIR" HMIS_DEPLOY_ALLOW_DIRTY="$DIRTY_OK" bash "$DEPLOY"
}

say "staging $REF @ ${SHA:0:8}"
prev_diverged="$(field diverged)"
reset_uat() {
  say "resetting UAT's synthetic database (the previous staging carried migrations main does not)"
  HMIS_TARGET=uat HMIS_DEPLOY_DIR="$UAT_DIR" bash "$MAIN/docker/prod/uat-reset.sh"
}
if ! run_deploy; then
  [ "$prev_diverged" = "1" ] || die "UAT deploy of $REF @ ${SHA:0:8} failed; staging is not updated"
  reset_uat
  run_deploy || die "UAT deploy of $REF @ ${SHA:0:8} failed again after the reset"
elif [ "$REF" = "main" ] && [ "$prev_diverged" = "1" ]; then
  # The deploy went through, but the lane's tables are still in the database, and main may later
  # add the same migration under another number. Back on main means back to main's schema exactly.
  reset_uat
fi
# Stays "diverged" while a lane that carried migrations, or anything staged after one without a
# reset, is on UAT.
[ "$REF" = "main" ] || [ "$prev_diverged" != "1" ] || DIVERGED=1
printf 'ref=%s\nsha=%s\ndiverged=%s\nat=%s\n' "$REF" "$SHA" "$DIVERGED" "$(date -u +%FT%TZ)" >"$MARKER"
say "https://stagehmis.crkmch.com is $REF @ ${SHA:0:8} (hard-reload open tabs: Ctrl+Shift+R)"
