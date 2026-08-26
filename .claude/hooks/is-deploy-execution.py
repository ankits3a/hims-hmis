#!/usr/bin/env python3
"""Did this command EXECUTE deploy.sh, or merely mention it?

The old matcher asked `case "$cmd" in *deploy.sh*)`, which is true of `git add -- …/deploy.sh` and
of any document that quotes the filename. It misfired three times in one session (Plan 16a).

This asks the only question that matters: is deploy.sh the WORD IN COMMAND POSITION? Heredoc bodies
are stripped first (they are data), the rest is tokenised with `shlex` so a quoted string stays ONE
token, and a segment's leading interpreters and env assignments are stepped over. Then: does the
command word end in `deploy.sh`?

  bash docker/prod/deploy.sh          -> yes, `bash` is an interpreter, next word is the script
  git add -- docker/prod/deploy.sh    -> no, the command word is `git`
  python3 -c "open('…/deploy.sh')"    -> no, the -c argument is one token and is not the command
  <<EOF … bash deploy.sh … EOF        -> no, heredoc bodies are stripped
  setsid nohup sh -c 'bash …/deploy.sh > log' &  -> YES, a SHELL's -c argument is recursed into

AMENDED 2026-08-26 (Plan 09a, after a REAL production deploy went undetected). A shell's `-c`
argument is a COMMAND, not data — and `python3 -c` is data, which is why the recursion is limited to
shells. This mattered because AGENT-RULES rule 18 REQUIRES long commands to be run detached
(`setsid nohup sh -c '…'`), and a deploy is the longest command this project has: **the old matcher
could only see a deploy run the way the rules say not to run it.** Every correctly-executed deploy
was invisible to the audit trigger. Found by running one and noticing the stamp was never written.

A parse failure returns NOT-EXECUTED on purpose: a missed audit costs one skipped measurement, a
spurious one costs tokens — which is the defect the audit exists to prevent, in miniature.

Exit 0 = executed. Exit 1 = mentioned. Reads the command on stdin.
"""
import re
import shlex
import sys

INTERPRETERS = {"bash", "sh", "zsh", "dash", "ksh", "source", ".", "exec", "sudo", "env",
                "time", "nohup", "setsid", "command"}
# Only these carry a COMMAND in `-c`. `python3 -c` and `perl -e` carry a program, which is data —
# recursing into those would reintroduce the "mentions the filename" misfire this file exists to fix.
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
MAX_DEPTH = 4  # `setsid nohup sh -c "bash -c '…'"` is already pathological; bound it rather than trust it.
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "{", "}", "\n"}
ENV_ASSIGN = re.compile(r"^\w+=")
IS_DEPLOY = re.compile(r"(^|/)deploy\.sh$")


def executed(command: str, depth: int = 0) -> bool:
    if depth > MAX_DEPTH:
        return False  # fail closed, same reason a parse failure does
    # Heredoc BODIES are data, never commands.
    body_stripped = re.sub(r"<<-?\s*'?\"?(\w+)'?\"?.*?^\1", " ", command, flags=re.S | re.M)
    try:
        tokens = shlex.split(body_stripped, comments=False, posix=True)
    except ValueError:
        return False  # unbalanced quotes — fail closed

    at_command_position = True
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in SEPARATORS:
            at_command_position = True
            i += 1
            continue
        if not at_command_position:
            i += 1
            continue
        if token in INTERPRETERS or ENV_ASSIGN.match(token):
            # A SHELL's `-c` argument is a command string. shlex keeps it as ONE token, so the scan
            # above walks straight past it — which is exactly how a real deploy went unseen.
            if token in SHELLS and i + 2 < len(tokens) and tokens[i + 1] == "-c":
                if executed(tokens[i + 2], depth + 1):
                    return True
                i += 3
                at_command_position = False
                continue
            i += 1
            continue  # still in command position: `sudo bash deploy.sh`
        at_command_position = False
        if IS_DEPLOY.search(token):
            return True
        i += 1
    return False


if __name__ == "__main__":
    sys.exit(0 if executed(sys.stdin.read()) else 1)
