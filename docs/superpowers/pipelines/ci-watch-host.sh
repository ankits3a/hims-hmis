#!/usr/bin/env bash
# ci-watch-host.sh — green/red per FULL SHA, from the BUILD HOST, with no credential at all.
#
# WHY THIS EXISTS (EXECUTION-LESSONS §2.91, and it is a correction rather than an addition).
# `ci-watch.sh` beside this file, and EXECUTE-METHOD-V3 §8, both said the build host cannot watch
# CI. Both were correct about `gh` — which needs a credential nobody has put on this box — and
# NEITHER was correct about CI. This repository is PUBLIC, so the UNAUTHENTICATED GitHub API
# answers over plain `curl` from here. That is the only reason §2.87's two red commits were found
# at the phase that made them rather than at some later phase's close. Both sentences are amended
# in place, citing §2.91.
#
# IT READS `/actions/runs?head_sha=`, NOT `/commits/{sha}/check-runs`, AND THE DIFFERENCE IS THE
# ID IT PRINTS. Both are readable unauthenticated; §2.91 names the second. But a CHECK-RUN id is
# not a WORKFLOW-RUN id, and `gh run view <check-run-id>` does not resolve — so a poller reading
# check-runs emits a repair command that cannot work, at the exact moment somebody needs it. That
# is §2.90's class (guidance printed to an operator, wrong) and it was caught here by executing the
# script against a known-red sha and reading what it told the operator to type. `/actions/runs`
# returns the id `gh run view` accepts: for `3eec860` it is 32668118868, which is the id 11f's
# runbook item O4 names.
#
# WHAT IT CANNOT DO, stated so nobody re-derives it: job LOGS are 403 without a credential. This
# script's job is the VERDICT (§2.55's "CI is watched, not assumed"), never the diagnosis. When it
# says RED, the failing test name still needs somebody's authenticated `gh run view <id>
# --log-failed`.
#
#   bash docs/superpowers/pipelines/ci-watch-host.sh <full-sha> [<full-sha> …]
#
# FULL shas only, and that is §2.55's rule rather than fussiness: an abbreviated sha is not a key
# this API accepts, and a poller that silently resolved a prefix to the wrong commit would report a
# verdict about code nobody wrote.
#
# Exit status — THREE STATES, because a CI result has three (§2.59):
#   0  every sha GREEN
#   1  at least one sha RED                       — stop; later work is building on a red tree
#   2  at least one sha UNRESOLVED, none red      — timed out, no run object, or a job that DID NOT
#                                                   RUN. This is NOT a verdict on the code: the CI
#                                                   criterion is UNDISCHARGED in both directions.
#
# Read the exit VALUE, never a pipeline's status (AGENT-RULES rules 16-17):
#   bash ci-watch-host.sh "$sha" > /opt/hmis/.ciwatch.log 2>&1; echo $? > /opt/hmis/.ciwatch.exit
#
# Environment: CI_WATCH_REPO · CI_WATCH_INTERVAL (s, default 120) · CI_WATCH_TIMEOUT (s, default
# 1800 — this repo's `verify` runs ~450-700 s, plus queue time).
#
# REQUIRES `curl` AND `python3`. It is "credential-free", not "curl-only": the JSON is parsed by a
# short inline python program, because parsing it in bash is how a watcher starts lying. python3 is
# present on the build host (3.14.4, measured 2026-08-24). Said here so a host that lacks it gets an
# answer instead of a mystery.
#
# ═══ THE RATE LIMIT IS A BUDGET, AND IT IS ENFORCED HERE RATHER THAN DISCOVERED ═══
#
# Unauthenticated GitHub is 60 requests/hour/IP, SHARED with every other user of this box. One
# request per unresolved sha per sweep, so the ceiling is (shas × 3600 / interval). The default
# 120 s interval costs 30/hour for one sha. If the configured combination would exceed
# MAX_REQUESTS_PER_HOUR the script RAISES THE INTERVAL and says so — it does not quietly burn the
# budget, because the next thing to hit a 403 would be somebody else's unrelated work.

set -uo pipefail

REPO="${CI_WATCH_REPO:-ankits3a/hims-hmis}"
INTERVAL="${CI_WATCH_INTERVAL:-120}"
TIMEOUT="${CI_WATCH_TIMEOUT:-1800}"
MAX_REQUESTS_PER_HOUR=40      # of the 60/hour/IP ceiling, leaving headroom for anything else here
DID_NOT_RUN_SECONDS=15        # §2.59: a billing- or quota-blocked job "fails" in seconds

if [[ $# -eq 0 ]]; then
  echo "usage: ci-watch-host.sh <full-sha> [<full-sha> …]" >&2
  exit 2
fi

shas=()
for sha in "$@"; do
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "!! '$sha' is not a full 40-character sha. This API does not resolve prefixes, and a" >&2
    echo "!! poller that guessed one would report a verdict about a commit nobody wrote." >&2
    exit 2
  fi
  # DEDUPE. A sha passed twice is resolved once but counted twice in `${#shas[@]}`, so the
  # completion test could never be met and the script slept out its whole timeout before printing a
  # correct verdict (11f reviewer, minor 6).
  [[ " ${shas[*]-} " == *" $sha "* ]] || shas+=("$sha")
done

# The budget, applied BEFORE the first request.
per_hour=$(( ${#shas[@]} * 3600 / INTERVAL ))
if [[ $per_hour -gt $MAX_REQUESTS_PER_HOUR ]]; then
  INTERVAL=$(( ${#shas[@]} * 3600 / MAX_REQUESTS_PER_HOUR ))
  echo "ci-watch-host: ${#shas[@]} sha(s) at the requested interval would cost ${per_hour} req/hour," \
       "over this script's self-imposed ${MAX_REQUESTS_PER_HOUR}/hour (of GitHub's 60/hour/IP," \
       "left as headroom for anything else on this box) — interval raised to ${INTERVAL}s."
fi

# Prints "<conclusion> <elapsed_seconds> <run_id>" for a resolved sha; "pending"; "none"; or
# "error <http_code>". One request. Never interprets — that is the caller's job below.
probe() {
  local sha="$1" body code
  body="$(curl -sS -m 30 -w $'\n%{http_code}' \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=10" 2>/dev/null)" || {
      echo "error curl"; return; }
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  case "$code" in
    200) ;;
    # A 404 or 401 is PERMANENT — a wrong CI_WATCH_REPO, or a repo that stopped being public.
    # Retrying it burns the whole timeout and a third of an hourly budget to reach the same answer.
    404|401) echo "fatal $code"; return ;;
    *) echo "error $code"; return ;;   # 403 (rate limit), 5xx, 000: genuinely transient
  esac
  # THE BODY GOES ON STDIN, NOT THROUGH THE ENVIRONMENT. It was `CI_BODY="$body" python3` until
  # 11f's reviewer measured the ceiling: `execve` on this host refuses an env string at ~131 KB,
  # and one `workflow_run` object from this API is ~17 KB — so eight runs on one sha killed the
  # probe with "Argument list too long" on stderr, which `$(probe …)` does not capture. The empty
  # stdout then fell through the case below to `*)` and printed CI DID NOT RUN — a verdict minted
  # by the poller's own plumbing and blamed on GitHub billing. stdin has no such limit.
  printf '%s' "$body" | python3 -c '
import json, sys
from datetime import datetime

def secs(a, b):
    if not a or not b:
        return 0
    f = "%Y-%m-%dT%H:%M:%SZ"
    return int((datetime.strptime(b, f) - datetime.strptime(a, f)).total_seconds())

try:
    d = json.load(sys.stdin)
except Exception:
    print("error parse"); sys.exit(0)

runs = d.get("workflow_runs") or []
if not runs:
    print("none"); sys.exit(0)

# ONE RUN PER (WORKFLOW, EVENT), THE LATEST.
#
# THE EVENT IS HALF THE KEY, and leaving it out was the ONE construction in which this script could
# say GREEN about a RED commit (11f reviewer, M3). `.github/workflows/ci.yml` is
# `on: [push, pull_request]`, and the two events share a workflow_id while testing DIFFERENT TREES:
# a pull_request run checks out refs/pull/N/merge, a push run checks out the commit itself, and
# both report the same head_sha. So "latest run of this workflow wins" picks whichever GitHub
# happened to schedule second, and a green merge-result run would mask a red push run on the same
# sha. Grouping by (workflow, event) and taking the WORST across events cannot do that.
#
# Within one (workflow, event) the latest still wins, which is the re-run case: there a newer
# attempt genuinely supersedes the one it re-ran.
latest = {}
for r in runs:
    key = (r.get("workflow_id"), r.get("event"))
    prev = latest.get(key)
    if prev is None or (r.get("run_started_at") or "") > (prev.get("run_started_at") or ""):
        latest[key] = r
runs = list(latest.values())

if any(r.get("status") != "completed" for r in runs):
    print("pending"); sys.exit(0)

# The worst conclusion wins, and the run it belongs to is the one worth naming.
order = {"failure": 0, "timed_out": 0, "cancelled": 0, "action_required": 0,
         "stale": 1, "neutral": 1, "skipped": 1, "success": 2}
worst = min(runs, key=lambda r: order.get(r.get("conclusion"), 0))
print("%s %d %s" % (worst.get("conclusion"),
                    secs(worst.get("run_started_at"), worst.get("updated_at")),
                    worst.get("id")))
'
}

echo "ci-watch-host: ${REPO}, ${#shas[@]} sha(s), every ${INTERVAL}s, giving up after ${TIMEOUT}s."

declare -A verdict=()
resolved=0
started=$SECONDS
sweep=0

while :; do
  sweep=$(( sweep + 1 ))
  for sha in "${shas[@]}"; do
    [[ -n "${verdict[$sha]+x}" ]] && continue
    short="${sha:0:7}"
    read -r concl secs id <<<"$(probe "$sha")"

    case "$concl" in
      none)    echo "  $short  no run yet (sweep ${sweep})" ;;
      pending) echo "  $short  running… (sweep ${sweep})" ;;
      error)
        # A transient failure must not become a verdict, and must not kill the watch either.
        echo "  $short  API unreadable (${secs:-?}) — retrying next sweep"
        ;;
      fatal)
        # Permanent: a wrong repo, or one that is no longer public. Retrying cannot change it, and
        # spending the whole timeout to say so wastes a shared hourly budget.
        echo "  $short  API says ${secs:-?} — PERMANENT (check CI_WATCH_REPO='${REPO}'). Not retried."
        verdict[$sha]="UNRESOLVED"; resolved=$(( resolved + 1 ))
        ;;
      success)
        echo "  $short  GREEN (${secs}s, run ${id})"
        verdict[$sha]="GREEN"; resolved=$(( resolved + 1 ))
        ;;
      # EVERY conclusion string GitHub emits, listed exhaustively so the `*)` arm below can mean
      # "the plumbing broke" rather than "a conclusion I have not met". `startup_failure` belongs
      # here: it is a real verdict about a run, not a fault in this script, and omitting it would
      # have sent a genuinely broken workflow to the retry-forever arm.
      failure|timed_out|cancelled|action_required|stale|neutral|skipped|startup_failure)
        if [[ "${secs:-0}" -lt $DID_NOT_RUN_SECONDS ]]; then
          # §2.59. `conclusion=failure` after three seconds is a job that executed nothing —
          # billing, a spending limit, a blocked dispatch — and it reports IDENTICALLY to a real
          # red. Reading `conclusion` alone once nearly recorded a verified-correct fix as broken.
          echo ""
          echo "  ############################################################"
          echo "  #  $short — CI DID NOT RUN. This is NOT a verdict on the code."
          echo "  #  conclusion=${concl} but the job lasted ${secs}s (run ${id})."
          echo "  #  Almost always billing, a spending limit, or a blocked dispatch."
          echo "  #  The CI criterion is UNDISCHARGED — not red, and not green either."
          echo "  ############################################################"
          echo ""
          verdict[$sha]="UNRESOLVED"
        else
          echo ""
          echo "  ############################################################"
          echo "  #  $short — CI IS RED (conclusion=${concl}, ${secs}s, run ${id})"
          echo "  #  STOP. Later work is building on a red tree, and a build-host"
          echo "  #  'pnpm verify' being green does not contradict this — that is"
          echo "  #  exactly how six commits shipped red once (§2.55), and how two"
          echo "  #  more did under v3's per-task pushes (§2.87)."
          echo "  #  The failing test needs an authenticated run:"
          echo "  #    gh run view ${id} --log-failed"
          echo "  #  Job logs are 403 from this host; that half is not this"
          echo "  #  script's to answer (§2.91)."
          echo "  ############################################################"
          echo ""
          verdict[$sha]="RED"
        fi
        resolved=$(( resolved + 1 ))
        ;;
      *)
        # THE ARM THAT MUST EXIST. Anything the probe emits that is not one of the tokens above —
        # empty output, a python traceback, a shape this script has never seen — is a failure of
        # the PLUMBING, and plumbing must never mint a CI verdict. Without this arm every
        # unrecognised token fell into the conclusion branch above and was reported as
        # "CI DID NOT RUN … almost always billing", which is a wrong statement about somebody's
        # commit, attributed to GitHub (11f reviewer, M2).
        echo "  $short  probe returned something unrecognised (\"${concl}\") — retrying next sweep."
        echo "           This is a fault in ci-watch-host.sh, NOT a verdict about the commit."
        ;;
    esac
  done

  [[ $resolved -ge ${#shas[@]} ]] && break

  if [[ $(( SECONDS - started )) -ge $TIMEOUT ]]; then
    for sha in "${shas[@]}"; do
      [[ -n "${verdict[$sha]+x}" ]] && continue
      echo "  ${sha:0:7}  UNRESOLVED after ${TIMEOUT}s — neither green nor red. The CI criterion"
      echo "           for this commit is UNDISCHARGED; say so rather than assuming either way."
      verdict[$sha]="UNRESOLVED"
    done
    break
  fi

  sleep "$INTERVAL"
done

# --- the verdict, and the exit VALUE that carries it ---
worst=0
for sha in "${shas[@]}"; do
  echo "ci-watch-host: ${sha:0:7} ${verdict[$sha]}"
  case "${verdict[$sha]}" in
    RED)        worst=1 ;;
    UNRESOLVED) [[ $worst -eq 0 ]] && worst=2 ;;
  esac
done
exit $worst
