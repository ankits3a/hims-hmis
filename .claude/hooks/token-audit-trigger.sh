#!/usr/bin/env bash
# token-audit-trigger.sh — fires the token-audit skill when a PLAN CLOSES or DEPLOYS.
#
# WHY A HOOK AND NOT A HABIT. The audit only pays if it happens every time, and it is exactly the
# step a session skips when it is tired and the phase is finally green. The harness runs this; the
# model does not have to remember.
#
# WHAT IT MATCHES, deliberately narrowly — a `git push` or a `deploy.sh` is not itself interesting.
# What is interesting is a push that carries a phase document's CLOSE, or any deploy. Everything
# else stays silent, because a hook that fires on every push is a hook somebody disables.
#
# IT IS IDEMPOTENT. One stamp per commit sha under .git/, so a re-push, a retry, or three pushes in
# one close do not ask three times.
#
# ~~KNOWN LIMITATION~~ — FIXED 2026-08-26 (Plan 16a), after it misfired THREE TIMES in one session.
# The old matcher asked `case "$cmd" in *deploy.sh*)`, which is true of `git add -- …/deploy.sh`, of
# `sed -n '400,440p' …/deploy.sh`, and of any heredoc whose PROSE contains the filename — all three
# of which happened while Plan 16a edited the deploy script and wrote about having done so.
#
# The old comment argued the limitation was the better trade: a per-(sha,kind) stamp bounds it to one
# spurious nudge, and "a matcher smart enough to parse compound shells is a matcher nobody can audit
# at a glance". The first half held. The second was answered by asking a SIMPLER question instead of
# a cleverer one: not "does this string appear" but "is deploy.sh the word in COMMAND POSITION".
# `is-deploy-execution.py` beside this file strips heredoc bodies, tokenises with `shlex` so a quoted
# string stays one token, steps over interpreters and env assignments, and checks the command word.
# Forty lines, one question, and `test-deploy-trigger.sh` pins it against 24 cases including the
# three that actually misfired.
#
# A parse failure returns NOT-A-DEPLOY on purpose: a missed audit costs one skipped measurement, a
# spurious one costs tokens — which is the defect the audit exists to prevent, in miniature.
#
# It reads stdin (the PostToolUse payload) but does not require it — run it by hand to test:
#   echo '{"tool_input":{"command":"git push origin main"}}' | bash .claude/hooks/token-audit-trigger.sh
set -uo pipefail

REPO=/opt/hmis
cd "$REPO" 2>/dev/null || exit 0

payload=$(cat 2>/dev/null || true)

# FAST PATH, and it is why this is safe to hang off EVERY Bash call. A PostToolUse/Bash hook runs
# hundreds of times a session; spawning python3 each time would add real latency for nothing. A
# plain shell `case` on the RAW payload rejects the ~99% of commands that cannot possibly matter,
# before any interpreter starts.
case "$payload" in
  *"git push"*|*deploy.sh*) ;;
  *) exit 0 ;;
esac

cmd=$(printf '%s' "$payload" | python3 -c "
import json,sys
try: print((json.load(sys.stdin).get('tool_input') or {}).get('command',''))
except Exception: print('')
" 2>/dev/null || true)

# Only a push or a deploy is a candidate.
case "$cmd" in
  *"git push"*|*deploy.sh*) ;;
  *) exit 0 ;;
esac

# ...AND IT MUST BE AN EXECUTION, NOT A MENTION. Reading ABOUT a deploy is not deploying, and
# neither is `git add`-ing the script. The blocklist that used to live here (grep|cat|sed|…) was a
# guess at the read shapes; this asks the question directly.
is_deploy=0
if printf '%s' "$cmd" | python3 "$REPO/.claude/hooks/is-deploy-execution.py" 2>/dev/null; then
  is_deploy=1
fi



sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
subject=$(git log -1 --format=%s 2>/dev/null || echo "")
files=$(git show --name-only --format= HEAD 2>/dev/null || echo "")
reason=""

[ "$is_deploy" = 1 ] && reason="a DEPLOY just ran"
phase_docs=""
if [ -z "$reason" ]; then
  # A phase closes when a PHASE DOCUMENT changes and the subject says so.
  #
  # `plans/reports/` IS EXCLUDED, and that is a loop this hook built for itself: the audit writes
  # its lessons into `plans/reports/EXECUTION-LESSONS.md`, so the commit RECORDING an audit matched
  # the trigger FOR an audit — with the word "close" in its own subject. One audit asked for the
  # next. A phase document is `plans/<date>-<name>.md`; the reports directory holds the audit's own
  # output, and an audit's output is never the thing being audited.
  #
  # AND THE ROADMAP IS EXCLUDED TOO — added 2026-08-26 (Plan 09a), after this hook fired TWICE for
  # one close. `2026-08-11-phase1-plan-series.md` is the plan SERIES index, not a phase document:
  # every close updates its status line, and it sorts FIRST by date, so the `head -1` below stamped
  # the ROADMAP and left the actual phase document unstamped. The next commit touching only that
  # phase document therefore computed a different key and asked again. Measured: 09a's close
  # (`9f9ec96`) stamped `…plan-series-md-`, and `b7ae37a` fired a second time an hour later.
  # A document that changes at EVERY close can never be the thing that identifies ONE close.
  phase_docs=$(printf '%s' "$files" \
    | grep "^docs/superpowers/plans/[^/]*\.md$" \
    | grep -v "phase1-plan-series\.md$" || true)
  if [ -n "$phase_docs" ]; then
    case "$subject" in
      *CLOSE*|*close*|*"gate report"*|*SHIPPED*) reason="a phase document's CLOSE was just pushed";;
    esac
  fi
fi
[ -z "$reason" ] && exit 0

# THE STAMP IS PER (sha, KIND), not per sha. A phase that closes and is deployed later at the same
# commit is TWO events worth auditing — the close asks "was that spend worth it", the deploy asks it
# again with production in hand. One stamp per sha would have silently swallowed the second.
case "$reason" in *DEPLOY*) kind=deploy;; *) kind=close;; esac

# THE CLOSE STAMP IS PER PHASE DOCUMENT, NOT PER SHA. A close is rarely one commit — remediation,
# the roadmap line and the audit's own record all follow it, and a per-sha stamp asked again at
# every one. A DEPLOY stamp stays per-sha: deploying the same tree twice is genuinely two events.
if [ "$kind" = close ]; then
  # STAMP EVERY PHASE DOCUMENT IN THE COMMIT, NOT JUST THE FIRST — added 2026-08-26 (Plan 09a).
  # `head -1` made the identity of a close depend on which document happened to sort first, which
  # is exactly how one close asked twice. A commit that closes two phases is two audits; a commit
  # that re-touches an already-audited phase is none. Fire only if at least one is NEW.
  fresh=0
  while IFS= read -r doc; do
    [ -z "$doc" ] && continue
    key=$(printf '%s' "$doc" | tr -c 'A-Za-z0-9' '-')
    st="$REPO/.git/.token-audit-close-$key"
    [ -e "$st" ] || { fresh=1; : > "$st" 2>/dev/null || true; }
  done <<EOF
$phase_docs
EOF
  [ "$fresh" = 0 ] && exit 0
else
  stamp="$REPO/.git/.token-audit-$kind-$sha"
  [ -e "$stamp" ] && exit 0
  : > "$stamp" 2>/dev/null || true
fi

# EVERY FIRING IS LOGGED WITH THE COMMAND THAT CAUSED IT. A hook that fires wrongly is otherwise
# un-diagnosable: the model never sees the payload, and this session proved that reconstructing the
# command from memory produces a confident wrong answer. Firings are rare by construction (one per
# sha per kind), so the log stays small; `tail -20 .git/.token-audit-hook.log` is the whole
# investigation the next time somebody says "why did that fire?".
{ printf '%s  %s  %s\n    %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$kind" "$sha" "$cmd"; } \
  >> "$REPO/.git/.token-audit-hook.log" 2>/dev/null || true

cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TOKEN AUDIT DUE — $reason ($sha).\n\nThe owner's standing instruction: every time a plan is committed and deployed, audit where the tokens went and whether they were an investment or an expense, then amend the method so the next phase costs less for the same result.\n\nInvoke the 'token-audit' skill now. It runs docs/superpowers/pipelines/token-audit.js (zero model tokens), reads the verdict, weighs what the spend bought against the phase's CLOSE, writes the lessons into EXECUTION-LESSONS.md, amends EXECUTE-METHOD-V3.md, and appends this phase to token-baselines.json.\n\nDo not skip it because the phase is finally green. That is precisely when it gets skipped, which is why it is a hook and not a habit."}}
JSON
exit 0
