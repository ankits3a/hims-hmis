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

A parse failure returns NOT-EXECUTED on purpose: a missed audit costs one skipped measurement, a
spurious one costs tokens — which is the defect the audit exists to prevent, in miniature.

Exit 0 = executed. Exit 1 = mentioned. Reads the command on stdin.
"""
import re
import shlex
import sys

INTERPRETERS = {"bash", "sh", "zsh", "dash", "ksh", "source", ".", "exec", "sudo", "env",
                "time", "nohup", "setsid", "command"}
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "{", "}", "\n"}
ENV_ASSIGN = re.compile(r"^\w+=")
IS_DEPLOY = re.compile(r"(^|/)deploy\.sh$")


def executed(command: str) -> bool:
    # Heredoc BODIES are data, never commands.
    body_stripped = re.sub(r"<<-?\s*'?\"?(\w+)'?\"?.*?^\1", " ", command, flags=re.S | re.M)
    try:
        tokens = shlex.split(body_stripped, comments=False, posix=True)
    except ValueError:
        return False  # unbalanced quotes — fail closed

    at_command_position = True
    for token in tokens:
        if token in SEPARATORS:
            at_command_position = True
            continue
        if not at_command_position:
            continue
        if token in INTERPRETERS or ENV_ASSIGN.match(token):
            continue  # still in command position: `sudo bash deploy.sh`
        at_command_position = False
        if IS_DEPLOY.search(token):
            return True
    return False


if __name__ == "__main__":
    sys.exit(0 if executed(sys.stdin.read()) else 1)
