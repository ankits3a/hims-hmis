#!/usr/bin/env bash
# ci-watch.sh — watch CI for every new commit on origin/main and SHOUT on red.
#
# WHY THIS EXISTS (EXECUTION-LESSONS §2.33, §2.55, §2.59).
# `gh` cannot authenticate on the build host, so no pipeline agent can check CI — every gate and
# checker is correctly told to report the CI item as "delegated to the main session". That
# delegation was sound while waves were driven by hand and the main session sat in every gap.
# Under the Workflow tool the waves run back-to-back and NOBODY is in the gap, so CI goes
# unwatched for the length of a run. Plan 08.5 shipped SIX commits red that way, on one
# deterministic defect, while every build-host `pnpm verify` was green.
#
# The fix that needs no credential on the build host: run THIS on the machine that already has an
# authenticated `gh` — the owner's — in the background, for the duration of a pipeline.
#
#   bash docs/superpowers/pipelines/ci-watch.sh            # watch until interrupted
#   bash docs/superpowers/pipelines/ci-watch.sh --once     # check current HEAD once and exit
#
# Exit status: 0 = nothing red seen. 1 = a commit went RED (also printed loudly).
#
# §2.59 IS THE POINT OF THE `did_run` CHECK BELOW. A CI result has THREE states — green, red, and
# DID NOT RUN — and the third reports IDENTICALLY to the second in `gh run list --json conclusion`.
# A billing-blocked, quota-blocked or never-dispatched job "fails" in three seconds having executed
# nothing. Reading `conclusion` alone once nearly caused a verified-correct fix to be recorded as
# broken. A run is evidence about a commit only if it RAN.

set -uo pipefail

REPO="${CI_WATCH_REPO:-ankits3a/hims-hmis}"
INTERVAL="${CI_WATCH_INTERVAL:-60}"
ONCE=0
[[ "${1:-}" == "--once" ]] && ONCE=1

seen=""
worst=0

# Returns: "<status> <conclusion> <seconds> <run_id>", or "none" if no run exists yet.
run_for() {
  gh api "repos/$REPO/actions/runs?head_sha=$1&per_page=1" \
    --jq '.workflow_runs[0] | if . == null then "none" else
            "\(.status) \(.conclusion // "-") \((.updated_at|fromdateiso8601) - (.run_started_at|fromdateiso8601)) \(.id)"
          end' 2>/dev/null || echo "none"
}

check() {
  local sha="$1" short="${1:0:7}" info status concl secs id
  info="$(run_for "$sha")"
  [[ "$info" == "none" || -z "$info" ]] && { echo "  $short  no run yet"; return 2; }
  read -r status concl secs id <<<"$info"
  [[ "$status" != "completed" ]] && { echo "  $short  $status…"; return 2; }

  # --- §2.59: did it actually RUN? ---
  if [[ "$concl" != "success" && "${secs%.*}" -lt 15 ]]; then
    echo ""
    echo "  ############################################################"
    echo "  #  $short — CI DID NOT RUN. This is NOT a verdict on the code."
    echo "  #  conclusion=$concl but the job lasted ${secs%.*}s."
    echo "  #  Almost always billing, a spending limit, or a blocked dispatch."
    echo "  #  Check: gh run view $id"
    echo "  #  The CI criterion is UNDISCHARGED — do not record this as red,"
    echo "  #  and do not record it as green either."
    echo "  ############################################################"
    echo ""
    return 2
  fi

  if [[ "$concl" == "success" ]]; then
    echo "  $short  GREEN (${secs%.*}s)"
    return 0
  fi

  echo ""
  echo "  ############################################################"
  echo "  #  $short — CI IS RED (${secs%.*}s, run $id)"
  echo "  #  STOP THE PIPELINE. Later tasks are building on a red tree,"
  echo "  #  and a build-host 'pnpm verify' being green does not contradict"
  echo "  #  this — that is exactly how six commits shipped red once."
  echo "  #  gh run view $id --log-failed"
  echo "  ############################################################"
  echo ""
  return 1
}

echo "ci-watch: $REPO, every ${INTERVAL}s. Ctrl-C to stop."
while :; do
  git fetch -q origin 2>/dev/null
  for sha in $(git rev-list --reverse origin/main -20); do
    [[ " $seen " == *" $sha "* ]] && continue
    check "$sha"; rc=$?
    [[ $rc -eq 2 ]] && continue          # pending or did-not-run: re-check next sweep
    seen="$seen $sha"
    [[ $rc -eq 1 ]] && worst=1
  done
  [[ $ONCE -eq 1 ]] && break
  sleep "$INTERVAL"
done
exit $worst
