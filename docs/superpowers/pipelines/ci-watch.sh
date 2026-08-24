#!/usr/bin/env bash
# ci-watch.sh — watch CI for every new commit on origin/main and SHOUT on red.
#
# WHY THIS EXISTS (EXECUTION-LESSONS §2.33, §2.55, §2.59).
# ~~`gh` cannot authenticate on the build host, so no pipeline agent can check CI~~ — **AMENDED
# 2026-08-24 (ledger §2.91, Plan 11f T4): the first clause is true and the second does not follow
# from it.** `gh` cannot authenticate here; CI can still be READ here, because this repository is
# public and the unauthenticated GitHub API answers over plain `curl`. The struck sentence is left
# in place rather than deleted because it is quoted by briefs compiled before that date, and
# because the mistake it records is the durable one: **a capability ruling stated against a TOOL
# expires the moment another route to the QUESTION exists.** `ci-watch-host.sh` beside this file is
# that route — green/red per full sha, no credential, from the build host. What genuinely still
# needs `gh` is job LOGS (403 unauthenticated), which is diagnosis rather than verdict.
# — every gate and
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
#   bash docs/superpowers/pipelines/ci-watch.sh --once     # check current window once and exit
#
# Exit status: 0 = nothing red seen. 1 = a commit went RED (also printed loudly).
#
# Environment: CI_WATCH_REPO · CI_WATCH_INTERVAL (s, default 60) · CI_WATCH_DEPTH (commits per
# sweep, default 20) · CI_WATCH_MAX_TRIES (sweeps before a commit is declared UNRESOLVED,
# default 20 — at the default interval that is ~20 minutes, comfortably past this repo's ~450 s
# runs plus queue time; if you shorten CI_WATCH_INTERVAL, raise this or you will label a merely
# slow run UNRESOLVED).
#
# §2.59 IS THE POINT OF THE `did_run` CHECK BELOW. A CI result has THREE states — green, red, and
# DID NOT RUN — and the third reports IDENTICALLY to the second in `gh run list --json conclusion`.
# A billing-blocked, quota-blocked or never-dispatched job "fails" in three seconds having executed
# nothing. Reading `conclusion` alone once nearly caused a verified-correct fix to be recorded as
# broken. A run is evidence about a commit only if it RAN.
#
# §2.63 IS THE POINT OF THE BOUNDED RETRY AND THE HEARTBEAT BELOW, and it was bought by this
# script failing at the one job it exists to do. Plan 10's run: the loop `continue`d on rc 2
# WITHOUT recording the sha, so three historical billing-blocked commits were re-reported every
# sweep forever, the log filled with them, and the one commit that actually went red was found by
# the main session querying `gh` by hand in the epilogue — the position §2.55(b) exists to move
# the check out of. Two defects, and the second generalises:
#   (a) a sha the watcher cannot resolve must be recorded as UNRESOLVED after a BOUNDED number of
#       sweeps and reported ONCE. A commit whose run object will never exist (§2.62 — two tasks in
#       one wave coalescing their pushes) is otherwise re-reported until the pipeline ends.
#   (b) A WATCHDOG THAT REPORTS ONLY EXCEPTIONS IS INDISTINGUISHABLE FROM A WATCHDOG THAT HAS
#       STOPPED WATCHING. Hence the per-sweep heartbeat: "checked N, latest <sha> STATE". A stall
#       is then visible within one sweep instead of after five and a half hours.

set -uo pipefail

REPO="${CI_WATCH_REPO:-ankits3a/hims-hmis}"
INTERVAL="${CI_WATCH_INTERVAL:-60}"
DEPTH="${CI_WATCH_DEPTH:-20}"
MAX_TRIES="${CI_WATCH_MAX_TRIES:-20}"
ONCE=0
[[ "${1:-}" == "--once" ]] && ONCE=1

seen=""
worst=0
declare -A tries=()     # sha -> sweeps we have failed to resolve it
declare -A state_of=()  # sha -> last state we decided for it (for the heartbeat)
known=0                 # how many shas we have decided a state for
# `known` is a PLAIN COUNTER on purpose, and the guarded lookups below are deliberate too.
# Under `set -u`, bash 5.2 treats `${#assoc[@]}` on an EMPTY associative array as an unbound
# variable and the script DIES. The empty case is not hypothetical: it is every sweep where
# `git rev-list` returns nothing — a transient fetch failure, a detached HEAD, a network blip.
# A heartbeat that kills the watcher when the network hiccups is the very failure this rewrite
# exists to remove (§2.63(b): a watchdog that has stopped watching must not look like a quiet one).
# Caught by smoke-testing the script outside a git repo before committing it.

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

echo "ci-watch: $REPO, every ${INTERVAL}s, ${DEPTH} commits/sweep, UNRESOLVED after ${MAX_TRIES} sweeps. Ctrl-C to stop."
sweep=0
while :; do
  sweep=$((sweep + 1))
  git fetch -q origin 2>/dev/null
  checked=0
  for sha in $(git rev-list --reverse origin/main -"$DEPTH"); do
    [[ " $seen " == *" $sha "* ]] && continue
    check "$sha"; rc=$?
    checked=$((checked + 1))

    if [[ $rc -eq 2 ]]; then
      # Pending, or a run object that will never resolve (§2.62's no-run-at-all, a
      # billing-blocked job, a dispatch that never happened). Retry — but BOUNDED, and then
      # record it, or this one sha is re-reported every sweep for the length of the pipeline.
      tries[$sha]=$(( ${tries[$sha]:-0} + 1 ))
      if [[ ${tries[$sha]} -ge $MAX_TRIES ]]; then
        echo "  ${sha:0:7}  UNRESOLVED after ${tries[$sha]} sweeps — recorded, will not be reported again."
        echo "           The CI criterion for this commit is UNDISCHARGED: it is neither green nor red."
        echo "           Reproduce its condition by hand, or discharge it by equivalence and LABEL it as such (§2.62)."
        seen="$seen $sha"
        [[ -z "${state_of[$sha]+x}" ]] && known=$((known + 1))
        state_of[$sha]="UNRESOLVED"
      else
        [[ -z "${state_of[$sha]+x}" ]] && known=$((known + 1))
        state_of[$sha]="PENDING(${tries[$sha]}/${MAX_TRIES})"
      fi
      continue
    fi

    seen="$seen $sha"
    [[ -z "${state_of[$sha]+x}" ]] && known=$((known + 1))
    if [[ $rc -eq 1 ]]; then
      worst=1
      state_of[$sha]="RED"
    else
      state_of[$sha]="GREEN"
    fi
  done

  # --- §2.63(b): the heartbeat. A watchdog that prints nothing when all is well cannot be
  # distinguished from one that has died. This line prints every sweep, always — including the
  # sweep where git returned nothing, which is exactly when you most need to see it. ---
  tip="$(git rev-parse origin/main 2>/dev/null || echo unknown)"
  if [[ -n "${state_of[$tip]+x}" ]]; then tipstate="${state_of[$tip]}"; else tipstate="UNKNOWN"; fi
  echo "ci-watch: sweep ${sweep} — checked ${checked} new, ${known} known, latest ${tip:0:7} ${tipstate}"

  [[ $ONCE -eq 1 ]] && break
  sleep "$INTERVAL"
done
exit $worst
