#!/usr/bin/env bash
# test-deploy-trigger.sh — pins `is-deploy-execution.py` against the shapes that matter.
#
# Every MUST-NOT-FIRE case below is real: the first three are the exact commands that misfired
# during Plan 16a, which is why this file exists. Run it after any change to the matcher:
#   bash .claude/hooks/test-deploy-trigger.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
python3 - <<'PYEOF'
import subprocess, sys

MUST_FIRE = [
    "bash docker/prod/deploy.sh",
    "cd /opt/hmis-prod && ./deploy.sh",
    "sh /opt/hmis/docker/prod/deploy.sh --yes",
    "bash deploy.sh 2>&1 | tee /tmp/x.log",
    "setsid nohup bash docker/prod/deploy.sh",
    "DEPLOY_CONFIRM=1 bash docker/prod/deploy.sh",
    "/opt/hmis/docker/prod/deploy.sh",
    'bash "docker/prod/deploy.sh"',
    "sudo bash docker/prod/deploy.sh",
    # ── PLAN 09a, 2026-08-26: THE CASE A REAL PRODUCTION DEPLOY HIT. ──
    # AGENT-RULES rule 18 requires long commands to run DETACHED, and a deploy is the longest command
    # this project has — so this is the shape a correctly-run deploy actually takes. The matcher
    # stepped over `setsid`/`nohup`/`sh`, met `-c`, stopped, and never looked inside. The stamp was
    # never written and the audit was never asked for. Found by deploying and noticing the silence.
    "setsid nohup sh -c 'bash /opt/hmis/docker/prod/deploy.sh > /opt/hmis/.deploy.log 2>&1; echo $? > /opt/hmis/.deploy.exit' >/dev/null 2>&1 &",
    "sh -c 'bash docker/prod/deploy.sh'",
    "setsid sh -c 'bash -c \"bash docker/prod/deploy.sh\"'",

]
MUST_NOT_FIRE = [
    # The three that actually misfired, Plan 16a, 2026-08-26.
    "git add -- apps/core/scripts/seed.ts docker/prod/deploy.sh docs/plan.md && git commit -q -m 'feat: seed'",
    "python3 - <<'EOF'\ns = 'pairs seeded, in `deploy.sh`, and left alone on re-run'\nprint(s)\nEOF",
    "git add -- docs/EXECUTION-LESSONS.md && git commit -q -m 'feat(method): audit' && git push origin main",
    # Read shapes.
    "grep -n 'seed:' deploy.sh",
    "sed -n '400,440p' docker/prod/deploy.sh",
    "cat docker/prod/deploy.sh",
    "git show HEAD -- docker/prod/deploy.sh",
    "git commit -m 'docs: mention deploy.sh in the runbook'",
    "wc -l docker/prod/deploy.sh",
    "python3 -c \"print(open('docker/prod/deploy.sh').read())\"",
    "echo bash deploy.sh > notes.txt",
    "python3 - <<'PY'\nopen('x','w').write('bash deploy.sh')\nPY",
    "vim docker/prod/deploy.sh",
    "cp docker/prod/deploy.sh /tmp/backup.sh",
    "git diff docker/prod/deploy.sh | head -20",
    # PLAN 09a — recursing into a shell's `-c` must NOT reintroduce mention-vs-execution. These are
    # the cases that would break if the recursion were widened to every interpreter.
    "sh -c 'cat docker/prod/deploy.sh'",
    "bash -c 'grep -n compose docker/prod/deploy.sh'",
    "python3 -c \"open('docker/prod/deploy.sh')\"",
    "setsid nohup sh -c 'sed -n 1,40p /opt/hmis/docker/prod/deploy.sh > /tmp/x' &",
]

def executed(cmd):
    return subprocess.run(["python3", ".claude/hooks/is-deploy-execution.py"],
                          input=cmd, capture_output=True, text=True).returncode == 0

bad = 0
for c in MUST_FIRE:
    if not executed(c):
        print("FALSE NEGATIVE (a real deploy would be missed):", c[:72]); bad += 1
for c in MUST_NOT_FIRE:
    if executed(c):
        print("FALSE POSITIVE (an audit nobody asked for):", c[:72].replace("\n", "\\n")); bad += 1
total = len(MUST_FIRE) + len(MUST_NOT_FIRE)
print(f"{total} cases, {bad} wrong")
sys.exit(1 if bad else 0)
PYEOF
