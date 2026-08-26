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
# KNOWN LIMITATION, MEASURED BY THIS HOOK FIRING ON ITS OWN TEST HARNESS — and it is EXECUTION-
# LESSONS §2.53 recurring in a new place. That entry says `pgrep -af jest` matches the compound
# shell that CONTAINS the string "jest"; the same is true here. The hook receives the WHOLE outer
# command, so a compound shell that merely quotes "deploy.sh" inside a heredoc or an echo — a test
# harness, exactly like the one that proved this hook works — reads as a deploy. The blocklist below
# catches the common read shapes (grep, cat, git log …) but cannot catch a python3 heredoc that
# happens to contain the string.
#
# It is left as a limitation rather than solved with a cleverer matcher, for two reasons. The
# per-(sha, kind) stamp bounds the blast radius to ONE spurious nudge, which a session can read and
# dismiss in a sentence. And a matcher smart enough to parse compound shells is a matcher nobody can
# audit at a glance — which, for a hook whose whole job is to save money, is the worse trade.
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

# ...AND IT MUST BE AN EXECUTION, NOT A MENTION. Found by this hook's own first live test, which
# fired on a command that merely CONTAINED the string "deploy.sh" inside a test harness. A spurious
# audit is not harmless here: the whole point of the audit is that tokens cost money, so an audit
# nobody asked for is the defect it exists to prevent, in miniature. Reading ABOUT a deploy is not
# deploying. This is a short blocklist rather than a clever matcher on purpose — it is auditable at
# a glance, and a false NEGATIVE here costs one skipped audit while a false POSITIVE costs tokens.
case "$cmd" in
  grep*|rg*|cat*|less*|head*|tail*|wc*|ls*|echo*|find*|sed*|awk*|"git log"*|"git show"*|"git diff"*|"#"*)
    exit 0 ;;
esac

sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
subject=$(git log -1 --format=%s 2>/dev/null || echo "")
files=$(git show --name-only --format= HEAD 2>/dev/null || echo "")
reason=""

case "$cmd" in *deploy.sh*) reason="a DEPLOY just ran";; esac
if [ -z "$reason" ]; then
  # A phase closes when a plans/ document changes and the subject says so.
  if printf '%s' "$files" | grep -q "docs/superpowers/plans/"; then
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
stamp="$REPO/.git/.token-audit-$kind-$sha"
[ -e "$stamp" ] && exit 0
: > "$stamp" 2>/dev/null || true

cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TOKEN AUDIT DUE — $reason ($sha).\n\nThe owner's standing instruction: every time a plan is committed and deployed, audit where the tokens went and whether they were an investment or an expense, then amend the method so the next phase costs less for the same result.\n\nInvoke the 'token-audit' skill now. It runs docs/superpowers/pipelines/token-audit.js (zero model tokens), reads the verdict, weighs what the spend bought against the phase's CLOSE, writes the lessons into EXECUTION-LESSONS.md, amends EXECUTE-METHOD-V3.md, and appends this phase to token-baselines.json.\n\nDo not skip it because the phase is finally green. That is precisely when it gets skipped, which is why it is a hook and not a habit."}}
JSON
exit 0
